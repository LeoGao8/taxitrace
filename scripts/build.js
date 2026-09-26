// Static build for Cloudflare: public/ plus Leaflet (served by server.js at /vendor/leaflet/) into dist/.
// Also bakes data/airports/ in as static assets with a manifest, so the Worker needs no bucket:
// the deployed data is whatever was committed. Update it by committing new data and redeploying.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const skip = (src) => path.basename(src) !== '.DS_Store' && !src.endsWith('.map');

// Only files the store can serve; skips .tmp leftovers and .DS_Store.
const DATA_EXT = new Set(['.json', '.png', '.jpg', '.webp', '.gif']);
const ICAO_RE = /^[A-Z0-9-]{2,8}$/;

await fs.rm(dist, { recursive: true, force: true });
await fs.cp(path.join(root, 'public'), dist, { recursive: true, filter: skip });
await fs.cp(path.join(root, 'node_modules', 'leaflet', 'dist'), path.join(dist, 'vendor', 'leaflet'), { recursive: true, filter: skip });

// airports/<ICAO>/<name> -> dist/data/airports/<ICAO>/<name>, plus manifest.json listing
// each airport's files so the Worker can answer listAirports()/exists() without probing.
const src = path.join(root, 'data', 'airports');
const out = path.join(dist, 'data', 'airports');
const manifest = {};

for (const icao of (await fs.readdir(src).catch(() => [])).sort()) {
  if (!ICAO_RE.test(icao) || !(await fs.stat(path.join(src, icao))).isDirectory()) continue;
  const names = (await fs.readdir(path.join(src, icao))).filter((n) => DATA_EXT.has(path.extname(n))).sort();
  if (!names.length) continue;
  await fs.mkdir(path.join(out, icao), { recursive: true });
  for (const name of names) await fs.cp(path.join(src, icao, name), path.join(out, icao, name));
  manifest[icao] = names;
}

await fs.mkdir(path.join(dist, 'data'), { recursive: true });
await fs.writeFile(path.join(dist, 'data', 'manifest.json'), JSON.stringify(manifest));

const files = Object.values(manifest).reduce((n, names) => n + names.length, 0);
console.log(`Built ${path.relative(root, dist)}/ (${Object.keys(manifest).length} airports, ${files} data files)`);
