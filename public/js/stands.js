// Gates, bays and stands — where a taxi starts. Shared by server and browser.
//
// Airport.stands: [{ id, ref, kind: 'gate' | 'stand', coords: [y, x] }]
// OSM aeroway=gate -> 'gate'; aeroway=parking_position and traced points -> 'stand'.

// The words ATC uses for them. All are accepted in a clearance.
export const STAND_WORDS = { gate: 'gate', gates: 'gate', stand: 'stand', stands: 'stand', bay: 'stand', bays: 'stand', parking: 'stand' };

// "Stand 36" -> "36", "gate d 5" -> "D5", "36;37" -> "36"
export function cleanStandRef(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .split(/[;,/]/)[0]
    .toUpperCase()
    .replace(/^\s*(GATE|STAND|BAY|PARKING(\s+POSITION)?|POSITION)\b/, '')
    .replace(/[\s._-]+/g, '');
  return /^[A-Z0-9]{1,6}$/.test(s) ? s : null;
}

// What to call them at this airport: Australia/NZ say bay, North America gate.
export function standWord(icao) {
  if (/^(Y|NZ)/.test(icao || '')) return 'BAY';
  if (/^[KCP]/.test(icao || '')) return 'GATE';
  return 'STAND';
}

// ref -> stand. When a gate and a stand share a ref, the word decides
// ("gate 5" -> the gate); otherwise prefer the stand, where the aircraft sits.
export function indexStands(stands = []) {
  const byRef = new Map();
  for (const s of stands) {
    if (!byRef.has(s.ref)) byRef.set(s.ref, []);
    byRef.get(s.ref).push(s);
  }
  const refs = [...byRef.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const resolve = (ref, word) => {
    const list = byRef.get(String(ref).toUpperCase()) || byRef.get(String(ref).toUpperCase().replace(/^0+(?=\d)/, ''));
    if (!list) return null;
    return list.find((s) => s.kind === word) || list.find((s) => s.kind === 'stand') || list[0];
  };
  return { refs, resolve };
}

// Traced charts keep stands as one-point features while editing.
export function splitTraced(features) {
  const lines = [];
  const stands = [];
  for (const f of features) {
    if (f.kind === 'stand') {
      const ref = cleanStandRef(f.label);
      if (ref && f.coords.length) stands.push({ id: f.id, ref, kind: 'stand', coords: f.coords[0] });
    } else lines.push(f);
  }
  return { features: lines, stands };
}
