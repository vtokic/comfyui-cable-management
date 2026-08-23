// Route reconciliation -- the 2e semantics, live (increment 1: plain chains).
//
// The design round's rulings, as running behavior:
//   - HONEST DISCONNECT: breaking a chain severs the hidden true links for real.
//     No auto-mend to the nearest surviving anchor (2b's walk is retracted).
//   - A severed subtree keeps its apparent structure as a FRAGMENT, drawn as ghost
//     strokes (floating-link register): shape preserved, no data in the system.
//     Re-feeding the fragment's head re-materializes it from the new feed.
//   - WIDGET chains never go dead: a widget that loses its feed is a provider
//     again (its own literal), and everything downstream re-sources to it.
//     Rule: a fragment re-roots iff its head can provide, else it floats.
//   - REPLACING a feed re-sources the subtree live -- the route delivers whatever
//     its head is fed.
//   - A hand-wired input always beats a remembered route ("their wire wins").
//
// The whole pass is LOCAL rules on one record, run to fixpoint -- cascades (sever
// rolling down a chain, re-source following a replacement) emerge from iteration,
// not from subtree walks:
//
//   record [host, hostIdx, linkId] on consumer input (node, idx):
//   1. linkId === null (severed memory): host gone or input hand-fed -> DROP;
//      host pin able to provide again -> RE-MATERIALIZE, record goes live.
//   2. linkId real, own link matches (healthy passthrough):
//      host pin cannot provide -> SEVER (disconnect for real, record -> null id);
//      host pin provides something else -> RE-SOURCE (reconnect, new id).
//   3. linkId real, own link gone: re-fed by hand -> DROP ("their wire wins");
//      host gone -> DROP (nothing to remember against); host pin still able to
//      provide -> DROP (the user cut THIS consumer specifically -- ruled: no
//      memory); host pin dead too -> the break came from UPSTREAM (origin died
//      or the whole chain was cut at once) -> convert to severed memory, the
//      same fragment shape the rule-2 cascade produces.
//
// "Provide" is the widget pin's dual nature from the design round: an input's
// output only passes through (feed dead = nothing to give -> sever), a widget's
// output falls back to being an output (its literal) when the feed dies.
//
// REROUTE CHAINS (increment 2): a link that threads reroutes or ribbon teeth
// severs like any other, but its chain survives as a dangling floating link --
// the typed, grabbable carrier the design round ruled ("floating links can
// exist on either end"). The record's optional 4th element remembers the
// chain's TAIL reroute; revival and re-sourcing pass it to core's
// connect(..., afterRerouteId), which re-threads the new link through the
// same chain and removes the parked float itself. A floatfrom entry keeps the
// parked float drawing from the pin it apparently descends from.
//
// "Severed memory" reuses the legacy record slot with linkId=null -- fragments
// serialize with the workflow for free, and prune() already keeps null-id
// records dormant. Record shape: [host, hostIdx, linkId|null, tailRerouteId?].

import { nodeById } from "./graph.js";
import { isOwned, ownerOf, materialiseIn } from "./primitive.js";
import { anchorOf, invalidate } from "./ledger.js";
import { stampFloats } from "./routestore.js";
import { linkSlots } from "./invoke.js";

const FROM = "cablemanagement.from";

const getLink = (graph, id) =>
  graph.getLink ? graph.getLink(id) : graph._links?.get?.(id) ?? graph.links?.[id];

function setRec(node, idx, rec) {
  const map = { ...(node.properties?.[FROM] ?? {}) };
  map[String(idx)] = rec;
  node.properties[FROM] = map;
}

function dropRec(node, idx) {
  const map = node.properties?.[FROM];
  if (!map) return;
  const next = { ...map };
  delete next[String(idx)];
  if (Object.keys(next).length) node.properties[FROM] = next;
  else delete node.properties[FROM];
}

/** Decision-only twin of providerOf: no primitive gets materialised. */
function canProvide(graph, host, hostIdx) {
  const slot = host?.inputs?.[hostIdx];
  if (!slot) return false;
  if (slot.link != null) return !!getLink(graph, slot.link);
  return !!slot.widget;
}

/**
 * What a host pin can PROVIDE right now: the true origin of its live feed, or --
 * for widget-backed inputs -- the host's own literal, republished through its
 * owned primitive (materialised on demand). Null means the pin has nothing to
 * give, which is what makes an input-flavour chain sever instead of re-root.
 */
function providerOf(graph, host, hostIdx) {
  const slot = host?.inputs?.[hostIdx];
  if (!slot) return null;
  const lid = slot.link;
  if (lid != null) {
    const link = getLink(graph, lid);
    const origin = link ? nodeById(graph, link.origin_id) : null;
    return origin ? { origin, slot: link.origin_slot } : null;
  }
  if (slot.widget) {
    const prim = ownerOf(graph, host, hostIdx) ?? materialiseIn(graph, host, hostIdx);
    if (prim) return { origin: prim, slot: 0 };
  }
  return null;
}

/**
 * One reconciliation pass to fixpoint. Mutates the graph (honest severs,
 * re-materializations); runs inside the same stack as the gesture that
 * triggered it wherever possible, so its edits share the gesture's undo step.
 */
export function pass(graph) {
  const summary = { severed: [], fed: [], resourced: [], dropped: [] };
  if (!graph) return summary;
  let changed = true;
  for (let guard = 0; changed && guard < 50; guard++) {
    changed = false;
    for (const node of graph.nodes ?? []) {
      const map = node.properties?.[FROM];
      if (!map) continue;
      for (const key of Object.keys(map)) {
        const idx = Number(key);
        const rec = map[key];
        const slot = node.inputs?.[idx];
        if (!Array.isArray(rec) || !slot) continue;
        const [h, hIdx, lid] = rec;
        const host = nodeById(graph, h);
        const own = slot.link != null ? getLink(graph, slot.link) : null;

        if (lid === null) {
          // Rule 1: severed memory.
          if (!host) {
            dropRec(node, idx);
            summary.dropped.push(`${node.id}:${idx} (host gone)`);
            changed = true;
            continue;
          }
          if (slot.link != null) {
            // Hand-fed while severed: their wire wins, permanently.
            dropRec(node, idx);
            summary.dropped.push(`${node.id}:${idx} (hand-fed)`);
            changed = true;
            continue;
          }
          const prov = providerOf(graph, host, Number(hIdx));
          if (prov) {
            // Re-thread the remembered reroute chain if it still exists; the
            // parked float on it is removed by core when the link lands.
            const tail = rec[3];
            const chain = tail != null ? graph.getReroute?.(tail) ?? graph.reroutes?.get?.(tail) : null;
            const link = linkSlots(prov.origin, prov.slot, node, idx, chain ? tail : undefined);
            const newId = link?.id ?? node.inputs[idx].link;
            if (newId != null) {
              setRec(node, idx, [String(h), Number(hIdx), newId]);
              summary.fed.push(`${node.id}:${idx}<-${h}:${hIdx}`);
              changed = true;
            }
          }
          continue;
        }

        if (own && slot.link === lid) {
          // Rule 2: healthy passthrough -- is its host pin still telling the truth?
          if (!host) continue; // dead host is prune's territory (retarget-or-forget)
          const tail = own.parentId ?? null;
          const prov = providerOf(graph, host, Number(hIdx));
          if (!prov) {
            // Chain broken upstream and the host has nothing to give: sever
            // for real, keep the shape as memory. keepReroutes parks any
            // reroute chain as a dangling float -- the typed carrier.
            node.disconnectInput(idx, true);
            setRec(node, idx, tail != null
              ? [String(h), Number(hIdx), null, tail]
              : [String(h), Number(hIdx), null]);
            if (tail != null) {
              // The parked float should draw from the pin it apparently
              // descends from, not from the dead chain's true origin.
              stampFloats(graph, [tail], [String(h), Number(hIdx)], { ifAbsent: true });
            }
            summary.severed.push(`${node.id}:${idx}`);
            changed = true;
            continue;
          }
          if (String(prov.origin.id) !== String(own.origin_id) || prov.slot !== own.origin_slot) {
            // The pin provides something else now: the route follows its head,
            // re-threading the same reroute chain the wire already rode.
            node.disconnectInput(idx, true);
            const link = linkSlots(prov.origin, prov.slot, node, idx, tail ?? undefined);
            const newId = link?.id ?? node.inputs[idx].link;
            setRec(node, idx, [String(h), Number(hIdx), newId ?? null]);
            summary.resourced.push(`${node.id}:${idx}->${prov.origin.id}:${prov.slot}`);
            changed = true;
          }
          continue;
        }

        // Rule 3: our link is gone.
        if (slot.link != null) {
          dropRec(node, idx);
          summary.dropped.push(`${node.id}:${idx} (hand-fed)`);
          changed = true;
        } else if (!host || canProvide(graph, host, Number(hIdx))) {
          // Host gone, or the feed above is intact -- the user cut THIS
          // consumer specifically. Ruled: no memory.
          dropRec(node, idx);
          summary.dropped.push(`${node.id}:${idx} (user cut)`);
          changed = true;
        } else {
          // The host pin is dead too: the break came from upstream (origin
          // deleted, chain cut wholesale). Same fragment as a cascade sever.
          setRec(node, idx, [String(h), Number(hIdx), null]);
          summary.severed.push(`${node.id}:${idx} (upstream death)`);
          changed = true;
        }
      }
    }
  }
  ghostEdges = collectGhosts(graph);
  invalidate();
  return { ...summary, ghosts: ghostEdges.length };
}

let running = false;

/**
 * The safe entry point: never re-enters (the pass's own connects fire the events
 * that schedule it), and never operates mid-drag -- core temporarily holds links
 * in limbo while one is in hand, and reconciling against that would sever chains
 * the user is merely moving.
 */
export function reconcile(app, graph) {
  if (running || !graph) return null;
  if (app?.canvas?.linkConnector?.isConnecting) return null;
  running = true;
  try {
    return pass(graph);
  } finally {
    running = false;
  }
}

/** Ghost edges of every fragment: host pin -> severed consumer input, per null record. */
function collectGhosts(graph) {
  const edges = [];
  for (const node of graph.nodes ?? []) {
    const map = node.properties?.[FROM];
    if (!map) continue;
    for (const key of Object.keys(map)) {
      const rec = map[key];
      if (!Array.isArray(rec) || rec[2] !== null) continue;
      const idx = Number(key);
      if (node.inputs?.[idx]?.link != null) continue;
      const host = nodeById(graph, rec[0]);
      if (!host) continue;
      // A remembered reroute chain carries the wire's parked shape already --
      // the ghost stroke only needs to bridge from the chain's TAIL reroute to
      // the severed input. Without a chain it bridges from the pin itself.
      edges.push({ host: String(rec[0]), hostIdx: Number(rec[1]), node: String(node.id), idx, type: node.inputs?.[idx]?.type, tail: rec[3] ?? null });
    }
  }
  return edges;
}

let ghostEdges = [];
let renderInstalled = false;

/** Graph-space anchor of a slot's DOM dot; getConnectionPos fallback for legacy mode. */
function slotAnchor(app, node, idx, isInput) {
  const root = document.querySelector(`.lg-node[data-node-id="${CSS.escape(String(node.id))}"]`);
  const dot = root?.querySelector(`[data-slot-key="${CSS.escape(`${node.id}-${isInput ? "in" : "out"}-${idx}`)}"]`);
  const scale = app.canvas?.ds?.scale;
  if (root && dot && scale) {
    const rr = root.getBoundingClientRect();
    const dr = dot.getBoundingClientRect();
    if (dr.width) {
      const TITLE = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
      return [
        node.pos[0] + (dr.left + dr.width / 2 - rr.left) / scale,
        node.pos[1] - TITLE + (dr.top + dr.height / 2 - rr.top) / scale,
      ];
    }
  }
  return node.getConnectionPos?.(isInput, idx) ?? null;
}

/** The pass-through pin's anchor, falling back to the host input's own position. */
function pinAnchor(app, graph, hostId, hostIdx) {
  const host = nodeById(graph, hostId);
  if (!host) return null;
  const el = document.querySelector(
    `.cablemanagement-pin[data-cablemanagement-node="${CSS.escape(String(hostId))}"][data-cablemanagement-index="${CSS.escape(String(hostIdx))}"]`
  );
  return (el && anchorOf(el, host)) ?? slotAnchor(app, host, hostIdx, true);
}

/**
 * Draw the fragments: one faint dashed stroke per ghost edge, in the slot type's
 * link colour, over drawConnections' output (the links layer -- under DOM nodes
 * in Vue, under node paint in legacy). Wrapped once, no-op while no fragments
 * exist.
 */
export function installGhostRender(app) {
  if (renderInstalled) return true;
  const proto = app?.canvas?.constructor?.prototype;
  const orig = proto?.drawConnections;
  if (typeof orig !== "function") return false;
  proto.drawConnections = function (ctx) {
    const r = orig.call(this, ctx);
    if (ghostEdges.length && this.graph) {
      try {
        for (const e of ghostEdges) {
          const tailR = e.tail != null ? this.graph.getReroute?.(e.tail) ?? this.graph.reroutes?.get?.(e.tail) : null;
          const a = tailR?.pos ? [tailR.pos[0], tailR.pos[1]] : pinAnchor(app, this.graph, e.host, e.hostIdx);
          const bNode = nodeById(this.graph, e.node);
          const b = bNode && slotAnchor(app, bNode, e.idx, true);
          if (!a || !b) continue;
          ctx.save();
          ctx.globalAlpha = 0.35;
          ctx.setLineDash([8, 5]);
          ctx.lineWidth = 2;
          ctx.strokeStyle =
            this.default_connection_color_byType?.[e.type] ?? this.default_link_color ?? "#9c9c9c";
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          const bend = Math.max(40, Math.abs(b[0] - a[0]) * 0.4);
          ctx.bezierCurveTo(a[0] + bend, a[1], b[0] - bend, b[1], b[0], b[1]);
          ctx.stroke();
          ctx.restore();
          window.__cablemanagementGhostDraws = (window.__cablemanagementGhostDraws ?? 0) + 1;
        }
      } catch {
        /* fragment paint must never take the canvas down */
      }
    }
    return r;
  };
  renderInstalled = true;
  return true;
}
