// Source registry. Every source exposes:
//   id, label
//   hasData(icao)          -> boolean (is something cached/saved locally?)
//   load(icao, {refresh})  -> Airport | null
//   save?(icao, body)      -> Airport   (only editable sources)
//
// Airport (the one shape the highlighter understands):
//   { icao, name, source, crs: 'geo' | 'image', bounds: [[y,x],[y,x]],
//     image?: { url, width, height },
//     features: [{ id, kind: 'taxiway'|'runway'|'apron', refs: string[], coords: [[y,x],...] }],
//     stands: [{ id, ref, kind: 'gate'|'stand', coords: [y,x] }],   (see public/js/stands.js)
//     notes: string[] }
//
// To add LittleNavmap later: create littlenavmap.js that reads the MSFS scenery
// database (taxipath table: name + start/end lat/lon per airport), return
// crs: 'geo' features, and register it here. Nothing else needs to change.
import * as osm from './osm.js';
import * as trace from './trace.js';

export const sources = { [osm.id]: osm, [trace.id]: trace };

export function getSource(id) {
  const source = sources[id];
  if (!source) throw Object.assign(new Error(`Unknown source "${id}"`), { status: 404 });
  return source;
}
