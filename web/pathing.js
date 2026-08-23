// PATHING -- the "PCB" link render mode. Product spec and landmine ledger: PATHING.md.
//
// Adds a 4th option to Comfy.LinkRenderMode; while it is active, link geometry is
// replaced with orthogonal routed traces (exit right, around obstacles, enter left),
// collinear runs are spread into lanes, and everything else -- hit-testing, centre
// button, arrows, flow dots -- rides the trace because it all derives from the Path2D
// and centrePos we emit. Other render modes are untouched; previews stay core-drawn;
// with the extension disabled a workflow left in PCB mode renders as splines.
//
// Composition with the ledger: the ledger substitutes visual endpoints upstream
// (_renderAllLinkSegments), so routes here are computed from pass-through pin
// positions automatically. No shared prototype methods.
//
// Everything installs lazily -- app.canvas does not exist during setup, and silent
// non-attachment is the canonical failure mode (WGIMCO-NATIVE.md section 0).

import { app } from "../../scripts/app.js";
import { beginFrame, debugRoutes, routeFor, stats } from "./pathing/registry.js";
import { clearOverlay, combAt, drawGates, firstMatchingLane, gestureFloatingEnroll, installApi, toothOf } from "./pathing/combs.js";
import { installGestures } from "./pathing/combgestures.js";
import { installClipboard } from "./pathing/combclipboard.js";
import { emit, pointAt } from "./pathing/trace.js";
import { handlePinDrop, handleGateInDrop, installPinDrops, undimPins, undimCoreSlots } from "./drops.js";
import { activeGraph } from "./graph.js";
import { isEnabled } from "./enabled.js";
import { boundTo } from "./invoke.js";

const state = { patched: false, option: false, PCB: 3 };

function active() {
  // PCB AESTHETICS only -- A* for plain links, decollision, sticking, straightening.
  // Its switch is the LINK RENDER MODE, and nothing else: the node-features toggle
  // (cablemanagement.enabled) governs pins, drawers and the layout, never routing.
  // Other link modes keep their native geometry for everything that is not a ribbon.
  return app.canvas && app.canvas.links_render_mode === state.PCB;
}

function combsOn() {
  // RIBBON MACHINERY -- combPass, gates, gestures, the gate->gate trace -- runs in
  // EVERY link render mode (mixed-modes ruling: ribbons always on; the ribbon's
  // internal run stays PCB-drawn, outer segments follow the native mode) and under
  // EVERY setting: ribbons are what the pack is, so there is no switch that takes
  // them away. Wanting the routing alone is what the standalone pcb pack is for.
  return !!app.canvas;
}

function pickSentinel() {
  // A HIGH fixed base, not first-free-above-3: the persisted Comfy.LinkRenderMode
  // value must keep meaning "PCB" across frontend releases, and core has grown new
  // link modes before. (Sessions that stored the old low sentinel re-pick PCB once.)
  const L = window.LiteGraph;
  const taken = [L.STRAIGHT_LINK, L.LINEAR_LINK, L.SPLINE_LINK, L.HIDDEN_LINK];
  let v = 64;
  while (taken.includes(v)) v++;
  return v;
}

function tryPatch() {
  const c = app.canvas;
  if (!c?.linkRenderer?.pathRenderer) return false;
  state.PCB = pickSentinel();

  const canvasProto = c.constructor.prototype;
  const prProto = Object.getPrototypeOf(c.linkRenderer.pathRenderer);

  const origDrawConnections = canvasProto.drawConnections;
  canvasProto.drawConnections = function (ctx) {
    const on = this === app.canvas;
    // A throw escaping drawConnections leaves core's is_rendering flag stuck and the
    // canvas dead for the session -- same failure class as drawLink below. The comb
    // records are workflow data; nothing they contain may take the render loop down.
    if (on) {
      try {
        beginFrame(this);
      } catch (err) {
        console.warn("cablemanagement combs: beginFrame failed", err);
      }
    }
    const r = origDrawConnections.call(this, ctx);
    // Gates paint over the links so the pin->lane fan stays inside the body;
    // selected gates go to the overlay canvas above the node DOM instead.
    try {
      if (on) drawGates(ctx, this.graph, this);
      else clearOverlay();
    } catch (err) {
      console.warn("cablemanagement combs: gate draw failed", err);
    }
    return r;
  };

  const origDrawLink = prProto.drawLink;
  prProto.drawLink = function (ctx, linkData, context) {
    if (combsOn() && linkData.id !== "temp" && linkData.id !== "dragging") {
      // A throw escaping drawLink KILLS core's render loop permanently (measured:
      // one bad route froze the canvas for the rest of the session). Spline
      // fallback for that link, loudly, and the loop survives.
      try {
        // Outside PCB mode routeFor serves comb crossings only -- the ribbon's
        // gate->gate run stays a trace, everything else renders natively.
        const r = routeFor(app.canvas, linkData, active());
        if (r) {
          linkData.__route = r;
          // Ribbon segments carry no centre marker -- one dot per lane stacked on a
          // dense bundle is pure clutter (design decision). Arrows stay; they read as flow.
          if (r.comb && context?.style?.showCenterMarker) {
            context = { ...context, style: { ...context.style, showCenterMarker: false } };
          }
        }
      } catch (err) {
        console.warn("cablemanagement pathing: route failed for link", linkData.id, err);
      }
    }
    return origDrawLink.call(this, ctx, linkData, context);
  };

  const origDrawLinkPath = prProto.drawLinkPath;
  prProto.drawLinkPath = function (ctx, path, link, context, lineWidth, color) {
    if (!link.__route) return origDrawLinkPath.call(this, ctx, path, link, context, lineWidth, color);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    emit(path, link.__route.pts);
    ctx.stroke(path);
  };

  const origCentre = prProto.calculateCenterPoint;
  prProto.calculateCenterPoint = function (link, context) {
    if (!link.__route) return origCentre.call(this, link, context);
    // Marker sits at the midpoint of the LONGEST straight run, not the arc-length
    // midpoint -- the arc midpoint can land next to a corner or inside a dense lane
    // stack, where the longest run is the trace's natural label position.
    const pts = link.__route.pts;
    let bi = 1, bl = -1;
    for (let k = 1; k < pts.length; k++) {
      const l = Math.abs(pts[k][0] - pts[k - 1][0]) + Math.abs(pts[k][1] - pts[k - 1][1]);
      if (l > bl) { bl = l; bi = k; }
    }
    const a = pts[bi - 1], b = pts[bi];
    link.centerPos = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
    link.centerAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  };

  const origPoint = prProto.computeConnectionPoint;
  prProto.computeConnectionPoint = function (link, t, context) {
    if (!link.__route) return origPoint.call(this, link, t, context);
    const p = pointAt(link.__route.pts, link.__route.m, t);
    return { x: p.x, y: p.y };
  };


  // Teeth are reroutes functionally, but must not LOOK or hover like them: core's
  // dot + slot-nub rendering fights the gate pins (design decision). Appearance only --
  // hit-testing and dragging stay core's, which the detach gesture rides on.
  const RR = window.LiteGraph?.Reroute;
  if (RR?.prototype?.draw) {
    const origRDraw = RR.prototype.draw;
    const origRSlots = RR.prototype.drawSlots;
    RR.prototype.draw = function (...a) {
      if (combsOn() && toothOf(this.id)) return;
      return origRDraw.apply(this, a);
    };
    RR.prototype.drawSlots = function (...a) {
      if (combsOn() && toothOf(this.id)) return;
      return origRSlots?.apply(this, a);
    };
  }

  state.patched = true;
  installApi(app); // window.__cablemanagementCombs -- programmatic comb surface
  installGestures(app, combsOn);
  return true;
}

// NOT part of tryPatch: none of this touches the path renderer, and gating it on the
// TS-private `pathRenderer` property held pin drop targets and the floating-reroute
// drop repair hostage to a rename in a future frontend. Installs as soon as the
// linkConnector exists, PCB or not.
// A link drag dropped on a gate BODY becomes a new dangling lane (floating link
  // parked in the comb). The one seam BOTH drag pipelines funnel through for empty
  // drops is linkConnector.dropOnNothing: the legacy canvas path reaches it via
  // dropLinks, and the Vue slot-drag path calls it via the adapter's dropOnCanvas
  // -- Vue drags never call dropLinks at all (measured: a dropLinks wrap simply
  // did not fire for pin-initiated drags). Wrapping here also runs BEFORE the
  // 'dropped-on-canvas' dispatch, which cannot be cancelled -- the search-box
  // popover listens without checking defaultPrevented. Node and tooth-pin drops
  // are already resolved upstream in both pipelines; anything reaching this seam
  // over a gate is ours.
function tryDropSeams() {
  const lc = app.canvas?.linkConnector;
  if (!lc) return false;
  if (lc.__cablemanagementDrop) return true;
  if (typeof lc.dropOnNothing !== "function" || typeof lc.dropOnNode !== "function") {
    lc.__cablemanagementDrop = true; // never retry into a TypeError
    console.warn("[cablemanagement] linkConnector drop seams missing; pin drops and gate parking unavailable");
    return true;
  }
  {
    lc.__cablemanagementDrop = true;
    const origDropOnNothing = boundTo(lc.dropOnNothing, lc);
    lc.dropOnNothing = (event) => {
      // The graph ON SCREEN -- app.graph is the root even inside a subgraph, and a
      // root reroute can sit within snap range of subgraph coordinates (positions
      // genuinely overlap after convertToSubgraph): resolving against the root
      // minted cross-graph links that persisted on save.
      const g = activeGraph(app);
      if (event && g) {
        // A throw here wedges the whole interaction (no cleanup, connector stuck
        // connecting) -- degrade to the native drop instead.
        try {
          // A drag the gate-pin handler already consumed must not reach the
          // release menu or core's drop stages -- there is nothing left to drop.
          if (lc.__cablemanagementGateDone) return;
          if (state.patched) {
            // Source drag onto an IN gate pin: connect through that lane (drops.js).
            if (handleGateInDrop(app, lc, event)) return;
            const hit = combAt(g, event.canvasX, event.canvasY);
            // Lane creation lives ONLY on the "+" square below the gate
            // (Barney's design: body drops were opaque and fiddly next to the
            // pins, and core's body-drop gesture means connect-to-pin).
            if (hit && hit.zone === "newlane" && gestureFloatingEnroll(g, lc, hit.comb)) {
              g.setDirtyCanvas(true, true);
              return; // no dispatch -> no search box; caller's cleanup resets the connector
            }
            // Gate BODY = core node-body semantics: connect to the first
            // type-matching pin, synthesized as a drop on that lane's tooth so
            // every tooth contract (re-source, branch, polarity no-op) applies
            // verbatim. No matching lane -> consume for a snap-back, exactly
            // like the dim hint promised.
            if (hit && hit.zone === "body") {
              const type = lc.renderLinks?.[0]?.fromSlot?.type;
              const lane = firstMatchingLane(g, hit.comb, type);
              const to = lc.state?.connectingTo;
              if (lane && hit.which === "in" && to === "input") {
                // Source drag: the in-pin contract, connected manually by
                // handleGateInDrop -- our tooth blinding starves a raw
                // dropOnReroute on IN teeth by design.
                if (handleGateInDrop(app, lc, event, g.reroutes?.get?.(lane.in))) return;
              } else if (lane && hit.which === "out" && to === "output") {
                // Consumer drag: OUT teeth keep findSourceOutput, so core's
                // reroute contract (branch through the lane) works directly.
                const t = g.reroutes?.get?.(lane.out);
                if (t && lc.isRerouteValidDrop?.(t)) {
                  lc.dropOnReroute(t, event);
                  g.setDirtyCanvas(true, true);
                  return;
                }
              }
              lc.renderLinks.length = 0; // refused (polarity/type): snap back
              return;
            }
          }
          // Passthrough pins as drop targets (consumer drags; drops.js). The ONE
          // node feature on this seam, so the toggle is checked here rather than
          // around the whole handler -- everything else here is ribbon machinery.
          if (isEnabled() && handlePinDrop(app, lc, event)) return;
          // ANY reroute at the drop point, resolved from GRAPH truth. The Vue
          // drop path reads layoutStore.queryRerouteAtPoint, and two producers
          // never register there: our teeth (layout() writes pos directly) and
          // core's OWN setReroute -- the connectFloatingReroute path behind the
          // link-release menu's "Add Reroute" (createReroute registers, so
          // regular reroutes work; measured: every drop on a floating reroute
          // fell through to this seam). Core's validity check and reroute-drop
          // semantics do the rest; not PCB-gated, the layout gap is core's.
          let r = null, bd = 12;
          for (const rr of g.reroutes?.values?.() ?? []) {
            const d = Math.hypot(rr.pos[0] - event.canvasX, rr.pos[1] - event.canvasY);
            if (d < bd) { bd = d; r = rr; }
          }
          // Polarity no-op at THIS seam too: Vue tooth-releases funnel here
          // (the blinded Reroute methods starve Vue's direct path), and the
          // empty-canvas fall-through would DISCONNECT a carried link --
          // the ruling says nothing changes, so consume for a snap-back.
          {
            const t = r ? toothOf(r.id) : null;
            const to = lc.state?.connectingTo;
            if (t && ((t.side === "out" && to === "input") || (t.side === "in" && to === "output"))) {
              lc.renderLinks.length = 0;
              return;
            }
          }
          if (r && lc.isRerouteValidDrop?.(r)) {
            lc.dropOnReroute(r, event);
            g.setDirtyCanvas(true, true);
            return;
          }
        } catch (err) {
          console.warn("cablemanagement combs: gate drop failed", err);
        }
        // A link whose live end comes from a subgraph input/output panel cannot be
        // left dangling, parked on a reroute, or offered the release menu -- core has
        // no floating form for io-node links and swallows the drop silently (no
        // search box, no menu, nothing). Everything supported was already resolved
        // above or in the node/panel drop paths; say what happened instead of eating
        // the gesture like core does.
        if ((lc.renderLinks ?? []).some((rl) => rl.isIoNodeLink)) {
          app.extensionManager?.toast?.add?.({
            severity: "warn",
            summary: "Sorry -- ComfyUI can't do that",
            detail:
              "A link from a subgraph input/output panel can't be left dangling or dropped on a reroute. Drop it on a node slot or the opposite panel instead.",
            life: 5000,
          });
        }
      }
      return origDropOnNothing(event);
    };
    // Pins straddle the node's right edge, so a drop on one usually hit-tests as
    // the NODE and never reaches dropOnNothing -- the pin must win first here too.
    const origDropOnNode = boundTo(lc.dropOnNode, lc);
    lc.dropOnNode = (node, event) => {
      if (event && activeGraph(app) && isEnabled()) {
        try {
          if (handlePinDrop(app, lc, event)) return;
        } catch (err) {
          console.warn("cablemanagement: pin drop failed", err);
        }
      }
      return origDropOnNode(node, event);
    };
    // Teeth are reroutes on the pin column, so core's drop pipeline resolves a
    // drop there as dropOnReroute and dropOnNothing never fires -- the gate
    // in-pin handler must intercept this seam as well (measured: output-drags
    // on a live lane's in-pin no-opped, core has no swap-through-reroute).
    if (typeof lc.dropOnReroute === "function") {
      const origDropOnReroute = boundTo(lc.dropOnReroute, lc);
      lc.dropOnReroute = (reroute, event) => {
        if (event && reroute && activeGraph(app)) {
          try {
            if (handleGateInDrop(app, lc, event, reroute)) return;
            // Polarity no-ops (RULING: 'there is no output-to-output drop --
            // output-to-output and input-to-input are noops by force of
            // logic, both for core and for us'). Teeth pose as naked
            // reroutes, and core's reroute drop happily performs chain
            // surgery for a mismatched drag (measured: a destination-seeking
            // drag released on a ribbon.output pin rewrites the tooth's
            // parentId and decomposes the whole comb). Consume instead: the
            // wire snaps back untouched -- reset() restores hidden moved
            // links from its own inputLinks/outputLinks lists, not
            // renderLinks, so emptying renderLinks cancels cleanly.
            const t = toothOf(reroute.id);
            const to = lc.state?.connectingTo;
            if (t && ((t.side === "out" && to === "input") || (t.side === "in" && to === "output"))) {
              lc.renderLinks.length = 0;
              return;
            }
          } catch (err) {
            console.warn("cablemanagement: gate-pin drop failed", err);
          }
        }
        return origDropOnReroute(reroute, event);
      };
    }
    lc.events?.addEventListener?.("reset", () => {
      lc.__cablemanagementPinDone = false;
      lc.__cablemanagementGateDone = false;
      // Gesture over: every dim this drag applied comes off, deterministically
      // (the pointermove fallback only clears once the mouse moves again).
      undimPins();
      undimCoreSlots();
    });
    // Teeth must be OPAQUE to core's reroute-drop resolution. The Vue drop
    // path never reaches the connector seams above: useSlotLinkInteraction
    // resolves the reroute from the layout store (a module singleton we
    // cannot reach) and calls renderLink.connectToReroute* DIRECTLY --
    // measured: a pickup at B.input released on a ribbon.output pin ran
    // rl.connectToRerouteInput(tooth) with no drop* seam firing, rewrote the
    // tooth's parentId, and decomposed the whole comb. Both that path and
    // core's own dropOnReroute/isRerouteValidDrop resolve their targets
    // through two Reroute methods, so the starve happens there:
    //   - findTargetInputs: blind for EVERY tooth. Valid in-pin drops are
    //     handleGateInDrop's business (core's swap would skip provenance and
    //     the donor kill); out-pin destination drops are polarity no-ops.
    //   - findSourceOutput: blind for IN teeth only (source-seeking drops on
    //     ribbon.input are polarity no-ops); OUT teeth keep it -- that is
    //     the working branch/bundle gesture ('B joins the lane's
    //     destinations'), on both the Vue and legacy paths.
    // Starved, Vue falls through to dropOnCanvas -> the wraps above decide.
    // EXEMPTION: a drag's OWN fromReroute resolves normally -- the in-tooth
    // resume/re-feed gesture lands via ToOutputFromRerouteLink.connectToOutput
    // -> _connectOutputToReroute(fromReroute) -> findTargetInputs on the very
    // tooth the drag was pulled from (measured: blinding it broke the re-feed;
    // toothmods s6). Only FOREIGN drags find teeth opaque.
    const ownReroute = (rid) => {
      const lc2 = app.canvas?.linkConnector;
      return !!lc2?.renderLinks?.some?.((rl) => rl.fromReroute?.id === rid);
    };
    const Reroute = window.LiteGraph?.Reroute;
    if (Reroute?.prototype && !Reroute.prototype.__cablemanagementOpaque) {
      Reroute.prototype.__cablemanagementOpaque = true;
      const origTargets = Reroute.prototype.findTargetInputs;
      Reroute.prototype.findTargetInputs = function (...a) {
        if (toothOf(this.id) && !ownReroute(this.id)) return [];
        return origTargets.apply(this, a);
      };
      const origSource = Reroute.prototype.findSourceOutput;
      Reroute.prototype.findSourceOutput = function (...a) {
        if (toothOf(this.id)?.side === "in" && !ownReroute(this.id)) return null;
        return origSource.apply(this, a);
      };
    } else if (!Reroute) {
      console.warn("[cablemanagement] LiteGraph.Reroute missing; tooth drops may fall through to core reroute surgery");
    }
    installPinDrops(app);
  }
  return true;
}

function tryOption() {
  const vueApp = document.querySelector("#vue-app")?.__vue_app__ ?? document.querySelector("#app")?.__vue_app__;
  const pinia = vueApp?.config?.globalProperties?.$pinia;
  if (!pinia?._s) return false;
  for (const [, store] of pinia._s) {
    const bag = store.settingsById ?? store.settings;
    const def = bag?.["Comfy.LinkRenderMode"] ?? bag?.get?.("Comfy.LinkRenderMode");
    if (def && Array.isArray(def.options)) {
      if (!def.options.some((o) => o.value === state.PCB)) {
        def.options.push({ value: state.PCB, text: "PCB" });
      }
      state.option = true;
      return true;
    }
  }
  return false;
}

// The last redraw of a drag happens while the pointer is still down (splines, by
// design); without this, no frame runs after the drop until the next interaction, so
// traces only reappeared once the node was unselected. Capture-phase listener: core's
// own window handlers stopPropagation, which does not silence same-target siblings.
window.addEventListener(
  "pointerup",
  () => {
    if (!combsOn()) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Active graph: the canvas re-registers to the subgraph on entry, so the ROOT
      // graph's setDirtyCanvas reaches no canvas at all from inside one.
      activeGraph(app)?.setDirtyCanvas(false, true);
    }));
  },
  true
);

let patchTries = 0;
const timer = setInterval(() => {
  if (!state.seams) state.seams = tryDropSeams();
  if (!state.clipboard) state.clipboard = installClipboard();
  if (!state.patched) {
    tryPatch();
    // The gate is a TS-private property (linkRenderer.pathRenderer); if a frontend
    // renames it this must say so ONCE instead of failing silently forever.
    if (!state.patched && ++patchTries === 50) {
      console.warn("[cablemanagement] PCB patch points not found on this frontend; routed rendering unavailable");
    }
  }
  if (state.patched && !state.option) tryOption();
  if (state.patched && state.option && state.seams && state.clipboard) clearInterval(timer);
}, 200);

window.__cablemanagementPathing = { state, stats, routes: debugRoutes, PCB: () => state.PCB };
