// Route cache + obstacle snapshot + nudge orchestration. Routes recompute only when
// their inputs change and never while the pointer is down (R6): a stale/missing route
// falls back to core's spline, which is exactly the wanted during-drag rendering.
import { offsetStrand, route } from './router.js'
import { measure } from './trace.js'
import { nudgePass } from './nudge.js'
import {
  busCrossing, busCrossingPts, busSegments, busTrunk, combCrossing, combPass,
  crossingPts, gateRects, getBusPreview, busNotch, toothOf
} from './combs.js'

const cache = new Map() // linkId|sx|sy|ex|ey -> {key, raw, pts, m, version}
let obstacles = []
let version = 0
let tick = 0 // frame counter; routeFor stamps every entry it serves
let lastHash = ''
let lastRouteStamp = ''

// Called from the wrapped drawConnections, once per frame, before core renders.
export function beginFrame(canvas) {
  const graph = canvas.graph
  if (!graph) return
  combPass(graph, canvas) // validate records, snap teeth (except held ones), rebuild index
  let hash = ''
  const rects = []
  for (const node of graph._nodes) {
    const r = node.boundingRect ?? [node.pos[0], node.pos[1], node.size[0], node.size[1]]
    rects.push([r[0], r[1], r[2], r[3]])
    hash += `${node.id}|${r[0] | 0}|${r[1] | 0}|${r[2] | 0}|${r[3] | 0}|${node.flags?.collapsed ? 1 : 0};`
  }
  // Comb gate bodies obstruct like nodes (and their inflated edges are the wrap
  // lanes a flipped face needs). combPass above already snapped the geometry.
  for (const r of gateRects(graph)) {
    rects.push([r[0], r[1], r[2], r[3]])
    hash += `G|${r[0] | 0}|${r[1] | 0}|${r[2] | 0}|${r[3] | 0};`
  }
  if (hash !== lastHash) {
    lastHash = hash
    obstacles = rects
    version++
    if (cache.size > 4096) cache.clear()
  }

  // Reconcile bundles, then nudge, whenever the set of live routes changed. Routes
  // computed during THIS frame's draw get both passes next frame -- one-frame settle.
  //
  // Liveness needs more than the version stamp: slot positions settle over a couple of
  // mount frames while every node RECT stays put, so an entry made from the rough
  // default endpoints keeps the current version forever and would join nudge clusters
  // as a ghost segment on top of its refined twin. An entry that stopped being DRAWN
  // while sitting inside the viewport is such a ghost; one that is silent because it
  // scrolled out of view (the cull skips it) stays live so panning does not reflow lanes.
  const va = canvas.visible_area
  const live = []
  for (const e of cache.values()) {
    if (!e.raw || e.version !== version) continue
    let keep = e.tick >= tick - 2 || !va
    if (!keep) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const p of e.raw) {
        if (p[0] < x0) x0 = p[0]
        if (p[0] > x1) x1 = p[0]
        if (p[1] < y0) y0 = p[1]
        if (p[1] > y1) y1 = p[1]
      }
      keep = x1 < va[0] || x0 > va[0] + va[2] || y1 < va[1] || y0 > va[1] + va[3]
    }
    e.live = keep
    if (keep) live.push(e)
  }
  tick++
  const changed = reconcileBundles(live)
  const stamp = live.map((e) => e.key).join(';') + `#v${version}`
  if (changed || stamp !== lastRouteStamp) {
    lastRouteStamp = stamp
    // Ribbon crossings are comb-managed geometry: the nudge must not spread them.
    nudgePass(live.filter((e) => !e.comb), obstacles)
    for (const e of live) e.m = measure(e.pts)
  }
}

// Trunk furniture, drawn between beginFrame and core's link pass so channel
// segments land ON TOP of the sheath (coincident strokes inside a fat outline
// read as one cable). Lives here, not in combs.js, because the trunk template
// routes against THIS frame's obstacle snapshot. Also renders the bus-pull
// preview (gesture layer feeds it) as a dashed leader.
export function drawTrunks(ctx, canvas) {
  const g = canvas?.graph
  if (!g) return
  const segs = busSegments(g)
  const pv = getBusPreview()
  if (!segs.length && !pv) return
  const L = window.LiteGraph
  const grid = L?.alwaysSnapToGrid && L.CANVAS_GRID_SIZE > 0 ? L.CANVAS_GRID_SIZE : 0
  const clearance = grid ? Math.ceil(16 / grid) * grid : 16
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = L?.NODE_DEFAULT_BOXCOLOR ?? '#666'
  ctx.lineWidth = 7 // sheath: wider than the 3px strands it wraps
  for (const [up, down] of segs) {
    const tpl = busTrunk(g, up, down, obstacles, clearance, version)
    if (!tpl || tpl.length < 2) continue
    ctx.beginPath()
    ctx.moveTo(tpl[0][0], tpl[0][1])
    for (let k = 1; k < tpl.length; k++) ctx.lineTo(tpl[k][0], tpl[k][1])
    ctx.stroke()
  }
  if (pv?.from) {
    const a = busNotch(pv.from.out, pv.from.lanes.length)
    ctx.setLineDash([6, 4])
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(pv.to[0], pv.to[1])
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.restore()
}

// Same-pair bundles are rebuilt as RIBBON STRANDS: the median member's A* route is
// the template, every member becomes the template offset along the path's left normal
// by its rank offset (entry order along the first mid run). This nests strands
// correctly around wraps -- which per-member y-translation cannot (it copies the
// source-side stacking onto every run and inverts the far side's required nesting).
const LANE = 8

function reconcileBundles(live) {
  const groups = new Map()
  for (const e of live) {
    if (!e.pairKey) continue
    if (!groups.has(e.pairKey)) groups.set(e.pairKey, [])
    groups.get(e.pairKey).push(e)
  }
  let changed = false
  for (const [pk, group] of groups) {
    // Reroute SEGMENTS share one link id and one pair -- they are sequential pieces,
    // not siblings, and must never be ribbon-rebuilt from each other's shapes.
    const byLink = new Map()
    for (const m of group) {
      const id = m.key.split('|')[0]
      byLink.set(id, (byLink.get(id) ?? 0) + 1)
    }
    const members = group.filter((m) => byLink.get(m.key.split('|')[0]) === 1)
    if (members.length < 2) continue
    const stamp = pk + '#' + version + '#' + members.map((m) => m.key).sort().join(';')
    if (members.every((m) => m.bundleStamp === stamp)) continue

    members.sort((a, b) => a.start[1] - b.start[1] || a.start[0] - b.start[0])
    const tpl = members[(members.length - 1) >> 1].raw
    if (!tpl || tpl.length < 4) {
      for (const m of members) m.bundleStamp = stamp
      continue
    }
    // Rank by entry position projected on the first mid segment's travel direction;
    // the furthest-along strand takes the lane nearest the pins' side of that run.
    const d1 = [Math.sign(tpl[2][0] - tpl[1][0]), Math.sign(tpl[2][1] - tpl[1][1])]
    const ln = [d1[1], -d1[0]] // left normal of travel
    const seg1Vert = d1[0] === 0
    const pinSide = Math.sign(
      seg1Vert ? members[0].start[0] - tpl[1][0] : members[0].start[1] - tpl[1][1]
    )
    const lnPerp = seg1Vert ? ln[0] : ln[1]
    const sideSign = pinSide === Math.sign(lnPerp) ? 1 : -1

    const ranked = members
      .map((m) => ({ m, proj: m.start[0] * d1[0] + m.start[1] * d1[1] }))
      .sort((a, b) => b.proj - a.proj || String(a.m.key).localeCompare(String(b.m.key)))
    const mid = (ranked.length - 1) / 2
    ranked.forEach(({ m }, rank) => {
      const o = (mid - rank) * LANE * sideSign
      const t = offsetStrand(tpl, m.start, m.end, o)
      if (t) {
        m.raw = t
        m.pts = t.map((p) => [p[0], p[1]])
        changed = true
      }
      m.bundleStamp = stamp
    })
  }
  return changed
}

// Per-node-side lane allocation (design spec): on each side, up-bending wires nest
// topmost-closest; down-bending wires start ONE LANE beyond the farthest up-bender,
// bottommost-closest. Deterministic from graph truth; the allocated stub tip becomes
// an A* lane and the horizontal-first tie-break lands the bend exactly on it, so the
// side forms a ribbon by slot order with no iteration. Slot ys come from litegraph's
// getConnectionPos -- offset from the DOM truth, but consistently so, and only order
// and rough approach direction matter here. Opposite-side pairs are not counted
// against each other: their crossing is topologically forced, so standoff buys nothing.
const STUB = 24
// Lane ladder pitch at a pin column. Tighter than the 8px strand pitch on purpose
// (polish round): the deepest lane's stub is MANDATORY length for every wire on the
// side, and at 8px a many-input node forced stubs long enough to loop. 5px is the
// comb ribbon's proven minimum for 3px strokes (3 + 2 gap). The nudge's cluster
// threshold sits BELOW this pitch so allocated neighbours never re-spread to 8.
const STUB_PITCH = 5

// Exact endpoint ys per link, harvested from the draw calls. litegraph's
// getConnectionPos returns DEFAULT slot positions -- up to a slot column off on tall
// Vue nodes (the same bad data behind the ghost routes) -- which misclassifies
// approach directions. The memo self-corrects: allocation from defaults on the first
// frame, exact from the second; the changed stub re-keys the route and the ghost
// liveness retires the old one. Written per END: reroute segments share the link id,
// so a blanket {sy, ey} write from the final segment would record the last reroute's
// y as the origin pin's. sNext/ePrev are the IMMEDIATE hop past each pin -- the
// first/last reroute when the link has any -- because the approach direction at a
// node is set by the nearest hop, not the far pin.
const pinMemo = new Map() // linkId -> {sy, sNext, ey, ePrev}

function pinY(node, isInput, slot) {
  const p = node?.getConnectionPos?.(isInput, slot)
  return p ? p[1] : (node?.pos?.[1] ?? 0)
}

// Reroute ends. Core marks both reroute sides of a segment CENTER ('none') and
// nothing else ever gets that direction, so 'none' IS the reroute marker. The rule
// (design spec): the wire ENTERS a reroute horizontally from the side its upstream hop
// (output pin or parent reroute) sits on, and LEAVES from the opposite side -- the
// chain reads as one continuous run and never hooks around the dot. Upstream and
// downstream x come from the drawn sibling segments (the ledger moves visual
// endpoints off graph truth), graph truth is the first-frame fallback; a flipped
// side re-keys the route and ghost liveness retires the old shape, same as lane
// stubs. A dead-vertical upstream is the one case the rule leaves open: tie-break
// by downstream, so the exit faces where the wire goes next.
const rerouteMemo = new Map() // rerouteId -> {upX, downX}

function memoOf(id) {
  let m = rerouteMemo.get(id)
  if (!m) rerouteMemo.set(id, (m = {}))
  return m
}

function rerouteAt(graph, x, y) {
  if (!graph?.reroutes) return null
  for (const r of graph.reroutes.values()) {
    const p = r.pos
    if (Math.abs(p[0] - x) <= 0.5 && Math.abs(p[1] - y) <= 0.5) return r
  }
  return null
}

function upstreamX(graph, r) {
  const parent = r.parentId != null ? graph.getReroute?.(r.parentId) : null
  if (parent) return parent.pos[0]
  const ll = r.firstLink
  const n = ll && graph.getNodeById(ll.origin_id)
  return n?.getConnectionPos?.(false, ll.origin_slot)?.[0]
}

function downstreamX(graph, r) {
  for (const c of graph.reroutes.values()) {
    if (c.parentId !== r.id) continue
    for (const id of c.linkIds) if (r.linkIds?.has?.(id)) return c.pos[0]
  }
  const ll = r.firstLink
  const n = ll && graph.getNodeById(ll.target_id)
  return n?.getConnectionPos?.(true, ll.target_slot)?.[0]
}

// Gate pins are ONE SIDE OF A NODE (design decision): the same per-side allocation as
// laneStub, over the gate's teeth. Own ys are exact -- we lay the teeth out --
// and other-end ys come from the reroute memo harvested off the drawn segments,
// the same self-correcting source the classification fix used for node pins.
function gateStub(graph, t) {
  const side = t.side
  const list = []
  t.comb.lanes.forEach((l, i) => {
    const r = graph.reroutes?.get?.(l[side])
    if (!r) return
    const m = rerouteMemo.get(l[side])
    const otherY = side === 'in' ? m?.upY : m?.downY
    if (otherY == null) return // lane not drawn yet this session; skip this frame
    list.push({ i, y: r.pos[1], up: otherY <= r.pos[1] })
  })
  const ups = list.filter((s) => s.up).sort((a, b) => a.y - b.y)
  const downs = list.filter((s) => !s.up).sort((a, b) => b.y - a.y)
  let lane = ups.findIndex((s) => s.i === t.lane)
  if (lane < 0) {
    const d = downs.findIndex((s) => s.i === t.lane)
    if (d < 0) return STUB
    lane = ups.length + d
  }
  return STUB + lane * STUB_PITCH
}

// The side the wire enters this reroute from; the exit is always the opposite.
function rerouteSide(graph, r) {
  const m = rerouteMemo.get(r.id)
  const rx = r.pos[0]
  const ux = m?.upX ?? upstreamX(graph, r)
  if (ux != null && Math.abs(ux - rx) > 0.5) return ux < rx ? 'left' : 'right'
  const dx = m?.downX ?? downstreamX(graph, r)
  if (dx != null && Math.abs(dx - rx) > 0.5) return dx < rx ? 'right' : 'left'
  return 'left'
}

function laneStub(graph, node, isInput, slot) {
  const slots = node ? (isInput ? node.inputs : node.outputs) : null
  if (!slots) return STUB
  const list = []
  for (let j = 0; j < slots.length; j++) {
    // An output slot with several links is one pin, one lane; its wires fan at the
    // stub tip and the nudge fan-out staggers them from there.
    const linkId = isInput ? slots[j].link : slots[j].links?.[0]
    if (linkId == null) continue
    const ll = graph._links?.get?.(Number(linkId))
    if (!ll) continue
    const other = graph.getNodeById(isInput ? ll.origin_id : ll.target_id)
    if (!other) continue
    const m = pinMemo.get(Number(linkId))
    const y = (isInput ? m?.ey : m?.sy) ?? pinY(node, isInput, j)
    const otherY = (isInput ? m?.ePrev : m?.sNext) ??
      pinY(other, !isInput, isInput ? ll.origin_slot : ll.target_slot)
    list.push({ j, y, up: otherY <= y })
  }
  const ups = list.filter((s) => s.up).sort((a, b) => a.y - b.y)
  const downs = list.filter((s) => !s.up).sort((a, b) => b.y - a.y)
  let lane = ups.findIndex((s) => s.j === slot)
  if (lane < 0) {
    const d = downs.findIndex((s) => s.j === slot)
    if (d < 0) return STUB
    lane = ups.length + d
  }
  return STUB + lane * STUB_PITCH
}

export function routeFor(canvas, linkData) {
  const s = linkData.startPoint, e = linkData.endPoint
  const g = canvas.graph
  const llink = g?._links?.get?.(Number(linkData.id))
  const sIsPin = linkData.startDirection !== 'none'
  const eIsPin = linkData.endDirection !== 'none'
  if (llink) {
    let pm = pinMemo.get(Number(linkData.id))
    if (!pm) pinMemo.set(Number(linkData.id), (pm = {}))
    if (sIsPin) { pm.sy = s.y; pm.sNext = e.y }
    if (eIsPin) { pm.ey = e.y; pm.ePrev = s.y }
  }
  // Clearance shares the graph's snap arithmetic: with 10px snapping and 16px
  // inflation, lane furniture lives on a different modulus than the nodes and every
  // drop lands near-alignments at shifting sub-grid offsets (QA find: jank vanishes
  // at snap 16). Quantize UP to the grid so edges-on-grid put lanes on-grid too.
  const L = window.LiteGraph
  const grid = L?.alwaysSnapToGrid && L.CANVAS_GRID_SIZE > 0 ? L.CANVAS_GRID_SIZE : 0
  const clearance = grid ? Math.ceil(16 / grid) * grid : 16

  // Resolve reroute ends before the key: the entry side depends on the upstream hop,
  // so moving THAT can flip this segment's direction without touching its endpoints.
  // Memo writes first -- the incoming segment draws before the outgoing one, so the
  // exit side resolves from this frame's data.
  let sDir = linkData.startDirection, eDir = linkData.endDirection
  let tS = null, tE = null
  if (!sIsPin || !eIsPin) {
    const rS = sIsPin ? null : rerouteAt(g, s.x, s.y)
    const rE = eIsPin ? null : rerouteAt(g, e.x, e.y)
    // Comb crossing: both ends are one lane's in/out teeth -- the segment IS the
    // ribbon. Geometry comes from the comb (template + strand offset), not A*, and
    // the nudge leaves it alone. Fan-out links sharing the teeth get identical pts.
    const cross = rS && rE ? combCrossing(rS.id, rE.id) : null
    if (cross) {
      const key = `${linkData.id}|X${cross.comb.id}|${cross.lane}/${cross.comb.lanes.length}|${s.x | 0},${s.y | 0}|${e.x | 0},${e.y | 0}`
      const hit = cache.get(key)
      if (hit && hit.version === version) {
        hit.tick = tick
        return hit.raw ? hit : null
      }
      if (canvas.pointer?.isDown) return hit && hit.raw ? hit : null
      const raw = crossingPts(g, cross.comb, cross.lane, obstacles, clearance, version)
      const entry = raw
        ? {
            key, raw, pts: raw.map((p) => [p[0], p[1]]), m: measure(raw), version,
            tick, comb: true, start: [s.x, s.y], end: [e.x, e.y]
          }
        : { key, raw: null, version, tick }
      cache.set(key, entry)
      return raw ? entry : null
    }
    // Bus crossing: the teeth are one channel's out/in pair across a bus edge --
    // the segment is the trunk. Every channel shares the template past the pin
    // gutter, so the strokes overdraw into one cable inside the furniture sheath
    // (drawTrunks); comb-managed like ribbons, so the nudge leaves it alone.
    const bx = rS && rE ? busCrossing(rS.id, rE.id) : null
    if (bx) {
      const key = `${linkData.id}|B${bx.down.id}|${bx.lane}|${bx.up.lanes.length}/${bx.down.lanes.length}|${s.x | 0},${s.y | 0}|${e.x | 0},${e.y | 0}`
      const hit = cache.get(key)
      if (hit && hit.version === version) {
        hit.tick = tick
        return hit.raw ? hit : null
      }
      if (canvas.pointer?.isDown) return hit && hit.raw ? hit : null
      const raw = busCrossingPts(g, bx.up, bx.down, bx.lane, obstacles, clearance, version)
      const entry = raw
        ? {
            key, raw, pts: raw.map((p) => [p[0], p[1]]), m: measure(raw), version,
            tick, comb: true, start: [s.x, s.y], end: [e.x, e.y]
          }
        : { key, raw: null, version, tick }
      cache.set(key, entry)
      return raw ? entry : null
    }
    // A tooth's faces are fixed by its gate's orientation; free reroutes resolve
    // from the upstream-side rule.
    const toothDir = (t, atEnd) => {
      const pins = t.comb[t.side].pins
      const ribbon = pins === 'left' ? 'right' : 'left'
      return atEnd ? (t.side === 'in' ? pins : ribbon) : (t.side === 'out' ? pins : ribbon)
    }
    tS = rS ? toothOf(rS.id) : null
    tE = rE ? toothOf(rE.id) : null
    // Memo both coords for every reroute INCLUDING teeth: gate-side lane
    // allocation classifies by the exact other-end ys (crossing segments never
    // reach this block, so a tooth's memo holds its pin-side hop only).
    if (rS) { const m = memoOf(rS.id); m.downX = e.x; m.downY = e.y }
    if (rE) { const m = memoOf(rE.id); m.upX = s.x; m.upY = s.y }
    if (!sIsPin) {
      sDir = tS ? toothDir(tS, false)
        : rS ? (rerouteSide(g, rS) === 'left' ? 'right' : 'left') : 'right'
    }
    if (!eIsPin) {
      eDir = tE ? toothDir(tE, true) : rE ? rerouteSide(g, rE) : 'left'
    }
  }
  // Allocation is part of the cache key: connecting or dropping a SIBLING link changes
  // this link's lane without moving its endpoints or any node rect. The old entry
  // simply stops being served and the ghost liveness retires it. Lane allocation
  // belongs to node sides only -- a reroute end takes the plain stub (the llink's
  // origin/target slots describe the CHAIN's pins, not this segment's endpoints).
  let stubStart = STUB, stubEnd = STUB
  if (llink) {
    if (sIsPin) stubStart = laneStub(g, g.getNodeById(llink.origin_id), false, llink.origin_slot)
    if (eIsPin) stubEnd = laneStub(g, g.getNodeById(llink.target_id), true, llink.target_slot)
  }
  // Gate pins rank like a node side too (works for floating segments -- no llink).
  if (tS?.side === 'out') stubStart = gateStub(g, tS)
  if (tE?.side === 'in') stubEnd = gateStub(g, tE)
  const key = `${linkData.id}|${s.x | 0}|${s.y | 0}|${e.x | 0}|${e.y | 0}|${stubStart}|${stubEnd}|${sDir}>${eDir}`
  const hit = cache.get(key)
  if (hit && hit.version === version) {
    hit.tick = tick
    return hit.raw ? hit : null
  }

  // Endpoints or obstacles changed. Mid-gesture we do not compute (R6) -- core's
  // spline renders until the drop invalidates the pointer state.
  if (canvas.pointer?.isDown) return hit && hit.raw ? hit : null

  // Every link routes independently; same-pair bundles are rebuilt as ribbon strands
  // by reconcileBundles on the next beginFrame (one-frame settle).
  const pairKey = llink ? `${llink.origin_id}>${llink.target_id}` : null

  const raw = route({
    start: [s.x, s.y],
    end: [e.x, e.y],
    startDir: sDir,
    endDir: eDir,
    obstacles,
    clearance,
    stubStart,
    stubEnd,
    // Gate faces bind; node pins and free reroutes keep the relaxed fold.
    enforceStart: !!tS,
    enforceEnd: !!tE
  })
  const entry = raw
    ? {
        key, raw, pts: raw.map((p) => [p[0], p[1]]), m: measure(raw), version, tick,
        pairKey, start: [s.x, s.y], end: [e.x, e.y]
      }
    : { key, raw: null, version, tick }
  cache.set(key, entry)
  return raw ? entry : null
}

export function stats() {
  return { cached: cache.size, obstacles: obstacles.length, version }
}

export function debugRoutes() {
  return [...cache.entries()]
    .filter(([, e]) => e.raw && e.version === version && e.live !== false)
    .map(([key, e]) => ({ key, pts: e.pts, raw: e.raw }))
}
