// Shared by server (sources) and browser (parser/route): how a taxiway or
// runway label string becomes canonical refs.

// "Taxiway A1" -> "A1", "twy b 4" -> "B4", "INTL3/INTL4" -> ["INTL3","INTL4"]
export function splitRefs(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(/[;,/]/)
    .map(cleanRef)
    .filter(Boolean);
}

export function cleanRef(raw) {
  const s = String(raw)
    .toUpperCase()
    .replace(/^\s*(TAXIWAY|TAXILANE|TWY|RUNWAY|RWY)\b/, '')
    .replace(/[\s._-]+/g, '');
  return s || null;
}

// Something that plausibly is a taxiway/runway designator (as opposed to a
// descriptive name like "Apron link"): A, A1, DOM3A, INTL5, 34L, 07.
export function looksLikeRef(s) {
  return (
    /^[A-Z]{1,2}$/.test(s) || // A, AB
    /^[A-Z]{1,5}\d{1,3}[A-Z]?$/.test(s) || // A1, B10, DOM3A, INTL5
    isRunwayDesignator(s)
  );
}

export function isRunwayDesignator(s) {
  const m = /^(\d{1,2})([LRC]?)$/.exec(s);
  return !!m && +m[1] >= 1 && +m[1] <= 36;
}

// Extra lookup keys for a canonical ref, so "7" finds runway "07".
export function refAliases(ref) {
  const aliases = [ref];
  const m = /^0(\d)([LRC]?)$/.exec(ref);
  if (m) aliases.push(m[1] + m[2]);
  return aliases;
}
