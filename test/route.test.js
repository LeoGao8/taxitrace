import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexAirport, planRoute } from '../public/js/route.js';
import { buildGraph, junctions } from '../public/js/graph.js';
import { dijkstra } from '../public/js/router.js';
import { polylineLength } from '../public/js/geometry.js';
import { splitRefs, cleanRef } from '../public/js/refs.js';
import { normalise } from '../server/sources/osm.js';

// A traced chart (pixel space, y up). P(x, y) -> CRS.Simple [lat, lng].
const P = (x, y) => [y, x];
const line = (id, refs, kind, ...pts) => ({ id, refs, kind, coords: pts.map(([x, y]) => P(x, y)) });
//
//   18 (runway) x=100        A y=200 from runway to INTL5
//   INTL5 x=300, y 100→497   stops just short of G (T-junction snap)
//   G y=500, x 0→1000        split over two ways at x=450
//   C x=600 from y=450→900, crosses G with no shared vertex, then east to
//     x=950 and back down to G at x=950 — so C meets G twice
//   Q y=700 in two pieces joined only by an unnamed link
//   Z isolated
const chart = {
  crs: 'image',
  image: { width: 1000, height: 1000 },
  bounds: [[0, 0], [1000, 1000]],
  features: [
    line('rwy', ['18', '36'], 'runway', [100, 0], [100, 1000]),
    line('a', ['A'], 'taxiway', [100, 200], [300, 200]),
    line('intl5', ['INTL5'], 'taxiway', [300, 100], [300, 497]),
    line('g1', ['G'], 'taxiway', [0, 500], [450, 500]),
    line('g2', ['G'], 'taxiway', [450, 500], [1000, 500]),
    line('c1', ['C'], 'taxiway', [600, 450], [600, 900], [950, 900]),
    line('c2', ['C'], 'taxiway', [950, 900], [950, 500]),
    line('q1', ['Q'], 'taxiway', [150, 700], [200, 700]),
    line('link', [], 'taxiway', [200, 700], [250, 700]),
    line('q2', ['Q'], 'taxiway', [250, 700], [400, 700]),
    line('z', ['Z'], 'taxiway', [20, 960], [60, 960]),
  ],
};
const index = indexAirport(chart);
const graph = buildGraph(chart);
const plan = (text, points) => planRoute(chart, index, graph, text, points);
const planar = (coords) => coords.map(graph.proj.fwd);
const len = (coords) => Math.round(polylineLength(planar(coords)));
const near = (a, b, tol = 1) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol, `${a} not near ${b}`);

test('graph: T-junctions, crossings and split ways all connect', () => {
  assert.equal(junctions(graph, 'INTL5', 'G').length, 1, 'INTL5 snaps onto G');
  assert.equal(junctions(graph, 'C', 'G').length, 2, 'C crosses G at x=600 and joins at x=950');
  assert.equal(junctions(graph, 'A', '18').length, 1);
  assert.equal(junctions(graph, 'A', 'INTL5').length, 1);
  assert.equal(junctions(graph, 'Q', 'G').length, 0);

  // Both G ways form one walkable taxiway.
  const west = [...graph.refNodes.get('G')].find((n) => graph.nodes[n][0] === 0);
  const east = [...graph.refNodes.get('G')].find((n) => graph.nodes[n][0] === 1000);
  const run = dijkstra(graph, [{ node: west, cost: 0 }], { ref: 'G' });
  assert.equal(Math.round(run.dist.get(east)), 1000);
});

test('middle taxiway is trimmed to the stretch between its junctions', () => {
  const r = plan('INTL5 G C');
  assert.deepEqual(r.path.pieces.map((p) => p.ref), ['G']);
  const g = planar(r.path.pieces[0].coords);
  near(g[0], [300, 500], 4);
  near(g[g.length - 1], [600, 500]);
  assert.equal(len(r.path.pieces[0].coords), 300); // x=600, not the longer x=950 junction
  assert.deepEqual(r.path.whole.map((w) => w.ref), ['INTL5', 'C']);
  assert.deepEqual(r.path.turns.map((t) => `${t.from}>${t.to}`), ['INTL5>G', 'G>C']);
  assert.equal(r.hints.length, 2);
  assert.deepEqual(r.warnings, []);
});

test('a bay in the clearance is the start point; taxi time at 10 kt', () => {
  const withStands = { ...chart, stands: [{ id: 's36', ref: '36', kind: 'stand', coords: P(320, 150) }] };
  const idx = indexAirport(withStands);
  const r = planRoute(withStands, idx, buildGraph(withStands), 'BAY 36 INTL5 G', { start: P(300, 400) });
  assert.equal(r.start.label, 'BAY 36');
  near(planar([r.path.start.point])[0], [300, 150]);
  assert.ok(r.hints.some((h) => /BAY 36.*ignored/.test(h)));
  // Chart pixels have no scale, so no time; the lead-in from the bay counts towards distance.
  assert.equal(r.path.seconds, null);
  assert.ok(Math.abs(r.path.total - (r.path.length + 20)) < 1);

  const missing = planRoute(withStands, idx, buildGraph(withStands), 'BAY 7 INTL5', {});
  assert.equal(missing.warnings[0].text, "BAY 7 isn't in this airport's data.");
});

test('taxi time is distance at 10 knots on real-world maps', () => {
  const g = (...pts) => pts.map(([lat, lon]) => ({ lat, lon }));
  const geo = normalise('TEST', { ways: [{ id: 1, tags: { aeroway: 'taxiway', ref: 'A' }, geometry: g([0, 0], [0.01, 0]) }] });
  const r = planRoute(geo, indexAirport(geo), buildGraph(geo), 'A', { start: [0, 0], end: [0.01, 0] });
  assert.ok(Math.abs(r.path.total - 1105.7) < 1, `total ${r.path.total}`);
  assert.ok(Math.abs(r.path.seconds - 1105.7 / 5.1444) < 1, `seconds ${r.path.seconds}`); // 10 kt = 5.144 m/s
});

test('start and end points trim the first and last taxiways', () => {
  const r = plan('INTL5 G C', { start: P(310, 120), end: P(900, 905) });
  assert.deepEqual(r.path.whole, []);
  assert.deepEqual(r.path.pieces.map((p) => p.ref), ['INTL5', 'G', 'C']);
  near(planar([r.path.start.point])[0], [300, 120]);
  near(planar([r.path.end.point])[0], [900, 900]);
  // One continuous line: each piece starts where the previous ended.
  for (let i = 1; i < r.path.pieces.length; i++) {
    const prev = r.path.pieces[i - 1].coords;
    near(planar([prev[prev.length - 1]])[0], planar([r.path.pieces[i].coords[0]])[0], 4);
  }
  // 380 on INTL5 + 300 on G + (400 + 300) on C via x=600. Via x=950 would be longer.
  assert.ok(Math.abs(r.path.length - 1380) < 5, `length ${r.path.length}`);
  assert.deepEqual(r.hints, []);
});

test('clearance ending in a runway stops at the hold point', () => {
  const r = plan('C G INTL5 A hold short 18', { start: P(600, 880) });
  assert.equal(r.hold, true);
  assert.equal(r.path.end.hold, '18');
  // The hold line sits back from the runway centreline (x=100) along A: 3 snap tolerances on a chart.
  const offset = graph.tol * 3;
  near(planar([r.path.end.point])[0], [100 + offset, 200]);
  assert.deepEqual(r.path.pieces.map((p) => p.ref), ['C', 'G', 'INTL5', 'A']);
  assert.ok(Math.abs(r.path.length - (380 + 300 + 300 + 200 - offset)) < 6, `length ${r.path.length}`);
  assert.deepEqual(r.path.whole, []);
  assert.deepEqual(r.path.holds.map((h) => [h.kind, h.ref, h.final]), [['hold', '18', true]]);
});

test('hold short of a runway mid-route: red bar, then the taxi carries on across it', () => {
  const offset = graph.tol * 3;
  const r = plan('INTL5 G hold short of runway 18 G', { start: P(300, 150), end: P(20, 500) });
  assert.equal(r.hold, false);
  assert.deepEqual(r.path.holds.map((h) => [h.kind, h.ref, h.final]), [['hold', '18', false]]);
  near(planar([r.path.holds[0].point])[0], [100 + offset, 500], 1); // east of the runway, on G, coming from INTL5
  // Straight over the runway: no stretch along it, and no G/18 turn labels.
  assert.deepEqual(r.path.pieces.map((p) => p.ref), ['INTL5', 'G', 'G']);
  assert.ok(r.path.turns.filter((t) => t.silent).length === 2);
  near(planar([r.path.end.point])[0], [20, 500], 1);

  // A bare runway between two taxiways the route goes straight over is held short of too.
  assert.deepEqual(plan('INTL5 G 18 G', { start: P(300, 150), end: P(20, 500) }).path.holds.map((h) => h.kind), ['hold']);
  // "cross" is marked where the route meets the runway, without a hold bar.
  const cross = plan('INTL5 G cross 18 G', { start: P(300, 150), end: P(20, 500) });
  assert.deepEqual(cross.path.holds.map((h) => h.kind), ['cross']);
  near(planar([cross.path.holds[0].point])[0], [100, 500], 1);
});

test('a runway taxied along (no hold short, not straight over) gets no hold marker', () => {
  const r = plan('A 18 G', { start: P(250, 200), end: P(20, 500) });
  assert.deepEqual(r.path.holds, []);
  assert.ok(r.path.pieces.some((p) => p.ref === '18'), 'walks along the runway from A to G');
  // Told to hold short first: still has to use the runway here (nothing else connects), but the hold is shown.
  assert.deepEqual(plan('A hold short 18 G', { start: P(250, 200), end: P(20, 500) }).path.holds.map((h) => h.kind), ['hold']);
});

//   B x=100 from y=100 up to C.   C y=500 from x=0 to 700, crossing 07/25 (x=300).
//   C2 from C at x=600 up to y=900, then east to 16R/34L (x=800), ending on it.
const two = {
  crs: 'image',
  image: { width: 1000, height: 1000 },
  bounds: [[0, 0], [1000, 1000]],
  features: [
    line('r25', ['07', '25'], 'runway', [300, 0], [300, 1000]),
    line('r16', ['16R', '34L'], 'runway', [800, 0], [800, 1000]),
    line('b', ['B'], 'taxiway', [100, 100], [100, 500]),
    line('c', ['C'], 'taxiway', [0, 500], [700, 500]),
    line('c2', ['C2'], 'taxiway', [600, 500], [600, 900], [800, 900]),
  ],
};
const g2 = buildGraph(two);

test('two holds in one clearance: "B C hold short of runway 25 C C2 hold short 16R"', () => {
  const off = g2.tol * 3;
  const r = planRoute(two, indexAirport(two), g2, 'B C Hold short of Runway 25 C C2 Hold short 16R', { start: P(100, 150) });

  assert.deepEqual(r.path.holds.map((h) => [h.kind, h.ref, h.final]), [['hold', '25', false], ['hold', '16R', true]]);
  near(g2.proj.fwd(r.path.holds[0].point), [300 - off, 500], 1); // on C, before 25, coming from the west
  near(g2.proj.fwd(r.path.holds[1].point), [800 - off, 900], 1); // on C2, before 16R
  // B, then C up to and across 25, on along C, C2, and the ribbon stops at the 16R hold line.
  assert.deepEqual(r.path.pieces.map((p) => p.ref), ['B', 'C', 'C', 'C2']);
  near(g2.proj.fwd(r.path.end.point), [800 - off, 900], 1);
  assert.deepEqual(r.warnings, []);
});

test('taxiways that never meet are joined by an inferred connection', () => {
  const r = plan('G Z');
  const link = r.path.pieces.find((p) => p.kind === 'link');
  assert.ok(link && link.inferred);
  assert.match(r.warnings[0].text, /G and Z don't meet/);
  assert.equal(r.steps[1].inferredBefore, true);
});

test('a taxiway broken in the data is walked across the network and flagged', () => {
  const r = plan('Q', { start: P(150, 705), end: P(400, 695) });
  assert.equal(r.path.pieces.length, 1);
  assert.equal(r.path.pieces[0].inferred, true);
  assert.equal(len(r.path.pieces[0].coords), 250);
  assert.match(r.warnings[0].text, /Q isn't continuous/);
});

test('missing refs are flagged and skipped without breaking the route', () => {
  const r = plan('INTL5 X G C');
  assert.match(r.warnings[0].text, /X isn't in this airport's data/);
  assert.deepEqual(r.path.pieces.map((p) => p.ref), ['G']);
});

test('ref cleaning', () => {
  assert.deepEqual(splitRefs('INTL3/INTL4'), ['INTL3', 'INTL4']);
  assert.deepEqual(splitRefs('16R/34L'), ['16R', '34L']);
  assert.deepEqual(splitRefs('A;B'), ['A', 'B']);
  assert.equal(cleanRef('Taxiway B 4'), 'B4');
});

test('OSM normalisation: refs, name fallback, unnamed taxiways', () => {
  const g = (...pts) => pts.map(([lat, lon]) => ({ lat, lon }));
  const airport = normalise('TEST', {
    method: 'bbox',
    aerodrome: { tags: { name: 'Test Field' } },
    ways: [
      { id: 1, tags: { aeroway: 'taxiway', ref: 'A' }, geometry: g([0, 0], [0, 0.01]) },
      { id: 2, tags: { aeroway: 'taxiway', name: 'Taxiway B' }, geometry: g([0, 0], [0.01, 0]) },
      { id: 3, tags: { aeroway: 'taxiway', name: 'Cargo link road' }, geometry: g([0, 0], [0.01, 0.01]) },
      { id: 4, tags: { aeroway: 'runway', ref: '09/27' }, geometry: g([0.02, 0], [0.02, 0.02]) },
      { id: 5, tags: { aeroway: 'taxilane', ref: 'T1' }, geometry: g([0, 0], [0.001, 0]) },
    ],
  });
  assert.equal(airport.name, 'Test Field');
  assert.deepEqual(airport.features.map((f) => [f.kind, f.refs]), [
    ['taxiway', ['A']],
    ['taxiway', ['B']],
    ['taxiway', []],
    ['runway', ['09', '27']],
    ['taxiway', ['T1']],
  ]);
  assert.equal(airport.notes.length, 2); // bbox fallback + 1 unnamed
  assert.deepEqual(airport.stands, []);

  const withGates = normalise('TEST', {
    ways: [],
    stands: [
      { type: 'node', id: 1, tags: { aeroway: 'parking_position', ref: '36' }, lat: 1, lon: 2 },
      { type: 'way', id: 2, tags: { aeroway: 'parking_position', ref: '36' }, lat: 1, lon: 2 }, // same stand twice
      { type: 'node', id: 3, tags: { aeroway: 'gate', name: 'Gate D 5' }, lat: 3, lon: 4 },
      { type: 'node', id: 4, tags: { aeroway: 'gate', name: 'Qantas Club' }, lat: 5, lon: 6 },
    ],
  });
  assert.deepEqual(withGates.stands.map((s) => `${s.kind} ${s.ref}`), ['stand 36', 'gate D5']);
  assert.equal(indexAirport(airport).resolve('9'), '09');

  // Ways sharing an OSM node share a graph node.
  const og = buildGraph(airport);
  assert.equal(junctions(og, 'A', 'B').length, 1);
});

test('OSM fetch falls back to the aerodrome bounding box when area lookup is empty', async () => {
  const { fetchAirport } = await import('../server/sources/osm.js');
  const queries = [];
  const realFetch = globalThis.fetch;
  const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  globalThis.fetch = async (url, opts) => {
    const q = new URLSearchParams(opts.body.toString()).get('data');
    queries.push(q);
    // One mirror is permanently busy; the others answer.
    if (url.includes('overpass-api.de')) return { ok: true, status: 200, text: async () => '<html><strong>Error</strong>: too busy</html>' };
    if (q.includes('map_to_area')) return reply({ elements: [{ type: 'node', lat: -35, lon: 149, tags: { aeroway: 'aerodrome', icao: 'XXXX', name: 'Node Field' } }] });
    return reply({
      elements: [
        { type: 'way', id: 9, tags: { aeroway: 'taxiway', ref: 'A' }, geometry: [{ lat: -35, lon: 149 }, { lat: -35.001, lon: 149 }] },
        { type: 'node', id: 10, tags: { aeroway: 'gate', ref: '5' }, lat: -35.0005, lon: 149.001 },
        { type: 'way', id: 11, tags: { aeroway: 'parking_position', ref: '6' }, geometry: [{ lat: -35, lon: 149.002 }, { lat: -35.002, lon: 149.002 }] },
      ],
    });
  };
  try {
    const raw = await fetchAirport('XXXX', { retryMs: 5 });
    assert.equal(raw.method, 'bbox');
    assert.equal(raw.ways.length, 1);
    assert.deepEqual(raw.stands.map((s) => [s.tags.ref, +s.lat.toFixed(6), +s.lon.toFixed(6)]), [['5', -35.0005, 149.001], ['6', -35.001, 149.002]]); // way: its centre
    const bbox = queries.find((q) => !q.includes('map_to_area'));
    assert.match(bbox, /way\(-35\.03\d*,148\.96\d*,-34\.97\d*,149\.03\d*\)/);
    assert.match(bbox, /node\(-35\.03\d*,148\.96\d*,-34\.97\d*,149\.03\d*\)\[aeroway~"\^\(gate\|parking_position\)\$"\]/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Overpass: all mirrors asked at once, a hanging one does not hold up the answer', async () => {
  const { overpass } = await import('../server/sources/osm.js');
  const realFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (url, { signal }) => {
    if (url.includes('slow')) {
      return new Promise((_, reject) => signal.addEventListener('abort', () => ((cancelled = true), reject(new Error('aborted')))));
    }
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, text: async () => '{"elements":[]}' }), 20));
  };
  try {
    const t0 = Date.now();
    const res = await overpass('q', { endpoints: ['https://slow.example/api', 'https://fast.example/api'], deadline: 5000 });
    assert.deepEqual(res.elements, []);
    assert.ok(Date.now() - t0 < 1000, 'answered without waiting for the slow mirror');
    assert.ok(cancelled, 'the slow request is cancelled');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Overpass: busy mirrors are retried, then it gives up by the deadline', async () => {
  const { overpass } = await import('../server/sources/osm.js');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 504, text: async () => 'busy' };
  };
  try {
    const t0 = Date.now();
    await assert.rejects(overpass('q', { endpoints: ['https://a.example/api', 'https://b.example/api'], deadline: 300, retryMs: 20 }), (err) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /a\.example: HTTP 504/);
      return true;
    });
    assert.ok(Date.now() - t0 < 600, 'stops at the deadline');
    assert.ok(calls > 4, `retried (${calls} calls)`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Overpass: a mirror that queued the request gets a second copy', async () => {
  const { overpass } = await import('../server/sources/osm.js');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, { signal }) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    return Promise.resolve({ ok: true, status: 200, text: async () => '{"elements":[1]}' });
  };
  try {
    const t0 = Date.now();
    const res = await overpass('q', { endpoints: ['https://queued.example/api'], hedgeMs: 50, deadline: 5000 });
    assert.deepEqual(res.elements, [1]);
    assert.equal(calls, 2);
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Overpass: lean memory budget first, big budget only if the server runs out', async () => {
  const { fetchAirport } = await import('../server/sources/osm.js');
  const realFetch = globalThis.fetch;
  const headers = [];
  globalThis.fetch = async (url, opts) => {
    const q = new URLSearchParams(opts.body.toString()).get('data');
    headers.push(/\[out:json\][^;]*/.exec(q)[0]);
    if (q.includes('maxsize')) return { ok: true, status: 200, text: async () => '<html><strong>Error</strong>: runtime error: Query run out of memory using about 64 MB of RAM.</html>' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [{ type: 'way', id: 1, tags: { aeroway: 'taxiway', ref: 'A' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }] }] }) };
  };
  try {
    const t0 = Date.now();
    const raw = await fetchAirport('XXXX', { endpoints: ['https://one.example/api'], retryMs: 1000, deadline: 5000 });
    assert.ok(Date.now() - t0 < 500, 'no retries before switching budget');
    assert.equal(raw.ways.length, 1);
    assert.match(headers[0], /timeout:20\]\[maxsize:67108864/);
    assert.equal(headers.at(-1), '[out:json][timeout:60]');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('after crossing a runway the taxi carries on to the far side, never silently back', () => {
  const idx2 = indexAirport(two);
  // Start on C east of 25; C2 is also east. Crossing 25 and coming straight back would be a U-turn.
  const r = planRoute(two, idx2, g2, 'C hold short 25 C C2', { start: P(680, 500) });
  assert.ok(r.warnings.some((w) => /After crossing 25, C doesn't continue on the far side/.test(w.text)), JSON.stringify(r.warnings));

  // From the west it's a proper crossing: west of 25, over it, on to C2. No warning.
  const ok = planRoute(two, idx2, g2, 'C hold short 25 C C2', { start: P(50, 500) });
  assert.deepEqual(ok.warnings, []);
  const xs = ok.path.pieces.flatMap((p) => p.coords.map((c) => g2.proj.fwd(c)[0]));
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-6), 'always heading east along C');
});
