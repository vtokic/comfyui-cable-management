// Cable Management -- What Goes In Must Come Out.
//
// Every connected input sprouts a pass-through output pin. Drag off it and you get a link
// from whatever actually feeds that input, so a value can be daisy-chained onward without
// routing a second cable back to its source.
//
// Deliberately renderer-agnostic: no __vue_app__, no component patching, no litegraph
// internals. Geometry comes from the DOM, truth comes from the graph. That combination
// survives the canvas -> Vue-nodes migration, which is precisely what killed the previous
// generation of widget-hooking extensions.

import { app } from "../../scripts/app.js";
import { activeGraph, passThroughInputs, nodeFromId } from "./graph.js";
import { clearAll, clearNode, syncNode } from "./pins.js";
import { install as installDrag, attachCanvasEvents } from "./drag.js";
import {
  isOwned,
  ownedIds,
  reapIfUnused,
  mirrorFromHost,
  ensureApplyHook,
  ensureStableSerial,
  ensureConnectGate,
  injectLiterals,
  parkWithHost,
} from "./primitive.js";
import * as ledger from "./ledger.js";
import { build as buildLedger, prune } from "./reanchor.js";
import * as collapse from "./collapse.js";
import { install as installBridge } from "./bridge.js";
import { install as installPaste } from "./paste.js";
import { install as installConvert } from "./convert.js";
import { install as installStitch, reapStitches, stitchIds } from "./stitch.js";
import { install as installUnpack } from "./unpack.js";
import { migrateCoverage } from "./covered.js";
import { isEnabled, setEnabled } from "./enabled.js";
import { setDebugView, debugViewActive } from "./ledger.js";
import { reconcile as routesReconcile, installGhostRender } from "./routes.js";
import { dump as routestoreDump } from "./routestore.js";
import { boundTo } from "./invoke.js";

const SETTING = "cablemanagement.enabled";
const DEBUG_SETTING = "cablemanagement.debug";

let queued = false;
let uninstallDrag = null;

/**
 * Live NODE-FEATURES toggle state for the other modules. The prototype/instance wraps
 * (bridge, paste, convert, stitch, the passthrough drop seams, ledger pass) install once
 * and stay installed; their BODIES consult this so "off" means stock NODES -- no pins,
 * no drawers, no layout, and no machinery left hidden. Routing and ribbons are outside
 * its remit entirely (see enabled.js). The flag lives in enabled.js (a leaf) so no module needs to
 * import index.js for it -- an import cycle here let registerExtension run before
 * drag.js finished evaluating, and a settings store hydrated early enough fired
 * start() into the half-evaluated module (boot TDZ crashes, partial installs).
 */
export { isEnabled } from "./enabled.js";

/** Extensions are served as static files; the stylesheet has to be pulled in by hand. */
function loadStylesheet() {
  const href = new URL("./cablemanagement.css", import.meta.url).href;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/** Rebuild pins for every rendered node. Cheap enough to run on any graph change. */
// The ledger patches LGraphCanvas.prototype, which does not exist until GraphCanvas mounts --
// well after setup() runs. Attempt it on each sync until it takes.
let ledgerReady = false;
function ensureLedger() {
  if (!app.canvas) return;
  attachCanvasEvents();
  // Same late-prototype story as the ledger; both installers are self-guarding no-ops
  // once they take.
  installBridge(app);
  installPaste();
  installConvert();
  installStitch(app);
  installUnpack(app); // backup site; the primary (ungated) install is in setup()
  if (ledgerReady) return;
  if (ledger.install(app, buildLedger)) {
    ledger.watch(app);
    ledgerReady = true;
  } else if (app.canvas.constructor?.prototype) {
    // Present but unpatchable (true ES private on older frontends): stop retrying.
    ledgerReady = true;
    console.warn("[cablemanagement] link re-anchoring unavailable on this frontend; links draw from their true endpoints");
  }
}

let syncCount = 0; // QA/diagnostics: how often the full pass actually runs
let warnedLegacy = false;

function sync() {
  queued = false;
  if (!isEnabled()) return; // before ensureLedger: no wraps get installed while off
  syncCount++;
  ensureWheel();
  ensureLedger();
  // Resolve against the graph on screen, not app.graph -- inside a subgraph they differ.
  const graph = activeGraph(app);
  if (!graph) return;
  // Legacy (non-Vue) nodes mode: the DOM this extension is built from does not exist,
  // but the graph passes below would still run -- parking primitives back onto hosts
  // and healing stitches in a session that renders them as ordinary nodes ("haunted",
  // and it contradicts the README's idle promise). No node DOM -> fully inert.
  // Queue-time literal delivery stays live via the graphToPrompt wrap regardless.
  if ((graph.nodes?.length ?? 0) > 0 && !document.querySelector(".lg-node")) {
    if (!warnedLegacy) {
      warnedLegacy = true;
      console.warn("[cablemanagement] Vue nodes mode (Nodes 2.0) is off -- node modifications idle; PCB routing and ribbons stay active");
    }
    return;
  }

  // Primitives we created are an implementation detail of a widget's pass-through pin, so
  // they are hidden -- but with `visibility`, not `display`. A display:none node has no box,
  // its slot rect stops being measurable, core drops the slot from its layout store and
  // links snap back to litegraph's default anchors. `visibility:hidden` keeps the geometry
  // intact and merely stops it painting. Parked inside the host's footprint, the primitive's
  // own wire is occluded by the host, since links draw beneath the DOM node layer.
  // Coverage transitions on hosted widget inputs, both directions: a landing link
  // makes the primitive's literal stale (migrate consumers to the live origin); a
  // removed link makes the literal the truth again (revert dependents to the
  // primitive). BEFORE anything mirrors or reaps.
  migrateCoverage(graph);
  const owned = ownedIds(graph);
  reapOrphans(graph);
  reapStitches(graph);
  // Stitch reroutes get the same invisibility treatment as owned primitives.
  for (const id of stitchIds(graph)) owned.add(id);
  prune(graph);
  // Route reconciliation (2e): honest sever / re-source / re-materialize. The
  // rAF sync is the backstop for programmatic edits; gesture edits are caught
  // synchronously by ensureRoutesEvents so they share the gesture's undo step.
  installGhostRender(app);
  ensureRoutesEvents();
  ensureTrackerWrap();
  routesReconcile(app, graph);

  for (const nodeEl of document.querySelectorAll(".lg-node[data-node-id]")) {
    const id = nodeEl.dataset.nodeId;

    if (owned.has(id)) {
      // Debug view: machinery stays visible as a ghost -- see it, never touch
      // it. Both branches keep re-asserting their style so toggling the view
      // converges on the next sync pass without extra bookkeeping.
      const ghost = debugViewActive();
      nodeEl.dataset.cablemanagementHidden = "1";
      nodeEl.style.visibility = ghost ? "" : "hidden";
      nodeEl.style.opacity = ghost ? "0.35" : "";
      nodeEl.style.pointerEvents = "none";
      clearNode(nodeEl);
      continue;
    }
    // A primitive that stops being ours (extension disabled, user adopted it) must go back
    // to being an ordinary visible node.
    if (nodeEl.dataset.cablemanagementHidden === "1") {
      delete nodeEl.dataset.cablemanagementHidden;
      nodeEl.style.visibility = "";
      nodeEl.style.opacity = "";
      nodeEl.style.pointerEvents = "";
    }

    const node = nodeFromId(graph, id);
    if (!node) {
      clearNode(nodeEl);
      collapse.clearNode(nodeEl);
      continue;
    }

    // A collapsed node keeps its pins -- stacked into a single point beside the title bar,
    // mirroring how core stacks the node's own slots when collapsed. They stay mounted so
    // ledger wires still resolve to them and follow the node while it is dragged.
    const isCollapsed = nodeEl.dataset.collapsed === "true";
    // Put back a size the loader clamped BEFORE collapse.syncNode runs: its re-measure
    // nudge adjusts size relative to whatever it finds, so the restore must land first.
    // The collapse styling follows in this same synchronous pass -- by the time anything
    // measures, the rows are folded and the small size sticks.
    const savedSize = sizeRestore.get(id);
    // Bare-id keyed: a subgraph-inner node can share the id of the root node the size
    // was stashed for -- only the node that actually carries a collapsed drawer may
    // consume it.
    const drawers = node.properties?.["cablemanagement.drawers"];
    if (savedSize && (drawers?.inputs || drawers?.outputs)) {
      sizeRestore.delete(id);
      if (typeof node.setSize === "function") node.setSize([...savedSize]);
      else {
        node.size[0] = savedSize[0];
        node.size[1] = savedSize[1];
      }
      graph.setDirtyCanvas(true, true);
    }

    // Collapse styling first, pins second: pin anchors are MEASURED from the rows, so the
    // drawer's dataset (and its row-hiding CSS) must be in effect before measuring.
    // One slot-element scan per node, shared by drawers and pins -- per-slot attribute
    // queries were the sync pass's dominant cost at scale.
    const slotEls = new Map();
    for (const el of nodeEl.querySelectorAll("[data-slot-key]")) {
      slotEls.set(el.getAttribute("data-slot-key"), el);
    }
    const passThroughs = passThroughInputs(graph, node);
    if (isCollapsed) collapse.clearNode(nodeEl);
    else collapse.syncNode(nodeEl, id, node, app.canvas?.ds?.scale || 1, slotEls);
    syncNode(app, nodeEl, id, passThroughs, isCollapsed, slotEls);
    // Whatever an owned primitive drives has a dead control on the host; put a live one
    // back over it so the value stays editable in the place it appears to live.
  }
}

/** Drop owned primitives whose last consumer went away. */
function reapOrphans(graph) {
  let owned = 0;
  for (const node of [...(graph?.nodes ?? [])]) {
    if (!isOwned(node)) continue;
    if (reapIfUnused(graph, node)) continue;
    owned++;
    // The host's widget is the source of truth; the primitive only republishes it.
    mirrorFromHost(graph, node);
    ensureApplyHook(graph, node);
    ensureStableSerial(graph, node); // configure-parity widgets (redo-queue survival)
    ensureConnectGate(node); // primitives loaded from a saved workflow need it too
    parkWithHost(graph, node); // follow a dragged host; honest draws start somewhere sane
  }
  // The second half of serialize idempotency: a primitive is always created AFTER
  // its consumers, so live node `order` values (assigned at add time) disagree
  // with what configure() recomputes from topology -- same redo-wiping drift as
  // the widget set. Realign whenever machinery is present.
  if (owned) graph.updateExecutionOrder?.();
}

/**
 * Route reconciliation must run in the SAME STACK as the gesture that changed the
 * links, or its severs/reconnects land in a separate undo step from the user's own
 * edit. The link connector's events fire synchronously at gesture end; reconcile()
 * itself skips while a drag is still in flight, and the rAF sync pass remains the
 * backstop for anything these events miss.
 */
let routesLc = null;
function ensureRoutesEvents() {
  const lc = app.canvas?.linkConnector?.events;
  if (!lc || lc === routesLc) return;
  routesLc = lc;
  const run = () => {
    if (isEnabled()) routesReconcile(app, activeGraph(app));
  };
  for (const ev of ["link-created", "input-moved", "output-moved", "after-drop-links", "reset"]) {
    lc.addEventListener?.(ev, run);
  }
}

/**
 * Undo-step atomicity BY CONSTRUCTION: reconcile immediately before the change
 * tracker captures, so every state it records is post-reconciliation -- no undo
 * step can ever land on a cut-but-not-yet-severed graph (which reconcile would
 * instantly re-mutate, wiping redo and fighting the user). Skipped during
 * undo/redo restore itself: restored states were captured reconciled.
 */
let trackerWrapped = false;
function ensureTrackerWrap() {
  if (trackerWrapped) return;
  const proto = app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.constructor?.prototype;
  if (!proto || typeof proto.captureCanvasState !== "function") return;
  const orig = proto.captureCanvasState;
  proto.captureCanvasState = function (...args) {
    try {
      if (!this._restoringState && isEnabled()) routesReconcile(app, activeGraph(app));
    } catch {
      /* the capture itself must never fail */
    }
    return orig.apply(this, args);
  };
  trackerWrapped = true;
}

/** Coalesce the storm of mutations a single graph edit produces into one rebuild. */
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(sync);
}

/**
 * Saved sizes of drawer-collapsed nodes, captured at load time.
 *
 * A collapsed node can be resized below its EXPANDED minimum. On load, core measures the
 * content before this extension has applied the collapse styling, clamps the node up to
 * that expanded minimum, and the saved height is lost. The file holds the truth; stash it
 * here and let the sync loop re-apply it in the same pass that hides the rows -- by the
 * time anything re-measures, the content is short and the size sticks.
 */
const sizeRestore = new Map(); // nodeId -> [w, h], consumed on apply

let origLoadGraphData = null;
function wrapLoadGraphData() {
  if (origLoadGraphData || typeof app.loadGraphData !== "function") return;
  origLoadGraphData = boundTo(app.loadGraphData, app);
  app.loadGraphData = async (graphData, ...rest) => {
    try {
      sizeRestore.clear();
      for (const n of graphData?.nodes ?? []) {
        const d = n?.properties?.["cablemanagement.drawers"];
        const w = n?.size?.[0];
        const h = n?.size?.[1];
        if ((d?.inputs || d?.outputs) && w != null && h != null) {
          sizeRestore.set(String(n.id), [w, h]);
        }
      }
    } catch {
      /* a malformed workflow should fail in core's loader, not here */
    }
    return origLoadGraphData(graphData, ...rest);
  };
}

let origGraphToPrompt = null;
/**
 * A plain input fed by an owned primitive gets its literal at prompt build -- core's
 * value-copy machinery only writes into widgets, and the link from a virtual node
 * resolves to nothing. Wrapped once; never unwrapped (a no-op without owned primitives).
 */
function wrapGraphToPrompt() {
  if (origGraphToPrompt || typeof app.graphToPrompt !== "function") return;
  origGraphToPrompt = boundTo(app.graphToPrompt, app);
  app.graphToPrompt = async (...args) => {
    const res = await origGraphToPrompt(...args);
    try {
      // Gated on the toggle so "off" is a faithful uninstall preview: a queue that
      // only works through this injection should fail here exactly as it would for
      // a receiver without the extension.
      if (isEnabled()) injectLiterals(res?.output, app.graph);
    } catch {
      /* never break queueing over a cosmetic-value injection */
    }
    return res;
  };
}

let observer = null;
let wheelTarget = null;

function start() {
  if (uninstallDrag) return;
  loadStylesheet();
  // The outputs-at-bottom restyle is one class on <body>; all of it lives in the
  // stylesheet. Not togglable: pass-through pins need the right edge of every input
  // and widget row, which is exactly what this layout frees.
  document.body.classList.add("cablemanagement-layout");
  window.__cablemanagement = {
    ledger: () => ledger.debug(),
    sync,
    syncs: () => syncCount,
    // Runtime-only toggle for the harness -- no settings write, no persistence.
    debugView: (v) => {
      setDebugView(v === true);
      app.graph?.setDirtyCanvas?.(true, true);
      window.dispatchEvent(new CustomEvent("cablemanagement:resync"));
    },
    // Harness access to one explicit route reconciliation (normally event-driven).
    routesPass: () => {
      const r = routesReconcile(app, activeGraph(app));
      app.graph?.setDirtyCanvas?.(true, true);
      return r;
    },
    // The v1 route registry, for the harness: dump adapts legacy keys on
    // sight, so calling it on a graph-shaped object IS the adapter.
    routes: routestoreDump,
  };
  uninstallDrag = installDrag(app);
  wrapGraphToPrompt();
  wrapLoadGraphData();

  // The node layer is re-rendered by Vue on every meaningful change -- link made or broken,
  // node added, subgraph entered, workflow loaded. Watching the DOM catches all of it
  // without knowing which store or event was responsible. STYLE is the exception: node
  // drags (transform on the .lg-node itself) and pan/zoom (panes, minimap) rewrite style
  // attributes EVERY FRAME, and a full pass per frame is the difference between 60fps and
  // jank on dense graphs. Those write OUTSIDE node interiors; style changes INSIDE a node
  // (widget growth, textarea resize) move rows with no other watched mutation and still
  // count. Gesture ends re-sync via pointerup (primitive parking, pin re-measure), zoom
  // via wheel.
  const relevant = (records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.attributeName === "style") {
        const t = r.target;
        if (!(t instanceof Element)) continue;
        if (t.classList.contains("lg-node")) continue; // drag transform, per frame
        if (!t.closest(".lg-node")) continue; // panes, minimap, overlays
      }
      return true;
    }
    return false;
  };
  observer = new MutationObserver((records) => {
    if (relevant(records)) schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-node-id", "data-slot-key", "data-collapsed", "style"],
  });

  // Pan and zoom move rows without mutating them; drags settle on release. The wheel
  // listener may miss here (app.canvas is often null this early); ensureWheel retries
  // from the sync loop until the canvas exists.
  ensureWheel();
  window.addEventListener("pointerup", schedule, true);
  window.addEventListener("resize", schedule);
  window.addEventListener("cablemanagement:resync", schedule);

  ledger.setActive(true);
  schedule();
}

/** Attach the zoom re-sync once the canvas element exists; retried per sync. */
function ensureWheel() {
  const c = app.canvas?.canvas;
  if (!c || c === wheelTarget) return;
  wheelTarget?.removeEventListener?.("wheel", schedule);
  c.addEventListener("wheel", schedule, { passive: true });
  wheelTarget = c;
}

function stop() {
  uninstallDrag?.();
  uninstallDrag = null;
  document.body.classList.remove("cablemanagement-layout");
  // Every watcher the toggle installed comes back out, or each off/on cycle stacks a
  // fresh MutationObserver over the whole body.
  observer?.disconnect();
  observer = null;
  wheelTarget?.removeEventListener?.("wheel", schedule);
  wheelTarget = null;
  window.removeEventListener("pointerup", schedule, true);
  window.removeEventListener("resize", schedule);
  window.removeEventListener("cablemanagement:resync", schedule);
  // The ledger's prototype patches stay (unpatchable once shared), but the pass goes
  // honest: no re-anchoring, no SUPPRESS -- a stitch's inbound gate wire must not stay
  // invisible while the extension claims to be off.
  ledger.setActive(false);
  clearAll();
  collapse.clearAll();
  // Hidden primitives must not stay invisible once we are no longer managing them.
  for (const el of document.querySelectorAll('.lg-node[data-cablemanagement-hidden="1"]')) {
    delete el.dataset.cablemanagementHidden;
    el.style.visibility = "";
    el.style.opacity = "";
    el.style.pointerEvents = "";
  }
}

app.registerExtension({
  name: "cablemanagement",

  settings: [
    {
      id: SETTING,
      // Deliberately filed next to Comfy.LinkRenderMode (LiteGraph > Graph), not under
      // a Cable Management section -- cable management controls belong together.
      category: ["LiteGraph", "Graph", "Cable Management"],
      name: "Cable Management node features (req. Nodes 2.0)",
      tooltip:
        "Pass-through pins, collapsible input/output drawers, and the outputs-at-bottom " +
        'layout. "Off" returns nodes to stock rendering; hidden pass-through primitives ' +
        "become ordinary visible nodes. Requires Nodes 2.0 (Modern Node Design); PCB " +
        "routing and ribbons work without it.",
      type: "boolean",
      defaultValue: true,
      // Grayed out -- not force-written -- in legacy sessions: the stored preference
      // must survive a Nodes 2.0 round-trip, and the boot gate already no-ops the
      // features regardless of the value. The getter runs each time the settings
      // panel renders the row (FormItem spreads attrs), so the state is fresh on
      // panel open; a mode flip while the dialog stays open won't re-gray until
      // the row re-renders. Setting read, not .lg-node DOM: an empty graph has no
      // node DOM in either mode.
      attrs: {
        get disabled() {
          return app.extensionManager?.setting?.get("Comfy.VueNodes.Enabled") === false;
        },
      },
      onChange: (value) => {
        setEnabled(value !== false);
        isEnabled() ? start() : stop();
      },
    },
    {
      id: DEBUG_SETTING,
      // Same section as the master toggle -- "a checkbox next to it".
      category: ["LiteGraph", "Graph", "Cable Management Debug"],
      name: "Cable Management debug view",
      tooltip:
        "Show the truth under the illusion: every re-anchored or suppressed link " +
        "also draws its REAL wire as a faint dashed spline, and hidden machinery " +
        "nodes appear as untouchable ghosts.",
      type: "boolean",
      defaultValue: false,
      onChange: (value) => {
        setDebugView(value === true);
        app.graph?.setDirtyCanvas?.(true, true);
        window.dispatchEvent(new CustomEvent("cablemanagement:resync")); // ghost pass
      },
    },
  ],

  async setup() {
    // Deliberately OUTSIDE the enabled gate: unpack record translation repairs
    // serialised data, not rendering -- a disabled extension must not lose a
    // workflow's machinery to an unpack either.
    installUnpack(app);
    setEnabled(app.extensionManager?.setting?.get(SETTING) !== false);
    setDebugView(app.extensionManager?.setting?.get(DEBUG_SETTING) === true);
    if (isEnabled()) start();
  },
});
