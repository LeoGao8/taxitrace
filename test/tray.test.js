import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRefs, groupStands, withStand, applyRef, dropLastWord } from '../public/js/tray.js';

const refs = ['07', '16R', '25', '34L', 'A', 'A1', 'A2', 'AB', 'B10', 'B2', 'DOM3A', 'INTL5'].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const { runways, groups } = groupRefs(refs, (r) => /^\d/.test(r));
const g = (key) => groups.find((x) => x.key === key);

test('groups refs by letter prefix, runways apart', () => {
  assert.deepEqual(runways, ['07', '16R', '25', '34L']);
  assert.deepEqual(groups.map((x) => x.key), ['A', 'AB', 'B', 'DOM', 'INTL']);
  assert.deepEqual(g('A'), { key: 'A', hasSelf: true, refs: ['A', 'A1', 'A2'] });
  assert.deepEqual(g('B'), { key: 'B', hasSelf: false, refs: ['B2', 'B10'] });
});

test('a numbered ref replaces the plain letter just entered', () => {
  assert.equal(applyRef('', 'A', null), 'A');
  assert.equal(applyRef('J A', 'A1', g('A')), 'J A1');
  assert.equal(applyRef('J a', 'A1', g('A')), 'J A1');
  assert.equal(applyRef('A1', 'A2', g('A')), 'A2'); // fixing a mis-tap
  assert.equal(applyRef('A1', 'A', g('A')), 'A1 A');
});

test('otherwise refs are appended', () => {
  assert.equal(applyRef('AB', 'A1', g('A')), 'AB A1');
  assert.equal(applyRef('alpha lima ', 'B2', g('B')), 'alpha lima B2');
  assert.equal(applyRef('A A1', '34L', null), 'A A1 34L');
});

test('backspace drops the last word', () => {
  assert.equal(dropLastWord('A J  K '), 'A J');
  assert.equal(dropLastWord('A'), '');
  assert.equal(dropLastWord(''), '');
  assert.equal(dropLastWord('C HOLD SHORT'), 'C');
  assert.equal(dropLastWord('C hold short 25'), 'C hold short');
});

test('stands group by tens or letter prefix', () => {
  const groups = groupStands(['1', '8', '10', '36', '36A', '39', '101', 'D1', 'D12']);
  assert.deepEqual(groups.map((x) => `${x.key}:${x.refs.join(',')}`), ['1–9:1,8', '10s:10', '30s:36,36A,39', '100s:101', 'D:D1,D12']);
});

test('picking a bay puts it at the front, replacing any earlier one', () => {
  assert.equal(withStand('', 'BAY', '36'), 'BAY 36');
  assert.equal(withStand('A B', 'BAY', '36'), 'BAY 36 A B');
  assert.equal(withStand('BAY 12 A B', 'BAY', '36'), 'BAY 36 A B');
  assert.equal(withStand('A gate d5 B', 'GATE', 'D7'), 'GATE D7 A B');
  assert.equal(withStand('stand 51 left A', 'STAND', '52'), 'STAND 52 A');
});
