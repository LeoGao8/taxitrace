// Taxiway network graph built from labelled polylines (any source).
//
//   nodes  — clustered line vertices, plus points where lines cross or where
//            a line ends on another one (T-junction)
//   edges  — the pieces of each segment between nodes, carrying that line's
//            refs, so a taxiway split over several ways is still one ref
//
// Two refs "meet" wherever they share a node.
import { projection, snapTolerance, dist, projectOnSegment, segmentIntersection, Grid } from './geometry.js';

export function buildGraph(airport) {
  const proj = projection(airport);
  const tol = snapTolerance(airport);
  const nodes = []; // [x, y]
  const nodeGrid = new Grid(tol * 2);

  // Reuse an existing node within `tol`, otherwise make a new one.
  const nodeAt = (p) => {
    let best = -1;
    let bestD = tol;
    for (const n of nodeGrid.near(p)) {
      const d = dist(nodes[n], p);
      if (d <= bestD) {
        best = n;
        bestD = d;
      }
    }
    if (best >= 0) return best;
    nodes.push(p);
    nodeGrid.insertPoint(p, nodes.length - 1);
    return nodes.length - 1;
  };

  // 1. Segments with clustered endpoint nodes.
  const segments = []; // { a, b, pa, pb, feature }
  for (const feature of airport.features) {
    if (feature.kind === 'apron' || feature.coords.length < 2) continue;
    const pts = feature.coords.map(proj.fwd);
    let prev = nodeAt(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const cur = nodeAt(pts[i]);
      if (cur !== prev) segments.push({ a: prev, b: cur, feature, splits: [] });
      prev = cur;
    }
  }
  const vertexCount = nodes.length;

  const segGrid = new Grid(Math.max(tol * 8, 1));
  segments.forEach((s, i) => segGrid.insertSegment(nodes[s.a], nodes[s.b], i));

  // 2. T-junctions: a vertex lying on another segment's interior.
  for (let n = 0; n < vertexCount; n++) {
    const seen = new Set();
    for (const si of segGrid.near(nodes[n])) {
      if (seen.has(si)) continue;
      seen.add(si);
      const s = segments[si];
      if (s.a === n || s.b === n) continue;
      const hit = projectOnSegment(nodes[n], nodes[s.a], nodes[s.b]);
      if (hit.dist <= tol && hit.t > 0 && hit.t < 1) s.splits.push({ t: hit.t, node: n });
    }
  }

  // 3. Crossings without a shared vertex.
  segments.forEach((s, i) => {
    const candidates = new Set();
    const pa = nodes[s.a];
    const pb = nodes[s.b];
    const steps = Math.max(1, Math.ceil(dist(pa, pb) / (segGrid.size / 4)));
    for (let k = 0; k <= steps; k++) {
      for (const j of segGrid.near([pa[0] + ((pb[0] - pa[0]) * k) / steps, pa[1] + ((pb[1] - pa[1]) * k) / steps])) {
        if (j > i) candidates.add(j);
      }
    }
    for (const j of candidates) {
      const o = segments[j];
      if (o.a === s.a || o.a === s.b || o.b === s.a || o.b === s.b) continue;
      const hit = segmentIntersection(pa, pb, nodes[o.a], nodes[o.b]);
      if (!hit) continue;
      const n = nodeAt(hit.point); // snaps to a nearby endpoint if there is one
      if (n !== s.a && n !== s.b) s.splits.push({ t: hit.t, node: n });
      if (n !== o.a && n !== o.b) o.splits.push({ t: hit.u, node: n });
    }
  });

  // 4. Edges between consecutive nodes along each segment.
  const edges = [];
  const adj = nodes.map(() => []);
  const refNodes = new Map();
  const refEdges = new Map();
  const seenEdge = new Set();

  for (const s of segments) {
    const chain = [s.a, ...s.splits.sort((x, y) => x.t - y.t).map((x) => x.node), s.b];
    for (let k = 1; k < chain.length; k++) {
      const a = chain[k - 1];
      const b = chain[k];
      if (a === b) continue;
      const key = `${Math.min(a, b)}-${Math.max(a, b)}-${s.feature.id}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      const e = edges.length;
      edges.push({ a, b, len: dist(nodes[a], nodes[b]), refs: s.feature.refs, kind: s.feature.kind, fid: s.feature.id });
      adj[a].push(e);
      adj[b].push(e);
      for (const ref of s.feature.refs) {
        if (!refNodes.has(ref)) refNodes.set(ref, new Set());
        refNodes.get(ref).add(a).add(b);
        if (!refEdges.has(ref)) refEdges.set(ref, []);
        refEdges.get(ref).push(e);
      }
    }
  }

  return { nodes, edges, adj, refNodes, refEdges, proj, tol, unit: proj.unit };
}

// Junction nodes shared by two refs.
export function junctions(graph, refA, refB) {
  const a = graph.refNodes.get(refA);
  const b = graph.refNodes.get(refB);
  if (!a || !b) return [];
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  return [...small].filter((n) => large.has(n));
}

// Nearest point on any edge of `ref` to planar point p.
export function projectOntoRef(graph, ref, p) {
  let best = null;
  for (const e of graph.refEdges.get(ref) || []) {
    const { a, b } = graph.edges[e];
    const hit = projectOnSegment(p, graph.nodes[a], graph.nodes[b]);
    if (!best || hit.dist < best.dist) best = { edge: e, t: hit.t, point: hit.point, dist: hit.dist };
  }
  return best;
}
