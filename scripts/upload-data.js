// One-off: copy data/airports/ (from `npm start`) into the R2 bucket the Worker uses.
// Run: npm run upload-data            (add -- --local to fill wrangler dev's local bucket instead)
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BUCKET = 'taxitrace-data';
const root = path.resolve(import.meta.dirname, '..', 'data', 'airports');
const target = process.argv.includes('--local') ? '--local' : '--remote';
const TYPES = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

for (const icao of (await fs.readdir(root)).sort()) {
  const dir = path.join(root, icao);
  if (!(await fs.stat(dir)).isDirectory()) continue;
  for (const name of await fs.readdir(dir)) {
    const type = TYPES[path.extname(name)];
    if (!type) continue; // skips .tmp and .DS_Store
    console.log(`${icao}/${name}`);
    execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/airports/${icao}/${name}`,
      '--file', path.join(dir, name), '--content-type', type, target], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
}
