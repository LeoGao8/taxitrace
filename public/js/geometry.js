// Planar geometry shared by the graph builder and router. Everything here
// works in a flat x/y space: metres for geo airports, pixels for charts.

export function projection(airport) {
  if (airport.crs !== 'geo') {
    // CRS.Simple [lat, lng] = [height - y, x]; keep y up, it doesn't matter.
    return { fwd: ([lat, lng]) => [lng, lat], inv: ([x, y]) => [y, x], unit: 'px' };
  }
  const [[minLat], [maxLat]] = airport.bounds || [[0], [0]];
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  // Equirectangular metres — accurate to well under 1% across one airport.
  return {
    fwd: ([lat, lng]) => [lng * 111320 * k, lat * 110574],
    inv: ([x, y]) => [y / 110574, x / (111320 * k)],
    unit: 'm',
  };
}

// How close two points must be to count as "the same place" when joining
// lines into a network.
export function snapTolerance(airport) {
  if (airport.crs === 'geo') return 2; // metres: OSM junctions share nodes exactly
  const { width, height } = airport.image;
  return Math.hypot(width, height) * 0.008; // hand traces rarely touch exactly
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function lerp(a, b, t) {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

// Closest point on segment ab to p: { t in [0,1], point, dist }.
export function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  const point = [a[0] + t * dx, a[1] + t * dy];
  return { t, point, dist: dist(p, point) };
}

// Proper intersection of segments p1p2 and q1q2: { t, u, point } or null.
export function segmentIntersection(p1, p2, q1, q2) {
  const rx = p2[0] - p1[0];
  const ry = p2[1] - p1[1];
  const sx = q2[0] - q1[0];
  const sy = q2[1] - q1[1];
  const d = rx * sy - ry * sx;
  if (Math.abs(d) < 1e-12) return null; // parallel
  const qpx = q1[0] - p1[0];
  const qpy = q1[1] - p1[1];
  const t = (qpx * sy - qpy * sx) / d;
  const u = (qpx * ry - qpy * rx) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: [p1[0] + t * rx, p1[1] + t * ry] };
}

export function polylineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += dist(coords[i - 1], coords[i]);
  return len;
}

// Uniform grid for "what's near here?" queries.
export class Grid {
  constructor(cellSize) {
    this.size = cellSize;
    this.cells = new Map();
  }
  key(x, y) {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
  }
  insertPoint(p, value) {
    const k = this.key(p[0], p[1]);
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push(value);
  }
  // Every cell a segment passes through (sampled finely enough that a 3x3
  // query around any point within one cell of the segment finds it).
  insertSegment(a, b, value) {
    const len = dist(a, b);
    const steps = Math.max(1, Math.ceil(len / (this.size / 4)));
    const seen = new Set();
    for (let i = 0; i <= steps; i++) {
      const p = lerp(a, b, i / steps);
      const k = this.key(p[0], p[1]);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k).push(value);
    }
  }
  // Values in the 3x3 block of cells around p (may contain duplicates).
  *near(p) {
    const cx = Math.floor(p[0] / this.size);
    const cy = Math.floor(p[1] / this.size);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(`${cx + dx},${cy + dy}`);
        if (cell) yield* cell;
      }
    }
  }
}

export class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(priority, value) {
    const a = this.items;
    a.push([priority, value]);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent][0] <= a[i][0]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
