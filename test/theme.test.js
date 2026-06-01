const test = require('node:test');
const assert = require('node:assert/strict');

const {
  THEME_MODES,
  normalizeThemeMode,
  resolveThemeMode,
  getThemeButtonStates,
} = require('../extension/theme.js');

test('defaults unknown or missing theme modes to system', () => {
  assert.equal(normalizeThemeMode(), 'system');
  assert.equal(normalizeThemeMode('midnight'), 'system');
});

test('resolves system mode from the current preferred color scheme', () => {
  assert.equal(resolveThemeMode('system', true), 'dark');
  assert.equal(resolveThemeMode('system', false), 'light');
});

test('resolves explicit light and dark modes without using system preference', () => {
  assert.equal(resolveThemeMode('light', true), 'light');
  assert.equal(resolveThemeMode('dark', false), 'dark');
});

test('builds one selected button state for the active saved mode', () => {
  const states = getThemeButtonStates('dark');

  assert.deepEqual(
    states.map(state => state.mode),
    THEME_MODES,
  );
  assert.deepEqual(
    states.map(state => state.selected),
    [false, false, true],
  );
});
