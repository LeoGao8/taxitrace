// Static build for Cloudflare: public/ plus Leaflet (served by server.js at /vendor/leaflet/) into dist/.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const skip = (src) => path.basename(src) !== '.DS_Store' && !src.endsWith('.map');

await fs.rm(dist, { recursive: true, force: true });
await fs.cp(path.join(root, 'public'), dist, { recursive: true, filter: skip });
await fs.cp(path.join(root, 'node_modules', 'leaflet', 'dist'), path.join(dist, 'vendor', 'leaflet'), { recursive: true, filter: skip });

console.log(`Built ${path.relative(root, dist)}/`);
