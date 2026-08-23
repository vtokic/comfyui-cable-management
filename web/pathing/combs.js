// Combs -- grouped reroutes forming dense ribbon corridors (PATHING.md, comb round).
//
// A comb is a matched gate pair. Each gate is "half a node": normally spaced pins on
// one face, the composed ribbon leaving the other. Teeth are NATIVE reroutes (one
// in/out pair per lane) so persistence, undo, floating-link limbo, and extension-off
// degradation all ride core; the comb itself is only a grouping record in
// graph.extra plus geometry enforcement here. One gate is all "in", the other all
// "out": a member's chain always runs in-tooth before out-tooth, so the ribbon is
// uniform by construction while endpoint geometry stays free. Order is insertion
// order, top pin first; exit mirrors entry, so crossings the far endpoints demand
// happen outside the gates, never inside.
//
// PoC surface: programmatic API only (window.__cablemanagementCombs). Gestures come after.
import { offsetStrand, route } from './router.js'
import { linkSlots } from '../invoke.js'
import { activeGraph, nodeFromId } from '../graph.js'
import { carriedLinkOf, migrateFloatFrom, provenanceOf, recordProvenance, settleCarriedLink } from '../reanchor.js'
import { floatSrc, routeSrc, unclaim } from '../routestore.js'

const KEY = 'cablemanagement_combs'
const GATE_W = 24 // gate body width; the pin->lane fan hides inside it
const PIN_PITCH = 20 // matches litegraph slot spacing ("normally spaced pins")
const LINE_W = 3 // core connections_width: the stroke each gap must clear
const GAP = 2 // design spec: the dark outline visibly separates the lanes
const PITCH = LINE_W + GAP // centreline spacing; a centre-to-centre 2 overlapped
const PAD = 12 // gate vertical padding around the pin column

// Read paths must not WRITE: stamping an empty array into every viewed graph's extra
// made merely opening+saving a workflow mutate the file.
const NO_RECORDS = []
function records(graph, create = false) {
  if (!graph.extra) {
    if (!create) return NO_RECORDS
    graph.extra = {}
  }
  if (!Array.isArray(graph.extra[KEY])) {
    if (!create) return NO_RECORDS
    graph.extra[KEY] = []
  }
  // graph.extra is untrusted workflow data: a malformed entry (non-object, missing
  // gates/lanes) would throw inside the render path and kill core's render loop for
  // the session. Repair in place -- garbage under OUR key gets dropped.
  const arr = graph.extra[KEY]
  for (let i = arr.length - 1; i >= 0; i--) {
    const c = arr[i]
    const ok = c && typeof c === 'object' && Array.isArray(c.lanes) &&
      c.in && Array.isArray(c.in.pos) && c.out && Array.isArray(c.out.pos)
    if (!ok) arr.splice(i, 1)
  }
  return arr
}

// Derived gate geometry. pos is the gate rect's top-left; pins on `pins` side, the
// ribbon face is the opposite edge. Ribbon lanes centre on the gate's middle.
function gateGeom(gate, n) {
  const [x, y] = gate.pos
  // Collapsed ribbon (per-comb; combPass mirrors comb.collapsed onto the gates
  // as a transient): the gate is a GATE_W square, every pin and lane stacks on
  // its centre -- node-collapse semantics, implicit linking only.
  if (gate._collapsed) {
    const cy = y + GATE_W / 2
    return {
      rect: [x, y, GATE_W, GATE_W],
      pinX: gate.pins === 'left' ? x : x + GATE_W,
      ribbonX: gate.pins === 'left' ? x + GATE_W : x,
      centerY: cy,
      pinY: () => cy,
      laneY: () => cy,
      pinDir: gate.pins,
      ribbonDir: gate.pins === 'left' ? 'right' : 'left'
    }
  }
  // Min height = a 3-lane gate (ruling): the hover control column carries up
  // to four glyphs, and a 2-lane gate must hold them too.
  const h = PAD * 2 + Math.max(2, Math.max(0, n - 1)) * PIN_PITCH
  // Labels expansion (ruling: pins stay put, the body bulges toward the ribbon
  // side). _labelW is a transient, non-enumerable stash written by combPass --
  // never serialized; gate.labels (the toggle) is the persisted bit.
  const extra = gate.labels ? gate._labelW ?? 0 : 0
  const pinX = gate.pins === 'left' ? x : x + GATE_W
  const ribbonX = gate.pins === 'left' ? x + GATE_W + extra : x - extra
  return {
    rect: gate.pins === 'left' ? [x, y, GATE_W + extra, h] : [x - extra, y, GATE_W + extra, h],
    pinX,
    ribbonX,
    centerY: y + h / 2,
    // Pin block vertically centred on the gate (Barney's nitpick): identical
    // to the PAD anchor at 3+ lanes, centred when min-height adds headroom.
    pinY: (i) => y + (h - Math.max(0, n - 1) * PIN_PITCH) / 2 + i * PIN_PITCH,
    laneY: (i) => y + h / 2 + (i - (n - 1) / 2) * PITCH,
    pinDir: gate.pins, // direction a pin-side wire extends away from the gate
    ribbonDir: gate.pins === 'left' ? 'right' : 'left'
  }
}

// rerouteId -> {comb, lane, side} rebuilt by combPass; consulted per drawLink.
let toothIndex = new Map()
const tplCache = new Map() // combId -> {stamp, tpl}

// Gate bodies are routing obstacles. Without them the Hanan grid has NO lanes
// near a gate (lanes are obstacle edges), so a flipped face's wrap literally
// cannot exist -- A* fails and the fallback runs the ribbon straight through the
// body (measured: flip appeared to do nothing). Their inflated edges ARE the
// wrap lanes.
export function gateRects(graph) {
  const out = []
  for (const comb of records(graph)) {
    const n = comb.lanes.length
    out.push(gateGeom(comb.in, n).rect, gateGeom(comb.out, n).rect)
  }
  return out
}

export function toothOf(rid) {
  return toothIndex.get(rid) ?? null
}

// {comb, lane} when the two teeth are an in/out pair of one lane, else null.
export function combCrossing(sRid, eRid) {
  const a = toothIndex.get(sRid), b = toothIndex.get(eRid)
  if (!a || !b || a.comb !== b.comb || a.lane !== b.lane) return null
  if (a.side !== 'in' || b.side !== 'out') return null
  return { comb: a.comb, lane: a.lane }
}

// Once per frame, before core draws: validate records against graph truth (teeth
// deleted with the extension off, undo, etc.), auto-decompose below two lanes, snap
// teeth onto their pin slots, rebuild the index. A tooth the user is core-dragging
// is exempt from the snap -- the drop decides whether it detaches or snaps back.
// ---- lane labels (#4, precursor for sorting) -------------------------------------
// What a lane is called: the label a user would read at the wire's SOURCE end.
// Resolution order mirrors the drawing illusion -- the apparent source wins
// (route/float claims on the teeth, or the owned-primitive host pair), so a
// passthrough-fed lane is named after the host's input/widget row, not the true
// upstream. Read live every pass: slot renames are silent property writes.
const LABEL_FONT = '11px Arial'
const LABEL_PAD = 8 // gap pin->text and text->header strip
// The ribbon-side strip of an expanded gate is the COLLAPSED GATE BODY acting
// as a vertical header (Barney's spec): controls and caret live there, and the
// label-to-ribbon distance is exactly label-to-pin gap + that header.
function ctrlCx(gate, g) {
  if (!(gate.labels && gate._labelW)) return g.rect[0] + g.rect[2] / 2
  return gate.pins === 'right' ? g.rect[0] + GATE_W / 2 : g.rect[0] + g.rect[2] - GATE_W / 2
}

const slotName = (s) => s?.label ?? s?.localized_name ?? s?.name ?? null

export function laneLabel(graph, lane) {
  const nodeById = (id) => graph.getNodeById(id) ?? graph.getNodeById(Number(id))
  const apparent =
    routeSrc(graph, lane.in) ?? routeSrc(graph, lane.out) ??
    floatSrc(graph, lane.in) ?? floatSrc(graph, lane.out)
  if (apparent) {
    const name = slotName(nodeById(apparent[0])?.inputs?.[Number(apparent[1])])
    if (name) return name
  }
  const t = graph.reroutes?.get?.(lane.in)
  const ll = t?.firstLink ?? t?.firstFloatingLink
  if (ll && ll.origin_id != null && ll.origin_id !== -1) {
    const origin = nodeById(ll.origin_id)
    if (origin?.properties?.['cablemanagement.owned']) {
      const name = slotName(
        nodeById(origin.properties['cablemanagement.host'])?.inputs?.[
          Number(origin.properties['cablemanagement.hostSlot'])
        ]
      )
      if (name) return name
    }
    const name = slotName(origin?.outputs?.[ll.origin_slot])
    if (name) return name
  }
  return '—' // sourceless lane (ruling: placeholder, count stays honest)
}

// Offscreen measurer: widths are needed in combPass, before any draw ctx exists.
let measureCtx = null
function labelWidth(text) {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  measureCtx.font = LABEL_FONT
  return measureCtx.measureText(text).width
}

// Per-pass label refresh for a labels-on OUT gate: resolves every lane's name,
// stashes the list and the bulge width as NON-ENUMERABLE transients (JSON never
// sees them; gate.labels is the only persisted bit). No cap by ruling: a novel
// gets shown as a novel.
function refreshLabels(graph, comb) {
  let list = null // both gates show the SOURCE names; resolve once
  for (const which of ['in', 'out']) {
    const gate = comb[which]
    // Mirror the per-comb collapse onto each gate (gateGeom reads gates only).
    Object.defineProperty(gate, '_collapsed', {
      value: !!comb.collapsed, writable: true, configurable: true, enumerable: false
    })
    if (!gate.labels || comb.collapsed) {
      if (gate._labelW) stash(gate, 0, null)
      continue
    }
    list ??= comb.lanes.map((l) => laneLabel(graph, l))
    let w = 0
    for (const t of list) w = Math.max(w, labelWidth(t))
    stash(gate, Math.ceil(w) + LABEL_PAD * 2, list)
  }
}

function stash(gate, w, list) {
  Object.defineProperty(gate, '_labelW', { value: w, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(gate, '_labelList', { value: list, writable: true, configurable: true, enumerable: false })
}

export function combPass(graph, canvas) {
  if (!graph) return
  let held = null
  if (canvas?.pointer?.isDown && canvas.selectedItems) {
    for (const it of canvas.selectedItems) {
      if (it?.linkIds && it?.pos) (held ??= new Set()).add(it.id)
    }
  }
  const recs = records(graph)
  const idx = new Map()
  // A lane is live only while a real wire (or real float) rides its teeth. Tooth
  // EXISTENCE is not enough: the phantom floating id (see mint) defeats core's
  // own reroute GC, so a fully deleted link leaves both teeth behind and the gate
  // would render wireless pins forever (sweep cells C/M). Scrub phantoms off
  // surviving teeth each pass too -- absorbed user dots and workflows saved
  // before the fix carry them into the session.
  const scrub = (r) => {
    for (const id of [...(r.floatingLinkIds ?? [])]) {
      if (!graph.floatingLinks?.has?.(id)) r.floatingLinkIds.delete(id)
    }
  }
  const wired = (r) => {
    for (const id of r.linkIds ?? []) if (graph._links?.has?.(Number(id))) return true
    return (r.floatingLinkIds?.size ?? 0) > 0
  }
  for (let i = recs.length - 1; i >= 0; i--) {
    const comb = recs[i]
    comb.lanes = comb.lanes.filter((l) => {
      const tin = graph.reroutes?.get?.(l.in)
      const tout = graph.reroutes?.get?.(l.out)
      if (!tin || !tout) return false
      scrub(tin)
      scrub(tout)
      if (wired(tin) || wired(tout)) return true
      graph.removeReroute(l.in)
      graph.removeReroute(l.out)
      return false
    })
    if (comb.lanes.length < 2) {
      recs.splice(i, 1) // teeth stay behind as plain reroutes (spec)
      tplCache.delete(comb.id)
      continue
    }
    refreshLabels(graph, comb) // before layout: the bulge is part of the geometry
    layout(graph, comb, held)
    comb.lanes.forEach((l, lane) => {
      idx.set(l.in, { comb, lane, side: 'in' })
      idx.set(l.out, { comb, lane, side: 'out' })
    })
  }
  toothIndex = idx

  // Marquee proxy: teeth ARE core-selectable, so a marquee over a gate catches
  // them. On idle frames (never mid-drag -- the in-tooth pull needs its selection
  // alive), convert selected teeth into GATE selection and purge them from core's
  // set; otherwise their stale-position overlays render and group-drags fight the
  // pin snap ("distorts the marquee", QA find).
  if (canvas && !canvas.pointer?.isDown && canvas.selectedItems?.size) {
    for (const it of [...canvas.selectedItems]) {
      if (!it?.linkIds || !it.pos) continue
      const t = idx.get(it.id)
      if (!t) continue
      canvas.selectedItems.delete(it)
      it.selected = false
      gateSel.set(selKey(t.comb, t.side), t.comb)
    }
  }
  // Prune entries whose RECORD is gone -- by object identity, so a reloaded
  // graph reusing a comb id never inherits the selection.
  if (gateSel.size) {
    const alive = new Set(recs)
    for (const [k, ref] of [...gateSel]) if (!alive.has(ref)) gateSel.delete(k)
  }
}

function layout(graph, comb, skip) {
  const n = comb.lanes.length
  for (const which of ['in', 'out']) {
    const g = gateGeom(comb[which], n)
    comb.lanes.forEach((l, i) => {
      if (skip?.has?.(l[which])) return
      const r = graph.reroutes.get(l[which])
      if (!r) return
      const dx = g.pinX - r.pos[0]
      const dy = g.pinY(i) - r.pos[1]
      // move(), never a pos write: it is the one path that syncs the frontend
      // layout store, which marquee, right-click, and Vue drop hit-testing all
      // read (a raw pos write left teeth registered at their creation position).
      if (dx || dy) r.move(dx, dy)
    })
  }
}

// Ribbon polyline for one lane: pin, fan inside the gate body, offset template
// between the ribbon faces, mirrored fan, pin. The template is ONE routed link
// (gate centre to gate centre, clearance inflated by the ribbon's half-width);
// lanes ride it via the strand offset machinery, so bends nest like a bundle.
export function crossingPts(graph, comb, lane, obstacles, clearance, version) {
  const n = comb.lanes.length
  const gi = gateGeom(comb.in, n)
  const go = gateGeom(comb.out, n)
  // Collapsed ribbon: every lane rides ONE line (decollision zero) -- offsets
  // and the ribbon half-width vanish, all strands draw identical points.
  const off = comb.collapsed ? 0 : (lane - (n - 1) / 2) * PITCH
  const a = [gi.ribbonX, gi.laneY(lane)]
  const b = [go.ribbonX, go.laneY(lane)]
  const halfRibbon = comb.collapsed ? 0 : Math.ceil(((n - 1) * PITCH) / 2)

  let mid = null
  // Direct seam mode: facing gates closer than the corridor the router needs
  // (both inflated bodies block every seam cell, so A* wraps a horseshoe OVER
  // the gates instead -- measured at spawn, where the gates touch). Lanes cross
  // the seam straight; when the gates are vertically offset, each lane's
  // vertical is staggered across the seam, ordered against the shift so the
  // parallel Zs nest without crossing each other.
  const dirIn = gi.ribbonDir === 'right' ? 1 : -1
  const dirOut = go.ribbonDir === 'right' ? 1 : -1
  const gap = (b[0] - a[0]) * dirIn
  // gap sign matters: ribbons facing AWAY from each other also pass the
  // opposed-dirs check but show a negative gap -- that shape must keep the
  // router wrap (flip round). Small negative slack covers facing gates dragged
  // into bodily overlap, where the wrap would flash back mid-drag.
  // Upper bound = the room the template's face stubs need (24 + halfRibbon per
  // side, matching the route() call below): a gap the stubs cannot fit makes
  // the template itself fold, so the seam takes over exactly there. The
  // negative slack absorbs a labels bulge too -- an expanded out gate can
  // burrow under an adjacent in gate, and the straight seam (wires under the
  // gate bodies) is the right shape there, not a wrap.
  const slack = GATE_W +
    (comb.out.labels ? comb.out._labelW ?? 0 : 0) +
    (comb.in.labels ? comb.in._labelW ?? 0 : 0)
  if (dirOut === -dirIn && gap >= -slack && gap < 2 * (24 + halfRibbon)) {
    if (Math.abs(a[1] - b[1]) < 0.1) {
      mid = [a, b]
    } else {
      const t = (b[1] > a[1] ? n - lane : lane + 1) / (n + 1)
      const vx = a[0] + dirIn * Math.max(gap, 0) * t
      mid = [a, [vx, a[1]], [vx, b[1]], b]
    }
  }

  if (!mid) {
    const stamp = `${comb.in.pos}|${comb.in.pins}|${comb.out.pos}|${comb.out.pins}|${n}|v${version}`
    let cached = tplCache.get(comb.id)
    if (!cached || cached.stamp !== stamp) {
      const tpl = route({
        start: [gi.ribbonX, gi.centerY],
        end: [go.ribbonX, go.centerY],
        startDir: gi.ribbonDir, // departs outward from the in-gate's ribbon face
        endDir: go.ribbonDir, // stub extends outward from the out-gate's ribbon face
        obstacles,
        clearance: clearance + halfRibbon,
        // Strands offset perpendicular from the template by up to halfRibbon;
        // with the default 24px stub a wide ribbon's inner strands folded back
        // THROUGH the gate body (measured: 20 lanes = 76px offset vs 24px
        // stub). The face stubs must clear the ribbon's own width too.
        stubStart: 24 + halfRibbon,
        stubEnd: 24 + halfRibbon,
        enforceStart: true, // gate faces are binding (flip round)
        enforceEnd: true,
        vPad: 8 // same shadow standoff the plain routes keep off node bodies
      })
      cached = { stamp, tpl }
      tplCache.set(comb.id, cached)
    }
    // Touching or near-degenerate gates simplify the template below 4 points --
    // unusable for strand offsets (and t[2] does not exist). Synth path covers it.
    if (cached.tpl && cached.tpl.length >= 4) {
      // Left-normal offset sign depends on the first mid run's travel direction.
      const t = cached.tpl
      const d1x = Math.sign(t[2][0] - t[1][0]) || Math.sign(b[0] - a[0]) || 1
      mid = offsetStrand(t, a, b, off * (d1x >= 0 ? -1 : 1))
    }
  }
  if (!mid) {
    // Trivial straight corridor (route() returned null) or degenerate template.
    mid =
      Math.abs(a[1] - b[1]) < 0.1
        ? [a, b]
        : [a, [(a[0] + b[0]) / 2, a[1]], [(a[0] + b[0]) / 2, b[1]], b]
  }

  const fan = (g, pin, lanePt) => {
    const fx = g.ribbonX + (g.ribbonDir === 'right' ? -4 : 4)
    return [pin, [fx, pin[1]], [fx, lanePt[1]]]
  }
  const pts = [
    ...fan(gi, [gi.pinX, gi.pinY(lane)], a),
    ...mid,
    ...fan(go, [go.pinX, go.pinY(lane)], b).reverse()
  ]
  return clean(pts)
}

function clean(pts) {
  const out = [pts[0]]
  for (let k = 1; k < pts.length; k++) {
    const a = out[out.length - 1], b = pts[k]
    if (Math.abs(a[0] - b[0]) < 0.1 && Math.abs(a[1] - b[1]) < 0.1) continue
    const c = out[out.length - 2]
    if (
      c &&
      ((Math.abs(c[0] - a[0]) < 0.1 && Math.abs(a[0] - b[0]) < 0.1) ||
        (Math.abs(c[1] - a[1]) < 0.1 && Math.abs(a[1] - b[1]) < 0.1))
    ) {
      out[out.length - 1] = b
      continue
    }
    out.push(b)
  }
  return out
}

// ---- gesture support ------------------------------------------------------------

// Gate selection -- gates act as nodes: click selects, marquee selects (via the
// TEETH, which core's marquee catches; combPass converts them to gate selection
// and purges them from core's set so nothing drags or outlines the pins
// themselves), selected gates draw on top and follow node-group drags.
// Keyed `${combId}|${which}` but VALUED by the record object: comb ids restart
// per graph, so a cleared/reloaded graph can mint a comb with a stale key's id
// and inherit a phantom selection (measured: a one-gate [del] dissolved both
// columns). Identity checks make the prune exact.
const gateSel = new Map() // `${combId}|${which}` -> comb record
const selKey = (comb, which) => `${comb.id}|${which}`

export function isGateSelected(comb, which) {
  return gateSel.get(selKey(comb, which)) === comb
}

// Selecting also moves the comb record to the END of the list -- record order is
// draw order, so "jump to top" persists the way node z-order does.
export function selectGate(graph, comb, which, add) {
  if (!add) gateSel.clear()
  gateSel.set(selKey(comb, which), comb)
  const recs = records(graph)
  const i = recs.indexOf(comb)
  if (i >= 0 && i !== recs.length - 1) {
    recs.splice(i, 1)
    recs.push(comb)
  }
}

export function clearGateSelection() {
  gateSel.clear()
}

export function selectedGates(graph) {
  const out = []
  for (const comb of records(graph)) {
    for (const which of ['in', 'out']) {
      if (isGateSelected(comb, which)) out.push({ comb, which })
    }
  }
  return out
}

export function gateSelectionKeys() {
  return [...gateSel.keys()]
}

// Hover state for the flip glyph; the gesture layer feeds it from pointermove.
let hover = null // {id, which}

export function setHover(hit, graph) {
  const next = hit ? { id: hit.comb.id, which: hit.which } : null
  if ((next?.id !== hover?.id || next?.which !== hover?.which) && graph) {
    graph.setDirtyCanvas(true, true)
  }
  hover = next
}

// Inside the gate's top edge -- floating above it would put a hover dead-zone
// between body and glyph and the hover would clear on the way up.
// Hover control column (Barney's design): the caret yields its spot while
// hovered and up to three 12px glyphs stack vertically centred on the gate --
// they JUST fit a two-lane gate. Slot 0 flip, slot 1 labels, slot 2 reserved
// for sort. Hover out: glyphs gone, caret back.
function ctrlSlot(gate, n, slot) {
  const g = gateGeom(gate, n)
  // Four-slot grid centred on the gate: flip, labels, sort, collapse. The
  // 3-lane minimum height exists exactly so this fits.
  const cy = g.centerY + (slot - 1.5) * 14
  return [ctrlCx(gate, g) - 6, cy - 6, 12, 12]
}

export function glyphRect(gate, n) {
  return ctrlSlot(gate, n, 0)
}

// Labels toggle glyph: middle slot of the hover column.
export function labelsGlyphRect(gate, n) {
  return ctrlSlot(gate, n, 1)
}

// Sort glyph: third slot; opens the lane-sort modal (order applies comb-wide).
export function sortGlyphRect(gate, n) {
  return ctrlSlot(gate, n, 2)
}

// Collapse glyph: fourth slot (per-comb toggle, mirrored on both gates).
export function collapseGlyphRect(gate, n) {
  return ctrlSlot(gate, n, 3)
}

// The one control a collapsed gate offers: expand, centred on the square.
export function expandGlyphRect(gate, n) {
  const g = gateGeom(gate, n)
  return [ctrlCx(gate, g) - 6, g.centerY - 6, 12, 12]
}

// Hit-test a graph point against every gate. zone: 'flip' (hover glyph), 'body'
// (draggable panel), 'pins' (the tooth strip -- left for core's reroute handling).
// The "+" drop square below a gate: the ONE surface that creates lanes while a
// drag is live (Barney's design: body drops read as "connect to first matching
// pin", so lane creation gets its own explicit, visible target).
export function plusRect(gate, n) {
  const g = gateGeom(gate, n)
  // Anchored to the PIN side: a labels-expanded gate bulges toward the ribbon,
  // and the drop square must not wander with it.
  const x0 = gate.pins === 'left' ? g.rect[0] : g.rect[0] + g.rect[2] - GATE_W
  return [x0, g.rect[1] + g.rect[3] + 4, GATE_W, GATE_W]
}

// True while a free reroute dot rides a core drag (combgestures maintains it);
// link drags are read off the linkConnector directly. Together they decide
// when the "+" square draws.
let dotDragLive = false
export function setDotDrag(v) {
  dotDragLive = !!v
}
const dotDragActive = () => dotDragLive

export function combAt(graph, x, y) {
  for (const comb of records(graph)) {
    const n = comb.lanes.length
    for (const which of ['in', 'out']) {
      const pr = plusRect(comb[which], n)
      if (x >= pr[0] && x <= pr[0] + pr[2] && y >= pr[1] && y <= pr[1] + pr[3]) {
        return { comb, which, zone: 'newlane' }
      }
      // Collapsed comb: implicit linking only -- the square is all body except
      // the centred expand glyph (hover) and the "+" square handled above.
      if (comb.collapsed) {
        const eg = expandGlyphRect(comb[which], n)
        if (
          hover?.id === comb.id && hover.which === which &&
          x >= eg[0] && x <= eg[0] + eg[2] && y >= eg[1] && y <= eg[1] + eg[3]
        ) return { comb, which, zone: 'expand' }
        const [rx, ry, rw, rh] = gateGeom(comb[which], n).rect
        if (x < rx || x > rx + rw || y < ry || y > ry + rh) continue
        return { comb, which, zone: 'body' }
      }
      const gl = glyphRect(comb[which], n)
      if (
        hover?.id === comb.id && hover.which === which &&
        x >= gl[0] && x <= gl[0] + gl[2] && y >= gl[1] && y <= gl[1] + gl[3]
      ) return { comb, which, zone: 'flip' }
      {
        const lg = labelsGlyphRect(comb[which], n)
        if (
          hover?.id === comb.id && hover.which === which &&
          x >= lg[0] && x <= lg[0] + lg[2] && y >= lg[1] && y <= lg[1] + lg[3]
        ) return { comb, which, zone: 'labels' }
        const sg = sortGlyphRect(comb[which], n)
        if (
          hover?.id === comb.id && hover.which === which &&
          x >= sg[0] && x <= sg[0] + sg[2] && y >= sg[1] && y <= sg[1] + sg[3]
        ) return { comb, which, zone: 'sort' }
        const cg = collapseGlyphRect(comb[which], n)
        if (
          hover?.id === comb.id && hover.which === which &&
          x >= cg[0] && x <= cg[0] + cg[2] && y >= cg[1] && y <= cg[1] + cg[3]
        ) return { comb, which, zone: 'collapse' }
      }
      const [rx, ry, rw, rh] = gateGeom(comb[which], n).rect
      if (x < rx || x > rx + rw || y < ry || y > ry + rh) continue
      const strip = comb[which].pins === 'left' ? x <= rx + 10 : x >= rx + rw - 10
      return { comb, which, zone: strip ? 'pins' : 'body' }
    }
  }
  return null
}

/** The lane whose pin sits nearest a y inside a gate's pin column. */
export function laneAt(comb, which, y) {
  const gate = comb[which]
  if (!gate || !comb.lanes.length) return null
  // Derive from gateGeom's pinY, not a PAD anchor: the pin block is vertically
  // CENTRED on the min-height gate (chrome round), so on a 2-lane gate the
  // top pin sits half a pitch below y+PAD and the old anchor resolved every
  // pin to the wrong lane (battery catch: feedback snap hinted lane 1 while
  // hovering lane 0's pin).
  const g = gateGeom(gate, comb.lanes.length)
  const i = Math.round((y - g.pinY(0)) / PIN_PITCH)
  return comb.lanes[Math.max(0, Math.min(comb.lanes.length - 1, i))] ?? null
}

/** Core's own laxness: unknown or wildcard on either side is a match. */
export function typeMatch(a, b) {
  return a == null || b == null || a === '*' || b === '*' || String(a) === String(b)
}

/**
 * A lane's ends, sorted the way gate drops consume them: real links riding the
 * out-tooth; floats parked with a real target (a consumer waiting for a
 * source); floats holding only a real origin (a source waiting for a
 * consumer). Shared by the drop itself, the snap magnet, and the dim pass, so
 * the hint can never disagree with the drop.
 */
export function laneEnds(graph, lane) {
  const getLink = (id) => (graph.getLink ? graph.getLink(id) : graph._links?.get?.(id))
  const outR = graph.reroutes?.get?.(lane.out)
  const links = []
  const targets = []
  const parked = []
  const hanging = []
  if (outR) {
    for (const lid of outR.linkIds ?? []) {
      const l = getLink(lid)
      const t = l && nodeFromId(graph, l.target_id)
      if (t?.inputs?.[l.target_slot]) {
        links.push(l)
        targets.push({ node: t, slot: l.target_slot })
      }
    }
    for (const f of graph.floatingLinks?.values?.() ?? []) {
      if (f.parentId !== lane.in && f.parentId !== lane.out) continue
      const t = nodeFromId(graph, f.target_id)
      if (t?.inputs?.[f.target_slot]) {
        targets.push({ node: t, slot: f.target_slot })
        parked.push(f)
      } else if (nodeFromId(graph, f.origin_id)?.outputs?.[f.origin_slot]) {
        hanging.push(f)
      }
    }
  }
  return { outR, links, targets, parked, hanging }
}

// All tooth creation goes through this: core's LGraph.createReroute seeds the new
// reroute's floatingLinkIds with [before.id] when `before` is a REAL link (latent
// core bug, present 1.47.10 and 1.48.6) and nothing ever prunes the unresolvable
// id. The phantom then (a) blocks core's reroute GC -- totalLinks counts it, so
// dead teeth survive as wireless gate pins -- and (b) VETOES core's
// disconnect-to-float, which is gated on floatingLinkIds.size === 0 (sweep cells
// C/D/M). Scrub any id that does not resolve to an actual floating link.
function mint(graph, before) {
  const r = graph.createReroute([0, 0], before)
  if (r?.floatingLinkIds) {
    for (const id of [...r.floatingLinkIds]) {
      if (!graph.floatingLinks?.has?.(id)) r.floatingLinkIds.delete(id)
    }
  }
  return r
}

// Clipboard survival (combclipboard.js) rebuilds records outside this module.
export { mint as mintTooth, records as combRecords, layout as layoutComb }

// Replace a free reroute with a tooth pair inheriting its chain slot AND its whole
// linkIds set -- a junction reroute becomes one lane feeding all its branches, so
// manifold fan-out survives enrollment.
function absorb(graph, comb, reroute) {
  const tIn = mint(graph, reroute)
  const tOut = mint(graph, reroute)
  if (!tIn || !tOut) return false
  // A parked float's pin record is keyed by the reroute about to die -- move it
  // onto the teeth or the float snaps back to its true origin (QA 2f).
  migrateFloatFrom(graph, reroute.id, [tIn.id, tOut.id])
  graph.removeReroute(reroute.id)
  comb.lanes.push({ in: tIn.id, out: tOut.id })
  return true
}

const sharesLink = (a, b) => {
  for (const id of a.linkIds ?? []) if (b.linkIds?.has?.(id)) return true
  return false
}

// ---- same-source lane join (#4) --------------------------------------------------
// Merging a wire whose source a ribbon already carries must not mint a twin lane:
// the wire joins the EXISTING lane and forks at the ribbon output pin. "Same
// source" is exact: same real origin pin AND same apparent source -- two wires
// from one true origin but drawn from different pass-through pins read as
// different sources to the user and stay separate lanes.
const sameSrc = (a, b) =>
  (a == null && b == null) ||
  (a != null && b != null && String(a[0]) === String(b[0]) && Number(a[1]) === Number(b[1]))

function laneWithSource(graph, comb, originId, originSlot, apparent) {
  for (const lane of comb.lanes) {
    const t = graph.reroutes.get(lane.in)
    const ll = t?.firstLink
    if (!ll || String(ll.origin_id) !== String(originId) || ll.origin_slot !== originSlot) continue
    const lsrc = routeSrc(graph, lane.in) ?? routeSrc(graph, lane.out) ?? null
    if (sameSrc(lsrc, apparent)) return lane
  }
  return null
}

// Fold an enrolled reroute's wires into a matching lane: every rider reconnects
// through the lane's teeth (core connect replaces the occupied input and retires
// the old chain), provenance re-records under the new link ids when the lane
// draws from a pass-through pin, and the now-wireless dot goes. Returns false --
// caller falls through to a plain enroll -- when the reroute carries floats, a
// mixed-origin manifold, or no lane matches.
function joinLane(graph, comb, reroute) {
  // Phantom float ids (see mint) ride FREE dots too: core's createReroute seeds
  // them and only the VUE draw path happens to prune (legacy never validates),
  // so every legacy-mode join was vetoed by the guard below (battery catch:
  // ribbonjoin s2 green under Vue, dead under legacy). Scrub against graph
  // truth first -- a REAL parked float still refuses the join.
  if (reroute.floatingLinkIds) {
    for (const id of [...reroute.floatingLinkIds]) {
      if (!graph.floatingLinks?.has?.(id)) reroute.floatingLinkIds.delete(id)
    }
  }
  if (reroute.floatingLinkIds?.size) return false
  const ids = [...(reroute.linkIds ?? [])]
  if (!ids.length) return false
  const links = ids.map((id) => (graph.getLink ? graph.getLink(id) : graph._links?.get?.(id))).filter(Boolean)
  if (links.length !== ids.length) return false
  const o = links[0]
  if (!links.every((l) => String(l.origin_id) === String(o.origin_id) && l.origin_slot === o.origin_slot)) return false
  const apparent = routeSrc(graph, reroute.id) ?? null
  const lane = laneWithSource(graph, comb, o.origin_id, o.origin_slot, apparent)
  if (!lane) return false
  const srcNode = graph.getNodeById(o.origin_id) ?? graph.getNodeById(Number(o.origin_id))
  if (!srcNode) return false
  const host = apparent && (graph.getNodeById(apparent[0]) ?? graph.getNodeById(Number(apparent[0])))
  for (const l of links) {
    const t = graph.getNodeById(l.target_id) ?? graph.getNodeById(Number(l.target_id))
    if (!t) continue
    const nl = linkSlots(srcNode, l.origin_slot, t, l.target_slot, lane.out)
    if (nl && host) recordProvenance(t, l.target_slot, host, Number(apparent[1]), nl.id)
  }
  unclaim(graph, 'reroutes', reroute.id)
  unclaim(graph, 'floats', reroute.id)
  if (graph.reroutes?.has?.(reroute.id)) graph.removeReroute(reroute.id)
  return true
}

// Reroute dropped onto a reroute: comb is born at the drop point, gates adjacent
// and touching on the ribbon side. The dot that was already there takes lane 0.
export function gestureCreate(graph, target, dragged) {
  if (target === dragged || sharesLink(target, dragged)) return null
  const recs = records(graph, true) // creating: the one place a comb array may be born
  const id = recs.reduce((m, c) => Math.max(m, c.id), 0) + 1
  const [x, y] = target.pos
  const cy = y - PAD - PIN_PITCH / 2
  const comb = {
    id,
    in: { pos: [x - GATE_W, cy], pins: 'left' },
    out: { pos: [x, cy], pins: 'right' },
    lanes: []
  }
  recs.push(comb)
  absorb(graph, comb, target)
  absorb(graph, comb, dragged)
  layout(graph, comb)
  return id
}

// First lane whose carried type matches a drag's type -- the gate-body "connect
// to first available matching pin" resolution.
export function firstMatchingLane(graph, comb, type) {
  for (const l of comb.lanes) {
    const ends = laneEnds(graph, l)
    const carried = ends.links[0]?.type ?? ends.parked[0]?.type ?? ends.hanging[0]?.type ?? null
    if (typeMatch(carried, type)) return l
  }
  return null
}

// Reroute dropped onto the "+" square: append as the last lane (a same-source
// wire still JOINS its lane instead of minting a twin).
export function gestureEnroll(graph, comb, reroute) {
  if (toothIndex.has(reroute.id)) return false
  for (const l of comb.lanes) {
    const t = graph.reroutes.get(l.in)
    if (t && sharesLink(t, reroute)) return false
  }
  if (joinLane(graph, comb, reroute)) {
    layout(graph, comb)
    return true
  }
  const ok = absorb(graph, comb, reroute)
  if (ok) layout(graph, comb)
  return ok
}

// Park an in-flight link drag as a new lane -- the "limbo" state of the spec. The
// dangling side rides core's floating-link machinery: connectFloatingReroute mints
// the floating link and its terminus reroute; the second tooth is a plain
// createReroute insert ahead of it (which also lands in the layout store -- the
// terminus itself needs no core hit-testing, the out-pull gesture owns it). Works
// for fresh drags AND resumed/branched ones (fromReroute chains compose), both
// directions:
//   from an output -> lane floats at the OUT side (terminus = out-tooth)
//   from an input  -> lane floats at the IN side (near-input reroute = out-tooth)
export function gestureFloatingEnroll(graph, lc, comb) {
  const rls = lc?.renderLinks ?? []
  let made = false
  for (const rl of rls) {
    if (!rl?.node?.connectFloatingReroute || !rl.fromSlot) continue
    if (rl.toType !== 'input' && rl.toType !== 'output') continue
    // A drag CARRYING an existing link whose source this ribbon already runs
    // (#4 join rule): the wire joins the matching lane -- consumer reconnects
    // through the teeth, forking at the ribbon output pin -- instead of
    // parking a twin floating lane. connect() replaces the occupied input, so
    // the donor link dies with the swap; provenance follows the lane.
    const carried = carriedLinkOf(graph, rl)
    if (carried) {
      const tNode = graph.getNodeById(carried.target_id) ?? graph.getNodeById(Number(carried.target_id))
      const rec = tNode && provenanceOf(tNode, carried.target_slot, graph)
      const apparent = rec ? [String(rec[0]), Number(rec[1])] : null
      const lane = laneWithSource(graph, comb, carried.origin_id, carried.origin_slot, apparent)
      const srcNode = lane && (graph.getNodeById(carried.origin_id) ?? graph.getNodeById(Number(carried.origin_id)))
      if (srcNode && tNode) {
        const nl = linkSlots(srcNode, carried.origin_slot, tNode, carried.target_slot, lane.out)
        if (nl) {
          const host = apparent && (graph.getNodeById(apparent[0]) ?? graph.getNodeById(Number(apparent[0])))
          if (host) recordProvenance(tNode, carried.target_slot, host, Number(apparent[1]), nl.id)
          made = true
          continue
        }
      }
    }
    const terminus = rl.node.connectFloatingReroute([0, 0], rl.fromSlot, rl.fromReroute?.id)
    if (!terminus) continue
    const rIn = mint(graph, terminus)
    if (!rIn) continue
    // Chain order is [rIn, terminus] both ways; only which end dangles differs
    // (output-drag: terminus is the would-be input end; input-drag: rIn is the
    // would-be source end and the terminus sits nearest the real input).
    comb.lanes.push({ in: rIn.id, out: terminus.id })
    made = true
    // A drag CARRYING an existing link (core pickup by either end) parked
    // here is a MOVE into limbo: the donor end empties. Skipping this left
    // the original link alive alongside the fresh float (QA: 'adds a
    // floating lane connected to B AND leaves A->B untouched -- impossible
    // state'). Float first -- it must exist before the donor link dies.
    settleCarriedLink(graph, rl)
  }
  if (made) layout(graph, comb)
  return made
}

// [del] semantics (design decision): the SELECTION decides. Both gates selected -> the
// whole comb dissolves and the links heal plain. One gate selected -> that
// gate's teeth dissolve with it, the partner gate decomposes into plain
// reroutes left standing in its column. Teeth are native reroutes and the
// record rides graph.extra, so undo restores either shape.
export function dissolveComb(graph, comb, sides) {
  const recs = records(graph)
  const i = recs.indexOf(comb)
  if (i < 0) return false
  for (const lane of comb.lanes) {
    if (sides.has('in')) graph.removeReroute(lane.in)
    if (sides.has('out')) graph.removeReroute(lane.out)
  }
  recs.splice(i, 1)
  tplCache.delete(comb.id)
  gateSel.delete(selKey(comb, 'in'))
  gateSel.delete(selKey(comb, 'out'))
  return true
}

// Pulling an in-tooth away detaches its lane: the partner out-tooth dissolves and
// the pulled dot stays under the pointer as a plain reroute ("pulling from 'in'
// disconnects; the dragging reroute IS the tooth"). Out-teeth never detach -- the
// next combPass snaps them home.
export function detachLane(graph, comb, rid) {
  const i = comb.lanes.findIndex((l) => l.in === rid)
  if (i < 0) return false
  const lane = comb.lanes.splice(i, 1)[0]
  graph.removeReroute(lane.out)
  return true
}

// Gate panels, drawn over the links so the fan geometry stays inside the body.
// Teeth do NOT render as reroute dots (suppressed in pathing.js) -- each lane gets
// a node-style pin: a small typed-colour circle straddling the gate's pin edge.
// Record order is base z (selectGate moves a comb's record to the end). SELECTED
// gates render on an overlay canvas stacked ABOVE the DOM node layer -- the main
// canvas sits underneath every Vue node, so "jump on top of nodes" is impossible
// there ("z order still not working", QA find).
function drawGate(ctx, graph, comb, which, sel, canvas) {
  // A gate is half a node, so it wears the node's theme: Comfy's colour palette
  // writes these LiteGraph constants, and reading them at draw time follows every
  // palette switch (audit: no invented colours where a core value exists).
  const L = window.LiteGraph
  const body = L?.NODE_DEFAULT_BGCOLOR ?? '#353535'
  const n = comb.lanes.length
  const g = gateGeom(comb[which], n)
  ctx.beginPath()
  ctx.roundRect(g.rect[0], g.rect[1], g.rect[2], g.rect[3], 5)
  ctx.fillStyle = body
  ctx.fill()
  ctx.strokeStyle = sel ? (L?.NODE_BOX_OUTLINE_COLOR ?? '#fff') : (L?.NODE_DEFAULT_BOXCOLOR ?? '#666')
  ctx.lineWidth = sel ? 1.5 : 1
  ctx.stroke()
  // The dim contract: while a link drags, targets the drop cannot use fade to
  // 40% -- the same cue core slots give. An in-pin serves a source drag when the
  // lane has a compatible open end, and a consumer drag when the lane has a
  // source; an out-pin only ever receives consumer drags. The pulled lane's own
  // pin stays bright: it is the drag's source, not a refused target.
  const lc = canvas?.linkConnector
  const drag = lc?.isConnecting && lc.renderLinks?.length
    ? {
        to: lc.state?.connectingTo,
        type: lc.renderLinks[0]?.fromSlot?.type,
        fromRid: lc.renderLinks[0]?.fromReroute?.id,
      }
    : null
  // "+" square: visible exactly while something droppable is in flight (link
  // drag or a free dot ride); it is the sole lane-creation surface.
  if (drag || dotDragActive()) {
    const [px, py, pw, ph] = plusRect(comb[which], n)
    ctx.beginPath()
    ctx.roundRect(px, py, pw, ph, 5)
    ctx.fillStyle = body
    ctx.fill()
    ctx.strokeStyle = L?.NODE_DEFAULT_BOXCOLOR ?? '#666'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.beginPath()
    const cx = px + pw / 2, cy = py + ph / 2, arm = 5
    ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy)
    ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm)
    ctx.strokeStyle = L?.NODE_TEXT_COLOR ?? '#ddd'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  comb.lanes.forEach((l, i) => {
    const t = graph.reroutes?.get?.(l[which])
    let dim = false
    if (drag) {
      const ends = laneEnds(graph, l)
      const carried = ends.links[0]?.type ?? ends.parked[0]?.type ?? ends.hanging[0]?.type ?? null
      if (which === 'out') {
        dim = drag.to !== 'output' || !typeMatch(carried, drag.type)
      } else if (drag.to === 'input') {
        dim = !(
          ends.targets.some((x) => typeMatch(drag.type, x.node.inputs[x.slot]?.type)) ||
          ends.hanging.some((f) => typeMatch(drag.type, f.type))
        )
      } else {
        // Consumer drags never land on an in-pin: ribbon.input is input-like,
        // and input-to-input is a no-op by force of logic (polarity ruling) --
        // the drop seam consumes it, so the pin must not advertise (hint=truth).
        dim = true
      }
      if (dim && l[which] === drag.fromRid) dim = false
    }
    ctx.globalAlpha = dim ? 0.4 : 1
    ctx.beginPath()
    ctx.arc(g.pinX, g.pinY(i), 4, 0, Math.PI * 2)
    ctx.fillStyle = t?._colour ?? canvas?.default_link_color ?? '#999'
    ctx.fill()
    ctx.strokeStyle = body
    ctx.lineWidth = 1
    ctx.stroke()
  })
  ctx.globalAlpha = 1
  // Lane labels (either gate, toggled): source names printed per pin row inside
  // the bulged body, anchored at the pin side and running toward the ribbon.
  const lgate = comb[which]
  if (lgate.labels && lgate._labelList) {
    ctx.font = LABEL_FONT
    ctx.fillStyle = L?.NODE_TEXT_COLOR ?? '#ddd'
    ctx.textBaseline = 'middle'
    ctx.textAlign = lgate.pins === 'right' ? 'right' : 'left'
    const tx = lgate.pins === 'right' ? g.pinX - LABEL_PAD : g.pinX + LABEL_PAD
    lgate._labelList.forEach((t, i) => ctx.fillText(t, tx, g.pinY(i)))
  }
  const hovered = hover?.id === comb.id && hover.which === which
  if (!hovered) {
    // Flow caret: INFORMATION, not interaction -- a filled ◀/▶ in semitransparent
    // black. IN gate points pins->ribbon, OUT gate ribbon->pins, so a comb scans
    // source-to-sink at a glance. Shown only while the control column is hidden.
    const dir = which === 'in' ? g.ribbonDir : g.pinDir
    const cx = ctrlCx(comb[which], g)
    const dx = dir === 'right' ? 4 : -4
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.moveTo(cx - dx, g.centerY - 5)
    ctx.lineTo(cx + dx, g.centerY)
    ctx.lineTo(cx - dx, g.centerY + 5)
    ctx.closePath()
    ctx.fill()
  } else if (comb.collapsed) {
    // Collapsed square offers ONE control: expand (outward chevrons).
    const [ex, ey, ew, eh] = expandGlyphRect(comb[which], n)
    const ecx = ex + ew / 2
    ctx.strokeStyle = L?.NODE_TITLE_COLOR ?? '#999'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(ecx - 4, ey + 5); ctx.lineTo(ecx, ey + 1); ctx.lineTo(ecx + 4, ey + 5)
    ctx.moveTo(ecx - 4, ey + eh - 5); ctx.lineTo(ecx, ey + eh - 1); ctx.lineTo(ecx + 4, ey + eh - 5)
    ctx.stroke()
  } else {
    // Hover control column in the caret's place (Barney's design): flip,
    // labels, sort, collapse -- four 12px glyphs on the min-height gate.
    const [gx, gy, gw, gh] = glyphRect(comb[which], n)
    const cy = gy + gh / 2
    ctx.strokeStyle = L?.NODE_TITLE_COLOR ?? '#999'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(gx + 5, cy - 4); ctx.lineTo(gx + 1, cy); ctx.lineTo(gx + 5, cy + 4)
    ctx.moveTo(gx + gw - 5, cy - 4); ctx.lineTo(gx + gw - 1, cy); ctx.lineTo(gx + gw - 5, cy + 4)
    ctx.stroke()
    {
      const [lx, ly, lw, lh] = labelsGlyphRect(comb[which], n)
      ctx.beginPath()
      for (let k = 0; k < 3; k++) {
        const yy = ly + 3 + k * (lh - 6) / 2
        ctx.moveTo(lx + 2, yy); ctx.lineTo(lx + lw - 2, yy)
      }
      ctx.stroke()
      // sort: descending bars
      const [sx, sy, sw, sh] = sortGlyphRect(comb[which], n)
      ctx.beginPath()
      for (let k = 0; k < 3; k++) {
        const yy = sy + 3 + k * (sh - 6) / 2
        ctx.moveTo(sx + 2, yy); ctx.lineTo(sx + 2 + (sw - 4) * (1 - k * 0.3), yy)
      }
      ctx.stroke()
      // collapse: inward chevrons
      const [cx2, cy2, cw2, ch2] = collapseGlyphRect(comb[which], n)
      const ccx = cx2 + cw2 / 2
      ctx.beginPath()
      ctx.moveTo(ccx - 4, cy2 + 1); ctx.lineTo(ccx, cy2 + 5); ctx.lineTo(ccx + 4, cy2 + 1)
      ctx.moveTo(ccx - 4, cy2 + ch2 - 1); ctx.lineTo(ccx, cy2 + ch2 - 5); ctx.lineTo(ccx + 4, cy2 + ch2 - 1)
      ctx.stroke()
    }
  }
}

let overlay = null

function overlayCtx(canvas) {
  const src = canvas.canvas
  if (!overlay) {
    overlay = document.createElement('canvas')
    overlay.className = 'cablemanagement-gate-overlay'
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:60;'
    document.body.appendChild(overlay)
  }
  const r = src.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr)
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h }
  overlay.style.left = `${r.left}px`
  overlay.style.top = `${r.top}px`
  overlay.style.width = `${r.width}px`
  overlay.style.height = `${r.height}px`
  const ctx = overlay.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const { scale, offset } = canvas.ds
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * scale * offset[0], dpr * scale * offset[1])
  return ctx
}

export function clearOverlay() {
  if (overlay) {
    const ctx = overlay.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, overlay.width, overlay.height)
  }
}

// ALL gates live on the overlay: node-like z means a gate brought to top STAYS
// above nodes after deselection, and the main canvas can never paint above the
// DOM node layer. Record order is base z, selected gates draw last. The ribbon
// stays on the main canvas (under nodes, like links); the gate body covers its
// own fan from above either way.
export function drawGates(ctx, graph, canvas) {
  const recs = graph?.extra?.[KEY]
  if (!Array.isArray(recs) || !recs.length || !canvas) {
    clearOverlay()
    return
  }
  const gates = []
  for (const comb of recs) {
    gates.push([comb, 'in'], [comb, 'out'])
  }
  gates.sort((a, b) => (isGateSelected(a[0], a[1]) ? 1 : 0) - (isGateSelected(b[0], b[1]) ? 1 : 0))
  const octx = overlayCtx(canvas)
  for (const [comb, which] of gates) {
    drawGate(octx, graph, comb, which, isGateSelected(comb, which), canvas)
  }
}

// ---- programmatic API (PoC; gesture layer comes later) -------------------------

function enroll(graph, comb, linkId) {
  const link = graph._links.get(Number(linkId))
  if (!link) return false
  // Two inserts before the final segment chain source -> in -> out -> target.
  const tIn = mint(graph, link)
  const tOut = mint(graph, link)
  if (!tIn || !tOut) return false
  comb.lanes.push({ in: tIn.id, out: tOut.id })
  return true
}

export function installApi(app) {
  // The graph ON SCREEN, not the root -- inside a subgraph app.graph still points at
  // the root, and a comb created there would enroll root links from subgraph
  // coordinates (cross-graph corruption, persisted on save).
  const g = () => activeGraph(app)
  const dirty = () => activeGraph(app)?.setDirtyCanvas(true, true)
  const find = (id) => records(g()).find((c) => c.id === id)

  const api = {
    create(linkIdA, linkIdB, x, y) {
      const recs = records(g(), true)
      const id = recs.reduce((m, c) => Math.max(m, c.id), 0) + 1
      const comb = {
        id,
        in: { pos: [x, y], pins: 'left' },
        out: { pos: [x + GATE_W, y], pins: 'right' }, // adjacent, touching ribbon faces
        lanes: []
      }
      recs.push(comb)
      enroll(g(), comb, linkIdA)
      enroll(g(), comb, linkIdB)
      layout(g(), comb)
      dirty()
      return id
    },
    add(combId, linkId) {
      const comb = find(combId)
      if (!comb) return false
      const ok = enroll(g(), comb, linkId)
      if (ok) layout(g(), comb)
      dirty()
      return ok
    },
    // Labels (harness + future sorting): read resolved lane names; pass `on`
    // to set the persisted toggle programmatically. Per gate; default out.
    labels(combId, on, which = 'out') {
      const comb = find(combId)
      if (!comb) return null
      const gate = comb[which === 'in' ? 'in' : 'out']
      if (on !== undefined) {
        if (on) gate.labels = true
        else delete gate.labels
        dirty()
      }
      return { on: !!gate.labels, list: comb.lanes.map((l) => laneLabel(g(), l)) }
    },
    remove(combId, linkId) {
      const comb = find(combId)
      if (!comb) return false
      const i = comb.lanes.findIndex((l) =>
        g().reroutes.get(l.in)?.linkIds?.has?.(Number(linkId))
      )
      if (i < 0) return false
      const l = comb.lanes.splice(i, 1)[0]
      g().removeReroute(l.in) // splices the chain; the link keeps flowing plain
      g().removeReroute(l.out)
      // A one-lane comb is no comb: combPass decomposes it, teeth become reroutes.
      dirty()
      return true
    },
    decompose(combId) {
      const recs = records(g())
      const i = recs.findIndex((c) => c.id === combId)
      if (i < 0) return false
      tplCache.delete(recs[i].id)
      recs.splice(i, 1)
      dirty()
      return true
    },
    move(combId, which, x, y) {
      const comb = find(combId)
      if (!comb || !comb[which]) return false
      comb[which].pos = [x, y]
      layout(g(), comb)
      dirty()
      return true
    },
    flip(combId, which) {
      const comb = find(combId)
      if (!comb || !comb[which]) return false
      comb[which].pins = comb[which].pins === 'left' ? 'right' : 'left'
      layout(g(), comb)
      dirty()
      return true
    },
    list() {
      return records(g()).map((c) => ({
        id: c.id,
        in: c.in,
        out: c.out,
        lanes: c.lanes.map((l) => ({ ...l }))
      }))
    },
    selection() {
      return gateSelectionKeys()
    }
  }
  window.__cablemanagementCombs = api
  return api
}
