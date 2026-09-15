// Clearance parser: free text -> ordered list of taxiway/runway refs.
//
// Pure function, no DOM. `resolveRef(str)` maps a candidate like "A1" or "7"
// to the airport's canonical ref ("A1", "07") or null, so matching is always
// against what the airport actually has. `resolveStand(ref, word)` does the same
// for gates/bays ("bay 36" is where the taxi starts).
import { isRunwayDesignator, looksLikeRef } from './refs.js';
import { STAND_WORDS } from './stands.js';

const PHONETIC = {
  alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', fox: 'F',
  golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L', mike: 'M',
  november: 'N', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T',
  uniform: 'U', victor: 'V', whiskey: 'W', whisky: 'W', xray: 'X', yankee: 'Y', zulu: 'Z',
};

const NUMBERS = {
  zero: '0', one: '1', two: '2', three: '3', tree: '3', four: '4', fower: '4', five: '5', fife: '5',
  six: '6', seven: '7', eight: '8', nine: '9', niner: '9',
};

const SIDES = { left: 'L', right: 'R', centre: 'C', center: 'C' };

const FILLER = new Set(`
  taxi taxiway taxiways taxilane twy via to hold holding short of cross crossing runway runways rwy
  contact monitor ground tower apron delivery clearance departure departures approach radar
  and then on onto at the point position turn straight ahead continue expect follow give way
  behind request when ready report clear cleared for intersection until from in into join use
  gate stand bay parking terminal north south east west northbound southbound eastbound westbound
  bound traffic passing pushback push back start approved face facing line up wait after before
  your you frequency decimal please roger wilco correct remain this that is are it go we me my
  if be by as or so no do us an am ok okay full length right left via backtrack vacate exit
  high speed rapid first second next available airborne tail nose
`.split(/\s+/).filter(Boolean));

// "hold short (of runway) 25", "cross (runway) 25": applies to the next ref.
const ACTION_WORDS = { hold: 'hold', holding: 'hold', cross: 'cross', crossing: 'cross' };

const SKIP_NUMBERS = new Set(['contact', 'monitor', 'frequency']); // "contact ground 121.7"

/**
 * @returns {{
 *   start: { ref: string, input: string, found: boolean, word: 'gate'|'stand' } | null,
 *   steps: { ref: string, input: string, found: boolean, action: 'hold'|'cross'|null }[],
 *   ignored: string[],   // filler words we deliberately skipped
 *   unknown: string[],   // words we couldn't interpret at all
 * }}
 */
export function parseClearance(text, resolveRef, resolveStand = () => null) {
  const tokens = classify(tokenize(text));
  const steps = [];
  const ignored = [];
  const unknown = [];
  let start = null;
  let action = null; // pending "hold short" / "cross" for the next ref
  const push = (step) => {
    steps.push({ ...step, action });
    action = null;
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (ACTION_WORDS[t.raw]) {
      // "hold position" is not a hold short.
      action = tokens[i + 1]?.raw === 'position' ? null : ACTION_WORDS[t.raw];
      ignored.push(t.raw);
      i++;
      continue;
    }

    if (STAND_WORDS[t.raw]) {
      const r = matchStand(tokens, i, resolveStand);
      if (r) {
        if (!start) start = r.start; // the first one mentioned is where we are
        else ignored.push(r.start.input);
        i = r.next;
        continue;
      }
    }

    if (t.type === 'filler' || t.type === 'side' || t.type === 'skip') {
      ignored.push(t.raw);
      i++;
      continue;
    }

    if (t.type === 'letter' || t.type === 'ref') {
      const r = matchLetterGroup(tokens, i, resolveRef);
      push(r.step);
      i = r.next;
      continue;
    }

    if (t.type === 'digit') {
      const r = matchDigitGroup(tokens, i, resolveRef);
      if (r.step) push(r.step);
      else unknown.push(r.input);
      i = r.next;
      continue;
    }

    // Longer word: could still be a real ref ("DOM", or "intl five" = INTL5).
    const r = matchLetterGroup(tokens, i, resolveRef);
    if (r.step.found) {
      push(r.step);
      i = r.next;
    } else {
      unknown.push(t.raw);
      i++;
    }
  }

  return { start, steps, ignored, unknown };
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/x-ray/g, 'xray')
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

function classify(words) {
  const out = [];
  let skipNumbers = false;

  for (const raw of words) {
    let type;
    let value = raw.toUpperCase();

    if (/^\d+\.\d+$/.test(raw)) type = 'skip'; // a frequency
    else if (PHONETIC[raw]) [type, value] = ['letter', PHONETIC[raw]];
    else if (NUMBERS[raw]) [type, value] = ['digit', NUMBERS[raw]];
    else if (SIDES[raw]) [type, value] = ['side', SIDES[raw]];
    else if (FILLER.has(raw)) type = 'filler';
    else if (/^\d+$/.test(raw)) type = 'digit';
    else if (/^[a-z]{1,2}$/.test(raw)) type = 'letter';
    else if (/\d/.test(raw) && /^[a-z0-9]+$/.test(raw)) type = 'ref';
    else type = 'word';

    if (skipNumbers) {
      if (type === 'digit' || type === 'skip' || type === 'filler') {
        out.push({ raw, type: 'skip', value });
        continue;
      }
      skipNumbers = false;
    }
    out.push({ raw, type, value });
    if (SKIP_NUMBERS.has(raw)) skipNumbers = true;
  }
  return out;
}

// A, A1, "alpha one", "alpha bravo" (=AB if it exists), "dom 3 alpha".
function matchLetterGroup(tokens, i, resolveRef) {
  const first = tokens[i];
  const candidates = [{ value: first.value, end: i + 1, digits: '' }];

  let value = first.value;
  let digits = '';
  for (let j = i + 1; j < tokens.length && j < i + 5; j++) {
    const t = tokens[j];
    if (t.type === 'digit' && first.type !== 'ref') {
      digits += t.value;
      value += t.value;
    } else if (t.type === 'letter' && t.value.length === 1 && digits) {
      // Trailing letter as in "dom three alpha" = DOM3A. Plain "A J" is never
      // merged into "AJ" — type double-letter refs without a space.
      value += t.value;
      candidates.push({ value, end: j + 1, digits });
      break;
    } else break;
    candidates.push({ value, end: j + 1, digits });
  }

  let checkedDigits = false;
  for (let k = candidates.length - 1; k >= 0; k--) {
    const c = candidates[k];
    const ref = resolveRef(c.value);
    if (ref) return { step: { ref, input: joinRaw(tokens, i, c.end), found: true }, next: c.end };

    // "alpha two" with no A2 at this airport still means A2 (flag it missing),
    // not A followed by a stray "2" — unless the number stands on its own as a
    // runway ("A 34 left").
    if (!checkedDigits && c.digits && c.value === first.value + c.digits) {
      checkedDigits = true;
      const standsAlone = tokens[c.end]?.type === 'side' || resolveRef(c.digits);
      if (!standsAlone && looksLikeRef(c.value)) {
        return { step: { ref: c.value, input: joinRaw(tokens, i, c.end), found: false }, next: c.end };
      }
    }
  }

  return { step: { ref: first.value, input: first.raw, found: false }, next: i + 1 };
}

// "bay 36", "gate d5", "stand three six alpha", "gate delta five", "stand 51 left".
// Returns null when the word isn't followed by a number ("give way", "parking brake").
function matchStand(tokens, i, resolveStand) {
  const word = STAND_WORDS[tokens[i].raw];
  let j = i + 1;
  while (tokens[j] && /^(number|no)$/.test(tokens[j].raw)) j++;
  const t = tokens[j];
  if (!t) return null;

  const candidates = []; // longest last
  if (t.type === 'ref') candidates.push({ value: t.value, end: j + 1 });
  else {
    let value = '';
    let k = j;
    if (t.type === 'letter' && t.value.length === 1 && tokens[j + 1]?.type === 'digit') value = tokens[k++].value;
    let digits = '';
    while (tokens[k]?.type === 'digit' && digits.length < 4) digits += tokens[k++].value;
    if (!digits) return null;
    value += digits;
    candidates.push({ value, end: k });
    // A trailing letter/side belongs to the stand only if that stand exists: "bay 36 A" is usually bay 36 then taxiway A.
    const next = tokens[k];
    if (next && (next.type === 'side' || (next.type === 'letter' && next.value.length === 1))) {
      candidates.push({ value: value + next.value, end: k + 1 });
    }
  }

  for (const c of [...candidates].reverse()) {
    const stand = resolveStand(c.value, word);
    if (stand) return { start: { ref: stand.ref, label: `${tokens[i].value} ${stand.ref}`, input: joinRaw(tokens, i, c.end), found: true, word, stand }, next: c.end };
  }
  const c = candidates[0];
  return { start: { ref: c.value, label: `${tokens[i].value} ${c.value}`, input: joinRaw(tokens, i, c.end), found: false, word }, next: c.end };
}

// 34L, "three four left", "7" (-> 07).
function matchDigitGroup(tokens, i, resolveRef) {
  let digits = '';
  let j = i;
  while (j < tokens.length && tokens[j].type === 'digit' && (digits + tokens[j].value).length <= 3) {
    digits += tokens[j].value;
    j++;
  }
  const side = tokens[j]?.type === 'side' || (tokens[j]?.type === 'letter' && /^[LRC]$/.test(tokens[j].value));
  const candidates = side ? [{ value: digits + tokens[j].value, end: j + 1 }, { value: digits, end: j }] : [{ value: digits, end: j }];

  for (const c of candidates) {
    const ref = resolveRef(c.value);
    if (ref) return { step: { ref, input: joinRaw(tokens, i, c.end), found: true }, next: c.end };
  }
  const best = candidates[0];
  if (isRunwayDesignator(best.value)) {
    return { step: { ref: best.value, input: joinRaw(tokens, i, best.end), found: false }, next: best.end };
  }
  return { step: null, input: joinRaw(tokens, i, j), next: j };
}

function joinRaw(tokens, from, to) {
  return tokens.slice(from, to).map((t) => t.raw).join(' ');
}
