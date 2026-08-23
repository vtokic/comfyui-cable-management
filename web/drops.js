// Passthrough pins as DROP TARGETS -- the receiving half of the junction model.
//
// Only the CONSUMER direction needs us: an input-drag (seeking an output)
// dropped on a pin connects the consumer to the pin's VALUE -- the upstream
// origin for a connected input, the owned primitive for a widget literal
// (materialised on demand, reaped if the connect refuses). Source drags dropped
// on a pin already land through core's node-body drop (first matching input).
//
// Core cannot see the pins at all: they are not slots, and during a drag they
// are pointer-events:none besides -- so the drop pipeline resolves them from
// the pin DOM by proximity, in graph units, at the same seams the reroute belt
// uses (dropOnNothing and dropOnNode instance wraps in pathing.js).
import { activeGraph, nodeFromId, originOf } from "./graph.js";
import { materialise, ownerOf, reapIfUnused } from "./primitive.js";
import { recordProvenance, recordGateProvenance, settleCarriedLink } from "./reanchor.js";
import { stampFloats, unclaim } from "./routestore.js";
import { stitchGates, isStitch } from "./stitch.js";
import { invalidate, anchorOf } from "./ledger.js";
import { combAt, laneAt, toothOf, laneEnds, typeMatch } from "./pathing/combs.js";
import { pendingPin } from "./drag.js";
import { linkSlots } from "./invoke.js";


/** Nearest pin within 12 graph units, filtered to the dragged type. */
function pinNear(graph, x, y, type) {
  let best = null;
  let bd = 12;
  for (const el of document.querySelectorAll(".cablemanagement-pin")) {
    const node = nodeFromId(graph, el.dataset.cablemanagementNode);
    if (!node) continue;
    if (!typeMatch(el.dataset.cablemanagementType, type)) continue;
    const a = anchorOf(el, node);
    if (!a) continue;
    const d = Math.hypot(a[0] - x, a[1] - y);
    if (d < bd) {
      bd = d;
      best = { el, node, anchor: a };
    }
  }
  return best;
}

/**
 * The IN-gate lane a point addresses: the pin strip resolves by row, and a
 * near-miss lands on the closest in-tooth within the same 12-unit radius the
 * reroute belt uses. One region function for the drop AND the snap magnet, so
 * the hint only ever pops where a release would land.
 */
export function inLaneAt(graph, x, y) {
  const hit = combAt(graph, x, y);
  if (hit && hit.which === "in" && hit.zone === "pins") {
    const lane = laneAt(hit.comb, "in", y);
    if (lane) return lane;
  }
  // Inside a gate but not on the in-pin strip: the point belongs to that
  // zone's own semantics (body = park a NEW lane) -- the near-miss radius
  // below must not poach it, or the body's pin-side edge silently populates
  // an existing lane instead of creating one (Barney's collision question).
  if (hit) return null;
  let best = null;
  let bd = 12;
  for (const r of graph.reroutes?.values?.() ?? []) {
    const t = toothOf(r.id);
    if (!t || t.side !== "in") continue;
    const d = Math.hypot(r.pos[0] - x, r.pos[1] - y);
    if (d < bd) {
      bd = d;
      best = t.comb?.lanes?.[t.lane] ?? null;
    }
  }
  return best;
}

/**
 * The out-pin anchor a CONSUMER drag of this type would connect through, or
 * null. Mirror of gateInNear (Barney's QA caveat: input-side snapped, output
 * side didn't). The drop itself lands through the dropOnNothing wrap's
 * nearest-reroute fallback -- tooth within 12 units, core dropOnReroute
 * semantics: consumer feeds from the lane's source through the tooth -- so
 * the hint uses the same radius and the same "lane has a compatible source"
 * predicate, and pops only where that release would connect.
 */
function gateOutNear(graph, x, y, type) {
  let best = null;
  let bd = 12;
  for (const r of graph.reroutes?.values?.() ?? []) {
    const t = toothOf(r.id);
    if (!t || t.side !== "out") continue;
    const d = Math.hypot(r.pos[0] - x, r.pos[1] - y);
    if (d < bd) {
      bd = d;
      best = { reroute: r, lane: t.comb?.lanes?.[t.lane] ?? null };
    }
  }
  if (!best?.lane) return null;
  const { links, hanging, parked } = laneEnds(graph, best.lane);
  const carried = links[0]?.type ?? hanging[0]?.type ?? parked[0]?.type ?? null;
  const hasSource = links.length || hanging.length;
  if (!hasSource || !typeMatch(type, carried)) return null;
  return { anchor: [best.reroute.pos[0], best.reroute.pos[1]] };
}

/** The in-pin anchor a source drag of this type would connect through, or null. */
function gateInNear(graph, x, y, type) {
  const lane = inLaneAt(graph, x, y);
  if (!lane) return null;
  const { targets, hanging } = laneEnds(graph, lane);
  const ok =
    targets.some((t) => typeMatch(type, t.node.inputs[t.slot]?.type)) ||
    hanging.some((f) => typeMatch(type, f.type));
  if (!ok) return null;
  const r = graph.reroutes?.get?.(lane.in);
  return r ? { anchor: [r.pos[0], r.pos[1]] } : null;
}

/**
 * A SOURCE drag dropped on a ribbon gate's IN pin -- the direction core has no
 * gesture for at all ("ribbon input pins don't accept links", QA 2f). The pin
 * names a lane; the drop gives that lane the dragged output as its source:
 *   - lane carrying real links: their source is swapped (core connect replaces
 *     occupied inputs, afterRerouteId re-threads the same teeth);
 *   - source-dangling lane (float parked with a real target): the lane finally
 *     gets its source, and the parked float is retired;
 *   - source-HANGING lane (float pulled from a pin, no target yet -- how a
 *     floating ribbon is built): the float's source is replaced in place. The
 *     new float must be added BEFORE the old one is removed: core's
 *     removeFloatingLink garbage-collects reroutes at zero links, and the old
 *     float is all that holds the teeth.
 * Provenance follows the GESTURE: a drag from a real output writes none (the
 * source is genuinely what the user wired; any floatfrom illusion on the lane
 * ends). A drag pulled from a PASS-THROUGH PIN records the pin as the apparent
 * source -- consumer records for real links, floatfrom for a replaced hanging
 * float -- exactly as the same pull dropped anywhere else would (QA: a pin
 * pull onto an unpopulated in-pin visibly connected from the true origin).
 */
export function handleGateInDrop(app, lc, event, viaReroute) {
  const graph = activeGraph(app);
  if (!graph || lc.state?.connectingTo !== "input") return false;
  // One gate connect per gesture: the capture-phase pointerup handles first,
  // then the same release travels the Vue finalize and the drop seams.
  if (lc.__cablemanagementGateDone) return false;
  // Teeth ARE reroutes sitting on the pin column, so core's drop pipeline
  // hit-tests them BEFORE dropOnNothing ever fires -- this handler is wired
  // into BOTH seams: dropOnReroute hands the tooth over directly, the
  // dropOnNothing path resolves the lane from gate geometry.
  let lane = null;
  if (viaReroute) {
    const t = toothOf(viaReroute.id);
    if (!t || t.side !== "in") return false;
    lane = t.comb?.lanes?.[t.lane] ?? null;
  } else {
    lane = inLaneAt(graph, event.canvasX, event.canvasY);
  }
  if (!lane) return false;
  // The lane's ends: real links riding the out-tooth; parked floats holding a
  // real target (source-dangling); floats holding only a real origin
  // (source-hanging -- a wire pulled from a pin awaiting a consumer).
  const { outR, targets, parked, hanging } = laneEnds(graph, lane);
  if (!outR) return false;
  if (!targets.length && !hanging.length) return false;

  const pin = pendingPin?.() ?? null; // the pass-through pin this drag was pulled from, if any
  let did = false;
  let hung = null; // the replacement float, when the hanging path ran
  for (const rl of lc.renderLinks) {
    if (rl.toType !== "input") continue;
    const srcNode = rl.node;
    const srcIdx = srcNode?.outputs?.indexOf?.(rl.fromSlot);
    if (srcNode == null || srcIdx == null || srcIdx < 0) continue;
    let rlDid = false;
    for (const t of targets) {
      if (!typeMatch(rl.fromSlot?.type, t.node.inputs[t.slot]?.type)) continue;
      const link = linkSlots(srcNode, srcIdx, t.node, t.slot, lane.out);
      if (link) {
        rlDid = did = true;
        if (pin) recordProvenance(t.node, t.slot, pin.host, pin.index, link.id);
      }
    }
    for (const f of hanging) {
      if (!typeMatch(rl.fromSlot?.type, f.type)) continue;
      const LLinkC = window.LiteGraph?.LLink;
      if (!LLinkC || !graph.addFloatingLink) continue;
      const next = new LLinkC(-1, rl.fromSlot.type, srcNode.id, srcIdx, -1, -1);
      next.parentId = f.parentId;
      graph.addFloatingLink(next); // FIRST: the old float is all that holds the teeth
      graph.removeFloatingLink?.(f);
      hung = next;
      rlDid = did = true;
    }
    // A drag CARRYING an existing link (core pickup at the target end) that
    // just landed here is a MOVE: the donor input empties (QA: 'replaces X2
    // correctly but A->B remains unmodified' -- ruled: all of those
    // interactions kill A->B).
    if (rlDid) settleCarriedLink(graph, rl);
  }
  if (!did) return false;
  // Core retires floats whose terminus is the chain's LAST reroute; a float
  // parked on the IN tooth is not, so it goes by hand.
  for (const f of parked) {
    if (graph.floatingLinks?.has?.(f.id)) graph.removeFloatingLink?.(f);
  }
  // The lane's apparent source follows the gesture: a pin pull re-stamps the
  // teeth with the pulled pin; a genuine output ends the illusion instead.
  if (pin && hung) {
    stampFloats(graph, [lane.in, lane.out], [String(pin.host.id), pin.index]);
  } else {
    unclaim(graph, "floats", lane.in);
    unclaim(graph, "floats", lane.out);
  }
  // The ROUTE claim too, in both cases. A stale stamp actively fights the swap:
  // the next branch pulled through the lane inherits the OLD pin as apparent
  // source and reconcile re-sources it back to the old provider, resurrecting
  // the source the user just replaced (dbg-resource-chain QA). A pin pull needs
  // no carry-over either -- its fresh consumer records re-stamp on the next
  // prune pass.
  unclaim(graph, "reroutes", lane.in);
  unclaim(graph, "reroutes", lane.out);
  invalidate();
  graph.setDirtyCanvas(true, true);
  lc.__cablemanagementGateDone = true;
  lc.renderLinks.length = 0; // consume: no later stage may reconnect this drag
  return true;
}

export function handlePinDrop(app, lc, event) {
  const graph = activeGraph(app);
  if (!graph || lc.state?.connectingTo !== "output") return false;
  // One connect per gesture: a pin straddles the node edge, so a drop on its
  // outer half can reach BOTH seams (the pointerup below, then dropOnNothing).
  if (lc.__cablemanagementPinDone) return false;

  const best = pinNear(graph, event.canvasX, event.canvasY, lc.renderLinks[0]?.fromSlot?.type);
  if (!best) return false;

  const host = best.node;
  const index = Number(best.el.dataset.cablemanagementIndex);
  const kind = best.el.dataset.cablemanagementKind;

  let created = null;
  let tryConnect;
  if (kind === "link") {
    const origin = originOf(graph, host, index);
    if (!origin) return false;
    if (origin.node === graph.inputNode) {
      // Boundary origin: the pin's value IS the subgraph input, so feed the
      // consumer straight from the gate slot -- an ordinary gate->node link.
      // (Only gate-to-GATE is unsupported, and a consumer drag never IS a gate.)
      const gateSlot = graph.inputNode.slots?.[origin.slot];
      if (!gateSlot) return false;
      tryConnect = (rl) => {
        // A drag FROM the output gate landing here is gate-to-gate: core's
        // connectToSubgraphInput EXISTS but throws 'Not implemented' -- bridge
        // with a branded reroute instead (see stitch.js).
        if (rl.isIoNodeLink) {
          return !!stitchGates(graph, gateSlot, rl.fromSlot, event.canvasX, event.canvasY, [String(host.id), index]);
        }
        if (typeof rl.connectToSubgraphInput !== "function") return false;
        if (typeof rl.canConnectToSubgraphInput === "function" && !rl.canConnectToSubgraphInput(gateSlot))
          return false;
        rl.connectToSubgraphInput(gateSlot, lc.events);
        return true;
      };
    } else {
      const srcNode = origin.node;
      const srcSlot = origin.node.outputs?.[origin.slot];
      if (!srcNode || !srcSlot) return false;
      tryConnect = (rl) => {
        if (!rl.canConnectToOutput?.(srcNode, srcSlot)) return false;
        rl.connectToOutput(srcNode, srcSlot, lc.events);
        return true;
      };
    }
  } else {
    const existing = ownerOf(graph, host, index);
    const prim = existing ?? materialise(app, host, index);
    if (!prim) return false;
    if (!existing) created = prim;
    const srcSlot = prim.outputs?.[0];
    if (!srcSlot) return false;
    tryConnect = (rl) => {
      if (!rl.canConnectToOutput?.(prim, srcSlot)) return false;
      rl.connectToOutput(prim, srcSlot, lc.events);
      return true;
    };
  }

  const before = graph.state?.lastLinkId ?? 0;
  let did = false;
  for (const rl of lc.renderLinks) {
    if (rl.toType !== "output") continue;
    // The pin feeding its own slot would be the machinery link cablemanagement never creates.
    if (rl.node === host && rl.fromSlot === host.inputs?.[index]) continue;
    if (tryConnect(rl)) did = true;
  }
  if (!did) {
    if (created) reapIfUnused(graph, created);
    return false;
  }

  // Provenance for every link the drop just made: it was pulled ONTO the pin,
  // so it draws from the pin -- same record a drag FROM the pin would leave.
  // A gate target has no properties bag; its record lives in graph.extra.
  const after = graph.state?.lastLinkId ?? 0;
  for (let id = before + 1; id <= after; id++) {
    const link = graph.getLink ? graph.getLink(id) : graph._links?.get?.(id);
    if (!link) continue;
    // Stitch segments draw honestly -- the reroute at the drop point already
    // tells the story, and pin provenance on machinery would relocate it.
    if (isStitch(nodeFromId(graph, link.origin_id))) continue;
    if (link.targetIsIoNode ?? String(link.target_id) === "-20") {
      recordGateProvenance(graph, link, host, index);
      continue;
    }
    const target = nodeFromId(graph, link.target_id);
    if (isStitch(target)) continue;
    if (target?.properties) recordProvenance(target, link.target_slot, host, index, link.id);
  }
  invalidate();
  graph.setDirtyCanvas(true, true);
  lc.__cablemanagementPinDone = true;
  // Consume the drag: the Vue finish still runs AFTER this seam and would hand
  // the same render links to its snapped candidate -- the node-hover implied
  // connection to the first unoccupied matching output -- which would connect
  // again and REPLACE the pin link (an input holds one link; measured: the
  // implied connection always won on hosts with a matching output). An empty
  // renderLinks makes every later stage a no-op; reset clears it anyway.
  lc.renderLinks.length = 0;
  return true;
}

/**
 * The Vue seam. Vue slot drags never consult the link connector for drops on
 * node DOM: connectByPriority tries slot/reroute candidates, then dropOnCanvas
 * ONLY when the drop target is the canvas element -- a drop on a pin over a
 * node's DOM simply dies. This window-CAPTURE pointerup runs before the Vue
 * handler (per-gesture listeners register later than us). Legacy drags never
 * reach it (core's boot-time window-capture up handler stops propagation for
 * gestures it owns) -- those come through the dropOnNothing / dropOnNode wraps
 * instead; the __cablemanagementPinDone latch keeps the seams from double-connecting.
 */
export function installPinDrops(app) {
  window.addEventListener(
    "pointerup",
    (e) => {
      if (e.button !== 0) return;
      const lc = app.canvas?.linkConnector;
      if (!lc?.isConnecting) return;
      try {
        // Pin self-drop guard (audit 2g): a pin drag released on its own
        // HOST's body. Core treats same-node loopback as a strict no-op; the
        // replayed drag's true origin differs from the host, so core's guard
        // never fires and the implied body-connect would tear down and
        // RECREATE the host's own feed -- link-id churn, and a silently
        // orphaned reroute when the feed was threaded. Aiming at a specific
        // slot DOT still connects (slot resolution outranks the body); only
        // the implied body drop is consumed.
        const pin = lc.state?.connectingTo === "input" ? pendingPin?.() : null;
        if (pin && lc.renderLinks.length) {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          const nodeEl = el?.closest?.("[data-node-id]");
          if (nodeEl?.dataset?.nodeId === String(pin.host.id)) {
            // A release aimed at a DIFFERENT, type-compatible input dot of the
            // host is a deliberate connect and passes through; anything else
            // on the host -- body, title, widget rows, the pin's own input --
            // is the loopback and gets core's no-op.
            const key =
              el?.closest?.("[data-slot-key]")?.getAttribute?.("data-slot-key") ??
              el
                ?.closest?.(".lg-slot, .lg-node-widget")
                ?.querySelector?.("[data-slot-key]")
                ?.getAttribute?.("data-slot-key");
            const m = key && /^(.+)-in-(\d+)$/.exec(key);
            const idx = m ? +m[2] : null;
            const legit =
              m &&
              idx !== pin.index &&
              typeMatch(pin.host.inputs?.[idx]?.type, lc.renderLinks[0]?.fromSlot?.type);
            if (!legit) {
              lc.renderLinks.length = 0;
              return;
            }
          }
        }
        const c = app.canvas;
        const p = c.convertEventToCanvasOffset?.(e);
        if (!p) return;
        handlePinDrop(app, lc, { canvasX: p[0], canvasY: p[1] });
        // The owning pipeline still runs its own cleanup and resets the
        // connector; with the consumer already connected it finds no candidate.
      } catch (err) {
        console.warn("cablemanagement: pin drop failed", err);
      }
    },
    true
  );

  // Preview magnet. While the cursor sits on a type-matching pin, the Vue drag
  // loop still computes its node-hover implied candidate and writes its slot
  // position into lc.state.snapLinksPos every RAF -- the wire visibly yanks to
  // an output the drop will not use. state is ONE object mutated in place
  // (reset only assigns undefined), so an accessor on snapLinksPos redirects
  // EVERY write -- no race with their RAF. Legacy drags never write the field;
  // the pointermove below feeds them, and clears only its own stale write.
  let lastPt = null;
  const magnet = (lc) => {
    if (!lastPt) return null;
    const graph = activeGraph(app);
    if (!graph) return null;
    const type = lc.renderLinks[0]?.fromSlot?.type;
    // Consumer drags magnetise onto pass-through pins and ribbon out-pins
    // (whichever is closer); source drags onto the ribbon in-pins their drop
    // seam accepts -- always the same predicate as the drop.
    if (lc.state.connectingTo === "output") {
      const pin = pinNear(graph, lastPt[0], lastPt[1], type);
      const out = gateOutNear(graph, lastPt[0], lastPt[1], type);
      if (pin && out) {
        const dPin = Math.hypot(pin.anchor[0] - lastPt[0], pin.anchor[1] - lastPt[1]);
        const dOut = Math.hypot(out.anchor[0] - lastPt[0], out.anchor[1] - lastPt[1]);
        return dPin <= dOut ? pin : out;
      }
      return pin ?? out;
    }
    if (lc.state.connectingTo === "input") return gateInNear(graph, lastPt[0], lastPt[1], type);
    return null;
  };
  const armSnap = (lc) => {
    const st = lc?.state;
    if (!st || Object.getOwnPropertyDescriptor(st, "snapLinksPos")?.get) return;
    let val = st.snapLinksPos;
    Object.defineProperty(st, "snapLinksPos", {
      configurable: true,
      get: () => val,
      set: (v) => {
        const pin = Array.isArray(v) && lc.isConnecting ? magnet(lc) : null;
        if (pin) {
          val = [pin.anchor[0], pin.anchor[1]];
          lc.__cablemanagementMagnetPos = val;
        } else {
          val = v;
        }
      },
    });
  };
  window.addEventListener(
    "pointermove",
    (e) => {
      const lc = app.canvas?.linkConnector;
      if (!lc?.isConnecting) {
        lastPt = null;
        undimPins();
        return;
      }
      try {
        armSnap(lc);
        const p = app.canvas.convertEventToCanvasOffset?.(e);
        lastPt = p ? [p[0], p[1]] : null;
        const pin = magnet(lc);
        if (pin) {
          lc.state.snapLinksPos = [pin.anchor[0], pin.anchor[1]];
        } else if (lc.state.snapLinksPos === lc.__cablemanagementMagnetPos && lc.__cablemanagementMagnetPos) {
          // Only our own stale write is cleared -- a Vue candidate write is
          // theirs to manage (they rewrite next frame anyway).
          lc.state.snapLinksPos = undefined;
          lc.__cablemanagementMagnetPos = null;
        }
        dimPins(lc);
      } catch (err) {
        console.warn("cablemanagement: pin magnet failed", err);
      }
    },
    true
  );
}

/**
 * The dim contract on pass-through pins: while a link drags, core fades every
 * slot the drop cannot use to 40%; a full-brightness pin among dimmed slots
 * reads as a valid target it is not (audit 2g). A pin is usable only by a
 * consumer drag of a matching type; the pin the drag was pulled from stays
 * bright -- it is the source, not a refused target. Re-applied per move (pins
 * re-sync during drags), DOM writes guarded to actual changes.
 */
let pinsDimmed = false;
function dimPins(lc) {
  pinsDimmed = true;
  const to = lc.state?.connectingTo;
  const type = lc.renderLinks[0]?.fromSlot?.type;
  const src = pendingPin?.();
  for (const el of document.querySelectorAll(".cablemanagement-pin")) {
    const own =
      src &&
      String(src.host.id) === el.dataset.cablemanagementNode &&
      String(src.index) === el.dataset.cablemanagementIndex;
    const valid = own || (to === "output" && typeMatch(el.dataset.cablemanagementType, type));
    if (valid) delete el.dataset.cablemanagementDim;
    else if (el.dataset.cablemanagementDim !== "1") el.dataset.cablemanagementDim = "1";
  }
}
export function undimPins() {
  if (!pinsDimmed) return;
  pinsDimmed = false;
  for (const el of document.querySelectorAll(".cablemanagement-pin[data-cablemanagement-dim]")) {
    delete el.dataset.cablemanagementDim;
  }
}

/**
 * The same contract for CORE slots during drags core cannot see -- link drags
 * born on the canvas (tooth pulls) have no Vue drag session, so the composable
 * that dims incompatible slot DOM never runs. Computed once at drag start,
 * exactly like core's own compat map; inline opacity because the Vue store is
 * unreachable from extension land, cleared by undimCoreSlots on gesture end
 * (Vue never writes inline opacity, so there is nothing to fight).
 */
const coreDimmed = new Set();
export function dimCoreSlots(app) {
  const lc = app.canvas?.linkConnector;
  if (!lc?.isConnecting || !lc.renderLinks?.length) return;
  const graph = activeGraph(app);
  if (!graph) return;
  const to = lc.state?.connectingTo;
  const want = to === "input" ? "in" : "out";
  for (const el of document.querySelectorAll("[data-slot-key]")) {
    const m = /^(.+)-(in|out)-(\d+)$/.exec(el.getAttribute("data-slot-key") ?? "");
    if (!m) continue;
    const node = nodeFromId(graph, m[1]);
    if (!node) continue;
    let valid = false;
    if (m[2] === want) {
      const slot = (to === "input" ? node.inputs : node.outputs)?.[+m[3]];
      valid =
        !!slot &&
        lc.renderLinks.some((rl) =>
          to === "input" ? rl.canConnectToInput?.(node, slot) : rl.canConnectToOutput?.(node, slot)
        );
    }
    if (!valid) {
      el.style.opacity = "0.4";
      coreDimmed.add(el);
    }
  }
}
export function undimCoreSlots() {
  for (const el of coreDimmed) el.style.opacity = "";
  coreDimmed.clear();
}
