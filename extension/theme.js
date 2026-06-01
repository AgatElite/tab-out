(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.TabOutTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const THEME_MODES = ['light', 'system', 'dark'];
  const THEME_MODE_STORAGE_KEY = 'themeMode';

  function normalizeThemeMode(mode) {
    return THEME_MODES.includes(mode) ? mode : 'system';
  }

  function resolveThemeMode(mode, prefersDark) {
    const normalized = normalizeThemeMode(mode);
    if (normalized === 'system') return prefersDark ? 'dark' : 'light';
    return normalized;
  }

  function getThemeButtonStates(mode) {
    const normalized = normalizeThemeMode(mode);
    return THEME_MODES.map(themeMode => ({
      mode: themeMode,
      label: themeMode.charAt(0).toUpperCase() + themeMode.slice(1),
      selected: themeMode === normalized,
    }));
  }

  return {
    THEME_MODES,
    THEME_MODE_STORAGE_KEY,
    normalizeThemeMode,
    resolveThemeMode,
    getThemeButtonStates,
  };
});
