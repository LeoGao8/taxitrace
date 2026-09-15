// Router: ordered taxiway refs -> the actual path you taxi.
//
// Layers of choices:  start → junctions(ref0,ref1) → … → junctions(refN-1,refN) → end
// The cost of moving from one layer to the next is the shortest walk along
// that taxiway's own edges. A small DP picks the junction combination with the
// least total length. Where the data doesn't support a real connection the
// router still produces a path, marked `inferred`, and charges a penalty so a
// genuine connection always wins.
import { junctions, projectOntoRef } from './graph.js';
import { dist, MinHeap } from './geometry.js';

const INFERRED_PENALTY = 3;
// A runway you were told to hold short of or cross: go straight over it, and
// only taxi along it when nothing else connects.
const ALONG_RUNWAY_PENALTY = 25;
// Going over a runway and straight back the way you came. Only if nothing else connects.
const U_TURN_COST = 1e7;
const MAX_JUNCTIONS = 80; // per taxiway pair; overlapping refs can share long runs

/**
 * @param graph  from buildGraph
 * @param legs   [{ ref, kind, cross? }] in taxi order (no missing refs, no consecutive repeats);
 *               cross: a runway to go over rather than along
 * @param opts   start: [x,y] | null    clicked start point (planar)
 *               end:   [x,y] | null    clicked end point (planar)
 *               hold:  boolean         last leg is a runway to hold short of
 */
export function routeLegs(graph, legs, { start = null, end = null, hold = false } = {}) {
  if (!legs.length) return null;
  const router = new Router(graph, legs);
  const m = legs.length;

  const layers = [[router.endpoint(0, start, 'start')]];
  for (let k = 1; k < m; k++) layers.push(router.transitions(k - 1, k));
  layers.push([hold && m > 1 ? { id: 'hold', type: 'hold' } : router.endpoint(m - 1, end, 'end')]);

  // A runway between two taxiways is crossed: remember which side of it we
  // arrived on (junction states split in two), so the taxi carries on to the
  // other side instead of turning back.
  const sided = legs.map((l, k) => k > 0 && k < m - 1 && l.kind === 'runway' && legs[k - 1].kind !== 'runway' && legs[k + 1].kind !== 'runway');
  const splitSides = (layer) => layer.flatMap((s) => (s.type === 'junction' && !s.connector ? [1, -1].map((side) => ({ ...s, id: `${s.id}${side > 0 ? '+' : '-'}`, key: s.id, side })) : [s]));
  sided.forEach((isSided, r) => {
    if (!isSided) return;
    layers[r] = splitSides(layers[r]);
    layers[r + 1] = splitSides(layers[r + 1]);
  });
  const sideOf = (runway, node, p) => {
    const e = graph.adj[node].map((i) => graph.edges[i]).find((edge) => edge.refs.includes(runway));
    if (!e || !p) return 0;
    const [ax, ay] = graph.nodes[e.a];
    const [bx, by] = graph.nodes[e.b];
    const [nx, ny] = graph.nodes[node];
    const cross = (bx - ax) * (p[1] - ny) - (by - ay) * (p[0] - nx);
    return Math.abs(cross) < 1e-9 ? 0 : Math.sign(cross);
  };
  let uTurn = null;

  // DP over layers.
  const best = layers.map((layer) => layer.map(() => ({ cost: Infinity, prev: -1, walk: null })));
  best[0][0].cost = 0;
  for (let k = 0; k < m; k++) {
    layers[k + 1].forEach((to, i) => {
      const extra = to.connector ? to.connector.len * INFERRED_PENALTY : 0;
      layers[k].forEach((from, j) => {
        if (best[k][j].cost === Infinity) return;
        const walk = router.walk(k, from, to);
        let cost = best[k][j].cost + walk.cost * (legs[k].cross ? ALONG_RUNWAY_PENALTY : 1) + extra;
        let straight = false;

        if (to.side && sided[k + 1] && !walk.whole) {
          // Arriving at the runway: this state only holds routes from its side.
          const arrival = walk.coords[walk.coords.length - 2];
          const side = sideOf(legs[k + 1].ref, to.exit, arrival);
          if (side && side !== to.side) return;
        }
        if (sided[k] && from.side) {
          // On the runway itself: keep the side; note whether we went straight over.
          if (to.side !== from.side) return;
          straight = from.entry === to.exit;
        }
        if (k > 0 && sided[k - 1] && from.side && best[k][j].straight && !walk.whole && walk.coords.length > 1) {
          // Leaving the runway: back to the side we came from is a U-turn.
          if (sideOf(legs[k - 1].ref, from.entry, walk.coords[1]) === from.side) cost += U_TURN_COST;
        }
        if (cost < best[k + 1][i].cost) best[k + 1][i] = { cost, prev: j, walk, straight };
      });
    });
  }

  // Backtrack the chosen state in every layer.
  const chosen = new Array(layers.length);
  chosen[m] = 0;
  for (let k = m; k > 0; k--) chosen[k - 1] = best[k][chosen[k]].prev;

  const pieces = []; // continuous route: [{ ref, kind, inferred, coords }]
  const whole = []; // legs drawn in full because start/end is unknown
  const turns = [];
  const legLengths = []; // distance walked along each leg; null when drawn whole
  let length = 0;
  let inferred = false;

  for (let k = 0; k < m; k++) {
    const walk = best[k + 1][chosen[k + 1]].walk;
    legLengths.push(walk.whole ? null : walk.len);
    if (walk.whole) whole.push({ ref: legs[k].ref, kind: legs[k].kind, index: k });
    else if (walk.coords.length > 1) {
      pieces.push({ ref: legs[k].ref, kind: legs[k].kind, inferred: walk.inferred, coords: walk.coords });
      length += walk.len;
      inferred ||= walk.inferred;
    }

    const next = layers[k + 1][chosen[k + 1]];
    if (best[k + 1][chosen[k + 1]].cost >= U_TURN_COST && !uTurn && k > 0 && sided[k - 1]) uTurn = { ref: legs[k].ref, runway: legs[k - 1].ref };
    if (next.type === 'junction') {
      if (next.connector) {
        pieces.push({ ref: null, kind: 'link', inferred: true, coords: next.connector.coords });
        length += next.connector.len;
        inferred = true;
      }
      turns.push({
        from: legs[k].ref,
        to: legs[k + 1].ref,
        point: graph.nodes[next.entry],
        inferred: !!next.connector,
        hold: k + 1 === m - 1 && hold,
        index: k + 1, // leg being turned onto
      });
    }
  }

  const first = layers[0][0];
  const last = layers[m][0];
  return {
    pieces,
    whole,
    turns,
    length,
    inferred,
    start: first.type === 'point' ? { point: first.proj.point, clicked: first.clicked, ref: legs[0].ref } : null,
    end:
      last.type === 'point'
        ? { point: last.proj.point, clicked: last.clicked, ref: legs[m - 1].ref }
        : last.type === 'hold'
          ? { point: turns[turns.length - 1].point, hold: legs[m - 1].ref }
          : null,
    legLengths,
    uTurn, // { ref, runway } when the data forced turning back after crossing
    connectors: layers.slice(1, m).map((layer, i) => !!layer[chosen[i + 1]]?.connector),
    brokenLegs: pieces.filter((p) => p.inferred && p.ref).map((p) => p.ref),
  };
}

class Router {
  constructor(graph, legs) {
    this.g = graph;
    this.legs = legs;
    this.cache = new Map();
  }

  endpoint(legIndex, point, id) {
    if (!point) return { id, type: 'free' };
    const proj = projectOntoRef(this.g, this.legs[legIndex].ref, point);
    return proj ? { id, type: 'point', proj, clicked: point } : { id, type: 'free' };
  }

  transitions(ka, kb) {
    const a = this.legs[ka].ref;
    const b = this.legs[kb].ref;
    let shared = junctions(this.g, a, b);
    if (shared.length > MAX_JUNCTIONS) shared = shared.filter((_, i) => i % Math.ceil(shared.length / MAX_JUNCTIONS) === 0);
    if (shared.length) return shared.map((n) => ({ id: `j${kb}:${n}`, type: 'junction', exit: n, entry: n }));

    // Data gap: shortest connection over the whole network between the two taxiways.
    const connector = this.connect(a, b);
    return [{ id: `j${kb}:gap`, type: 'junction', exit: connector.from, entry: connector.to, connector }];
  }

  connect(refA, refB) {
    const g = this.g;
    const seeds = [...(g.refNodes.get(refA) || [])].map((node) => ({ node, cost: 0 }));
    const targets = g.refNodes.get(refB) || new Set();
    const run = dijkstra(g, seeds, { targets });
    if (run.reached != null) {
      const nodes = pathNodes(run, run.reached);
      return { from: nodes[0], to: run.reached, len: run.dist.get(run.reached), coords: nodes.map((n) => g.nodes[n]) };
    }
    // Not connected at all: straight line between the closest nodes.
    let best = { d: Infinity };
    for (const { node: u } of seeds) {
      for (const v of targets) {
        const d = dist(g.nodes[u], g.nodes[v]);
        if (d < best.d) best = { d, u, v };
      }
    }
    return { from: best.u, to: best.v, len: best.d, coords: [g.nodes[best.u], g.nodes[best.v]] };
  }

  // Walk leg k from state `from` (its entry side) to state `to` (its exit side).
  walk(k, from, to) {
    if (to.type === 'hold') return { cost: 0, len: 0, coords: [], inferred: false };
    if (from.type === 'free' || to.type === 'free') return { cost: 0, whole: true };

    const ref = this.legs[k].ref;
    const g = this.g;

    // Start and end on the same edge: straight along it.
    if (from.type === 'point' && to.type === 'point' && from.proj.edge === to.proj.edge) {
      const len = dist(from.proj.point, to.proj.point);
      return { cost: len, len, coords: [from.proj.point, to.proj.point], inferred: false };
    }

    const seeds = this.seeds(from);
    let inferred = false;
    let run = this.run(k, from, seeds, ref);
    let target = this.target(run, to);
    if (target.cost === Infinity) {
      // The taxiway's own lines don't connect these points — cross the network.
      run = this.run(k, from, seeds, null);
      target = this.target(run, to);
      inferred = true;
    }
    if (target.cost === Infinity) {
      const a = this.pointOf(from);
      const b = this.pointOf(to);
      const len = dist(a, b);
      return { cost: len * INFERRED_PENALTY, len, coords: [a, b], inferred: true };
    }

    const nodes = pathNodes(run, target.node);
    const coords = nodes.map((n) => g.nodes[n]);
    if (from.type === 'point') coords.unshift(from.proj.point);
    if (to.type === 'point') coords.push(to.proj.point);
    return { cost: target.cost * (inferred ? INFERRED_PENALTY : 1), len: target.cost, coords, inferred };
  }

  seeds(state) {
    if (state.type === 'junction') return [{ node: state.entry, cost: 0 }];
    const { edge, t } = state.proj;
    const e = this.g.edges[edge];
    return [
      { node: e.a, cost: t * e.len },
      { node: e.b, cost: (1 - t) * e.len },
    ];
  }

  target(run, state) {
    if (state.type === 'junction') {
      const cost = run.dist.get(state.exit) ?? Infinity;
      return { node: state.exit, cost };
    }
    const { edge, t } = state.proj;
    const e = this.g.edges[edge];
    const viaA = (run.dist.get(e.a) ?? Infinity) + t * e.len;
    const viaB = (run.dist.get(e.b) ?? Infinity) + (1 - t) * e.len;
    return viaA <= viaB ? { node: e.a, cost: viaA } : { node: e.b, cost: viaB };
  }

  pointOf(state) {
    return state.type === 'point' ? state.proj.point : this.g.nodes[state.type === 'junction' ? state.entry : 0];
  }

  run(k, from, seeds, ref) {
    const key = `${k}|${from.key ?? from.id}|${ref ?? '*'}`;
    if (!this.cache.has(key)) this.cache.set(key, dijkstra(this.g, seeds, { ref }));
    return this.cache.get(key);
  }
}

// Multi-source Dijkstra. `ref` restricts travel to that taxiway's edges;
// `targets` stops at the first target reached.
export function dijkstra(graph, seeds, { ref = null, targets = null } = {}) {
  const distMap = new Map();
  const prev = new Map(); // node -> previous node
  const heap = new MinHeap();
  for (const { node, cost } of seeds) {
    if (cost < (distMap.get(node) ?? Infinity)) {
      distMap.set(node, cost);
      prev.delete(node);
      heap.push(cost, node);
    }
  }
  const done = new Set();
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (targets?.has(u)) return { dist: distMap, prev, reached: u };
    for (const e of graph.adj[u]) {
      const edge = graph.edges[e];
      if (ref && !edge.refs.includes(ref)) continue;
      const v = edge.a === u ? edge.b : edge.a;
      const nd = d + edge.len;
      if (nd < (distMap.get(v) ?? Infinity)) {
        distMap.set(v, nd);
        prev.set(v, u);
        heap.push(nd, v);
      }
    }
  }
  return { dist: distMap, prev, reached: null };
}

function pathNodes(run, target) {
  const nodes = [target];
  let n = target;
  while (run.prev.has(n)) {
    n = run.prev.get(n);
    nodes.push(n);
  }
  return nodes.reverse();
}
