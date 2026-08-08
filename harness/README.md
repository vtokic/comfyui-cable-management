# cablemanagement test harness

Playwright scripts (Node, not Bun -- Bun cannot launch Playwright on Windows) that drive a
real browser against a running ComfyUI on 127.0.0.1:8187 (override with the COMFY_URL
env var). Each is standalone:

    node <script>.mjs

Core suite (each prints PASS/FAIL):

- `stress.mjs` -- 8 real workflows x pan/zoom/subgraph/undo; audits pins against the graph
- `wdrop.mjs` / `wvalue.mjs` -- widget pass-through drop + value propagation (incl. the
  edit-then-queue-immediately stale-mirror case)
- `wplain.mjs` -- widget pin onto PLAIN inputs (ShowText forceInput + PreviewAny wildcard),
  incl. prompt literal delivery
- `chained.mjs` -- chained pass-throughs, link and widget flavours, incl. preview anchoring
- `searchbox.mjs` / `searchclick.mjs` -- release-on-empty node search, keyboard and MOUSE
  selection (the mouse path is the one that regressed once)
- `abortretry.mjs` -- Escape out of the search box, then retry the drag
- `reload.mjs` -- save/reload roundtrip + extension-disabled degradation
- `combo.mjs` -- COMBO pass-through between two checkpoint loaders (needs real models)
- `movelink.mjs` -- pick up a re-anchored link at its input end and move it
- `collapsednode.mjs` -- pins collapse to the title point and follow node drags
- `subdrag.mjs` / `subdiag.mjs` -- subgraph-boundary-fed pins (canvas-drawn IO nodes)
- `regin*.mjs` -- pass-through drops onto regular inputs, incl. a sweep over a real workflow
- `delrecon.mjs` -- delete-bridge provenance inheritance (prim-fed and pin-fed deletions)
  plus host deletion reaping the owned primitive
- `copypaste.mjs` -- paste fixup matrix: plain/marquee/shift-paste x widget/input flavours,
  plus undo of a paste
- `pastechain.mjs` -- daisy-chained provenance: paste a whole A ==> C ==> D chain (both
  wires off A's primitive), and delete C mid-chain (provenance retargets to A's pin)
- `pathing-bus.mjs` -- comb buses: spawn a full mirror off a gate's bus pin (head
  promoted with a typed channel table), float-park and tap channels (real links
  riding every segment's teeth), trunk-collapsed gap segments, override at the
  mirror migrating shadowed consumers while upstream keeps the original value,
  sticky channel identity across unplugs, save/reload, override revert (source
  death re-taps riders upstream; user unplugs stay unplugged), decompose
  degradation
- `passcomb.mjs` -- widget passthrough x comb: park on a gate as a floating lane,
  the park survives the next graph-surface press (both reapers count floating links
  as consumers now), out-pin pull completes onto a real input riding the lane teeth,
  host widget value reaches the prompt, parked lane survives serialize/configure
- `pindrop.mjs` -- passthrough pins as drop targets: consumer input-drag onto a
  widget pin (primitive on demand, provenance, pin draw, prompt value) and onto a
  link pin (fed from true origin), source drop still rewires the host input
- `subpass.mjs` -- passthrough x subgraph: pin drop on the OUTPUT GATE draws from the pin
  (gate provenance lives in graph.extra -- the gate has no properties bag; writing one
  crashed), consumer drop on a boundary-origin pin feeds from the input gate slot,
  converting a pin host remaps outside provenance onto the subgraph node's own pin,
  converting a widget-pin host adopts the owned primitive into the set (consumer rides a
  new subgraph output; literal delivered through the boundary at prompt time), and
  GATE-TO-GATE stitches: a branded invisible core Reroute bridges the gates (pin-origin
  drag and hand-drawn drag both; core throws 'Not implemented' unhelped), unbridged
  stitches are reaped, and a stitch stranded mid-wire by subgraph UNPACK is healed to
  a direct link (state-based: any segment not gate-to-gate dissolves). Also the
  COVERAGE passes (general, not subgraph-only): a link
  landing on a hosted widget input migrates the primitive's consumers to the live
  origin (stitch when gate-to-gate) and reaps the stale machinery; dropping the link
  reverts dependents to a rematerialised primitive -- both directions asserted plain
  and in a closed subgraph, plus conversion's widget auto-promotion ending fully live
- `drawerqa.mjs` -- drawers QA round: caret action semantics (down closes, up opens; a
  node with only required inputs grows no inputs caret), collapse drops the node's
  `--node-height` floor to the folded natural height (shrink on collapse, regrow on
  expand) while a manually-enlarged node folds INSIDE its preserved box, no floor
  ratchet from the realign nudge, no enlargement across subgraph enter/exit remounts
  or a true refresh, and required unlinked inputs (`data-cablemanagement-req`) staying visible
  while optional ones fold. Scenario node: LatentCompositeMasked (required
  destination/source + optional mask); drawers/drawers2/impliedconn use it too now --
  KSampler's inputs are all required and no longer collapsible
- `sweep-a.mjs` .. `sweep-m.mjs` -- the passthrough x reroute/ribbon interaction
  sweep (see SWEEP.md for the cell matrix, the two bugs it caught -- core's
  phantom floatingLinkIds seed and the redo-wiping serialize drift -- and the
  invariants every cell asserts). All 13 green post-fix; run any of them
  standalone like the rest of the suite
- `movecomb.mjs` -- per-end ledger substitution (QA find): repositioning a combed
  passthrough link by its INPUT end must keep the chain's entry segment on the
  passthrough pin mid-drag (only the LOOSE end follows the pointer; dropping the
  whole entry drew it from the hidden primitive), sibling lane untouched, no
  route minted from the true origin, anchor restored on drop
- `dragsnap.mjs` -- preview snap for canvas-born link drags (QA find): the Vue
  drag session that drives snapLinksPos only serves drags started on slot DOM, so
  a pull from a floating reroute's slot nub never snapped and the comb out-tooth
  pull froze over node DOM (graph_mouse only updates over the canvas). The
  gesture layer drives snapLinksPos itself: pin hover, node-body hover (first
  compatible slot, free preferred), and both release paths still connect
- `floatdrag.mjs` -- ledger drag-guard membership (QA find): a passthrough-anchored
  floating link must STAY pin-anchored while an unrelated link drag is live (core
  stamps `_dragging` on every output-attached float as a style flag, and a global
  isConnecting check made every drag snap every float to its true origin); also
  asserts the pin anchor before and after the drag
- `passfloat.mjs` -- passthrough x floating reroutes: drops onto floats connect via
  the graph-truth belt (setReroute never registers the layout store), floats draw
  from the passthrough pin (floatfrom record on the chain's reroute + the
  _dragging-style-flag fix), completions inherit pin provenance. NOTE:
  Comfy.LinkRelease.Action is SERVER-side and shared with the user's browser; it is
  'context menu' by decree (Barney) and passfloat/abortretry pin it at startup

Pathing suite (PCB link render mode -- see PATHING.md):

- `pathing-milestone.mjs` -- backward link exits right / enters left / zero crossings,
  plus the stacked-chain scenario; screenshots to cablemanagement-screenshots/
- `pathing-lanes.mjs` -- collinear-overlap nudge (overlaps = 0) + collapsed fan-out
  (unique first-turn lanes)
- `pathing-fixes.mjs` -- anti-braid (3 same-order links, 0 crossings), reroute
  enter-left/exit-right, route-refresh after drag drop while still selected
- `pathing-furniture.mjs` -- centre button on trace + menu opens, arrows/flow on trace
- `pathing-ledger.mjs` -- pass-through pin link routes from the PIN position (ledger
  endpoint substitution composes with routing)
- `pathing-adjacent.mjs` -- side-by-side loader/controller pairs (Barney's screenshot),
  crossing detail per arrangement
- `pathing-braids.mjs` -- Barney's exact braid workflow (user/default/workflows/braids.json),
  crossing count + screenshot
- `pathing-overlapgate.mjs` -- decollide gating rules: same-lane runs with disjoint
  longitudinal spans stay untouched; near-aligned pins with a crowder inside the 16px
  clearance route inside the pin band instead of detouring
- `pathing-nudge-unit.mjs` -- pure-node unit test (no browser) of the pairwise collision
  rule: bridge segments must not merge spaced strands; real collisions spread;
  sequential touching spans stay put; obstacle-aware bias (polish round): a fan
  beside a node box shifts clear of it, a narrow corridor centres the fan
- `pathing-gapbias.mjs` -- the obstacle bias end-to-end: five links forced through a
  60px gap between stacked blockers cluster on one lane; the fan must stay inside
  the gap, clear of both boxes, on distinct lanes
- `pathing-combcaret.mjs` -- gate flow carets: IN points pins->ribbon, OUT
  ribbon->pins, and a flip flips the caret (asserted by sampling overlay pixels
  around the two candidate apex points)
- `pathing-combtheme.mjs` -- theme parity: stamping sentinel values into
  LiteGraph.NODE_DEFAULT_BGCOLOR / NODE_TITLE_COLOR repaints the gate body and
  caret (gates read the palette constants at draw time, no invented colours)
- `pathing-stubrank.mjs` -- per-node-side lane allocation: up-benders nest
  topmost-closest, down-benders one lane beyond, bottommost-closest; exact stub
  lengths (24/29/34/39 at the 5px STUB_PITCH) and zero crossings among a
  KSampler's four entries
- `pathing-reroutedir.mjs` -- reroute direction rule: wire enters a dot from its
  upstream's side, exits opposite (arrival sign == departure sign); forward,
  backward, and vertical-drop chains (the last tie-breaks by downstream)
- `pathing-combs.mjs` -- comb PoC (PATHING.md section 9): enrollment chain order,
  5px ribbon pitch (3 stroke + 2 gap) with insertion order preserved, lane add,
  template routes around a corridor blocker, serialize/configure revival,
  auto-decompose below two lanes, short-ribbon direct seam (touching gates and
  offset gap stay inside the gate box -- no horseshoe wrap)
- `toggle.mjs` -- master-toggle lifecycle: OFF makes the hidden primitive visible,
  removes pins, empties the ledger (no re-anchoring or SUPPRESS while off) and stops
  sync passes; ON restores all of it; drawer carets stay live across undo (handlers
  resolve the node at click time -- undo replaces instances while Vue reuses the DOM).
  NOTE: the shared server's change tracker holds state across suite runs -- checkpoint
  the built scene before testing undo or Ctrl+Z restores a previous suite's graph
- `gatefloat.mjs` -- gate-origin pin drag released on empty canvas: core cannot float
  io-node links (no release menu, no reroute, silent swallow); the extension fires a
  warn toast instead, graph untouched, connector reset
- `combsub.mjs` -- comb layer x subgraphs (the root-vs-active-graph fix): comb created
  inside a subgraph lands in the SUBGRAPH's extra, gate drag works there, a link
  released over empty subgraph canvas at a ROOT reroute's coordinates does NOT mint a
  cross-graph link (positions genuinely overlap after convertToSubgraph), presses at a
  root gate's coordinates select nothing while inside, and the root comb still works
  after the round trip. NOTE: dismissing the link-release search box with Escape EXITS
  the subgraph -- sequence subgraph-dependent asserts before any Escape
- `pathing-combgest.mjs` -- comb gestures via real mouse: reroute-on-reroute
  create, drop-on-gate enroll, gate body drag (teeth follow), hover-glyph flip,
  in-tooth pull detach, second-to-last pull auto-decompose
- `pathing-combfloat.mjs` -- floating lanes: link drag parked on a gate (both
  directions), dangling lane rides the ribbon, out-pin pull resumes/branches
  (manifold: two links, one tooth), drop on an in-pin completes the lane, and an
  in-pin pull on a source-dangling lane RESUMES the float onto an output instead
  of detaching the lane (polish round)
- `pathing-combsel.mjs` -- gates act as nodes: click/shift-click/clear selection,
  marquee via teeth proxies (purged from core's set), selected gates follow a
  node-group drag, selection bumps the comb to top of z, [del] semantics (one
  gate -> partner decomposes to reroutes; both -> links heal plain; mixed ->
  core still deletes its items; never the "Nothing selected" toast). NOTE: this
  instance is LEGACY nav mode -- marquee is Ctrl+drag, plain drag pans (and
  invalidates any precomputed screen coordinates)
- `pathing-combflip.mjs` -- gate faces are binding: flipped in-gate takes pin
  wires on its right face and wraps the ribbon past its left face; flipped
  out-gate mirrors it (the router's enforced-stub + gates-as-obstacles round)
- `pathing-combrank.mjs` -- gate pins rank like a node side: four up-benders get
  stubs 24/29/34/39 by row, no crossings at the pin side
- `pathing-stress.mjs` -- PCB mode over all real workflows, zero page errors
- `pathing-spike-patchpoints.mjs` / `pathing-spike-postpass.mjs` -- the original
  feasibility spikes (patch-point presence/counters; cull post-pass render)

Suites that CANNOT run on a stock install (they need the author's environment):
stress + pathing-stress + pathing-braids + subdrag/subdiag/regin3 (real workflows),
subpass/wplain/delrecon/copypaste/pastechain (ShowText from pysssss -- these SKIP with
a message), pathing-adjacent/pathing-combrank (the author's node pack), and
passfloat/abortretry (they WRITE the server-side Comfy.LinkRelease.Action setting --
never run them against a baseline you care about). run-battery.sh runs the stock-safe
set and writes battery-results.txt.

The rest are one-off diagnostics kept for reference. Two harness traps that produced false
bug reports: a pin outside the viewport makes elementFromPoint return null (widen the
viewport, don't trust rect.width alone), and picking from the search box recentres the
camera (fresh page per case; raw ds mutation desyncs the Vue layer). A third from the
pathing round: route dumps must filter to the current obstacle version -- stale cache
generations poison overlap/crossing counts. A fourth: routes drawn once from litegraph's
DEFAULT slot positions (before the DOM measure lands) linger as ghost entries for the
liveness grace window -- burn ~6 redraw frames before reading routes, or the dump contains
doubled links and any pin-position math silently uses the wrong twin. A fifth trap, frontend
1.48.6+: the MINIMAP overlays the bottom-right corner (~340x220px, z-1000) -- slot
dots under it are unreachable by mouse and a drag from one silently never starts
(post-down isConnecting stays false). Keep interactive scene points out of the
bottom-right, or the failure looks like a broken gesture. Node positions snap
to the grid on this instance, so scenes needing precise placement must be built at final
coordinates (post-hoc pos writes round away). Playwright now lives in `harness/node_modules`
(ESM ignores NODE_PATH; the import resolves up from the script's own directory).
