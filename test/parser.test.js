import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClearance } from '../public/js/parser.js';
import { indexAirport } from '../public/js/route.js';

// Refs modelled on real YSSY OSM data.
const airport = {
  crs: 'geo',
  features: ['A', 'A1', 'B', 'B10', 'C', 'J', 'K', 'L', 'DOM3A', 'INTL5', 'AB'].map((ref) => ({ kind: 'taxiway', refs: [ref], coords: [] }))
    .concat([{ kind: 'runway', refs: ['16R', '34L'], coords: [] }, { kind: 'runway', refs: ['07', '25'], coords: [] }]),
};
const { resolve } = indexAirport(airport);
const refs = (text) => parseClearance(text, resolve).steps.map((s) => (s.found ? s.ref : `!${s.ref}`));

test('plain letters in order', () => {
  assert.deepEqual(refs('A J K'), ['A', 'J', 'K']);
  assert.deepEqual(refs('a j k'), ['A', 'J', 'K']);
  assert.deepEqual(refs('A, J, K'), ['A', 'J', 'K']);
});

test('NATO phonetic', () => {
  assert.deepEqual(refs('alpha juliet kilo'), ['A', 'J', 'K']);
  assert.deepEqual(refs('Alfa Juliett Kilo'), ['A', 'J', 'K']);
});

test('filler words are ignored', () => {
  const r = parseClearance('taxi to holding point runway 34L via A J K hold short of B', resolve);
  assert.deepEqual(r.steps.map((s) => s.ref), ['34L', 'A', 'J', 'K', 'B']);
  assert.deepEqual(r.unknown, []);
  assert.ok(r.ignored.includes('taxi') && r.ignored.includes('via'));
});

test('multi-character refs', () => {
  assert.deepEqual(refs('A1 B10 DOM3A'), ['A1', 'B10', 'DOM3A']);
  assert.deepEqual(refs('alpha one bravo one zero'), ['A1', 'B10']);
  assert.deepEqual(refs('intl five'), ['INTL5']);
  assert.deepEqual(refs('AB'), ['AB']);
});

test('plain letters are never glued into double-letter refs', () => {
  assert.deepEqual(refs('A B'), ['A', 'B']);
});

test('runway designators', () => {
  assert.deepEqual(refs('cross runway 16R'), ['16R']);
  assert.deepEqual(refs('hold short runway three four left'), ['34L']);
  assert.deepEqual(refs('34 L'), ['34L']);
  assert.deepEqual(refs('cross 7'), ['07']);
  assert.deepEqual(refs('A 34 left'), ['A', '34L']);
});

test('order and duplicates preserved', () => {
  assert.deepEqual(refs('A J A K A'), ['A', 'J', 'A', 'K', 'A']);
});

test('unknown taxiways are flagged, not dropped', () => {
  assert.deepEqual(refs('A Z K'), ['A', '!Z', 'K']);
  assert.deepEqual(refs('alpha two'), ['!A2']);
  assert.deepEqual(refs('cross 16C'), ['!16C']);
  const r = parseClearance('A qantas K', resolve);
  assert.deepEqual(r.unknown, ['qantas']);
});

test('frequencies and stand numbers are not taxiways', () => {
  const r = parseClearance('taxi stand 51 via B contact ground 121.7', resolve);
  assert.deepEqual(r.steps.map((s) => s.ref), ['B']);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(refs('contact tower one two zero decimal five then A'), ['A']);
});

test('empty input', () => {
  assert.deepEqual(parseClearance('   ', resolve), { start: null, steps: [], ignored: [], unknown: [] });
});

test('gate / bay / stand sets where the taxi starts', () => {
  const stands = { 36: { ref: '36' }, '51L': { ref: '51L' }, D5: { ref: 'D5' } };
  const resolveStand = (r) => stands[r] || null;
  const parse = (text) => {
    const r = parseClearance(text, resolve, resolveStand);
    return [r.start && `${r.start.found ? '' : '!'}${r.start.label}`, r.steps.map((s) => s.ref).join(' ')];
  };
  assert.deepEqual(parse('BAY 36 A B C'), ['BAY 36', 'A B C']);
  assert.deepEqual(parse('bay three six alpha'), ['BAY 36', 'A']); // A is a taxiway: no bay 36A
  assert.deepEqual(parse('from stand 51 left via A hold short 34 left'), ['STAND 51L', 'A 34L']);
  assert.deepEqual(parse('pushback approved gate delta five, taxi J'), ['GATE D5', 'J']);
  assert.deepEqual(parse('bay 99 K'), ['!BAY 99', 'K']); // flagged, never a taxiway or runway
  assert.deepEqual(parse('give way to traffic, parking brake set, A'), [null, 'A']);
});

test('hold short / cross attach to the ref that follows', () => {
  const r = parseClearance('A B hold short of runway 16R J cross 34L K hold position', resolve);
  assert.deepEqual(r.steps.map((s) => `${s.action ? `${s.action}:` : ''}${s.ref}`), ['A', 'B', 'hold:16R', 'J', 'cross:34L', 'K']);
  assert.deepEqual(parseClearance('hold position then A', resolve).steps.map((s) => s.action), [null]);
});
