// "My chart" source: an uploaded chart image plus lines you traced on it.
//
// In storage (trace.json) points are chart pixels [x, y] with y pointing down, so
// the file stays meaningful even outside this app. The normalised Airport uses
// Leaflet's CRS.Simple convention [lat, lng] = [height - y, x].
import { splitRefs } from '../../public/js/refs.js';
import { splitTraced } from '../../public/js/stands.js';

const TRACE_FILE = 'trace.json';
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const KINDS = new Set(['taxiway', 'runway', 'stand']);

export const id = 'trace';
export const label = 'My chart';

export async function hasData(store, icao) {
  return store.exists(icao, TRACE_FILE);
}

export async function load(store, icao) {
  const doc = await store.readJson(icao, TRACE_FILE);
  if (!doc) return null;
  const { width, height } = doc.image;
  const traced = doc.lines.map((line) => ({
    id: line.id,
    kind: line.kind,
    label: line.label,
    refs: splitRefs(line.label),
    coords: line.points.map(([x, y]) => [height - y, x]),
  }));
  const { features, stands } = splitTraced(traced);
  const notes = [];
  if (!features.length) notes.push('No taxiways traced yet — open the editor to trace this chart.');
  return {
    icao,
    name: icao,
    source: id,
    crs: 'image',
    image: { url: `/api/airports/${icao}/chart?v=${encodeURIComponent(doc.image.updatedAt || '')}`, width, height },
    bounds: [[0, 0], [height, width]],
    features,
    stands,
    notes,
  };
}

// Accepts normalised features back from the editor.
export async function save(store, icao, body) {
  const doc = await store.readJson(icao, TRACE_FILE);
  if (!doc) throw Object.assign(new Error('Upload a chart image first'), { status: 400 });
  if (!Array.isArray(body?.features)) throw Object.assign(new Error('features[] required'), { status: 400 });
  const { height } = doc.image;
  doc.lines = body.features
    .filter((f) => Array.isArray(f.coords) && f.coords.length >= (f.kind === 'stand' ? 1 : 2))
    .map((f) => ({
      id: String(f.id),
      kind: KINDS.has(f.kind) ? f.kind : 'taxiway',
      label: String(f.label ?? '').trim(),
      points: f.coords.map(([lat, lng]) => [round(lng), round(height - lat)]),
    }));
  doc.updatedAt = new Date().toISOString();
  await store.writeJson(icao, TRACE_FILE, doc);
  return load(store, icao);
}

export async function saveChart(store, icao, body, size, contentType, width, height) {
  const ext = IMAGE_TYPES[contentType];
  if (!ext) throw Object.assign(new Error(`Unsupported image type ${contentType} (use PNG, JPEG, WebP or GIF)`), { status: 415 });
  if (!(width > 0 && height > 0)) throw Object.assign(new Error('width and height required'), { status: 400 });

  const doc = (await store.readJson(icao, TRACE_FILE)) || { lines: [] };
  const old = doc.image;
  if (old && old.file !== `chart.${ext}`) await store.remove(icao, old.file);

  // Replacing a chart (e.g. a higher-res scan of the same page): scale existing
  // traces so they stay on the same spot.
  if (old && (old.width !== width || old.height !== height)) {
    const sx = width / old.width;
    const sy = height / old.height;
    for (const line of doc.lines) line.points = line.points.map(([x, y]) => [round(x * sx), round(y * sy)]);
  }

  await store.writeStream(icao, `chart.${ext}`, body, size, contentType);
  doc.image = { file: `chart.${ext}`, contentType, width, height, updatedAt: new Date().toISOString() };
  await store.writeJson(icao, TRACE_FILE, doc);
  return load(store, icao);
}

export async function chart(store, icao) {
  const doc = await store.readJson(icao, TRACE_FILE);
  const file = doc?.image && await store.readFile(icao, doc.image.file);
  return file ? { ...file, contentType: doc.image.contentType } : null;
}

const round = (n) => Math.round(n * 10) / 10;
