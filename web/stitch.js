// Gate-to-gate stitching -- branded core Reroute nodes as invisible carriers.
//
// Core cannot link the input gate to the output gate: the connect API throws
// 'Not implemented' in BOTH directions (ToInputFromIoNodeLink.connectToSubgraphOutput,
// ToOutputFromIoNodeLink.connectToSubgraphInput), and execution flattening cannot
// resolve a gate-origin link feeding a gate target. But core's VIRTUAL Reroute node
// between them satisfies both layers: it is a real inner node for the connect API
// (gate->node and node->gate are both legal), and the flattener erases it -- virtual
// resolution follows the node's own input link, and the gate-origin case lands in
// resolveInput's "up and out" branch (measured: an outer consumer resolves to the
// true outer origin through inGate -> Reroute -> outGate).
//
// Treatment mirrors the owned primitives (same design rule): core functionality
// hijacked, never modified. The Reroutes Cable Management creates are BRANDED and INVISIBLE,
// and cablemanagement takes responsibility for adding and reaping them; unbranded Reroutes
// belong to comfy and the user and are never touched. Remove cablemanagement and the branding
// is one unread property on an ordinary visible Reroute -- the workflow works as-is.

import { activeGraph, nodeById } from "./graph.js";
import { invalidate } from "./ledger.js";
import { recordProvenance, recordGateProvenance } from "./reanchor.js";
import { isEnabled } from "./enabled.js";
import { boundTo, linkSlots } from "./invoke.js";

const STITCH = "cablemanagement.stitch";
const STITCH_FROM = "cablemanagement.stitchFrom"; // [hostId, hostIndex] -- the pin the gesture came from

export function isStitch(node) {
  return node?.type === "Reroute" && node.properties?.[STITCH] === true;
}

/** Ids of branded stitch reroutes, for the same hide treatment as owned primitives. */
export function stitchIds(graph) {
  const ids = new Set();
  for (const n of graph?.nodes ?? []) if (isStitch(n)) ids.add(String(n.id));
  return ids;
}

/**
 * Resolve a gate slot to a CONCRETE one, creating it when the gesture used the
 * "empty" (+) slot -- typed and named after the opposite side when it has one.
 */
function concreteSlot(graph, side, slot, other) {
  const io = side === "in" ? graph.inputNode : graph.outputNode;
  if (slot && slot !== io.emptySlot) return slot;
  const type = String(other?.type ?? "*");
  const base = String(other?.name || type);
  const existing = new Set((side === "in" ? graph.inputs : graph.outputs).map((s) => s.name));
  let name = base;
  for (let i = 2; existing.has(name); i++) name = `${base}_${i}`;
  if (side === "in") {
    graph.addInput(name, type);
    return graph.inputs.at(-1);
  }
  graph.addOutput(name, type);
  return graph.outputs.at(-1);
}

/**
 * Bridge inSlot (SubgraphInput) to outSlot (SubgraphOutput) through a branded
 * Reroute parked at the drop point. Either slot may be the gate's empty slot.
 * `from` = [hostId, hostIndex] when the gesture came from a pass-through pin --
 * recorded on the reroute so the segments draw with the primitive treatment
 * (out-segment re-anchored onto the pin, in-segment suppressed; see reanchor.js).
 * Returns the reroute, or null with the graph untouched.
 */
export function stitchGates(graph, inSlot, outSlot, x, y, from) {
  const L = window.LiteGraph;
  if (!graph?.inputNode || !graph.outputNode) return null;
  const cin = concreteSlot(graph, "in", inSlot, outSlot !== graph.outputNode.emptySlot ? outSlot : null);
  const cout = concreteSlot(graph, "out", outSlot, cin);
  const R = L?.createNode?.("Reroute");
  if (!cin?.connect || !cout?.connect || !R) return null;
  R.pos = [x ?? 0, y ?? 0];
  graph.add(R);
  R.properties[STITCH] = true;
  if (from) R.properties[STITCH_FROM] = [String(from[0]), from[1]];
  const a = linkSlots(cin, R.inputs[0], R);
  const b = linkSlots(cout, R.outputs[0], R);
  if (!a || !b) {
    try {
      graph.remove(R);
    } catch {
      /* leave it for the reaper rather than throw mid-gesture */
    }
    return null;
  }
  invalidate();
  graph.setDirtyCanvas(true, true);
  return R;
}

const fromInGate = (l) => l?.originIsIoNode ?? String(l?.origin_id) === "-10";
const toOutGate = (l) => l?.targetIsIoNode ?? String(l?.target_id) === "-20";

/**
 * A stitch's job is strictly gate-to-gate. Unpacking a subgraph (or any rewire)
 * can leave one carrying an ordinary connection -- an invisible node kinking a
 * real wire. Such segments are legal DIRECT links now: heal each one
 * origin-to-target, and the unbridged leftover is machinery with no job: remove it.
 */
export function reapStitches(graph) {
  const getLink = (id) => (graph.getLink ? graph.getLink(id) : graph._links?.get?.(id));
  for (const n of [...(graph?.nodes ?? [])]) {
    if (!isStitch(n)) continue;
    const inLink = n.inputs?.[0]?.link != null ? getLink(n.inputs[0].link) : null;
    if (inLink) {
      for (const lid of [...(n.outputs?.[0]?.links ?? [])]) {
        const out = getLink(lid);
        if (!out || (fromInGate(inLink) && toOutGate(out))) continue; // a proper stitch segment
        try {
          healSegment(graph, n, inLink, out);
        } catch {
          /* leave that segment as it lies */
        }
      }
    }
    const bridged = n.inputs?.[0]?.link != null && (n.outputs?.[0]?.links?.length ?? 0) > 0;
    if (!bridged) {
      try {
        graph.remove(n);
      } catch {
        /* next sync retries */
      }
    }
  }
}

/** Reconnect one stitched segment directly, bypassing the stitch. Core's connect
 *  calls replace the occupied slots, detaching the stitch's own links as they go;
 *  the pin picture carries over while the recorded pin host is still around. */
function healSegment(graph, R, inLink, out) {
  const rec = R.properties?.[STITCH_FROM];
  const host = rec ? nodeById(graph, rec[0]) : null;
  if (toOutGate(out)) {
    const outSlot = graph.outputs?.[out.target_slot];
    const O = nodeById(graph, inLink.origin_id);
    const src = O?.outputs?.[inLink.origin_slot];
    const nl = outSlot && src ? linkSlots(outSlot, src, O) : null;
    if (nl && host) recordGateProvenance(graph, nl, host, rec[1]);
    return;
  }
  const T = nodeById(graph, out.target_id);
  if (!T?.inputs?.[out.target_slot]) return;
  let nl = null;
  if (fromInGate(inLink)) {
    T.disconnectInput(out.target_slot);
    nl = linkSlots(graph.inputs?.[inLink.origin_slot], T.inputs[out.target_slot], T) ?? null;
  } else {
    const O = nodeById(graph, inLink.origin_id);
    nl = O ? linkSlots(O, inLink.origin_slot, T, out.target_slot) ?? null : null;
  }
  if (nl && host && T.properties) recordProvenance(T, out.target_slot, host, rec[1], nl.id);
}

/**
 * The gesture seam: core routes every drop on an IO node through
 * linkConnector.dropOnIoNode, and a gate-origin drag (isIoNodeLink) landing on the
 * OPPOSITE gate is exactly the gate-to-gate case that throws. A gesture starts from
 * one place, so gate-origin render links never mix with ordinary ones -- when the
 * stitch case matches, handle the whole drop and skip core's loop entirely.
 * Covers hand-drawn gate drags AND pin drags forwarded to the boundary alike.
 */
export function install(app) {
  const lc = app.canvas?.linkConnector;
  if (!lc || lc.__cablemanagementStitch) return;
  // connectToSubgraphInput EXISTS but throws on this frontend generation; dropOnIoNode
  // itself could drift the same way. A missing method must not turn into a TypeError
  // inside every sync pass -- degrade to stock (gate-to-gate simply unavailable).
  if (typeof lc.dropOnIoNode !== "function") {
    lc.__cablemanagementStitch = true;
    console.warn("[cablemanagement] linkConnector.dropOnIoNode missing; gate-to-gate stitching unavailable");
    return;
  }
  lc.__cablemanagementStitch = true;
  // A boundary-forwarded pin drag looks identical to a hand-drawn gate drag by
  // drop time; drag.js stamps the pin on the connector so the stitch can carry it.
  lc.events?.addEventListener?.("reset", () => {
    lc.__cablemanagementBoundaryPin = null;
  });
  const orig = boundTo(lc.dropOnIoNode, lc);
  lc.dropOnIoNode = (ioNode, event) => {
    if (!isEnabled()) return orig(ioNode, event);
    try {
      const graph = activeGraph(app);
      const to = lc.state?.connectingTo;
      const gateLinks = (lc.renderLinks ?? []).filter((rl) => rl.isIoNodeLink);
      if (graph && gateLinks.length) {
        const from = lc.__cablemanagementBoundaryPin ?? null;
        lc.__cablemanagementBoundaryPin = null;
        if (to === "input" && ioNode === graph.outputNode) {
          const slot = ioNode.getSlotInPosition?.(event.canvasX, event.canvasY);
          if (slot) {
            for (const rl of gateLinks) {
              if (rl.node !== graph.inputNode) continue;
              stitchGates(graph, rl.fromSlot, slot, event.canvasX, event.canvasY, from);
            }
          }
          return;
        }
        if (to === "output" && ioNode === graph.inputNode) {
          const slot = ioNode.getSlotInPosition?.(event.canvasX, event.canvasY);
          if (slot) {
            for (const rl of gateLinks) {
              if (rl.node !== graph.outputNode) continue;
              stitchGates(graph, slot, rl.fromSlot, event.canvasX, event.canvasY, from);
            }
          }
          return;
        }
      }
    } catch (err) {
      console.warn("cablemanagement: gate stitch failed", err);
    }
    return orig(ioNode, event);
  };
}
