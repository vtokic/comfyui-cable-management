// Widget pass-through coverage changes -- keeping republished values LIVE.
//
// A widget pin's owned primitive republishes a LITERAL. The moment a link lands on
// the host's widget input, the literal stops being the truth: the input's value now
// flows from the link's origin, while the primitive keeps mirroring the host's
// stale widget (measured on a real workflow: a passthrough republished `true` to
// the output gate forever, no matter what the incoming boolean said -- while the
// same wiring built cover-first picked the value up live, because the pin drag
// resolved the true origin). Order of operations must not matter.
//
// So: when a covering link appears, migrate every consumer of the primitive onto
// the link's true origin -- exactly the link a fresh pin drag would create NOW
// (gate origin feeding a gate target becomes a stitch) -- carry the pin picture
// via provenance, and let the reaper take the stale machinery. Core's connect
// calls replace occupied slots themselves, so no manual unwiring.

import { isOwned, ownerOf, reapIfUnused, materialiseIn } from "./primitive.js";
import { recordProvenance, recordGateProvenance } from "./reanchor.js";
import { stitchGates, isStitch } from "./stitch.js";
import { nodeById, originOf } from "./graph.js";
import { invalidate } from "./ledger.js";
import { gateClaims } from "./routestore.js";
import { linkSlots } from "./invoke.js";

const HOST = "cablemanagement.host";
const HOST_SLOT = "cablemanagement.hostSlot";
const FROM = "cablemanagement.from";
const STITCH_FROM = "cablemanagement.stitchFrom";

/** Both directions over one graph plus its immediate subgraphs -- pure graph ops,
 *  no DOM, so closed subgraphs heal too (their stale values would otherwise ship
 *  at prompt time). The passes are mutually exclusive per host input (covered vs
 *  uncovered), so no ping-pong. */
export function migrateCoverage(graph) {
  migrateCovered(graph);
  migrateUncovered(graph);
  for (const n of graph?.nodes ?? []) {
    if (!n.subgraph) continue;
    migrateCovered(n.subgraph);
    migrateUncovered(n.subgraph);
  }
}

export function migrateCovered(graph) {
  for (const prim of [...(graph?.nodes ?? [])]) {
    if (!isOwned(prim)) continue;
    const host = nodeById(graph, prim.properties?.[HOST]);
    const i = prim.properties?.[HOST_SLOT];
    const slot = host?.inputs?.[i];
    if (!slot || slot.link == null) continue; // the literal is still the truth
    const links = [...(prim.outputs?.[0]?.links ?? [])];
    if (!links.length) continue; // floats only: nothing to migrate, reaper's call
    const origin = originOf(graph, host, i);
    if (!origin) continue;
    const fromGate = origin.node === graph.inputNode;
    let moved = false;
    for (const lid of links) {
      const link = graph.getLink ? graph.getLink(lid) : graph._links?.get?.(lid);
      if (!link) continue;
      try {
        if (link.targetIsIoNode ?? String(link.target_id) === "-20") {
          const outSlot = graph.outputs?.[link.target_slot];
          if (!outSlot) continue;
          if (fromGate) {
            if (
              stitchGates(graph, graph.inputs?.[origin.slot], outSlot, prim.pos?.[0] ?? 0, prim.pos?.[1] ?? 0, [
                String(host.id),
                i,
              ])
            )
              moved = true;
          } else {
            const src = origin.node.outputs?.[origin.slot];
            const nl = src ? linkSlots(outSlot, src, origin.node) : null;
            if (nl) {
              recordGateProvenance(graph, nl, host, i);
              moved = true;
            }
          }
        } else {
          const target = nodeById(graph, link.target_id);
          if (!target?.inputs?.[link.target_slot]) continue;
          let nl = null;
          if (fromGate) {
            target.disconnectInput(link.target_slot);
            nl = linkSlots(graph.inputs?.[origin.slot], target.inputs[link.target_slot], target) ?? null;
          } else {
            nl = linkSlots(origin.node, origin.slot, target, link.target_slot) ?? null;
          }
          if (nl) {
            recordProvenance(target, link.target_slot, host, i, nl.id);
            moved = true;
          }
        }
      } catch {
        /* migrate what we can; a failed hop leaves that consumer as it was */
      }
    }
    if (moved) {
      reapIfUnused(graph, prim);
      invalidate();
      graph.setDirtyCanvas(true, true);
    }
  }
}

/**
 * The REVERSE (by design): a properly constructed passthrough whose covering
 * input link gets dropped must revert to the primitive workaround -- the input is
 * a literal again, so every dependent that still names the pin (consumer
 * provenance, gate records, stitches) is rewired onto a (re)materialised owned
 * primitive. A dependent whose record was lost draws honestly and stays put --
 * the records ARE the contract markers.
 */
export function migrateUncovered(graph) {
  const getLink = (id) => (graph.getLink ? graph.getLink(id) : graph._links?.get?.(id));
  const targetsGate = (l) => l?.targetIsIoNode ?? String(l?.target_id) === "-20";
  // An uncovered widget host: the input holds no link but is widget-backed.
  const uncoveredHost = (hostId, hi) => {
    const host = nodeById(graph, hostId);
    const slot = host?.inputs?.[hi];
    return host && slot && slot.link == null && slot.widget ? host : null;
  };
  const groups = new Map(); // "hostId|i" -> dependents
  const groupFor = (host, i) => {
    const k = `${host.id}|${i}`;
    let g0 = groups.get(k);
    if (!g0) groups.set(k, (g0 = { host, i, consumers: [], gateSlots: [], stitches: [] }));
    return g0;
  };

  for (const T of graph.nodes ?? []) {
    const map = T.properties?.[FROM];
    if (map && !isStitch(T)) {
      for (const k of Object.keys(map)) {
        if (!Array.isArray(map[k])) continue; // workflow data is untrusted input
        const [hid, hi, lid] = map[k];
        if (T.inputs?.[Number(k)]?.link !== lid) continue; // stale record
        const host = uncoveredHost(hid, hi);
        if (!host) continue;
        const link = getLink(lid);
        const origin = link ? nodeById(graph, link.origin_id) : null;
        if (!origin || isOwned(origin)) continue; // already primitive-fed
        groupFor(host, hi).consumers.push({ T, s: Number(k) });
      }
    }
    const sf = T.properties?.[STITCH_FROM];
    if (Array.isArray(sf) && isStitch(T)) {
      const host = uncoveredHost(sf[0], sf[1]);
      if (host) groupFor(host, sf[1]).stitches.push(T);
    }
  }
  for (const [lid, rec] of gateClaims(graph)) {
    if (!Array.isArray(rec)) continue; // workflow data is untrusted input
    const [hid, hi] = rec;
    const host = uncoveredHost(hid, hi);
    if (!host) continue;
    const link = getLink(Number(lid));
    if (!link || !targetsGate(link)) continue;
    const origin = nodeById(graph, link.origin_id);
    if (!origin || isOwned(origin) || isStitch(origin)) continue; // stitches handled above
    groupFor(host, hi).gateSlots.push(link.target_slot);
  }

  for (const { host, i, consumers, gateSlots, stitches } of groups.values()) {
    // Crafted (or stale-beyond-repair) records can name targets no connect will ever
    // accept: without a breaker, every sync would materialise a primitive, fail to
    // wire it, and reap it -- burning a serialized node id per frame, forever.
    const failKey = `${graph.id ?? ""}|${host.id}|${i}`;
    if ((revertFailures.get(failKey) ?? 0) >= 3) continue;
    const prim = ownerOf(graph, host, i) ?? materialiseIn(graph, host, i);
    const out = prim?.outputs?.[0];
    if (!prim || !out) continue;
    let moved = false;
    try {
      for (const { T, s } of consumers) {
        const nl = linkSlots(prim, 0, T, s);
        if (nl) {
          recordProvenance(T, s, host, i, nl.id);
          moved = true;
        }
      }
      for (const s of gateSlots) {
        const nl = linkSlots(graph.outputs?.[s], out, prim);
        if (nl) {
          recordGateProvenance(graph, nl, host, i);
          moved = true;
        }
      }
      for (const R of stitches) {
        for (const lid of [...(R.outputs?.[0]?.links ?? [])]) {
          const l = getLink(lid);
          if (!l || !targetsGate(l)) continue;
          // connect replaces the stitch's link on the gate slot; the unbridged
          // stitch is the reaper's next meal
          const nl = linkSlots(graph.outputs?.[l.target_slot], out, prim);
          if (nl) {
            recordGateProvenance(graph, nl, host, i);
            moved = true;
          }
        }
      }
    } catch {
      /* partial revert still beats a stale value */
    }
    if (moved) {
      revertFailures.delete(failKey);
      invalidate();
      graph.setDirtyCanvas(true, true);
    } else {
      revertFailures.set(failKey, (revertFailures.get(failKey) ?? 0) + 1);
      reapIfUnused(graph, prim); // a fresh primitive that ended up feeding nothing
    }
  }
}

// Consecutive all-failed revert attempts per (graph, host, slot); three strikes stops
// the retry until something about the group succeeds again. Session-scoped.
const revertFailures = new Map();
