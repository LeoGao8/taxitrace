// Fills data/airports/ with cached Overpass responses for every ICAO in airports.txt,
// so the deployed site serves them instantly instead of fetching them live.
//
// Run by .github/workflows/cache.yml (on push and on a daily schedule); `npm run warm`
// does the same thing locally. One airport failing never fails the run: a missing cache
// entry only means that airport loads live, which still works.
//
//   npm run warm              refetch anything missing or older than MAX_AGE_DAYS
//   npm run warm -- --all     refetch everything, however fresh
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fetchAirport } from '../server/sources/osm.js';
import * as store from '../server/store.js';

const CACHE_FILE = 'osm-raw.json';
const MAX_AGE_DAYS = Number(process.env.WARM_MAX_AGE_DAYS || 30);
const PAUSE_MS = 1_500; // the Overpass mirrors are free and shared; don't hammer them
const all = process.argv.includes('--all');

const root = path.resolve(import.meta.dirname, '..');
const list = (await fs.readFile(path.join(root, 'airports.txt'), 'utf8'))
  .split('\n')
  .map((l) => l.replace(/#.*/, '').trim().toUpperCase())
  .filter(Boolean);

if (!list.length) {
  console.log('airports.txt lists no airports; nothing to warm.');
  process.exit(0);
}

const ageDays = (iso) => (Date.now() - Date.parse(iso)) / 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fetched = 0;
let kept = 0;
const failed = [];

for (const icao of list) {
  const raw = await store.readJson(icao, CACHE_FILE).catch(() => null);
  const age = raw?.fetchedAt ? ageDays(raw.fetchedAt) : Infinity;

  // No stands means the cache predates gate fetching, so it's worth redoing.
  const why = all ? 'forced' : !raw ? 'missing' : !raw.stands ? 'no stands' : age > MAX_AGE_DAYS ? `${Math.round(age)} days old` : null;
  if (!why) {
    console.log(`  ${icao}  ok (${Math.round(age)} days old)`);
    kept++;
    continue;
  }

  process.stdout.write(`  ${icao}  fetching (${why})... `);
  try {
    const t0 = Date.now();
    const next = await fetchAirport(icao);
    await store.writeJson(icao, CACHE_FILE, next);
    console.log(`${next.ways.length} ways, ${next.stands.length} stands, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    fetched++;
  } catch (err) {
    // Keep any existing cache rather than replacing it with nothing.
    console.log(`FAILED: ${err.message}`);
    failed.push(icao);
  }
  await sleep(PAUSE_MS);
}

console.log(`\nWarm: ${fetched} fetched, ${kept} already fresh, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}.`);
