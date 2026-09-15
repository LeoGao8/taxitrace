import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSettings, resolveTheme, inkFor, DEFAULTS } from '../public/js/settings.js';

test('stored settings are validated, missing ones defaulted', () => {
  assert.deepEqual(normaliseSettings(null), DEFAULTS);
  assert.deepEqual(normaliseSettings({ theme: 'light', ribbon: { color: '#FF2BD6', width: 'thick', glow: true } }), {
    theme: 'light',
    ribbon: { color: '#ff2bd6', width: 'thick', outline: 'dark', glow: true, chevrons: true },
  });
  const junk = normaliseSettings({ theme: 'neon', ribbon: { color: 'red;background:url(x)', width: 99, outline: 'x', glow: 'yes', chevrons: 0 } });
  assert.deepEqual(junk, DEFAULTS);
});

test('auto theme follows the device', () => {
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
});

test('arrows and labels on the ribbon use black or white, whichever is readable', () => {
  assert.equal(inkFor('#ffd60a'), '#000000'); // yellow
  assert.equal(inkFor('#ffffff'), '#000000');
  assert.equal(inkFor('#7c3aed'), '#ffffff'); // purple
  assert.equal(inkFor('#1e3a8a'), '#ffffff'); // navy
});
