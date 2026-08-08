// Comb gesture layer (PATHING.md section 9). Verbs:
//   reroute dropped on a reroute        -> comb is born (two lanes, gates adjacent)
//   reroute dropped on a gate or tooth  -> enroll as the last lane
//   in-tooth pulled away                -> lane detaches, the dot stays free --
//                                          UNLESS the lane dangles at the source
//                                          (floating tip): then the pull is an
//                                          output-seeking link drag that resumes
//                                          the float, mirroring the out-pull
//   out-tooth pulled                    -> NEW LINK drag through the lane (output
//                                          semantics: branch a complete lane,
//                                          resume a dangling one; never moves)
//   gate body dragged                   -> gate moves (teeth follow via combPass)
//   hover glyph clicked                 -> gate flips horizontally
//   bus pin pulled to empty canvas      -> a mirror comb spawns there (bus round)
//   empty out-pin pulled (bussed comb)  -> the channel's driver is spliced through
//                                          as a floating lane and the pull resumes
//                                          it -- core's drag end to end
// Core does all reroute dragging; we only observe presses and interpret drops --
// except the out-pull, which we start (dragFromReroute) and finish (dropLinks +
// reset) ourselves, because core never saw the swallowed pointerdown and its own
// pointer state machine will not fire the drop. Gate-body, glyph, and out-tooth
// presses are swallowed via DOCUMENT capture -- core's own listeners sit on the
// canvas element, and same-target capture runs in registration order, so an
// element-level listener could never preempt them.
import {
  busSpawn, busTapFloat, clearGateSelection, combAt, detachLane, dissolveComb,
  gestureCreate, gestureEnroll, isGateSelected, pinIndexAt, selectGate,
  selectedGates, setBusPreview, setHover, toothOf
} from './combs.js'
// Every graph resolution here must be the graph ON SCREEN -- the root graph is not it
// inside a subgraph, which made all comb gestures dead there and let presses hit-test
// invisible root gates from subgraph coordinates.
import { activeGraph } from '../graph.js'

export function installGestures(app, active) {
  let gateDrag = null // {press: [x,y], gates: [{comb, which, origin}]}
  let press = null // reroute press being core-dragged: {rid, x, y}
  let pullDrag = false // out-tooth pull: we own this link drag end to end
  let busDrag = null // bus-pin pull: {from: comb, press: [x,y]}; release on empty spawns a mirror
  // Link drags born on the CANVAS element (reroute slot pulls, our tooth pulls)
  // have no Vue drag session -- the composable that snaps the preview to a
  // compatible slot and keeps it moving over node DOM only serves drags started
  // on slot DOM. For canvas-born connector drags we drive snapLinksPos ourselves
  // (QA find: float pulls didn't snap; the comb pull's preview froze the moment
  // the pointer entered a node, because graph_mouse only updates over the canvas).
  let canvasPress = false
  // Selected gates follow node-group drags (marquee semantics): a press on a
  // selected NODE arms this; deltas are read off that node's own pos, which works
  // for both the legacy canvas drag and the Vue node drag.
  let follow = null // {refNode, refPos, gates: [{comb, which, origin}]}

  const graphPt = (e) => {
    const c = app.canvas
    if (c?.convertEventToCanvasOffset) {
      const p = c.convertEventToCanvasOffset(e)
      return [p[0], p[1]]
    }
    const r = c.canvas.getBoundingClientRect()
    return [
      (e.clientX - r.left) / c.ds.scale - c.ds.offset[0],
      (e.clientY - r.top) / c.ds.scale - c.ds.offset[1]
    ]
  }

  const rerouteNear = (g, x, y, not) => {
    let best = null, bd = 12
    for (const r of g.reroutes?.values?.() ?? []) {
      if (r === not) continue
      const d = Math.hypot(r.pos[0] - x, r.pos[1] - y)
      if (d < bd) { bd = d; best = r }
    }
    return best
  }

  const elCentre = (el) => {
    const r = el.getBoundingClientRect()
    const c = app.canvas, cr = c.canvas.getBoundingClientRect()
    return [
      (r.x + r.width / 2 - cr.left) / c.ds.scale - c.ds.offset[0],
      (r.y + r.height / 2 - cr.top) / c.ds.scale - c.ds.offset[1]
    ]
  }

  // Snap the in-flight preview like the Vue session would: pin hover snaps to the
  // pin when compatible, node hover snaps to the first compatible slot (free ones
  // preferred), otherwise the preview simply follows the pointer -- which is also
  // what keeps it moving over node DOM. elementsFromPoint, not e.target: core
  // captures the pointer on the canvas element, so targets lie during its drags.
  const driveSnap = (e) => {
    const lc = app.canvas?.linkConnector
    if (!lc?.isConnecting || !lc.renderLinks?.length) return
    const g = activeGraph(app)
    const to = lc.state?.connectingTo
    const want = to === 'input' ? 'in' : 'out'
    const fits = (node, slot) => lc.renderLinks.some((rl) =>
      to === 'input' ? rl.canConnectToInput?.(node, slot) : rl.canConnectToOutput?.(node, slot)
    )
    let slotEl = null, nodeEl = null
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      slotEl ??= el.closest?.('[data-slot-key]')
      nodeEl ??= el.closest?.('[data-node-id]')
      if (nodeEl) break
    }
    let snap = null
    const m = slotEl && /^(.+)-(in|out)-(\d+)$/.exec(slotEl.getAttribute('data-slot-key') ?? '')
    if (m && m[2] === want) {
      const node = g?.getNodeById(m[1]) ?? g?.getNodeById(Number(m[1]))
      const slot = node && (to === 'input' ? node.inputs : node.outputs)?.[+m[3]]
      if (slot && fits(node, slot)) snap = elCentre(slotEl)
    }
    if (!snap && nodeEl) {
      const nid = nodeEl.getAttribute('data-node-id')
      const node = g?.getNodeById(nid) ?? g?.getNodeById(Number(nid))
      const slots = node && (to === 'input' ? node.inputs : node.outputs)
      let pick = -1
      for (let j = 0; slots && j < slots.length; j++) {
        if (!fits(node, slots[j])) continue
        if (pick < 0) pick = j
        const free = to === 'input' ? slots[j].link == null : !slots[j].links?.length
        if (free) { pick = j; break }
      }
      if (pick >= 0) {
        const el = document.querySelector(`[data-slot-key="${node.id}-${want}-${pick}"]`)
        if (el) snap = elCentre(el)
        else {
          const p = node.getConnectionPos(to === 'input', pick)
          if (p) snap = [p[0], p[1]]
        }
      }
    }
    const pt = snap ?? graphPt(e)
    const cur = lc.state.snapLinksPos
    if (!cur || cur[0] !== pt[0] || cur[1] !== pt[1]) {
      lc.state.snapLinksPos = [pt[0], pt[1]]
      g?.setDirtyCanvas(true, true)
    }
  }

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!active() || e.button !== 0) return
      const g = activeGraph(app)
      const canvas = app.canvas
      canvasPress = e.target === canvas?.canvas

      // Presses off the canvas element (node DOM, widgets): keep gate selection
      // only when pressing an already-selected node -- that press starts a group
      // drag the gates must follow. Anything else clears (node semantics).
      if (e.target !== canvas?.canvas) {
        const nodeEl = e.target instanceof Element ? e.target.closest('[data-node-id]') : null
        const nid = nodeEl?.getAttribute('data-node-id')
        const refNode = nid != null
          ? [...(canvas?.selectedItems ?? [])].find(
              (it) => it?.pos && it.size && String(it.id) === String(nid)
            )
          : null
        if (refNode) {
          follow = {
            refNode,
            refPos: [refNode.pos[0], refNode.pos[1]],
            gates: selectedGates(g).map((s) => ({ ...s, origin: [...s.comb[s.which].pos] }))
          }
          if (!follow.gates.length) follow = null
        } else if (!e.shiftKey) {
          clearGateSelection()
          g?.setDirtyCanvas(true, true)
        }
        return
      }

      const [x, y] = graphPt(e)
      const hit = combAt(g, x, y)
      if (hit?.zone === 'bus') {
        // Bus-pin pull (out-gates only): release on empty canvas births a mirror
        // there. In-gate tabs are drop targets, not drag sources -- fall through.
        if (hit.which === 'out') {
          busDrag = { from: hit.comb, press: [x, y] }
          setBusPreview({ from: hit.comb, to: [x, y] })
          g.setDirtyCanvas(true, true)
          e.stopPropagation(); e.preventDefault()
        }
        return
      }
      if (hit?.zone === 'flip') {
        hit.comb[hit.which].pins = hit.comb[hit.which].pins === 'left' ? 'right' : 'left'
        g.setDirtyCanvas(true, true)
        e.stopPropagation(); e.preventDefault()
        return
      }
      if (hit?.zone === 'body') {
        // Node semantics: pressing an unselected gate selects it exclusively
        // (clearing core's node selection too); shift adds; pressing a selected
        // gate keeps the whole selection. The drag then moves EVERY selected gate.
        if (e.shiftKey) selectGate(g, hit.comb, hit.which, true)
        else if (!isGateSelected(hit.comb, hit.which)) {
          selectGate(g, hit.comb, hit.which, false)
          app.canvas.deselectAll?.()
        } else {
          // Already selected: keep the selection, still bump z (node semantics --
          // every click on a node brings it to front).
          selectGate(g, hit.comb, hit.which, true)
        }
        // Node semantics both ways: the gate drags with the selection, so the
        // selection also drags with the gate (core-selected nodes ride along).
        gateDrag = {
          press: [x, y],
          gates: selectedGates(g).map((s) => ({ ...s, origin: [...s.comb[s.which].pos] })),
          items: [...(app.canvas.selectedItems ?? [])]
            .filter((it) => it?.pos && (it.size || it.linkIds))
            .map((it) => ({ it, origin: [it.pos[0], it.pos[1]] }))
        }
        g.setDirtyCanvas(true, true)
        e.stopPropagation(); e.preventDefault()
        // preventDefault also suppressed the browser's focus change -- without
        // this, keydown targets stay outside graph-canvas-container and BOTH
        // delete paths (core's binding and ours) bail on their scope check.
        canvas.canvas.focus?.()
        return
      }
      // Empty canvas / pins / free reroutes: clear gate selection (a marquee will
      // re-select through the teeth proxies).
      if (!e.shiftKey) clearGateSelection()

      const r = rerouteNear(g, x, y)
      // Empty pin on a bussed out-gate: the channel has a driver upstream but no
      // tooth here yet. Splice a floating continuation through the chain and
      // resume it with core's own drag -- the drop machinery is then exactly the
      // out-tooth pull's (bus round).
      if (!r && hit?.zone === 'pins' && hit.comb.bus && hit.which === 'out') {
        const k = pinIndexAt(hit.comb, 'out', y)
        const l = k >= 0 ? hit.comb.lanes[k] : null
        const empty = !l || l.out == null || !g.reroutes?.get?.(l.out)
        if (empty) {
          const lc = app.canvas.linkConnector
          if (lc && !lc.isConnecting) {
            const terminus = busTapFloat(g, hit.comb, k)
            if (terminus) {
              lc.dragFromReroute(g, terminus)
              pullDrag = true
              g.setDirtyCanvas(true, true)
              e.stopPropagation(); e.preventDefault()
            }
          }
          return
        }
      }
      if (r) {
        const t = toothOf(r.id)
        if (t?.side === 'out') {
          const lc = app.canvas.linkConnector
          if (lc && !lc.isConnecting) {
            lc.dragFromReroute(g, r)
            pullDrag = true
            g.setDirtyCanvas(true, true)
            e.stopPropagation(); e.preventDefault()
          }
          return
        }
        // In-tooth of a lane dangling at the SOURCE (input-drag parked on the
        // gate): the tip carries only a floating link with no origin. Detaching
        // would rip the thread out of the ribbon for nothing -- instead resume
        // the float as an output-seeking drag (core's dragFromRerouteToOutput
        // reconnects the real target inputs through the surviving chain).
        if (t?.side === 'in' && !r.linkIds?.size) {
          const fl = r.firstFloatingLink
          if (fl && Number(fl.origin_id) === -1) {
            const lc = app.canvas.linkConnector
            if (lc && !lc.isConnecting) {
              lc.dragFromRerouteToOutput(g, r)
              pullDrag = true
              g.setDirtyCanvas(true, true)
              e.stopPropagation(); e.preventDefault()
            }
            return
          }
        }
        press = { rid: r.id, x, y } // observe only; core owns the drag
      }
    },
    true
  )

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!active()) return
      const [x, y] = graphPt(e)
      if (busDrag) {
        setBusPreview({ from: busDrag.from, to: [x, y] })
        activeGraph(app)?.setDirtyCanvas(true, true)
        return
      }
      if (pullDrag) {
        // Preview rides core's connecting_links; we drive the snap position (and
        // with it, motion over node DOM -- graph_mouse freezes there).
        driveSnap(e)
        activeGraph(app)?.setDirtyCanvas(true, true)
        return
      }
      if (gateDrag) {
        const L = window.LiteGraph
        const grid = L?.alwaysSnapToGrid && L.CANVAS_GRID_SIZE > 0 ? L.CANVAS_GRID_SIZE : 0
        const snap = (v) => (grid ? Math.round(v / grid) * grid : v)
        const dx = x - gateDrag.press[0], dy = y - gateDrag.press[1]
        for (const gd of gateDrag.gates) {
          gd.comb[gd.which].pos = [snap(gd.origin[0] + dx), snap(gd.origin[1] + dy)]
        }
        for (const s of gateDrag.items) {
          const nx = snap(s.origin[0] + dx), ny = snap(s.origin[1] + dy)
          const mdx = nx - s.it.pos[0], mdy = ny - s.it.pos[1]
          if (!mdx && !mdy) continue
          // The store-syncing path is INVERTED between the two kinds: reroutes
          // sync via move() (raw pos setter), nodes sync via the pos SETTER --
          // LGraphNode.move() is a deliberate no-op in Vue mode (measured:
          // nodes silently ignored the gate drag).
          if (s.it.linkIds) s.it.move(mdx, mdy)
          else s.it.pos = [nx, ny]
        }
        activeGraph(app).setDirtyCanvas(true, true) // combPass re-lays the teeth
        return
      }
      if (follow) {
        // Node deltas already carry the grid snap; adding them keeps alignment.
        const dx = follow.refNode.pos[0] - follow.refPos[0]
        const dy = follow.refNode.pos[1] - follow.refPos[1]
        if (dx || dy) {
          for (const gd of follow.gates) {
            gd.comb[gd.which].pos = [gd.origin[0] + dx, gd.origin[1] + dy]
          }
          activeGraph(app)?.setDirtyCanvas(true, true)
        }
        return
      }
      if (canvasPress && app.canvas?.linkConnector?.isConnecting) {
        driveSnap(e) // core-owned drag born on the canvas (reroute slot pulls)
        return
      }
      if (!app.canvas?.pointer?.isDown) setHover(combAt(activeGraph(app), x, y), activeGraph(app))
    },
    true
  )

  // Delete/Backspace on selected gates. Core's binding runs the
  // DeleteSelectedItems command off a WINDOW bubble listener -- gates are not
  // core items, so a gates-only selection reads as empty and toasts "Nothing
  // selected". Document capture preempts it. Mixed selections compose: we
  // dissolve the combs and let the event through so core deletes its own items;
  // swallowed only when core's set is empty (its handler would only toast).
  document.addEventListener(
    'keydown',
    (e) => {
      if (!active()) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      const t = e.composedPath?.()[0] ?? e.target
      if (
        t instanceof Element &&
        (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)
      ) return
      // Same scoping as core's own Delete binding.
      const container = document.getElementById('graph-canvas-container')
      if (container && t instanceof Node && !container.contains(t)) return
      const g = activeGraph(app)
      const sel = selectedGates(g)
      if (!sel.length) return
      const byComb = new Map()
      for (const { comb, which } of sel) {
        if (!byComb.has(comb)) byComb.set(comb, new Set())
        byComb.get(comb).add(which)
      }
      for (const [comb, sides] of byComb) dissolveComb(g, comb, sides)
      clearGateSelection()
      g.setDirtyCanvas(true, true)
      if (!app.canvas?.selectedItems?.size) { e.stopPropagation(); e.preventDefault() }
    },
    true
  )

  // A cancelled pointer (window blur, pen lift, browser gesture takeover) fires NO
  // pointerup; a stranded flag would make the next unrelated release run drop
  // resolution.
  window.addEventListener(
    'pointercancel',
    () => {
      pullDrag = false
      gateDrag = null
      follow = null
      press = null
      canvasPress = false
      busDrag = null
      setBusPreview(null)
    },
    true
  )

  window.addEventListener(
    'pointerup',
    (e) => {
      canvasPress = false
      if (busDrag) {
        const d = busDrag
        busDrag = null
        setBusPreview(null)
        const g = activeGraph(app)
        if (g) {
          const [x, y] = graphPt(e)
          // A click is not a pull, and a release over any comb is a no-op in v1
          // (re-parenting existing combs is a later round -- lane identity maps
          // are ambiguous). Empty canvas births the mirror at the pointer.
          if (Math.hypot(x - d.press[0], y - d.press[1]) >= 6 && !combAt(g, x, y)) {
            busSpawn(g, d.from, x, y)
          }
          g.setDirtyCanvas(true, true)
        }
        return
      }
      if (pullDrag) {
        pullDrag = false
        const lc = app.canvas?.linkConnector
        const g = activeGraph(app)
        if (lc && g) {
          const [x, y] = graphPt(e)
          // Vue pins live in the DOM with centres ON the node's boundary, where the
          // legacy getNodeOnPos misses (measured: a drop dead on the pin fell through
          // to dropOnNothing and the search box kept the connector alive). The
          // [data-slot-key] element is not in the hit element's ancestry either
          // (separate layer), so resolve by PROXIMITY: nearest keyed slot within
          // 20px of the drop. Legacy dropLinks stays the fallback and still handles
          // gates, reroutes, node bodies, and release-on-empty.
          let connected = false
          let slotEl = null, bd = 400
          for (const el of document.querySelectorAll('[data-slot-key]')) {
            const r = el.getBoundingClientRect()
            if (!r.width) continue
            const dx = e.clientX - (r.x + r.width / 2)
            const dy = e.clientY - (r.y + r.height / 2)
            const d = dx * dx + dy * dy
            if (d < bd) { bd = d; slotEl = el }
          }
          const m = slotEl && /^(.+)-(in|out)-(\d+)$/.exec(slotEl.getAttribute('data-slot-key') ?? '')
          if (m) {
            const node = g.getNodeById(m[1]) ?? g.getNodeById(Number(m[1]))
            if (node && m[2] === 'in' && lc.state?.connectingTo === 'input') {
              const input = node.inputs?.[+m[3]]
              for (const rl of lc.renderLinks) {
                if (input && rl.canConnectToInput?.(node, input)) {
                  rl.connectToInput(node, input, lc.events)
                  connected = true
                }
              }
            } else if (node && m[2] === 'out' && lc.state?.connectingTo === 'output') {
              const output = node.outputs?.[+m[3]]
              for (const rl of lc.renderLinks) {
                if (output && rl.canConnectToOutput?.(node, output)) {
                  rl.connectToOutput(node, output, lc.events)
                  connected = true
                }
              }
            }
          }
          if (!connected) {
            // Core adorns pointer events the same way before handing them to dropLinks.
            e.canvasX = x; e.canvasY = y
            lc.dropLinks(g, e) // wrapped seam: gate drops become dangling lanes too
          }
          lc.reset?.(true)
          g.setDirtyCanvas(true, true)
        }
        return
      }
      if (gateDrag) { gateDrag = null; activeGraph(app)?.setDirtyCanvas(true, true); return }
      if (follow) {
        // The node's drop-time grid snap lands AFTER this capture handler runs --
        // apply the final delta once core has settled, then disarm.
        const f = follow
        follow = null
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const dx = f.refNode.pos[0] - f.refPos[0]
          const dy = f.refNode.pos[1] - f.refPos[1]
          for (const gd of f.gates) {
            gd.comb[gd.which].pos = [gd.origin[0] + dx, gd.origin[1] + dy]
          }
          activeGraph(app)?.setDirtyCanvas(true, true)
        }))
        return
      }
      if (!active() || !press) return
      const p = press
      press = null
      const g = activeGraph(app)
      const [x, y] = graphPt(e)
      if (Math.hypot(x - p.x, y - p.y) < 6) return // click, not a pull
      const t = toothOf(p.rid)
      if (t) {
        // Detach runs SYNCHRONOUSLY: it only deletes the PARTNER tooth, so core's
        // in-flight drag of this dot is untouched. Deferring it loses the race
        // against combPass, which snaps the still-enrolled tooth back to its pin
        // before the deferred removal lands (measured: freed dot parked ON the pin
        // slot, overlapping the next lane's tooth and poisoning the next grab).
        if (t.side === 'in') {
          detachLane(g, t.comb, p.rid)
          g.setDirtyCanvas(true, true)
        }
        // out-teeth: no-op, the next combPass snaps them home
        return
      }
      // Create/enroll DELETE the dot core is finalizing -- those wait until core's
      // own pointerup handling is done with it.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const r = g.reroutes?.get?.(p.rid)
        if (!r || toothOf(p.rid)) return
        const gate = combAt(g, r.pos[0], r.pos[1])
        const other = gate ? null : rerouteNear(g, r.pos[0], r.pos[1], r)
        const otherTooth = other ? toothOf(other.id) : null
        if (gate) gestureEnroll(g, gate.comb, r)
        else if (otherTooth) gestureEnroll(g, otherTooth.comb, r)
        else if (other) gestureCreate(g, other, r)
        g.setDirtyCanvas(true, true)
      }))
    },
    true
  )
}
