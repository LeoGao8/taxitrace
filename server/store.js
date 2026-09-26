// File-based persistence for `npm start`: one folder per airport under data/airports/<ICAO>/.
//   meta.json      { preferredSource }
//   osm-raw.json   cached Overpass response (normalised on every read)
//   trace.json     your hand traces, in chart pixel coordinates
//   chart.<ext>    uploaded chart image
//
// Store interface (server/static-store.js implements the read-only half for Cloudflare):
//   readJson(icao, name) -> value | null        writeJson(icao, name, value)
//   exists(icao, name) -> boolean               remove(icao, name)
//   writeStream(icao, name, webStream, size, contentType)
//   readFile(icao, name) -> { body: webStream, size } | null
//   listAirports() -> string[]
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { ICAO_RE, normaliseIcao } from './api.js';

const ROOT = path.resolve(import.meta.dirname, '..', 'data', 'airports');

const airportDir = (icao) => path.join(ROOT, normaliseIcao(icao));
const filePath = (icao, name) => path.join(airportDir(icao), name);

export async function readJson(icao, name) {
  try {
    return JSON.parse(await fs.readFile(filePath(icao, name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJson(icao, name, value) {
  await fs.mkdir(airportDir(icao), { recursive: true });
  const target = filePath(icao, name);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, target); // atomic-ish so a crash never leaves half a file
}

export async function writeStream(icao, name, body, size) {
  await fs.mkdir(airportDir(icao), { recursive: true });
  let written = 0;
  const limited = Readable.fromWeb(body).on('data', (chunk) => {
    written += chunk.length;
    if (written > size) limited.destroy(Object.assign(new Error('Upload larger than Content-Length'), { status: 400 }));
  });
  await pipeline(limited, createWriteStream(filePath(icao, name)));
}

export async function readFile(icao, name) {
  try {
    const stat = await fs.stat(filePath(icao, name));
    return { body: Readable.toWeb(createReadStream(filePath(icao, name))), size: stat.size };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function exists(icao, name) {
  try {
    await fs.access(filePath(icao, name));
    return true;
  } catch {
    return false;
  }
}

export async function remove(icao, name) {
  await fs.rm(filePath(icao, name), { force: true });
}

export async function listAirports() {
  try {
    const entries = await fs.readdir(ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && ICAO_RE.test(e.name)).map((e) => e.name).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
