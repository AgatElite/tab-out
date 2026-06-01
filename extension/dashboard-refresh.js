(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.TabOutDashboardRefresh = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function attachDashboardRefreshListeners({
    document,
    window,
    chrome,
    render,
    debounceMs = 150,
  }) {
    let refreshTimer = null;
    let renderInFlight = false;
    let renderQueued = false;

    function isVisible() {
      return !document || document.visibilityState !== 'hidden';
    }

    async function runRefresh() {
      if (!isVisible()) return;

      if (renderInFlight) {
        renderQueued = true;
        return;
      }

      renderInFlight = true;
      try {
        await render();
      } finally {
        renderInFlight = false;
      }

      if (renderQueued) {
        renderQueued = false;
        scheduleRefresh();
      }
    }

    function scheduleRefresh() {
      if (!isVisible()) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        runRefresh();
      }, debounceMs);
    }

    function scheduleTabUpdatedRefresh(_tabId, changeInfo = {}) {
      if (!changeInfo.url && !changeInfo.title && changeInfo.status !== 'complete') return;
      scheduleRefresh();
    }

    if (document && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') scheduleRefresh();
      });
    }

    if (window && window.addEventListener) {
      window.addEventListener('focus', scheduleRefresh);
    }

    if (chrome && chrome.tabs) {
      chrome.tabs.onCreated?.addListener(scheduleRefresh);
      chrome.tabs.onRemoved?.addListener(scheduleRefresh);
      chrome.tabs.onUpdated?.addListener(scheduleTabUpdatedRefresh);
    }

    return { scheduleRefresh };
  }

  return { attachDashboardRefreshListeners };
});
