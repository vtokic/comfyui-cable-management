// Copy/paste survival for pass-through links.
//
// Core's clipboard clones `properties` verbatim, so a pasted node arrives carrying
// provenance that names the ORIGINAL nodes and link ids -- one prune pass later the
// pass-through picture is gone. And a widget pass-through's real origin is a hidden owned
// primitive that core's selection rules know nothing about: a plain paste drops that link
// (origin outside the selection), a shift-paste keeps it wired to the ORIGINAL primitive.
//
// _deserializeItems is the one funnel every paste goes through -- Ctrl+V, Paste with
// Connect, the HTML-clipboard path, node clone, alt-drag clone -- and it returns exactly
// the remap tables a fixup needs: results.nodes (old id -> new node) and results.links
// (old link id -> new LLink). The fixup runs synchronously inside the wrapper, before the
// paste commands' captureCanvasState, so the repaired graph lands in the paste's own undo
// step.
//
// ONE rule per provenance entry [host, hostSlot, linkId], no flavour detection: the entry
// describes a link dragged off the pin at (host, hostSlot), so the pasted copy must be
// wired from WHATEVER THAT PIN RESOLVES TO NOW.
//
//   host pasted     -> the apparent link was inside the selection; wire from the pasted
//                      host's pin: its input's origin if connected, its owned primitive
//                      for a widget slot (materialised on demand, shared by every pasted
//                      consumer). A link core kept to the ORIGINAL machinery is swapped
//                      out -- the user selected the pin's node, not the machinery. The
//                      pin's own resolution may itself be a pass-through being rebuilt by
//                      another entry (a daisy chain: C's pin resolves through C's input to
//                      A's primitive), so entries resolve in rounds until a round makes no
//                      progress.
//   host not pasted -> never create links; core already decided (kept on shift, dropped on
//                      plain). Keep the entry on the original host only if the kept link
//                      truly hangs off that pin's current resolution.

import { app } from "../../scripts/app.js";
import { isOwned, materialise, ownerOf } from "./primitive.js";
import { recordProvenance, forgetProvenance } from "./reanchor.js";
import { originOf, nodeById } from "./graph.js";
import { invalidate } from "./ledger.js";
import { isEnabled } from "./enabled.js";
import { linkSlots } from "./invoke.js";

const HOST = "cablemanagement.host";
const FROM = "cablemanagement.from";

let installed = false;

export function install() {
  if (installed) return true;
  const proto = app?.canvas?.constructor?.prototype;
  if (!proto || typeof proto._deserializeItems !== "function") return false;
  if (proto.__cablemanagementPaste) {
    installed = true;
    return true;
  }
  const orig = proto._deserializeItems;
  proto.__cablemanagementPaste = true;
  proto._deserializeItems = function (parsed, options) {
    const results = orig.call(this, parsed, options);
    if (results && isEnabled()) {
      try {
        fixup(this.graph, results);
      } catch (err) {
        console.warn("[cablemanagement] paste fixup failed:", err);
      }
      invalidate();
      window.dispatchEvent(new CustomEvent("cablemanagement:resync"));
    }
    return results;
  };
  installed = true;
  return true;
}

/** The result maps are keyed by number-normalised old ids; be liberal in the lookup. */
function mapGet(map, id) {
  if (!map || id == null) return undefined;
  return map.get(id) ?? map.get(Number(id)) ?? map.get(String(id));
}

/**
 * What the pin at (host, hostSlot) resolves to right now: the input's origin when
 * connected, else the host's own owned primitive for a widget slot. Null when neither
 * exists yet -- which may just mean another entry has not rebuilt it yet.
 */
function pinOrigin(graph, host, hostSlot) {
  const o = originOf(graph, host, hostSlot);
  if (o) return { node: o.node, slot: o.slot };
  const prim = ownerOf(graph, host, hostSlot);
  if (prim) return { node: prim, slot: 0 };
  return null;
}

function fixup(graph, results) {
  if (!graph || !results.nodes?.size) return;

  // Pasted owned primitives (a marquee over the host's footprint catches them): re-home
  // onto the pasted clone of their host. No clone pasted: the properties keep naming the
  // original, which either still exists (shift-paste daisy-chain) or does not
  // (cross-graph paste), in which case the host-gone reap collects the orphan.
  for (const n2 of results.nodes.values()) {
    if (!n2 || !isOwned(n2)) continue;
    const mappedHost = mapGet(results.nodes, n2.properties?.[HOST]);
    if (mappedHost) n2.properties[HOST] = mappedHost.id;
  }

  const entries = [];
  for (const n2 of results.nodes.values()) {
    const map = n2?.properties?.[FROM];
    if (!map) continue;
    for (const slotKey of Object.keys(map)) {
      const [hostOld, hostSlotRaw] = map[slotKey] ?? [];
      entries.push({ n2, idx: Number(slotKey), hostOld, hostSlot: Number(hostSlotRaw) });
    }
  }

  let pending = entries;
  while (pending.length) {
    const next = [];
    for (const e of pending) {
      let done;
      try {
        done = fixEntry(graph, results, e);
      } catch {
        forgetProvenance(e.n2, e.idx); // an unconnectable origin must not sink the rest
        done = true;
      }
      if (!done) next.push(e);
    }
    if (next.length === pending.length) break; // no progress: the leftovers are dead
    pending = next;
  }
  for (const e of pending) forgetProvenance(e.n2, e.idx);
}

/** @returns true when handled (recorded or forgotten); false to retry next round. */
function fixEntry(graph, results, { n2, idx, hostOld, hostSlot }) {
  const hostNew = mapGet(results.nodes, hostOld);
  const slotLink = n2.inputs?.[idx]?.link ?? null;
  const link =
    slotLink != null
      ? graph.getLink
        ? graph.getLink(slotLink)
        : graph._links?.get?.(slotLink)
      : null;
  const matches = (po) =>
    link && po && String(link.origin_id) === String(po.node.id) && link.origin_slot === po.slot;

  if (hostNew) {
    let po = pinOrigin(graph, hostNew, hostSlot);
    if (!po && hostNew.inputs?.[hostSlot]?.widget) {
      const prim = materialise(app, hostNew, hostSlot);
      if (prim) po = { node: prim, slot: 0 };
    }
    if (!po) return false;
    if (matches(po)) {
      recordProvenance(n2, idx, hostNew, hostSlot, slotLink);
      return true;
    }
    if (typeof po.node.connect !== "function") {
      // Subgraph boundary "nodes" have no connect(); nothing to rebuild from.
      forgetProvenance(n2, idx);
      return true;
    }
    if (slotLink != null) n2.disconnectInput(idx);
    const ll = linkSlots(po.node, po.slot, n2, idx) ?? null;
    if (ll) recordProvenance(n2, idx, hostNew, hostSlot, ll.id);
    else forgetProvenance(n2, idx);
    return true;
  }

  const host = nodeById(graph, hostOld);
  const po = host ? pinOrigin(graph, host, hostSlot) : null;
  if (matches(po)) recordProvenance(n2, idx, host, hostSlot, slotLink);
  else forgetProvenance(n2, idx);
  return true;
}
