// OpenStreetMap source: taxiways/runways/aprons and gates from the Overpass API.
//
// Lookup strategy (one request each; gates come back with the taxiways):
//   1. The aerodrome tagged icao=X -> everything inside its polygon (precise).
//   2. If that yields nothing (aerodrome mapped as a node, or no area built),
//      take the aerodrome element's bounding box (padded) and query inside it.
// Every request goes to all mirrors at once and the first good answer wins —
// public Overpass servers swing between 4 s and timing out minute to minute.
// The raw Overpass response is cached on disk and normalised on each read, so
// improvements to normalisation never require a re-fetch.
import * as store from '../store.js';
import { splitRefs, cleanRef, looksLikeRef } from '../../public/js/refs.js';
import { cleanStandRef } from '../../public/js/stands.js';

export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE_FILE = 'osm-raw.json';
// Parking positions can be ways (the stand lead-in line) or nodes; gates are nodes.
const WAYS = '^(taxiway|taxilane|runway|apron|parking_position)$';
const NODES = '^(gate|parking_position)$';
const DEADLINE_MS = 45_000; // give up on the whole lookup after this
const RETRY_MS = 2_500; // a busy mirror is asked again after this (then 5 s, 7.5 s…)
const HEDGE_MS = 6_000; // nothing back yet: send every mirror a second copy
// Overpass admits small declared budgets first when busy. 64 MB covers the
// biggest airports tried (ZBAA, LFPG, KATL); BIG is the fallback if one isn't.
const LEAN = '[out:json][timeout:20][maxsize:67108864]';
const BIG = '[out:json][timeout:60]';

export const id = 'osm';
export const label = 'OpenStreetMap';

export async function hasData(icao) {
  return store.exists(icao, CACHE_FILE);
}

const inFlight = new Map(); // a retry click while fetching joins the same request
const standsTried = new Map(); // icao -> last attempt, for caches from before gates were fetched
const STANDS_RETRY_MS = 10 * 60_000;

export async function load(icao, { refresh = false } = {}) {
  let cached = refresh ? null : await store.readJson(icao, CACHE_FILE);
  if (!cached) {
    if (!inFlight.has(icao)) {
      inFlight.set(icao, fetchAirport(icao)
        .then(async (raw) => (await store.writeJson(icao, CACHE_FILE, raw), raw))
        .finally(() => inFlight.delete(icao)));
    }
    cached = await inFlight.get(icao);
  } else if (!cached.stands && !(Date.now() - (standsTried.get(icao) || 0) < STANDS_RETRY_MS)) {
    standsTried.set(icao, Date.now());
    try {
      cached.stands = await fetchStands(icao, cached, { deadline: 20_000 });
      await store.writeJson(icao, CACHE_FILE, cached);
    } catch {} // still usable without gates; Re-fetch tries again
  }
  return normalise(icao, cached);
}

// ---------------------------------------------------------------- fetching

export async function fetchAirport(icao, opts) {
  const q = JSON.stringify(icao); // safe quoting inside Overpass QL
  const first = await leanFirst((budget) => `
    ${budget};
    nwr[aeroway=aerodrome][icao=${q}]->.ad;
    .ad out tags bb center;
    .ad map_to_area->.a;
    (way(area.a)[aeroway~"${WAYS}"]; node(area.a)[aeroway~"${NODES}"];);
    out geom qt;`, opts);
  const aerodrome = first.elements.find((e) => e.tags?.aeroway === 'aerodrome') || null;
  let found = splitElements(first.elements);
  let method = 'area';

  if (!found.ways.length) {
    if (!aerodrome) {
      throw Object.assign(
        new Error(`OpenStreetMap has no aerodrome tagged icao=${icao}. Try tracing your own chart instead.`),
        { status: 404 },
      );
    }
    const bb = bboxOf(paddedBounds(aerodrome));
    found = splitElements((await leanFirst((budget) => `
      ${budget};
      (way${bb}[aeroway~"${WAYS}"]; node${bb}[aeroway~"${NODES}"];);
      out geom qt;`, opts)).elements);
    method = 'bbox';
  }

  return {
    fetchedAt: new Date().toISOString(),
    method,
    aerodrome: aerodrome && { tags: aerodrome.tags, bounds: aerodrome.bounds, center: aerodrome.center, lat: aerodrome.lat, lon: aerodrome.lon },
    ways: found.ways,
    stands: found.stands,
  };
}

// Just the gates, for caches saved before gates were fetched.
export async function fetchStands(icao, raw, opts) {
  const within = raw.method === 'bbox' && raw.aerodrome ? bboxOf(paddedBounds(raw.aerodrome)) : '(area.a)';
  const setup = within === '(area.a)' ? `nwr[aeroway=aerodrome][icao=${JSON.stringify(icao)}]; map_to_area->.a;` : '';
  const res = await leanFirst((budget) => `
    ${budget};
    ${setup}
    (node${within}[aeroway~"${NODES}"]; way${within}[aeroway=parking_position];);
    out geom qt;`, opts);
  return splitElements(res.elements).stands;
}

// Run with the lean budget; only if the server says it ran out of memory, again with the big one.
async function leanFirst(makeQuery, opts) {
  try {
    return await overpass(makeQuery(LEAN), opts);
  } catch (err) {
    if (!/out of memory|maxsize/i.test(err.message)) throw err;
    return overpass(makeQuery(BIG), opts);
  }
}

// Overpass elements -> cached ways (taxiways etc.) and stands (one point each).
function splitElements(elements) {
  const ways = [];
  const stands = [];
  for (const e of elements) {
    const aeroway = e.tags?.aeroway;
    if (aeroway === 'gate' || aeroway === 'parking_position') {
      const pts = e.type === 'node' ? [e] : (e.geometry || []).filter(Boolean);
      if (!pts.length) continue;
      const lat = pts.reduce((sum, p) => sum + p.lat, 0) / pts.length;
      const lon = pts.reduce((sum, p) => sum + p.lon, 0) / pts.length;
      stands.push({ type: e.type, id: e.id, tags: e.tags, lat, lon });
    } else if (e.type === 'way' && e.geometry && aeroway !== 'aerodrome') {
      ways.push({ id: e.id, tags: e.tags, geometry: e.geometry });
    }
  }
  return { ways, stands };
}

const bboxOf = (bb) => `(${bb.minlat},${bb.minlon},${bb.maxlat},${bb.maxlon})`;

function paddedBounds(el) {
  if (el.bounds) {
    const padLat = 0.005; // ~500 m
    const padLon = 0.005 / Math.cos((el.bounds.minlat * Math.PI) / 180);
    return {
      minlat: el.bounds.minlat - padLat,
      maxlat: el.bounds.maxlat + padLat,
      minlon: el.bounds.minlon - padLon,
      maxlon: el.bounds.maxlon + padLon,
    };
  }
  // Aerodrome mapped as a single node: assume a ~3 km box around it.
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const dLat = 0.03;
  const dLon = 0.03 / Math.cos((lat * Math.PI) / 180);
  return { minlat: lat - dLat, maxlat: lat + dLat, minlon: lon - dLon, maxlon: lon + dLon };
}

// Ask every mirror at once; a busy one (fast 504/429/HTML error) is asked again
// after a short pause, and if nobody has answered after `hedgeMs` every mirror
// gets a second copy (a queued request can sit there while a fresh one runs).
// First valid answer wins and the rest are cancelled.
export async function overpass(query, { deadline = DEADLINE_MS, retryMs = RETRY_MS, hedgeMs = HEDGE_MS, endpoints = ENDPOINTS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  const started = Date.now();
  const errors = new Map();

  const tryMirror = async (endpoint) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await ask(endpoint, query, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) throw err;
        errors.set(new URL(endpoint).host, err.message);
        const wait = retryMs * attempt;
        if (err.fatal || Date.now() - started + wait > deadline) throw err;
        await sleep(wait, controller.signal);
      }
    }
  };

  try {
    const first = Promise.any(endpoints.map(tryMirror));
    const early = await Promise.race([first.then((value) => ({ value }), (error) => ({ error })), sleep(hedgeMs, controller.signal).then(() => null)]);
    if (early?.error) throw early.error; // every mirror gave a final no
    if (early) return early.value;
    return await Promise.any([first, ...endpoints.map(tryMirror)]); // still waiting: hedge
  } catch {
    for (const e of endpoints) if (!errors.has(new URL(e).host)) errors.set(new URL(e).host, `no answer in ${Math.round(deadline / 1000)} s`);
    const detail = [...errors].map(([host, msg]) => `${host}: ${msg}`).join('\n');
    throw Object.assign(new Error(`OpenStreetMap servers are too busy right now — try again shortly.\n${detail}`), { status: 502 });
  } finally {
    clearTimeout(timer);
    controller.abort(); // cancel the mirrors that lost the race
  }
}

async function ask(endpoint, query, signal) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'taxi-trace/0.1 (personal MSFS taxi helper)',
    },
    body: new URLSearchParams({ data: query }),
    signal,
  });
  const text = await res.text();
  // 400 is our query's fault: every mirror would say the same, so don't retry.
  if (res.status === 400) throw Object.assign(new Error('HTTP 400 (bad query)'), { fatal: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // A busy server answers 200 with an HTML/XML error page instead of JSON.
  if (!text.trimStart().startsWith('{')) {
    const msg = /<strong[^>]*>Error<\/strong>:\s*([^<]*)/.exec(text)?.[1];
    throw memoryAware(new Error(msg ? msg.trim().slice(0, 120) : 'non-JSON response'));
  }
  const json = JSON.parse(text);
  if (json.remark && /error|timed out/i.test(json.remark)) throw memoryAware(new Error(json.remark));
  return json;
}

// Out of memory won't go away by asking again: stop retrying so the big budget runs straight away.
function memoryAware(err) {
  if (/out of memory/i.test(err.message)) err.fatal = true;
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('cancelled'))), { once: true });
  });
}

// ------------------------------------------------------------ normalising

const KIND = { taxiway: 'taxiway', taxilane: 'taxiway', runway: 'runway', apron: 'apron' };

export function normalise(icao, raw) {
  const features = [];
  let unnamedTaxiways = 0;

  for (const way of raw.ways) {
    const kind = KIND[way.tags?.aeroway];
    if (!kind) continue;
    const coords = way.geometry.filter(Boolean).map((p) => [p.lat, p.lon]);
    if (coords.length < 2) continue;

    let refs = [];
    if (kind !== 'apron') {
      refs = splitRefs(way.tags.ref);
      if (!refs.length && way.tags.name) {
        // Some mappers put the letter in name="Taxiway B" instead of ref.
        const fromName = cleanRef(way.tags.name);
        if (fromName && looksLikeRef(fromName)) refs = [fromName];
      }
      if (kind === 'taxiway' && !refs.length) unnamedTaxiways++;
    }
    features.push({ id: `osm-${way.id}`, kind, refs, coords });
  }

  // Gates/bays. A way (a stand's lead-in line) is placed at its centre.
  const stands = [];
  const seen = new Set();
  for (const e of raw.stands || []) {
    const ref = cleanStandRef(e.tags.ref) || cleanStandRef(e.tags.name);
    const kind = e.tags.aeroway === 'gate' ? 'gate' : 'stand';
    if (!ref || seen.has(`${kind}:${ref}`)) continue;
    seen.add(`${kind}:${ref}`);
    stands.push({ id: `osm-${e.type}-${e.id}`, ref, kind, coords: [e.lat, e.lon] });
  }

  const notes = [];
  if (raw.stands && !stands.length) notes.push('No gates or bays with numbers in OSM here.');
  if (raw.method === 'bbox') {
    notes.push('No aerodrome area in OSM — used its bounding box instead, so neighbouring features may be included.');
  }
  if (unnamedTaxiways) notes.push(`${unnamedTaxiways} taxiway segment(s) have no ref in OSM and can't be matched.`);
  if (!features.some((f) => f.kind === 'taxiway' && f.refs.length)) {
    notes.push('No taxiways with refs found — OSM coverage is thin here; consider tracing your own chart.');
  }

  return {
    icao,
    name: raw.aerodrome?.tags?.name || icao,
    source: id,
    crs: 'geo',
    fetchedAt: raw.fetchedAt,
    bounds: boundsOf(features),
    features,
    stands,
    notes,
  };
}

function boundsOf(features) {
  let minY = Infinity, minX = Infinity, maxY = -Infinity, maxX = -Infinity;
  for (const f of features) {
    for (const [y, x] of f.coords) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return features.length ? [[minY, minX], [maxY, maxX]] : null;
}
