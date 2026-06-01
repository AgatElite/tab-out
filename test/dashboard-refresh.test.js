const test = require('node:test');
const assert = require('node:assert/strict');

const { attachDashboardRefreshListeners } = require('../extension/dashboard-refresh.js');

function createTarget() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
}

function createChromeTabs() {
  const listeners = {};
  return {
    listeners,
    onCreated: { addListener(fn) { listeners.created = fn; } },
    onRemoved: { addListener(fn) { listeners.removed = fn; } },
    onUpdated: { addListener(fn) { listeners.updated = fn; } },
  };
}

test('refreshes when an existing Tab Out page becomes visible again', async () => {
  const document = createTarget();
  document.visibilityState = 'visible';
  const window = createTarget();
  const chrome = { tabs: createChromeTabs() };
  let calls = 0;

  attachDashboardRefreshListeners({
    document,
    window,
    chrome,
    debounceMs: 0,
    render: async () => { calls += 1; },
  });

  document.listeners.visibilitychange();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(calls, 1);
});

test('refreshes when Chrome reports tab changes while Tab Out is visible', async () => {
  const document = createTarget();
  document.visibilityState = 'visible';
  const window = createTarget();
  const chrome = { tabs: createChromeTabs() };
  let calls = 0;

  attachDashboardRefreshListeners({
    document,
    window,
    chrome,
    debounceMs: 0,
    render: async () => { calls += 1; },
  });

  chrome.tabs.listeners.created();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(calls, 1);
});

test('ignores noisy tab update events that do not change dashboard content', async () => {
  const document = createTarget();
  document.visibilityState = 'visible';
  const window = createTarget();
  const chrome = { tabs: createChromeTabs() };
  let calls = 0;

  attachDashboardRefreshListeners({
    document,
    window,
    chrome,
    debounceMs: 0,
    render: async () => { calls += 1; },
  });

  chrome.tabs.listeners.updated(1, { status: 'loading' });
  chrome.tabs.listeners.updated(1, { favIconUrl: 'https://example.com/favicon.ico' });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(calls, 0);
});

test('coalesces refreshes while a render is already running', async () => {
  const document = createTarget();
  document.visibilityState = 'visible';
  const window = createTarget();
  const chrome = { tabs: createChromeTabs() };
  let calls = 0;
  let finishFirstRender;

  attachDashboardRefreshListeners({
    document,
    window,
    chrome,
    debounceMs: 0,
    render: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise(resolve => { finishFirstRender = resolve; });
      }
    },
  });

  chrome.tabs.listeners.created();
  await new Promise(resolve => setTimeout(resolve, 0));
  chrome.tabs.listeners.removed();
  chrome.tabs.listeners.updated(1, { title: 'Updated title' });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(calls, 1);

  finishFirstRender();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(calls, 2);
});
