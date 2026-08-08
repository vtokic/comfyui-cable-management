// Bus PoC: programmatic API (window.__cablemanagementCombs.bus). Asserts (1) spawn
// births a full mirror -- bus.from set, head promoted with a typed channel table,
// mirror lanes all empty; (2) float parks a channel's driver as a chained floating
// lane through the mirror; (3) tap materialises a REAL link driver->consumer riding
// the teeth of every segment (4-reroute chain), reusing a parked float's spine;
// (4) the gap segments render as bus crossings (|B keys) with a shared trunk run;
// (5) override at the mirror migrates shadowed downstream consumers onto the new
// source while the head's own links keep their original value; (6) channel
// identity is sticky -- unplugging a head lane nulls it in place, no index slide,
// type retained; (7) save/reload revives records, table, and wiring; (8)
// decomposing the mirror leaves every materialised link flowing plain.
import { chromium } from 'playwright'
const b = await chromium.launch({ headless: true })
const page = await b.newPage({ viewport: { width: 1900, height: 1000 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]))
await page.goto(process.env.COMFY_URL ?? 'http://127.0.0.1:8187', { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.app?.graph && window.__cablemanagementPathing?.state?.patched && window.__cablemanagementCombs?.bus, null, { timeout: 120_000 })
await page.waitForTimeout(3000)

let pass = true
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' -- ' + extra : ''}`)
  if (!cond) pass = false
}

const out = await page.evaluate(async () => {
  const app = window.app, g = app.graph, L = window.LiteGraph
  const P = window.__cablemanagementPathing, C = window.__cablemanagementCombs
  const settle = async () => {
    for (let i = 0; i < 6; i++) { g.setDirtyCanvas(true, true); await new Promise((r) => setTimeout(r, 200)) }
  }
  const mk = (type, x, y) => { const n = L.createNode(type); n.pos = [x, y]; g.add(n); return n }
  const chain = (link) => {
    const ids = []
    let rid = link?.parentId
    while (rid != null) { ids.push(rid); rid = g.getReroute(rid)?.parentId }
    return ids.reverse() // source-side first
  }
  const busSegs = () => P.routes().filter((r) => r.key.includes('|B'))
  const trunkY = (pts) => {
    let best = null, bl = -1
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], c = pts[k + 1]
      if (Math.abs(a[1] - c[1]) < 0.1 && Math.abs(a[0] - c[0]) > bl) { bl = Math.abs(a[0] - c[0]); best = a[1] }
    }
    return best
  }

  g.clear()
  app.canvas.links_render_mode = P.PCB()
  const report = {}

  // Three MODEL links straddling the head comb site.
  const s1 = mk('CheckpointLoaderSimple', 100, 100)
  const t1 = mk('CheckpointSave', 1200, 120)
  const s2 = mk('CheckpointLoaderSimple', 100, 400)
  const t2 = mk('CheckpointSave', 1200, 420)
  const s3 = mk('CheckpointLoaderSimple', 100, 700)
  const t3 = mk('CheckpointSave', 1200, 720)
  s1.connect(0, t1, 0); s2.connect(0, t2, 0); s3.connect(0, t3, 0)
  const [l1, l2, l3] = [...g._links.values()].map((l) => l.id)
  const headId = C.create(l1, l2, 600, 300)
  C.add(headId, l3)
  C.move(headId, 'out', 900, 300)
  await settle()

  // (1) spawn a mirror
  const mirrorId = C.bus.spawn(headId, 1600, 300)
  await settle()
  const rec = () => C.list().find((c) => c.id === mirrorId)
  const headRec = () => C.list().find((c) => c.id === headId)
  report.spawn = {
    mirror: rec()?.bus ?? null,
    headChan: headRec()?.bus?.chan ?? null,
    mirrorLanes: rec()?.lanes ?? null,
    headInfo: C.bus.info(headId),
    mirrorInfo: C.bus.info(mirrorId)
  }

  // (2) float-park channel 0 at the mirror
  const floats0 = g.floatingLinks?.size ?? 0
  const termId = C.bus.float(mirrorId, 0)
  await settle()
  report.float = {
    terminus: termId,
    lanes0: rec()?.lanes?.[0] ?? null,
    floatsGained: (g.floatingLinks?.size ?? 0) - floats0
  }

  // (3) taps: ch1 mints fresh teeth; ch0 reuses the float's spine
  const consumer1 = mk('CheckpointSave', 2100, 260)
  const consumer2 = mk('CheckpointSave', 2100, 560)
  const tap1 = C.bus.tap(mirrorId, 1, consumer1.id, 0)
  const tap0 = C.bus.tap(mirrorId, 0, consumer2.id, 0)
  await settle()
  const hl = headRec(), ml = rec()
  report.tap = {
    tap1, tap0,
    origin1: g._links.get(tap1)?.origin_id, target1: g._links.get(tap1)?.target_id,
    origin0: g._links.get(tap0)?.origin_id,
    chain1: chain(g._links.get(tap1)),
    expect1: [hl.lanes[1].in, hl.lanes[1].out, ml.lanes[1].in, ml.lanes[1].out],
    chain0: chain(g._links.get(tap0)),
    expect0: [hl.lanes[0].in, hl.lanes[0].out, ml.lanes[0].in, ml.lanes[0].out],
    s1id: s1.id, s2id: s2.id
  }

  // (4) trunk render: both gap segments share the trunk's long run
  const segs = busSegs()
  report.trunk = { count: segs.length, ys: segs.map((r) => trunkY(r.pts)) }

  // (5) override ch1 at the mirror
  const y = mk('CheckpointLoaderSimple', 1200, 900)
  const overrode = C.bus.override(mirrorId, 1, y.id, 0)
  await settle()
  const c1in = consumer1.inputs[0].link != null ? g._links.get(consumer1.inputs[0].link) : null
  report.override = {
    ok: overrode,
    yid: y.id,
    consumer1Origin: c1in?.origin_id ?? null,
    consumer1Chain: chain(c1in),
    mirrorLane1: rec()?.lanes?.[1] ?? null,
    originalIntact: g._links.get(l2)?.origin_id === s2.id && g._links.get(l2)?.target_id === t2.id,
    busSegsNow: busSegs().length // ch1's gap segment is gone; ch0's remains
  }

  // (6) sticky identity: unplug the head's channel 2
  g.removeLink(l3)
  await settle()
  report.sticky = {
    headLanes: headRec()?.lanes?.length,
    mirrorLanes: rec()?.lanes?.length,
    lane2: headRec()?.lanes?.[2] ?? null,
    chan2Type: headRec()?.bus?.chan?.[2]?.type ?? null
  }

  // (7) save/reload
  const data = g.serialize()
  g.configure(data)
  app.canvas.links_render_mode = P.PCB()
  await settle()
  const rc1 = g.getNodeById(consumer1.id)?.inputs?.[0]?.link
  report.reload = {
    records: g.extra?.cablemanagement_combs?.length,
    headChan: C.bus.info(headId)?.chan ?? null,
    mirrorFrom: C.bus.info(mirrorId)?.from ?? null,
    consumer1Origin: rc1 != null ? g._links.get(rc1)?.origin_id : null,
    busSegs: busSegs().length
  }

  // (8) decompose the mirror: every materialised link keeps flowing plain
  C.decompose(mirrorId)
  await settle()
  const pc1 = g.getNodeById(consumer1.id)?.inputs?.[0]?.link
  const pc2 = g.getNodeById(consumer2.id)?.inputs?.[0]?.link
  report.decompose = {
    records: g.extra?.cablemanagement_combs?.length,
    consumer1Fed: pc1 != null && g._links.get(pc1)?.origin_id === y.id,
    consumer2Fed: pc2 != null && g._links.get(pc2)?.origin_id === s1.id
  }
  return report
})

ok('mirror carries bus.from', out.spawn.mirror?.from != null, JSON.stringify(out.spawn.mirror))
ok('head promoted with 3 typed channels', out.spawn.headChan?.length === 3 && out.spawn.headChan.every((c) => c.type === 'MODEL'), JSON.stringify(out.spawn.headChan))
ok('mirror lanes empty (full mirror, lazy teeth)', out.spawn.mirrorLanes?.length === 3 && out.spawn.mirrorLanes.every((l) => l.in == null && l.out == null), JSON.stringify(out.spawn.mirrorLanes))
ok('info() resolves the head table from the mirror', out.spawn.mirrorInfo?.chan?.length === 3, JSON.stringify(out.spawn.mirrorInfo))
ok('float parks a chained lane', out.float.terminus != null && out.float.lanes0?.out === out.float.terminus && out.float.floatsGained === 1, JSON.stringify(out.float))
ok('tap ch1: real link source->consumer', out.tap.origin1 === out.tap.s2id && out.tap.tap1 != null, JSON.stringify({ o: out.tap.origin1, s: out.tap.s2id }))
ok('tap ch1 rides all 4 teeth', JSON.stringify(out.tap.chain1) === JSON.stringify(out.tap.expect1), `${out.tap.chain1} vs ${out.tap.expect1}`)
ok('tap ch0 reuses the float spine', out.tap.origin0 === out.tap.s1id && JSON.stringify(out.tap.chain0) === JSON.stringify(out.tap.expect0), `${out.tap.chain0} vs ${out.tap.expect0}`)
// >= 2: the parked ch0 float may render its own gap segment alongside the taps.
ok('gap segments render as bus crossings', out.trunk.count >= 2, `got ${out.trunk.count}`)
if (out.trunk.count >= 2) {
  const y0 = out.trunk.ys[0]
  ok('gap segments share the trunk run', y0 != null && out.trunk.ys.every((y) => Math.abs(y - y0) < 0.5), JSON.stringify(out.trunk.ys))
}
ok('override rewires the shadowed consumer', out.override.ok && out.override.consumer1Origin === out.override.yid, JSON.stringify({ o: out.override.consumer1Origin, y: out.override.yid }))
ok('override chain rides the mirror teeth', JSON.stringify(out.override.consumer1Chain) === JSON.stringify([out.override.mirrorLane1?.in, out.override.mirrorLane1?.out]), `${out.override.consumer1Chain}`)
ok('upstream keeps the original value', out.override.originalIntact === true)
ok('override localises ch1 (its gap segment is gone)', out.override.busSegsNow >= 1 && out.override.busSegsNow < out.trunk.count, `${out.trunk.count} -> ${out.override.busSegsNow}`)
ok('unplugged channel keeps its slot', out.sticky.headLanes === 3 && out.sticky.mirrorLanes === 3 && out.sticky.lane2?.in == null, JSON.stringify(out.sticky))
ok('sticky type survives the unplug', out.sticky.chan2Type === 'MODEL', `got ${out.sticky.chan2Type}`)
ok('reload revives bus records', out.reload.records === 2 && out.reload.headChan?.length === 3 && out.reload.mirrorFrom != null, JSON.stringify(out.reload))
ok('reload keeps the override wiring', out.reload.consumer1Origin === out.override.yid, `got ${out.reload.consumer1Origin}`)
ok('reload re-renders the trunk', out.reload.busSegs >= 1, `got ${out.reload.busSegs}`)
ok('decompose leaves links flowing', out.decompose.records === 1 && out.decompose.consumer1Fed && out.decompose.consumer2Fed, JSON.stringify(out.decompose))
console.log('page errors:', errs.length ? errs : 'none')
console.log(pass ? 'PASS' : 'FAIL')
await b.close()
process.exit(pass ? 0 : 1)
