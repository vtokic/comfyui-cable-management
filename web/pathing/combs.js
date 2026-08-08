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
// BUSES (bus round): a comb's out-gate can feed another comb wholesale through one
// connector, WAS-Bus style -- B's bus output to C's bus input stands in for wiring
// all of B's pins across. The HEAD comb (first in the chain) owns a channel table
// in its record: the identity and sticky type of every lane index, defined by the
// input set at the head (design decision, v1). Mirrors carry `bus.from` and copy
// the head's table verbatim -- full mirror, no subsetting. Under a bus, LANES
// OUTLIVE THEIR WIRES: a channel is a slot in the table, not a wire, so teeth are
// minted lazily where a wire actually rides and a dead lane nulls its teeth
// instead of sliding every index below it. A channel resolves to its nearest
// upstream local driver (override shadowing falls out of the walk); resolution
// MATERIALISES real links -- the graph always holds the true origin->consumer
// wire, so extension-off degradation still runs the overridden value.
//
// PoC surface: programmatic API only (window.__cablemanagementCombs). Gestures come after.
import { offsetStrand, route } from './router.js'
import { activeGraph } from '../graph.js'

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
    if (!ok) { arr.splice(i, 1); continue }
    // Bus fields are workflow data too: a head is {chan: [...]}, a mirror
    // {from: id}. Anything else under `bus` gets dropped -- the comb survives
    // as a plain comb, its teeth as plain reroutes (same degradation rule).
    if (c.bus != null) {
      const b = c.bus
      const shaped = typeof b === 'object' &&
        (typeof b.from === 'number' || Array.isArray(b.chan))
      if (!shaped) delete c.bus
      else if (Array.isArray(b.chan)) {
        b.chan = b.chan.filter((e) => e && typeof e === 'object')
      }
    }
  }
  return arr
}

// Derived gate geometry. pos is the gate rect's top-left; pins on `pins` side, the
// ribbon face is the opposite edge. Ribbon lanes centre on the gate's middle.
function gateGeom(gate, n) {
  const h = PAD * 2 + Math.max(0, n - 1) * PIN_PITCH
  const [x, y] = gate.pos
  const pinX = gate.pins === 'left' ? x : x + GATE_W
  const ribbonX = gate.pins === 'left' ? x + GATE_W : x
  return {
    rect: [x, y, GATE_W, h],
    pinX,
    ribbonX,
    centerY: y + h / 2,
    pinY: (i) => y + PAD + i * PIN_PITCH,
    laneY: (i) => y + h / 2 + (i - (n - 1) / 2) * PITCH,
    pinDir: gate.pins, // direction a pin-side wire extends away from the gate
    ribbonDir: gate.pins === 'left' ? 'right' : 'left'
  }
}

// rerouteId -> {comb, lane, side} rebuilt by combPass; consulted per drawLink.
let toothIndex = new Map()
const tplCache = new Map() // combId -> {stamp, tpl}

// Last frame's rider census per bussed lane: `${combId}|${ch}` -> {origin, riders,
// depth}. This is what makes override removal REVERT instead of orphan: when a
// lane dies, the census says who was riding it and whose output drove it. Restore
// fires ONLY if that origin node is GONE from the graph -- a deleted source takes
// its riders down in one core cascade, while a user unplugging consumers one by
// one leaves the origin standing, and those removals must stay removed.
let riderMemo = new Map()

function capRiders(graph, comb, tout) {
  const o = drivenBy(graph, tout)
  if (!o) return null
  const riders = []
  for (const id of tout.linkIds ?? []) {
    const ll = graph._links?.get?.(Number(id))
    if (ll) riders.push({ tid: ll.target_id, tslot: ll.target_slot })
  }
  return { origin: o.node.id, riders, depth: chainPath(graph, comb).length }
}

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
      const fl = graph.floatingLinks?.get?.(id)
      if (!fl) { r.floatingLinkIds.delete(id); continue }
      // Zombie float: the anchored end's node is gone. Core cleans real links on
      // node removal, but a parked float can outlive its source -- and it would
      // hold the lane "wired" forever (same failure class as the phantom ids),
      // which on a bussed lane also blocks the death event the restore keys on.
      const anchor = Number(fl.origin_id) !== -1 ? fl.origin_id : fl.target_id
      if (anchor != null && Number(anchor) !== -1 && !graph.getNodeById(anchor)) {
        graph.removeFloatingLink?.(fl)
        r.floatingLinkIds.delete(id)
      }
    }
  }
  const wired = (r) => {
    for (const id of r.linkIds ?? []) if (graph._links?.has?.(Number(id))) return true
    return (r.floatingLinkIds?.size ?? 0) > 0
  }
  busPass(graph, recs)
  const prevRiders = riderMemo
  const nextRiders = new Map()
  const deaths = [] // bussed lanes that lost their wires this frame
  for (let i = recs.length - 1; i >= 0; i--) {
    const comb = recs[i]
    if (comb.bus) {
      // Bussed lanes are CHANNELS: the identity is the head's table, not the wire,
      // so a dead lane nulls its teeth in place -- deleting it would slide every
      // index below and retarget every downstream override (bus round). Death and
      // survival both feed the rider census (restore-on-driver-death, below).
      comb.lanes.forEach((l, ch) => {
        const key = `${comb.id}|${ch}`
        const finish = (tout) => {
          const m = tout ? capRiders(graph, comb, tout) : null
          if (m) { nextRiders.set(key, m); return }
          const prev = prevRiders.get(key)
          if (prev) deaths.push({ comb, ch, memo: prev })
        }
        const tin = l.in != null ? graph.reroutes?.get?.(l.in) : null
        const tout = l.out != null ? graph.reroutes?.get?.(l.out) : null
        if (!tin || !tout) {
          // Missing teeth (ext-off deletion, undo): any survivor stays a plain dot.
          l.in = l.out = null
          finish(null)
          return
        }
        scrub(tin)
        scrub(tout)
        if (wired(tin) || wired(tout)) { finish(tout); return }
        graph.removeReroute(l.in)
        graph.removeReroute(l.out)
        l.in = l.out = null
        finish(null)
      })
      // No auto-decompose: an all-empty bussed comb is still a bus segment.
    } else {
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
    }
    layout(graph, comb, held)
    comb.lanes.forEach((l, lane) => {
      if (l.in != null) idx.set(l.in, { comb, lane, side: 'in' })
      if (l.out != null) idx.set(l.out, { comb, lane, side: 'out' })
    })
  }
  // Restore-on-driver-death: an override whose SOURCE died takes its riders down
  // in the same core cascade -- reconnect them from the next driver up, so
  // "disconnect an override and the channel reverts to what the bus provides".
  // The origin-alive guard is the whole design: wires removed while their source
  // still stands were removed on purpose and stay removed. Deepest lanes first,
  // so a rider tapped far down re-splices its full run; the input-empty check
  // makes shallower death entries for the same rider no-ops.
  if (deaths.length) {
    deaths.sort((a, b) => (b.memo.depth ?? 0) - (a.memo.depth ?? 0))
    let restored = false
    for (const d of deaths) {
      if (!d.memo.riders?.length) continue
      if (graph.getNodeById(d.memo.origin)) continue
      for (const rd of d.memo.riders) {
        const tn = graph.getNodeById(rd.tid)
        if (!tn || tn.inputs?.[rd.tslot]?.link != null) continue
        if (tapChannel(graph, d.comb, d.ch, tn, rd.tslot)) restored = true
      }
    }
    if (restored) {
      // Freshly minted teeth must hit-test and render as teeth THIS frame.
      idx.clear()
      for (const comb of recs) {
        comb.lanes.forEach((l, lane) => {
          if (l.in != null) idx.set(l.in, { comb, lane, side: 'in' })
          if (l.out != null) idx.set(l.out, { comb, lane, side: 'out' })
        })
      }
    }
  }
  riderMemo = nextRiders
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

// ---- bus bookkeeping -------------------------------------------------------------

const nextChanId = (chan) => chan.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1

// The type a lane's riding wire carries, for the head table's sticky types.
function laneType(graph, l) {
  for (const id of [l?.in, l?.out]) {
    const r = id != null ? graph.reroutes?.get?.(id) : null
    const t = r?.firstLink?.type ?? r?.firstFloatingLink?.type
    if (t != null) return t
  }
  return null
}

// Head-first chain of bus segments ending at `comb`. Plain combs are their own
// one-element chain (taps then just ride the comb's own teeth).
function chainPath(graph, comb) {
  const byId = new Map(records(graph).map((c) => [c.id, c]))
  const path = [comb]
  const seen = new Set([comb.id])
  let cur = comb
  while (cur.bus?.from != null) {
    const up = byId.get(cur.bus.from)
    if (!up || seen.has(up.id)) break // orphans/cycles: busPass repairs, this only reads
    path.unshift(up)
    seen.add(up.id)
    cur = up
  }
  return path
}

export function headOf(graph, comb) {
  return chainPath(graph, comb)[0]
}

// `comb` plus every mirror hanging off it, shallow-to-deep (spawn allows trees:
// one out-gate may feed several mirrors, and full-mirror semantics per branch
// need nothing extra).
function busSubtree(graph, comb) {
  const recs = records(graph)
  const out = [comb]
  for (let i = 0; i < out.length; i++) {
    for (const c of recs) {
      if (c.bus?.from === out[i].id && !out.includes(c)) out.push(c)
    }
  }
  return out
}

// The output that actually drives whatever rides this tooth: a real link's origin,
// or a parked float's -- a float dangling at its SOURCE (origin -1) drives nothing.
function drivenBy(graph, r) {
  if (!r) return null
  const ll = r.firstLink
  if (ll) {
    const n = graph.getNodeById(ll.origin_id)
    if (n) return { node: n, slot: ll.origin_slot }
  }
  const fl = r.firstFloatingLink
  if (fl && Number(fl.origin_id) !== -1) {
    const n = graph.getNodeById(fl.origin_id)
    if (n) return { node: n, slot: fl.origin_slot }
  }
  return null
}

// Once per frame, before the lane GC: cross-record repair and the full-mirror sync.
// Orphaned mirrors (head record gone, or a `from` cycle from corrupt data) promote
// to heads of whatever chain remains -- indices survive, types refill from wires.
function busPass(graph, recs) {
  const byId = new Map(recs.map((c) => [c.id, c]))
  for (const c of recs) {
    if (c.bus?.from == null) continue
    const seen = new Set([c.id])
    let p = byId.get(c.bus.from)
    let bad = !p
    while (!bad && p) {
      if (seen.has(p.id)) { bad = true; break }
      seen.add(p.id)
      if (p.bus?.from == null) break
      p = byId.get(p.bus.from)
      if (!p) bad = true
    }
    if (bad) c.bus = { chan: c.lanes.map(() => ({ id: 0, type: null })) }
  }
  // Heads: the table tracks lane growth (enrolling at the head is how a bus gains
  // a channel) and sticky types pin at first drive -- otherwise unplugging the
  // head driver would let a downstream override silently redefine the bus type.
  for (const c of recs) {
    const chan = c.bus?.chan
    if (!chan) continue
    for (const e of chan) if (!Number(e.id)) e.id = nextChanId(chan)
    while (chan.length < c.lanes.length) chan.push({ id: nextChanId(chan), type: null })
    while (c.lanes.length < chan.length) c.lanes.push({ in: null, out: null })
    chan.forEach((e, i) => {
      if (e.type == null) e.type = laneType(graph, c.lanes[i])
    })
  }
  // Mirrors: lane count follows the head's table exactly (full mirror, v1). A
  // truncated lane's teeth go with it -- they can only exist for channels the
  // head no longer has, which v1 never produces, but corrupt data might.
  for (const c of recs) {
    if (c.bus?.from == null) continue
    const n = headOf(graph, c)?.bus?.chan?.length ?? 0
    while (c.lanes.length < n) c.lanes.push({ in: null, out: null })
    while (c.lanes.length > n) {
      const l = c.lanes.pop()
      for (const id of [l?.in, l?.out]) {
        if (id != null && graph.reroutes?.get?.(id)) graph.removeReroute(id)
      }
    }
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
  const off = (lane - (n - 1) / 2) * PITCH
  const a = [gi.ribbonX, gi.laneY(lane)]
  const b = [go.ribbonX, go.laneY(lane)]
  const halfRibbon = Math.ceil(((n - 1) * PITCH) / 2)

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
  if (dirOut === -dirIn && gap >= -GATE_W && gap < 2 * (clearance + halfRibbon)) {
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
        enforceStart: true, // gate faces are binding (flip round)
        enforceEnd: true
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

// ---- buses -----------------------------------------------------------------------
// One connector standing in for the whole ribbon. The trunk between two bussed
// combs is drawn once as furniture (a sheath) and every tapped channel's real
// gap segment renders along the SAME polyline -- coincident strokes read as one
// fat cable, and hit-testing rides the Path2D like any link. Nothing about the
// bus itself is a graph construct: the record is grouping data, the wires are
// ordinary links materialised through the teeth, so extension-off degradation
// keeps every value flowing (the trunk just unbundles into strands).

const BUS_TAB = 14 // the notch below the gate body that carries the bus pin

// The bus pin's tab, hung BELOW the body so lane geometry (h, centerY, laneY)
// stays byte-identical for existing workflows' combs -- growing the body would
// shift every ribbon centreline in saved graphs.
export function busPinRect(gate, n) {
  const g = gateGeom(gate, n)
  return [g.rect[0] + g.rect[2] / 2 - 6, g.rect[1] + g.rect[3], 12, BUS_TAB]
}

export function busNotch(gate, n) {
  const [x, y, w, h] = busPinRect(gate, n)
  return [x + w / 2, y + h - 5]
}

// Trunk polyline between a comb's out-gate bus pin and its mirror's in-gate bus
// pin. One routed template per pair (same cache as ribbon templates); both stubs
// point down and are binding, so the trunk always leaves through the notch.
export function busTrunk(graph, up, down, obstacles, clearance, version) {
  const a = busNotch(up.out, up.lanes.length)
  const b = busNotch(down.in, down.lanes.length)
  const stamp = `${up.out.pos}|${up.lanes.length}|${down.in.pos}|${down.lanes.length}|v${version}`
  const key = `bus|${down.id}`
  let cached = tplCache.get(key)
  if (!cached || cached.stamp !== stamp) {
    let tpl = route({
      start: a,
      end: b,
      startDir: 'down',
      endDir: 'down',
      obstacles,
      clearance,
      stubStart: 10,
      stubEnd: 10,
      enforceStart: true,
      enforceEnd: true
    })
    // route() only returns null on A* failure here (down/down never takes the
    // trivial-straight early-out): drop below both gates and run across.
    if (!tpl) {
      const my = Math.max(a[1], b[1]) + 24
      tpl = clean([a, [a[0], my], [b[0], my], b])
    }
    cached = { stamp, tpl }
    tplCache.set(key, cached)
  }
  return cached.tpl
}

// [up, down] pairs for every live bus edge, for trunk drawing and crossing checks.
export function busSegments(graph) {
  const recs = records(graph)
  const byId = new Map(recs.map((c) => [c.id, c]))
  const out = []
  for (const c of recs) {
    if (c.bus?.from == null) continue
    const up = byId.get(c.bus.from)
    if (up) out.push([up, c])
  }
  return out
}

// {up, down, lane} when the two teeth are the out/in pair of one channel across a
// bus edge -- the segment IS the trunk (registry diverts it like a ribbon crossing).
export function busCrossing(sRid, eRid) {
  const a = toothIndex.get(sRid), b = toothIndex.get(eRid)
  if (!a || !b || a.comb === b.comb || a.lane !== b.lane) return null
  if (a.side !== 'out' || b.side !== 'in') return null
  if (b.comb.bus?.from !== a.comb.id) return null
  return { up: a.comb, down: b.comb, lane: a.lane }
}

// One channel's gap segment: pin, a shared gutter just outside the pin column
// gathering strands down to the notch, the trunk template, and the mirror image
// into the downstream in-gate. Everything past the gutter is IDENTICAL for every
// channel, so the strokes overdraw into one cable inside the furniture sheath.
export function busCrossingPts(graph, up, down, lane, obstacles, clearance, version) {
  const gU = gateGeom(up.out, up.lanes.length)
  const gD = gateGeom(down.in, down.lanes.length)
  const tpl = busTrunk(graph, up, down, obstacles, clearance, version)
  const gxU = gU.pinX + (gU.pinDir === 'right' ? 8 : -8)
  const gxD = gD.pinX + (gD.pinDir === 'right' ? 8 : -8)
  const a = tpl[0], b = tpl[tpl.length - 1]
  return clean([
    [gU.pinX, gU.pinY(lane)],
    [gxU, gU.pinY(lane)],
    [gxU, a[1]],
    ...tpl,
    [gxD, b[1]],
    [gxD, gD.pinY(lane)],
    [gD.pinX, gD.pinY(lane)]
  ])
}

// In-flight bus pull preview (gesture layer feeds it; drawTrunks renders it).
let busPreviewState = null // {from: comb, to: [x, y]}

export function setBusPreview(p) {
  busPreviewState = p
}

export function getBusPreview() {
  return busPreviewState
}

// Pin index under a graph-space y on one gate, clamped to the pin column.
export function pinIndexAt(comb, which, gy) {
  const n = comb.lanes.length
  if (!n) return -1
  const i = Math.round((gy - (comb[which].pos[1] + PAD)) / PIN_PITCH)
  return Math.max(0, Math.min(n - 1, i))
}

// Birth a mirror off `from`'s bus pin. First spawn promotes a plain comb to head:
// its CURRENT input set becomes the channel table ("the input set at A defines
// the type of the bus and the identities of all connection indices", v1 spec).
export function busSpawn(graph, from, x, y) {
  if (!from) return null
  if (!from.bus) {
    from.bus = { chan: from.lanes.map((l, i) => ({ id: i + 1, type: laneType(graph, l) })) }
  }
  const head = headOf(graph, from)
  const chan = head?.bus?.chan
  if (!chan) return null
  const recs = records(graph, true)
  const id = recs.reduce((m, c) => Math.max(m, c.id), 0) + 1
  const h = PAD * 2 + Math.max(0, chan.length - 1) * PIN_PITCH
  const cy = y - h / 2
  const comb = {
    id,
    in: { pos: [x - GATE_W, cy], pins: 'left' },
    out: { pos: [x, cy], pins: 'right' }, // adjacent, touching -- same birth shape as gestureCreate
    lanes: chan.map(() => ({ in: null, out: null })),
    bus: { from: from.id }
  }
  recs.push(comb)
  return comb
}

// Nearest local driver at or above `comb` for channel k, plus the deepest tooth
// already on that driver's spine -- new riders and new teeth splice in below it.
function channelSource(graph, comb, k) {
  const path = chainPath(graph, comb)
  let di = -1, origin = null
  for (let i = path.length - 1; i >= 0; i--) {
    const r = graph.reroutes?.get?.(path[i].lanes[k]?.out)
    const o = drivenBy(graph, r)
    if (o) { di = i; origin = o; break }
  }
  if (di < 0) return null
  let ai = di
  while (ai + 1 < path.length && graph.reroutes?.get?.(path[ai + 1].lanes[k]?.out)) ai++
  return { path, origin, afterR: graph.reroutes.get(path[ai].lanes[k].out), ai }
}

// Colour for an empty channel pin: the nearest riding tooth's wire colour, else
// the sticky type's palette colour -- a ring says "this value is available here".
export function channelColour(graph, comb, k, canvas) {
  const path = chainPath(graph, comb)
  for (let i = path.length - 1; i >= 0; i--) {
    for (const side of ['out', 'in']) {
      const r = graph.reroutes?.get?.(path[i].lanes[k]?.[side])
      if (r && (r.firstLink || r.firstFloatingLink)) {
        if (r._colour) return r._colour
        break
      }
    }
  }
  const t = headOf(graph, comb)?.bus?.chan?.[k]?.type
  if (t == null) return null
  return canvas?.link_type_colors?.[t] ?? window.LGraphCanvas?.link_type_colors?.[t] ?? canvas?.default_link_color ?? null
}

// Materialise channel k into a real link driver->target. The chain reuses every
// tooth already on the spine (shared strands, core fan-out) and mints the missing
// ones comb by comb, so the wire draws through every gate and trunk it crosses.
// A float parked on the spine stays -- it is what keeps the channel driven at
// this segment when the last real rider unplugs.
export function tapChannel(graph, comb, k, targetNode, targetSlot) {
  const src = channelSource(graph, comb, k)
  if (!src || !targetNode) return null
  const { path, origin, afterR, ai } = src
  const link = origin.node.connect(origin.slot, targetNode, targetSlot, afterR.id)
  if (!link) return null
  // Cores without the afterRerouteId connect param leave the link chainless;
  // either way the walk below is idempotent (linkIds is a Set).
  if (link.parentId !== afterR.id) link.parentId = afterR.id
  for (let r = afterR; r; r = r.parentId != null ? graph.reroutes.get(r.parentId) : null) {
    r.linkIds?.add?.(link.id)
  }
  const ti = path.indexOf(comb)
  for (let i = ai + 1; i <= ti; i++) {
    const tIn = mint(graph, link)
    const tOut = tIn && mint(graph, link)
    if (!tIn || !tOut) break
    path[i].lanes[k] = { in: tIn.id, out: tOut.id }
    layout(graph, path[i])
  }
  return link
}

// Park an in-flight (or programmatic) pull of channel k as a chained FLOAT ending
// at this comb's out tooth: teeth splice through every intermediate comb, and the
// terminus is exactly the dangling-lane limbo state the out-tooth pull gesture
// already resumes -- so "drag off an empty pin" is core's own drag end to end.
export function busTapFloat(graph, comb, k) {
  const src = channelSource(graph, comb, k)
  if (!src) return null
  const { path, origin, afterR, ai } = src
  const ti = path.indexOf(comb)
  if (ti <= ai) return null // a tooth already sits here; core's pull owns it
  const fromSlot = origin.node.outputs?.[origin.slot]
  if (!fromSlot || !origin.node.connectFloatingReroute) return null
  const terminus = origin.node.connectFloatingReroute([0, 0], fromSlot, afterR.id)
  if (!terminus) return null
  for (let i = ai + 1; i <= ti; i++) {
    const last = i === ti
    const tIn = mint(graph, terminus)
    if (!tIn) return null
    const tOut = last ? terminus : mint(graph, terminus)
    if (!tOut) return null
    path[i].lanes[k] = { in: tIn.id, out: tOut.id }
    layout(graph, path[i])
  }
  return terminus
}

// Override channel k at a mirror: the dropped output becomes the channel's local
// driver from this segment down. covered.js's rule, generalised from a widget
// literal to a channel: when a covering source appears, every shadowed consumer
// migrates onto it EAGERLY -- the graph then literally holds y->consumer, and
// uninstalling the extension keeps the overridden value flowing. The old spine
// below this comb is cleared first (its teeth belong to the shadowed driver's
// chain); upstream segments keep their wires untouched, so a tap at B still
// reads the head's value. The override is symmetric: deleting its source (or
// pulling its strand out of the gate) reverts the channel -- riders re-tap from
// the upstream driver (restore-on-driver-death in combPass, detachLane).
export function busOverrideFrom(graph, comb, k, node, fromSlot, fromRerouteId) {
  if (comb.bus?.from == null || !fromSlot || !node?.connectFloatingReroute) return false
  const chan = headOf(graph, comb)?.bus?.chan?.[k]
  if (!chan) return false
  const t = fromSlot.type
  // Frontend-only construct: nothing downstream validates, so the drop must.
  if (chan.type != null && t != null && chan.type !== '*' && t !== '*' && chan.type !== t) return false
  const subtree = busSubtree(graph, comb)
  const riders = new Map() // linkId -> {tid, tslot, comb}; deepest segment wins (BFS order)
  for (const s of subtree) {
    const r = graph.reroutes?.get?.(s.lanes[k]?.out)
    for (const id of r?.linkIds ?? []) {
      const ll = graph._links?.get?.(Number(id))
      if (ll) riders.set(Number(id), { tid: ll.target_id, tslot: ll.target_slot, comb: s })
    }
  }
  for (const s of subtree) {
    const lane = s.lanes[k]
    for (const side of ['in', 'out']) {
      const r = lane?.[side] != null ? graph.reroutes?.get?.(lane[side]) : null
      if (!r) continue
      // Floats first: removeReroute heals chains for links, but a float whose
      // terminus vanishes is core-GC territory we'd rather not lean on.
      for (const fid of [...(r.floatingLinkIds ?? [])]) {
        const fl = graph.floatingLinks?.get?.(fid)
        if (fl) graph.removeFloatingLink?.(fl)
      }
      graph.removeReroute(r.id)
    }
    if (lane) lane.in = lane.out = null
  }
  const terminus = node.connectFloatingReroute([0, 0], fromSlot, fromRerouteId ?? undefined)
  if (!terminus) return false
  const rIn = mint(graph, terminus)
  if (!rIn) return false
  comb.lanes[k] = { in: rIn.id, out: terminus.id }
  if (chan.type == null && t != null) chan.type = t
  layout(graph, comb)
  for (const [id, rd] of riders) {
    const tn = graph.getNodeById(rd.tid)
    graph.removeLink?.(Number(id))
    if (tn) tapChannel(graph, rd.comb, k, tn, rd.tslot)
  }
  return true
}

// Drop resolution for in-flight link drags over a bussed gate (called from the
// dropOnNothing seam ahead of gate parking). Input-drags tap the channel under
// the pointer from either gate; output-drags override it, mirrors' in-gate only.
export function busGateDrop(graph, lc, hit, dropY) {
  const comb = hit.comb
  if (!comb.bus) return false
  const rls = lc?.renderLinks ?? []
  if (!rls.length) return false
  const k = pinIndexAt(comb, hit.which, dropY)
  if (k < 0) return false
  const to = lc.state?.connectingTo
  if (to === 'output') {
    // Input seeking a source: feed it from the channel (tap).
    let made = false
    for (const rl of rls) {
      const node = rl?.node
      const slot = node?.inputs?.indexOf?.(rl.fromSlot) ?? -1
      if (slot < 0) continue
      if (tapChannel(graph, comb, k, node, slot)) made = true
    }
    return made
  }
  if (to === 'input' && comb.bus.from != null && hit.which === 'in') {
    for (const rl of rls) {
      if (!rl?.node?.connectFloatingReroute || !rl.fromSlot) continue
      // One channel, one driver: the first connectable render link wins.
      if (busOverrideFrom(graph, comb, k, rl.node, rl.fromSlot, rl.fromReroute?.id)) return true
    }
  }
  return false
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
export function glyphRect(gate, n) {
  const g = gateGeom(gate, n)
  return [g.rect[0] + g.rect[2] / 2 - 6, g.rect[1] + 3, 12, 12]
}

// Hit-test a graph point against every gate. zone: 'flip' (hover glyph), 'body'
// (draggable panel), 'pins' (the tooth strip -- left for core's reroute handling).
export function combAt(graph, x, y) {
  for (const comb of records(graph)) {
    const n = comb.lanes.length
    for (const which of ['in', 'out']) {
      // Bus pin tab: out-gates always wear one (it is how a bus starts); in-gates
      // only once bussed. Checked first -- the tab hangs outside the body rect.
      if (which === 'out' || comb.bus?.from != null) {
        const [bx, by, bw, bh] = busPinRect(comb[which], n)
        if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
          return { comb, which, zone: 'bus' }
        }
      }
      const gl = glyphRect(comb[which], n)
      if (
        hover?.id === comb.id && hover.which === which &&
        x >= gl[0] && x <= gl[0] + gl[2] && y >= gl[1] && y <= gl[1] + gl[3]
      ) return { comb, which, zone: 'flip' }
      const [rx, ry, rw, rh] = gateGeom(comb[which], n).rect
      if (x < rx || x > rx + rw || y < ry || y > ry + rh) continue
      const strip = comb[which].pins === 'left' ? x <= rx + 10 : x >= rx + rw - 10
      return { comb, which, zone: strip ? 'pins' : 'body' }
    }
  }
  return null
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

// Replace a free reroute with a tooth pair inheriting its chain slot AND its whole
// linkIds set -- a junction reroute becomes one lane feeding all its branches, so
// manifold fan-out survives enrollment.
function absorb(graph, comb, reroute) {
  const tIn = mint(graph, reroute)
  const tOut = mint(graph, reroute)
  if (!tIn || !tOut) return false
  graph.removeReroute(reroute.id)
  comb.lanes.push({ in: tIn.id, out: tOut.id })
  return true
}

const sharesLink = (a, b) => {
  for (const id of a.linkIds ?? []) if (b.linkIds?.has?.(id)) return true
  return false
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

// Reroute dropped onto a gate (or onto a tooth): append as the last lane.
export function gestureEnroll(graph, comb, reroute) {
  if (toothIndex.has(reroute.id)) return false
  // Full mirror: a mirror's lane set IS the head's table -- local additions land
  // as overrides via the pin drop, never as appended lanes.
  if (comb.bus?.from != null) return false
  for (const l of comb.lanes) {
    const t = l.in != null ? graph.reroutes.get(l.in) : null
    if (t && sharesLink(t, reroute)) return false
  }
  const ok = absorb(graph, comb, reroute)
  if (ok) {
    // Enrolling at a HEAD grows the bus: the new channel appears on every mirror
    // at once (busPass syncs the count) -- the whole point of the shorthand.
    if (comb.bus?.chan) {
      comb.bus.chan.push({ id: nextChanId(comb.bus.chan), type: laneType(graph, comb.lanes[comb.lanes.length - 1]) })
    }
    layout(graph, comb)
  }
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
  // Mirrors never grow lanes locally (full mirror): the drop falls through to
  // core, which offers its usual release semantics.
  if (comb.bus?.from != null) return false
  const rls = lc?.renderLinks ?? []
  const before = comb.lanes.length
  let made = false
  for (const rl of rls) {
    if (!rl?.node?.connectFloatingReroute || !rl.fromSlot) continue
    if (rl.toType !== 'input' && rl.toType !== 'output') continue
    const terminus = rl.node.connectFloatingReroute([0, 0], rl.fromSlot, rl.fromReroute?.id)
    if (!terminus) continue
    const rIn = mint(graph, terminus)
    if (!rIn) continue
    // Chain order is [rIn, terminus] both ways; only which end dangles differs
    // (output-drag: terminus is the would-be input end; input-drag: rIn is the
    // would-be source end and the terminus sits nearest the real input).
    comb.lanes.push({ in: rIn.id, out: terminus.id })
    made = true
  }
  if (made) {
    // Parking on a HEAD grows the bus: the new channel appears on every mirror
    // at once (busPass syncs the count) -- the point of the shorthand.
    if (comb.bus?.chan) {
      for (let i = before; i < comb.lanes.length; i++) {
        comb.bus.chan.push({ id: nextChanId(comb.bus.chan), type: laneType(graph, comb.lanes[i]) })
      }
    }
    layout(graph, comb)
  }
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
    if (sides.has('in') && lane.in != null) graph.removeReroute(lane.in)
    if (sides.has('out') && lane.out != null) graph.removeReroute(lane.out)
  }
  recs.splice(i, 1)
  healBusChildren(recs, comb)
  tplCache.delete(comb.id)
  tplCache.delete(`bus|${comb.id}`)
  gateSel.delete(selKey(comb, 'in'))
  gateSel.delete(selKey(comb, 'out'))
  return true
}

// Bus chain healing on comb removal: children of a vanished mirror re-parent past
// it (the chain closes up); children of a vanished HEAD each inherit a copy of
// the table and carry on as heads of their branches -- channel identity is data,
// not a live reference, so the split costs nothing.
function healBusChildren(recs, comb) {
  for (const c of recs) {
    if (c.bus?.from !== comb.id) continue
    if (comb.bus?.from != null) c.bus = { from: comb.bus.from }
    else if (comb.bus?.chan) c.bus = { chan: comb.bus.chan.map((e) => ({ ...e })) }
    // else: parent was never bussed (corrupt) -- busPass promotes the orphan.
  }
}

// Pulling an in-tooth away detaches its lane: the partner out-tooth dissolves and
// the pulled dot stays under the pointer as a plain reroute ("pulling from 'in'
// disconnects; the dragging reroute IS the tooth"). Out-teeth never detach -- the
// next combPass snaps them home.
export function detachLane(graph, comb, rid) {
  const i = comb.lanes.findIndex((l) => l.in === rid)
  if (i < 0) return false
  if (comb.bus) {
    // Channels keep their index: the strand rips out, the slot stays. Which wires
    // leave with the dot depends on what the strand IS. A spliced-through tap
    // (driver upstream) follows the dot -- standard comb detach. An OVERRIDE
    // strand reverts the channel instead: its riders re-tap from the next driver
    // up, and only the override's own feed leaves with the pulled dot (which may
    // evaporate under the pointer when no float rides it -- the override is gone,
    // that is the point). Same contract as restore-on-driver-death in combPass:
    // disconnecting an override reverts consumers to what the bus provides.
    const lane = comb.lanes[i]
    const tout = lane.out != null ? graph.reroutes?.get?.(lane.out) : null
    let riders = null
    if (comb.bus.from != null && tout) {
      const local = drivenBy(graph, tout)
      const upComb = records(graph).find((c) => c.id === comb.bus.from)
      const up = upComb ? channelSource(graph, upComb, i) : null
      if (local && up && (up.origin.node !== local.node || up.origin.slot !== local.slot)) {
        riders = []
        for (const id of tout.linkIds ?? []) {
          const ll = graph._links?.get?.(Number(id))
          if (!ll) continue
          const tail = toothOf(ll.parentId)
          riders.push({ id: Number(id), tid: ll.target_id, tslot: ll.target_slot, comb: tail?.comb ?? comb })
        }
      }
    }
    if (tout) graph.removeReroute(lane.out)
    comb.lanes[i] = { in: null, out: null }
    for (const rd of riders ?? []) {
      const tn = graph.getNodeById(rd.tid)
      graph.removeLink?.(rd.id)
      if (tn) tapChannel(graph, rd.comb, i, tn, rd.tslot)
    }
    return true
  }
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
function drawGate(ctx, graph, comb, which, sel, canvas, busLinked) {
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
  comb.lanes.forEach((l, i) => {
    const t = l[which] != null ? graph.reroutes?.get?.(l[which]) : null
    ctx.beginPath()
    ctx.arc(g.pinX, g.pinY(i), 4, 0, Math.PI * 2)
    if (t) {
      ctx.fillStyle = t._colour ?? canvas?.default_link_color ?? '#999'
      ctx.fill()
      ctx.strokeStyle = body
      ctx.lineWidth = 1
      ctx.stroke()
    } else {
      // A wireless bus channel is still a slot in the table. Ring in the driver's
      // colour when the value is available somewhere upstream ("plug here and you
      // get it"); a plain dark socket when nothing drives the channel at all.
      const dc = comb.bus ? channelColour(graph, comb, i, canvas) : null
      ctx.fillStyle = body
      ctx.fill()
      ctx.strokeStyle = dc ?? (L?.NODE_DEFAULT_BOXCOLOR ?? '#666')
      ctx.lineWidth = dc ? 1.5 : 1
      ctx.stroke()
    }
  })
  // Bus pin tab (bus round): every out-gate advertises one; in-gates wear one
  // once bussed. The dot fills when a trunk is attached on that side.
  if (which === 'out' || comb.bus?.from != null) {
    const [bx, by, bw, bh] = busPinRect(comb[which], n)
    ctx.beginPath()
    ctx.roundRect(bx, by - 2, bw, bh + 2, [0, 0, 4, 4])
    ctx.fillStyle = body
    ctx.fill()
    ctx.strokeStyle = L?.NODE_DEFAULT_BOXCOLOR ?? '#666'
    ctx.lineWidth = 1
    ctx.stroke()
    const linked = which === 'in' ? comb.bus?.from != null : busLinked
    ctx.beginPath()
    ctx.arc(bx + bw / 2, by + bh - 5, 3, 0, Math.PI * 2)
    if (linked) {
      ctx.fillStyle = L?.NODE_TITLE_COLOR ?? '#999'
      ctx.fill()
    } else {
      ctx.strokeStyle = L?.NODE_TITLE_COLOR ?? '#999'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
  // Flow caret (polish round): the IN gate points pins->ribbon, the OUT gate
  // ribbon->pins -- both read as travel direction, so a comb scans source-to-sink
  // at a glance and the two gates are tellable apart.
  const dir = which === 'in' ? g.ribbonDir : g.pinDir
  const cx = g.rect[0] + g.rect[2] / 2
  const dx = dir === 'right' ? 3 : -3
  ctx.strokeStyle = L?.NODE_TITLE_COLOR ?? '#999'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(cx - dx, g.centerY - 4)
  ctx.lineTo(cx + dx, g.centerY)
  ctx.lineTo(cx - dx, g.centerY + 4)
  ctx.stroke()
  if (hover?.id === comb.id && hover.which === which) {
    // flip glyph: paired chevrons above the gate (no text, path only)
    const [gx, gy, gw, gh] = glyphRect(comb[which], n)
    const cy = gy + gh / 2
    ctx.strokeStyle = L?.NODE_TITLE_COLOR ?? '#999'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(gx + 5, cy - 4); ctx.lineTo(gx + 1, cy); ctx.lineTo(gx + 5, cy + 4)
    ctx.moveTo(gx + gw - 5, cy - 4); ctx.lineTo(gx + gw - 1, cy); ctx.lineTo(gx + gw - 5, cy + 4)
    ctx.stroke()
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
  const parents = new Set() // combs whose bus pin has at least one mirror attached
  for (const comb of recs) {
    gates.push([comb, 'in'], [comb, 'out'])
    if (comb.bus?.from != null) parents.add(comb.bus.from)
  }
  gates.sort((a, b) => (isGateSelected(a[0], a[1]) ? 1 : 0) - (isGateSelected(b[0], b[1]) ? 1 : 0))
  const octx = overlayCtx(canvas)
  for (const [comb, which] of gates) {
    drawGate(octx, graph, comb, which, isGateSelected(comb, which), canvas, parents.has(comb.id))
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
    remove(combId, linkId) {
      const comb = find(combId)
      if (!comb) return false
      const i = comb.lanes.findIndex((l) =>
        g().reroutes.get(l.in)?.linkIds?.has?.(Number(linkId))
      )
      if (i < 0) return false
      const l = comb.lanes[i]
      g().removeReroute(l.in) // splices the chain; the link keeps flowing plain
      g().removeReroute(l.out)
      // Bussed lanes are channels: the slot stays, indices never slide.
      if (comb.bus) comb.lanes[i] = { in: null, out: null }
      else comb.lanes.splice(i, 1)
      // A one-lane comb is no comb: combPass decomposes it, teeth become reroutes.
      dirty()
      return true
    },
    decompose(combId) {
      const recs = records(g())
      const i = recs.findIndex((c) => c.id === combId)
      if (i < 0) return false
      const comb = recs[i]
      tplCache.delete(comb.id)
      tplCache.delete(`bus|${comb.id}`)
      recs.splice(i, 1)
      healBusChildren(recs, comb)
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
        lanes: c.lanes.map((l) => ({ ...l })),
        bus: c.bus ? JSON.parse(JSON.stringify(c.bus)) : null
      }))
    },
    selection() {
      return gateSelectionKeys()
    },
    // ---- bus surface (bus round; same PoC contract as the comb API) ----
    bus: {
      // Birth a mirror of `fromId`'s bus at (x, y); promotes a plain comb to head.
      spawn(fromId, x, y) {
        const c = busSpawn(g(), find(fromId), x, y)
        dirty()
        return c?.id ?? null
      },
      // Materialise channel `ch` into a real link driver -> node input.
      tap(combId, ch, nodeId, inputIndex) {
        const comb = find(combId)
        const node = comb ? g().getNodeById(Number(nodeId)) ?? g().getNodeById(nodeId) : null
        const link = comb && node ? tapChannel(g(), comb, ch, node, inputIndex) : null
        dirty()
        return link?.id ?? null
      },
      // Park channel `ch` as a dangling float ending at this comb's out tooth.
      float(combId, ch) {
        const t = busTapFloat(g(), find(combId), ch)
        dirty()
        return t?.id ?? null
      },
      // Drive channel `ch` from nodeId's output at this mirror; shadowed
      // downstream consumers migrate onto the new driver.
      override(combId, ch, nodeId, outputIndex) {
        const comb = find(combId)
        const node = comb ? g().getNodeById(Number(nodeId)) ?? g().getNodeById(nodeId) : null
        const slot = node?.outputs?.[outputIndex]
        const ok = comb && node && slot ? busOverrideFrom(g(), comb, ch, node, slot, null) : false
        dirty()
        return ok
      },
      info(combId) {
        const c = find(combId)
        if (!c?.bus) return null
        return {
          from: c.bus.from ?? null,
          chan: (headOf(g(), c)?.bus?.chan ?? []).map((e) => ({ ...e }))
        }
      }
    }
  }
  window.__cablemanagementCombs = api
  return api
}
