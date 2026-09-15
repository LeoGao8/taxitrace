// File-based persistence: one folder per airport under data/airports/<ICAO>/.
//   meta.json      { preferredSource }
//   osm-raw.json   cached Overpass response (normalised on every read)
//   trace.json     your hand traces, in chart pixel coordinates
//   chart.<ext>    uploaded chart image
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'data', 'airports');

// Also allows non-ICAO idents (e.g. private strips) since traces don't need OSM.
const ICAO_RE = /^[A-Z0-9-]{2,8}$/;

export function normaliseIcao(raw) {
  const icao = String(raw || '').trim().toUpperCase();
  if (!ICAO_RE.test(icao)) throw Object.assign(new Error(`Invalid airport ident "${raw}"`), { status: 400 });
  return icao;
}

export function airportDir(icao) {
  return path.join(ROOT, normaliseIcao(icao));
}

export function filePath(icao, name) {
  return path.join(airportDir(icao), name);
}

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

export async function writeFile(icao, name, buffer) {
  await fs.mkdir(airportDir(icao), { recursive: true });
  await fs.writeFile(filePath(icao, name), buffer);
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

export async function listFiles(icao) {
  try {
    return await fs.readdir(airportDir(icao));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
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
