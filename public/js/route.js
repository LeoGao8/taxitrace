// Clearance text + airport -> everything the UI needs to draw the taxi route.
// Pure (no DOM); the same code runs for OSM and traced-chart airports.
import { refAliases } from './refs.js';
import { indexStands } from './stands.js';
import { dist } from './geometry.js';

export const TAXI_SPEED_KT = 10;
// Hold bars sit this far back from where the route meets the runway centreline
// (real hold lines are ~50–90 m out). Traced charts have no scale: a few snap tolerances.
const HOLD_OFFSET_M = 60;
const holdOffset = (graph) => (graph.unit === 'm' ? HOLD_OFFSET_M : graph.tol * 3);
import { parseClearance } from './parser.js';
import { routeLegs } from './router.js';

export function indexAirport(airport) {
  const byRef = new Map();
  const alias = new Map();
  for (const f of airport.features) {
    if (f.kind === 'apron') continue;
    for (const ref of f.refs) {
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref).push(f);
      for (const a of refAliases(ref)) if (!alias.has(a)) alias.set(a, ref);
    }
  }
  const refs = [...byRef.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { byRef, refs, resolve: (s) => alias.get(String(s).toUpperCase()) ?? null, stands: indexStands(airport.stands) };
}

/**
 * @param points { start?: [lat,lng], end?: [lat,lng] } clicked map positions
 */
export function planRoute(airport, index, graph, text, points = {}) {
  const parsed = parseClearance(text, index.resolve, index.stands.resolve);
  // "BAY 36" in the clearance beats a start point clicked on the map.
  const stand = parsed.start?.found ? parsed.start.stand : null;
  const startPoint = stand ? stand.coords : points.start;
  const steps = parsed.steps.map((s, i) => {
    const features = s.found ? index.byRef.get(s.ref) : [];
    return { ...s, n: i + 1, features, kind: features.some((f) => f.kind === 'runway') ? 'runway' : 'taxiway' };
  });

  // Legs: found refs in order, consecutive repeats merged ("A A" is just A).
  const legs = [];
  for (const s of steps) {
    if (!s.found) continue;
    if (legs.length && legs[legs.length - 1].ref === s.ref) continue;
    legs.push({ ref: s.ref, kind: s.kind, stepN: s.n, action: s.action });
  }

  // Ends at a runway (or "hold short of X" / "cross X" last): stop at it.
  const last = legs[legs.length - 1];
  const hold = legs.length > 1 && (last.kind === 'runway' || !!last.action);
  // A runway mid-route with "hold short"/"cross": go over it, not along it.
  legs.forEach((l, k) => (l.cross = k > 0 && k < legs.length - 1 && l.kind === 'runway' && !!l.action));
  const { fwd, inv } = graph.proj;
  const raw = routeLegs(graph, legs, {
    start: startPoint ? fwd(startPoint) : null,
    end: points.end && !hold ? fwd(points.end) : null,
    hold,
  });

  const warnings = steps
    .filter((s) => !s.found)
    .map((s) => ({ level: 'bad', text: `${s.ref} isn't in this airport's data${s.input.toUpperCase() !== s.ref ? ` (from "${s.input}")` : ''}.` }));
  if (parsed.start && !parsed.start.found) {
    warnings.unshift({ level: 'bad', text: `${parsed.start.label} isn't in this airport's data${index.stands.refs.length ? '' : ' (no gates or bays loaded)'}.` });
  }
  const hints = [];
  if (stand && points.start && legs.length) hints.push(`Starting from ${parsed.start.label}; your map start point is ignored.`);
  let path = null;

  if (raw) {
    raw.connectors.forEach((isGap, i) => {
      if (!isGap) return;
      const a = legs[i].ref;
      const b = legs[i + 1].ref;
      steps[legs[i + 1].stepN - 1].inferredBefore = true;
      warnings.push({ level: 'warn', text: `${a} and ${b} don't meet in the data — joined by the shortest connection (dashed).` });
    });
    if (raw.uTurn) {
      warnings.push({ level: 'warn', text: `After crossing ${raw.uTurn.runway}, ${raw.uTurn.ref} doesn't continue on the far side here: the route turns back. Check the clearance or your start point.` });
    }
    for (const ref of new Set(raw.brokenLegs)) {
      warnings.push({ level: 'warn', text: `${ref} isn't continuous in the data here — that stretch is inferred (dashed).` });
    }

    const wholeIdx = new Set(raw.whole.map((w) => w.index));
    if (wholeIdx.has(0) && !(legs.length === 1 && hold)) {
      hints.push(
        index.stands.refs.length && !parsed.start
          ? `Start with your gate or bay (e.g. "BAY ${index.stands.refs[0]} ${legs[0].ref} …") or set a start point to trim ${legs[0].ref}.`
          : `Set a start point (your gate) to trim ${legs[0].ref}.`,
      );
    }
    if (legs.length > 1 && wholeIdx.has(legs.length - 1)) {
      hints.push(`Set an end point, or finish the clearance with a runway, to trim ${legs[legs.length - 1].ref}.`);
    }

    const marks = holdMarkers(raw, legs, graph, hold);
    for (const h of marks) {
      if (!h.final) continue;
      // The route ends at the hold line, not on the runway centreline.
      raw.length -= trimEnd(raw.pieces, dist(h.point, h.at));
      raw.end.point = h.point;
    }

    // Taxi distance includes the lead-in from the gate and out to the end point.
    const total = raw.length + (raw.start ? dist(raw.start.clicked, raw.start.point) : 0) + (raw.end?.clicked ? dist(raw.end.point, raw.end.clicked) : 0);

    const toLatLng = (coords) => coords.map(inv);
    path = {
      pieces: raw.pieces.map((p) => ({ ...p, coords: toLatLng(p.coords) })),
      whole: raw.whole.map((w) => ({ ...w, lines: index.byRef.get(w.ref).map((f) => f.coords) })),
      turns: raw.turns.map((t) => ({ ...t, point: inv(t.point) })),
      holds: marks.map((h) => ({ kind: h.kind, ref: h.ref, stepN: h.stepN, final: h.final, point: inv(h.point), towards: inv(h.towards) })),
      start: raw.start && { ...raw.start, point: inv(raw.start.point), clicked: inv(raw.start.clicked) },
      end: raw.end && { ...raw.end, point: inv(raw.end.point), clicked: raw.end.clicked && inv(raw.end.clicked) },
      length: raw.length,
      total,
      // Seconds at taxi speed; only when the chart is in real metres.
      seconds: graph.unit === 'm' ? total / ((TAXI_SPEED_KT * 1852) / 3600) : null,
      unit: graph.unit,
      inferred: raw.inferred,
    };
  }

  return { ...parsed, steps, legs, warnings, hints, path, hold };
}

// Hold shorts and crossings, in route order. A runway is held short of when the
// clearance says so, when it ends the route, or when the route goes straight
// over it mid-clearance ("C 25 C"); "cross 25" is marked but gets no hold bar.
function holdMarkers(raw, legs, graph, hold) {
  const joined = [];
  for (const p of raw.pieces) for (const c of p.coords) if (!joined.length || dist(joined[joined.length - 1], c) > 1e-9) joined.push(c);
  const offset = holdOffset(graph);
  const marks = [];
  let from = 0;

  for (const t of raw.turns) {
    const k = t.index;
    const leg = legs[k];
    const final = hold && k === legs.length - 1;
    const along = raw.legLengths[k];
    let kind = null;
    if (final) kind = leg.action === 'cross' ? 'cross' : 'hold';
    else if (leg.action) kind = leg.action;
    else if (leg.kind === 'runway' && along != null && along < graph.tol) kind = 'hold';
    if (!kind) continue;

    // Straight over a runway and back onto the same taxiway: no turn labels, the hold label says it.
    if (leg.kind === 'runway' && !final && along != null && along < graph.tol) {
      t.silent = true;
      const out = raw.turns.find((u) => u.index === k + 1);
      if (out && legs[k + 1].ref === legs[k - 1].ref) out.silent = true;
    }

    let idx = joined.findIndex((c, i) => i >= from && dist(c, t.point) < 1e-6);
    if (idx < 0) idx = joined.length - 1;
    from = idx;
    const mark = { kind, ref: leg.ref, stepN: leg.stepN, final, at: t.point, point: t.point, towards: joined[idx + 1] || t.point };
    if (kind === 'hold' && idx > 0) {
      // Back along the route towards where we came from, but never past the previous marker.
      let available = 0;
      for (let i = idx; i > (marks.at(-1)?.idx ?? 0); i--) available += dist(joined[i - 1], joined[i]);
      let remaining = Math.min(offset, available * 0.8);
      for (let i = idx; i > 0; i--) {
        const a = joined[i - 1];
        const b = joined[i];
        const seg = dist(a, b);
        if (seg >= remaining) {
          const f = seg ? remaining / seg : 0;
          mark.point = [b[0] + (a[0] - b[0]) * f, b[1] + (a[1] - b[1]) * f];
          mark.towards = b;
          break;
        }
        remaining -= seg;
      }
    }
    mark.idx = idx;
    marks.push(mark);
  }
  return marks;
}

// Cut `len` off the end of the route (in place). Returns the length removed.
function trimEnd(pieces, len) {
  let remaining = len;
  while (remaining > 1e-9 && pieces.length) {
    const coords = pieces[pieces.length - 1].coords;
    const a = coords[coords.length - 2];
    const b = coords[coords.length - 1];
    if (!a) {
      pieces.pop();
      continue;
    }
    const seg = dist(a, b);
    if (seg > remaining) {
      const f = remaining / seg;
      coords[coords.length - 1] = [b[0] + (a[0] - b[0]) * f, b[1] + (a[1] - b[1]) * f];
      return len;
    }
    coords.pop();
    remaining -= seg;
    if (coords.length < 2) pieces.pop();
  }
  return len - remaining;
}
