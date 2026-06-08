/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

const themeHelpers = window.TabOutTheme;
const deferredListHelpers = window.TabOutDeferredLists;
const dashboardRefresh = window.TabOutDashboardRefresh;
const dragOrderHelpers = window.TabOutDragOrder;
const themeMediaQuery = window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : { matches: false };
let selectedThemeMode = 'system';
let savedListMouseDrag = null;
let openTabMouseDrag = null;
let activeOpenTabDragChip = null;
let suppressNextDeferredClick = false;
let suppressNextOpenTabClick = false;
let pendingListDelete = null;
let selectedDeferredIds = new Set();
let archiveWhenOpened = false;
let lastOpenTabsHeaderHtml = '';
let lastOpenTabsRenderSignature = '';
let lastDeferredRenderSignature = '';
let lastArchiveRenderSignature = '';
let lastArchiveOpenedControlHtml = '';
const ARCHIVE_WHEN_OPENED_STORAGE_KEY = 'archiveWhenOpened';

function applyThemeMode(mode) {
  selectedThemeMode = themeHelpers.normalizeThemeMode(mode);

  const resolvedTheme = themeHelpers.resolveThemeMode(
    selectedThemeMode,
    themeMediaQuery.matches,
  );

  document.documentElement.dataset.themeMode = selectedThemeMode;
  document.documentElement.dataset.theme = resolvedTheme;
  updateThemeControl(selectedThemeMode);
}

function updateThemeControl(mode) {
  const states = themeHelpers.getThemeButtonStates(mode);

  for (const state of states) {
    const button = document.querySelector(`[data-action="set-theme"][data-theme-mode="${state.mode}"]`);
    if (!button) continue;
    button.classList.toggle('is-selected', state.selected);
    button.setAttribute('aria-pressed', state.selected ? 'true' : 'false');
  }
}

async function loadThemeMode() {
  try {
    const stored = await chrome.storage.local.get(themeHelpers.THEME_MODE_STORAGE_KEY);
    applyThemeMode(stored[themeHelpers.THEME_MODE_STORAGE_KEY]);
  } catch {
    applyThemeMode('system');
  }
}

async function saveThemeMode(mode) {
  const normalized = themeHelpers.normalizeThemeMode(mode);
  applyThemeMode(normalized);
  await chrome.storage.local.set({ [themeHelpers.THEME_MODE_STORAGE_KEY]: normalized });
}

function initThemeMode() {
  applyThemeMode('system');
  loadThemeMode();

  const handleSystemThemeChange = () => {
    if (selectedThemeMode === 'system') applyThemeMode('system');
  };

  if (themeMediaQuery.addEventListener) {
    themeMediaQuery.addEventListener('change', handleSystemThemeChange);
  } else if (themeMediaQuery.addListener) {
    themeMediaQuery.addListener(handleSystemThemeChange);
  }
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      index:    t.index,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       listId: "inbox",              // saved list ID; missing = Inbox
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]

   User-created lists are stored under "deferredLists":
   [{ id: "list-reading", name: "Reading", createdAt: "..." }]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    listId:    deferredListHelpers.DEFAULT_DEFERRED_LIST_ID,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

async function getDeferredLists() {
  const { deferredLists = [] } = await chrome.storage.local.get('deferredLists');
  return deferredListHelpers.normalizeDeferredLists(deferredLists);
}

function createUniqueDeferredList(name, existingLists) {
  const base = deferredListHelpers.createDeferredList(name);
  const existingIds = new Set(existingLists.map(list => list.id));
  if (!existingIds.has(base.id)) return base;

  let suffix = 2;
  let id = `${base.id}-${suffix}`;
  while (existingIds.has(id)) {
    suffix += 1;
    id = `${base.id}-${suffix}`;
  }
  return { ...base, id };
}

async function addDeferredList(name) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return null;

  const lists = await getDeferredLists();
  const list = createUniqueDeferredList(trimmedName, lists);
  const userLists = [...lists.filter(l => !l.isDefault), list];
  await chrome.storage.local.set({ deferredLists: userLists });
  return list;
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [], deferredLists = [] } = await chrome.storage.local.get(['deferred', 'deferredLists']);
  const visible = deferred.filter(t => !t.dismissed);
  const active = visible.filter(t => !t.completed);
  const lists = deferredListHelpers.normalizeDeferredLists(deferredLists);
  return {
    active,
    archived: visible.filter(t => t.completed),
    lists,
    groups: deferredListHelpers.groupDeferredTabsByList(active, lists),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

async function moveSavedTabToList(tabId, listId) {
  const { deferred = [], deferredLists = [] } = await chrome.storage.local.get(['deferred', 'deferredLists']);
  const lists = deferredListHelpers.normalizeDeferredLists(deferredLists);
  const knownListIds = new Set(lists.map(list => list.id));
  if (!knownListIds.has(listId)) return false;

  const moved = deferredListHelpers.moveDeferredTabToList(deferred, tabId, listId);
  await chrome.storage.local.set({ deferred: moved });
  return true;
}

async function reorderSavedTab(tabId, listId, beforeTabId = null) {
  const { deferred = [], deferredLists = [] } = await chrome.storage.local.get(['deferred', 'deferredLists']);
  const lists = deferredListHelpers.normalizeDeferredLists(deferredLists);
  const knownListIds = new Set(lists.map(list => list.id));
  if (!knownListIds.has(listId)) return false;

  const moved = deferredListHelpers.reorderDeferredTab(deferred, tabId, listId, beforeTabId);
  await chrome.storage.local.set({ deferred: moved });
  return true;
}

async function deleteSavedList(listId, mode, targetListId) {
  const { deferred = [], deferredLists = [] } = await chrome.storage.local.get(['deferred', 'deferredLists']);
  const result = deferredListHelpers.deleteDeferredList({
    deferred,
    lists: deferredLists,
    listId,
    mode,
    targetListId,
  });
  await chrome.storage.local.set({
    deferred: result.deferred,
    deferredLists: result.lists,
  });
}

async function renameSavedList(listId, name) {
  const { deferredLists = [] } = await chrome.storage.local.get('deferredLists');
  const lists = deferredListHelpers.renameDeferredList(deferredLists, listId, name);
  await chrome.storage.local.set({ deferredLists: lists });
}

async function updateSavedTabTitle(tabId, title) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const updated = deferredListHelpers.updateDeferredTabTitle(deferred, tabId, title);
  await chrome.storage.local.set({ deferred: updated });
}

async function bulkUpdateSavedTabs(action, targetListId) {
  const ids = [...selectedDeferredIds];
  if (ids.length === 0) return 0;

  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const updated = deferredListHelpers.bulkUpdateDeferredTabs(deferred, ids, action, targetListId);
  await chrome.storage.local.set({ deferred: updated });
  selectedDeferredIds = new Set();
  return ids.length;
}

async function setArchiveWhenOpened(enabled) {
  archiveWhenOpened = Boolean(enabled);
  await chrome.storage.local.set({ [ARCHIVE_WHEN_OPENED_STORAGE_KEY]: archiveWhenOpened });
}

async function loadArchiveWhenOpened() {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_WHEN_OPENED_STORAGE_KEY);
    archiveWhenOpened = Boolean(stored[ARCHIVE_WHEN_OPENED_STORAGE_KEY]);
  } catch {
    archiveWhenOpened = false;
  }
}

async function openSavedTabsByIds(ids, shouldArchive = archiveWhenOpened, openActive = false) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return 0;

  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const idSet = new Set(uniqueIds);
  const tabsToOpen = deferred.filter(tab => (
    idSet.has(tab.id) &&
    !tab.dismissed &&
    !tab.completed &&
    tab.url
  ));

  for (let i = 0; i < tabsToOpen.length; i += 1) {
    await chrome.tabs.create({ url: tabsToOpen[i].url, active: openActive && i === 0 });
  }

  if (shouldArchive && tabsToOpen.length > 0) {
    const openedIds = tabsToOpen.map(tab => tab.id);
    const updated = deferredListHelpers.bulkUpdateDeferredTabs(
      deferred,
      openedIds,
      'archive',
      undefined,
    );
    await chrome.storage.local.set({ deferred: updated });
    selectedDeferredIds = new Set([...selectedDeferredIds].filter(id => !openedIds.includes(id)));
  }

  return tabsToOpen.length;
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

function stableStringify(value) {
  return JSON.stringify(value);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  edit:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 7.125 16.875 4.5M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-id="${tab.id}" data-window-id="${tab.windowId}" data-tab-index="${tab.index}" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-id="${tab.id}" data-window-id="${tab.windowId}" data-tab-index="${tab.index}" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived, lists, groups } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0 && lists.length <= 1) {
      column.style.display = 'none';
      lastDeferredRenderSignature = '';
      lastArchiveRenderSignature = '';
      lastArchiveOpenedControlHtml = '';
      return;
    }

    column.style.display = 'block';
    renderArchiveOpenedControl();

    // Render active checklist items
    if (active.length > 0) {
      const activeIds = new Set(active.map(item => item.id));
      selectedDeferredIds = new Set([...selectedDeferredIds].filter(id => activeIds.has(id)));
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      const deferredSignature = stableStringify({
        groups: groups.map(group => ({
          list: group.list,
          items: group.items.map(item => ({
            id: item.id,
            url: item.url,
            title: item.title,
            listId: item.listId,
            savedAt: item.savedAt,
          })),
        })),
        selected: [...selectedDeferredIds].sort(),
      });
      if (deferredSignature !== lastDeferredRenderSignature) {
        list.innerHTML = groups.map(group => renderDeferredListGroup(group)).join('');
        lastDeferredRenderSignature = deferredSignature;
      }
      list.style.display = 'block';
      empty.style.display = 'none';
    } else if (lists.length > 1) {
      countEl.textContent = '0 items';
      const deferredSignature = stableStringify({
        groups: groups.map(group => ({ list: group.list, items: [] })),
        selected: [],
      });
      if (deferredSignature !== lastDeferredRenderSignature) {
        list.innerHTML = groups.map(group => renderDeferredListGroup(group)).join('');
        lastDeferredRenderSignature = deferredSignature;
      }
      list.style.display = 'block';
      empty.style.display = 'block';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
      lastDeferredRenderSignature = '';
    }
    updateDeferredBulkBar();

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      const archiveSignature = stableStringify(archived.map(item => ({
        id: item.id,
        url: item.url,
        title: item.title,
        completedAt: item.completedAt,
        savedAt: item.savedAt,
      })));
      if (archiveSignature !== lastArchiveRenderSignature) {
        archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
        lastArchiveRenderSignature = archiveSignature;
      }
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
      archiveList.innerHTML = '';
      lastArchiveRenderSignature = '';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

function renderDeferredListGroup(group) {
  const list = group.list;
  const items = group.items || [];
  const safeListId = (list.id || '').replace(/"/g, '&quot;');
  const safeListName = (list.name || '').replace(/"/g, '&quot;');
  const emptyText = list.isDefault ? 'New saves land here.' : 'Drop saved links here.';
  const renameButton = list.isDefault ? '' : `
    <button class="deferred-list-edit" type="button" data-action="rename-deferred-list" data-list-id="${safeListId}" data-list-name="${safeListName}" title="Rename list">
      ${ICONS.edit}
    </button>`;
  const deleteButton = list.isDefault ? '' : `
    <button class="deferred-list-delete" type="button" data-action="open-list-delete" data-list-id="${safeListId}" title="Delete list">
      ${ICONS.close}
    </button>`;
  const openAllButton = items.length === 0 ? '' : `
    <button class="deferred-list-open-all" type="button" data-action="open-deferred-list" data-list-id="${safeListId}" title="Open all saved tabs in ${safeListName}">
      ${ICONS.focus}
      Open all
    </button>`;

  return `
    <div class="deferred-list-group" data-deferred-list-id="${safeListId}">
      <div class="deferred-list-header">
        <span class="deferred-list-name">${list.name}</span>
        <span class="deferred-list-count">${items.length}</span>
        ${openAllButton}
        ${renameButton}
        ${deleteButton}
      </div>
      <div class="deferred-list-items">
        ${items.length > 0
          ? items.map(item => renderDeferredItem(item)).join('')
          : `<div class="deferred-list-empty">${emptyText}</div>`}
      </div>
    </div>`;
}

function updateDeferredBulkBar() {
  const bar = document.getElementById('deferredBulkBar');
  const countEl = document.getElementById('deferredBulkCount');
  if (!bar || !countEl) return;

  const count = selectedDeferredIds.size;
  if (count === 0) {
    bar.style.display = 'none';
    countEl.textContent = '0 selected';
    return;
  }

  countEl.textContent = `${count} selected`;
  bar.style.display = 'flex';
}

function renderArchiveOpenedControl() {
  const countEl = document.getElementById('deferredCount');
  if (!countEl) return;

  const checked = archiveWhenOpened ? ' checked' : '';
  const html = `
    <label class="archive-opened-toggle">
      <input type="checkbox" data-action="toggle-archive-when-opened"${checked}>
      <span>Archive when opened</span>
    </label>`;

  if (html === lastArchiveOpenedControlHtml) return;

  let control = document.getElementById('archiveOpenedToggleWrap');
  if (!control) {
    control = document.createElement('span');
    control.id = 'archiveOpenedToggleWrap';
    countEl.insertAdjacentElement('afterend', control);
  }
  control.innerHTML = html;
  lastArchiveOpenedControlHtml = html;
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);
  const checked = selectedDeferredIds.has(item.id) ? ' checked' : '';

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="toggle-deferred-selection" data-deferred-id="${item.id}"${checked}>
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" data-action="open-deferred-tab" data-deferred-id="${item.id}" draggable="false" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" draggable="false" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-edit-title" data-action="rename-deferred-tab" data-deferred-id="${item.id}" data-deferred-title="${(item.title || item.url || '').replace(/"/g, '&quot;')}" title="Rename saved tab">
        ${ICONS.edit}
      </button>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}

async function openListDeleteModal(listId) {
  const modal = document.getElementById('listDeleteModal');
  const summary = document.getElementById('listDeleteSummary');
  const targets = document.getElementById('listDeleteTargets');
  if (!modal || !summary || !targets) return;

  const { groups, lists } = await getSavedTabs();
  const group = groups.find(g => g.list.id === listId);
  if (!group || group.list.isDefault) return;
  if (group.items.length === 0) {
    await deleteSavedList(listId, 'delete');
    await renderDeferredColumn();
    showToast(`Deleted ${group.list.name}`);
    return;
  }

  const targetLists = lists.filter(list => list.id !== listId);
  pendingListDelete = { listId };

  summary.textContent = `"${group.list.name}" has ${group.items.length} saved tab${group.items.length !== 1 ? 's' : ''}.`;
  targets.innerHTML = targetLists.map((list, index) => `
    <label class="list-delete-target">
      <input type="radio" name="listDeleteTarget" value="${(list.id || '').replace(/"/g, '&quot;')}" ${index === 0 ? 'checked' : ''}>
      <span>${list.name}</span>
    </label>
  `).join('');
  modal.querySelector('input[name="listDeleteMode"][value="move"]').checked = targetLists.length > 0;
  modal.querySelector('input[name="listDeleteMode"][value="delete"]').checked = targetLists.length === 0;
  targets.classList.toggle('is-disabled', targetLists.length === 0);
  modal.style.display = 'flex';
}

function closeListDeleteModal() {
  const modal = document.getElementById('listDeleteModal');
  if (modal) modal.style.display = 'none';
  pendingListDelete = null;
}

async function confirmListDelete() {
  if (!pendingListDelete) return;

  const modal = document.getElementById('listDeleteModal');
  const mode = modal?.querySelector('input[name="listDeleteMode"]:checked')?.value || 'delete';
  const targetListId = modal?.querySelector('input[name="listDeleteTarget"]:checked')?.value;
  await deleteSavedList(pendingListDelete.listId, mode, targetListId);
  closeListDeleteModal();
  await renderDeferredColumn();
  showToast(mode === 'move' ? 'List deleted, tabs moved' : 'List and tabs deleted');
}

async function openBulkMoveModal() {
  const modal = document.getElementById('bulkMoveModal');
  const summary = document.getElementById('bulkMoveSummary');
  const targets = document.getElementById('bulkMoveTargets');
  if (!modal || !summary || !targets || selectedDeferredIds.size === 0) return;

  const { lists } = await getSavedTabs();
  summary.textContent = `${selectedDeferredIds.size} saved tab${selectedDeferredIds.size !== 1 ? 's' : ''} selected.`;
  targets.innerHTML = lists.map(list => `
    <button class="bulk-move-target" type="button" data-action="bulk-move-deferred" data-list-id="${(list.id || '').replace(/"/g, '&quot;')}">
      <span>${list.name}</span>
      <span class="bulk-move-target-hint">Move here</span>
    </button>
  `).join('');
  modal.style.display = 'flex';
}

function closeBulkMoveModal() {
  const modal = document.getElementById('bulkMoveModal');
  if (modal) modal.style.display = 'none';
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates section stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    const openTabsHeaderHtml = `${realTabs.length} open tab${realTabs.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; ${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    if (openTabsHeaderHtml !== lastOpenTabsHeaderHtml) {
      openTabsSectionCount.innerHTML = openTabsHeaderHtml;
      lastOpenTabsHeaderHtml = openTabsHeaderHtml;
    }
    const openTabsSignature = stableStringify(domainGroups.map(group => ({
      domain: group.domain,
      label: group.label,
      tabs: group.tabs.map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
      })),
    })));
    if (openTabsSignature !== lastOpenTabsRenderSignature) {
      openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
      lastOpenTabsRenderSignature = openTabsSignature;
    }
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
    lastOpenTabsHeaderHtml = '';
    lastOpenTabsRenderSignature = '';
  }

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Theme switcher ----
  if (action === 'set-theme') {
    const mode = actionEl.dataset.themeMode;
    await saveThemeMode(mode);
    const normalized = themeHelpers.normalizeThemeMode(mode);
    const label = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    showToast(normalized === 'system' ? 'Following system theme' : `${label} theme selected`);
    return;
  }

  // ---- Create a saved-tabs list ----
  if (action === 'create-deferred-list') {
    const name = window.prompt('Name this list');
    const list = await addDeferredList(name);
    if (!list) return;

    await renderDeferredColumn();
    showToast(`Created ${list.name}`);
    return;
  }

  if (action === 'open-list-delete') {
    const listId = actionEl.dataset.listId;
    if (listId) await openListDeleteModal(listId);
    return;
  }

  if (action === 'rename-deferred-list') {
    const listId = actionEl.dataset.listId;
    const currentName = actionEl.dataset.listName || '';
    const name = window.prompt('Rename this list', currentName);
    if (!listId || name === null) return;

    await renameSavedList(listId, name);
    await renderDeferredColumn();
    showToast('List renamed');
    return;
  }

  if (action === 'rename-deferred-tab') {
    e.stopPropagation();
    const tabId = actionEl.dataset.deferredId;
    const currentTitle = actionEl.dataset.deferredTitle || '';
    const title = window.prompt('Title for this saved tab', currentTitle);
    if (!tabId || title === null) return;

    await updateSavedTabTitle(tabId, title);
    await renderDeferredColumn();
    showToast('Saved tab renamed');
    return;
  }

  if (action === 'cancel-list-delete') {
    closeListDeleteModal();
    return;
  }

  if (action === 'confirm-list-delete') {
    await confirmListDelete();
    return;
  }

  if (action === 'toggle-deferred-selection') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    if (actionEl.checked) {
      selectedDeferredIds.add(id);
    } else {
      selectedDeferredIds.delete(id);
    }
    updateDeferredBulkBar();
    return;
  }

  if (action === 'toggle-archive-when-opened') {
    await setArchiveWhenOpened(actionEl.checked);
    lastArchiveOpenedControlHtml = '';
    renderArchiveOpenedControl();
    showToast(archiveWhenOpened ? 'Will archive opened saved tabs' : 'Opened saved tabs stay saved');
    return;
  }

  if (action === 'clear-deferred-selection') {
    selectedDeferredIds = new Set();
    await renderDeferredColumn();
    return;
  }

  if (action === 'bulk-open-deferred') {
    const count = await openSavedTabsByIds([...selectedDeferredIds]);
    await renderDeferredColumn();
    if (count > 0) showToast(`Opened ${count} saved tab${count !== 1 ? 's' : ''}`);
    return;
  }

  if (action === 'bulk-archive-deferred') {
    const count = await bulkUpdateSavedTabs('archive');
    await renderDeferredColumn();
    if (count > 0) showToast(`Archived ${count} saved tab${count !== 1 ? 's' : ''}`);
    return;
  }

  if (action === 'bulk-delete-deferred') {
    const count = await bulkUpdateSavedTabs('delete');
    await renderDeferredColumn();
    if (count > 0) showToast(`Deleted ${count} saved tab${count !== 1 ? 's' : ''}`);
    return;
  }

  if (action === 'open-bulk-move-deferred') {
    await openBulkMoveModal();
    return;
  }

  if (action === 'cancel-bulk-move') {
    closeBulkMoveModal();
    return;
  }

  if (action === 'bulk-move-deferred') {
    const listId = actionEl.dataset.listId;
    const count = await bulkUpdateSavedTabs('move', listId);
    closeBulkMoveModal();
    await renderDeferredColumn();
    if (count > 0) showToast(`Moved ${count} saved tab${count !== 1 ? 's' : ''}`);
    return;
  }

  if (action === 'open-deferred-tab') {
    e.preventDefault();
    const id = actionEl.dataset.deferredId;
    const count = await openSavedTabsByIds([id], archiveWhenOpened, true);
    await renderDeferredColumn();
    if (count > 0 && archiveWhenOpened) showToast('Opened and archived');
    return;
  }

  if (action === 'open-deferred-list') {
    const listId = actionEl.dataset.listId;
    if (!listId) return;

    const { groups } = await getSavedTabs();
    const group = groups.find(g => g.list.id === listId);
    const ids = group ? group.items.map(item => item.id) : [];
    const count = await openSavedTabsByIds(ids);
    await renderDeferredColumn();
    if (count > 0) showToast(`Opened ${count} saved tab${count !== 1 ? 's' : ''}`);
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Legacy check-off action (older rendered pages) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

function getDeferredDropTarget(x, y) {
  const target = document.elementFromPoint(x, y);
  const group = target?.closest('.deferred-list-group');
  if (!group) return null;

  const targetItem = target.closest('.deferred-item');
  let beforeTabId = null;
  if (targetItem) {
    const rect = targetItem.getBoundingClientRect();
    const dropAfterTarget = y > rect.top + rect.height / 2;
    if (dropAfterTarget) {
      const nextItem = targetItem.nextElementSibling?.closest?.('.deferred-item');
      beforeTabId = nextItem?.dataset.deferredId || null;
    } else {
      beforeTabId = targetItem.dataset.deferredId || null;
    }
  }

  return {
    group,
    listId: group.dataset.deferredListId,
    beforeTabId,
  };
}

async function moveOpenTabWithinSection(draggedId, targetId, dropAfterTarget) {
  if (!draggedId || !targetId || draggedId === targetId) return false;

  const draggedTab = openTabs.find(tab => String(tab.id) === String(draggedId));
  const targetTab = openTabs.find(tab => String(tab.id) === String(targetId));
  if (!draggedTab || !targetTab || draggedTab.windowId !== targetTab.windowId) return false;

  const targetIndex = dragOrderHelpers.calculateChromeMoveIndex({
    draggedIndex: draggedTab.index,
    targetIndex: targetTab.index,
    dropAfterTarget,
  });
  if (targetIndex === null) return false;

  await chrome.tabs.move(draggedTab.id, { index: targetIndex });
  await fetchOpenTabs();
  return true;
}

function clearOpenTabDragState() {
  if (activeOpenTabDragChip) activeOpenTabDragChip.classList.remove('dragging');
  activeOpenTabDragChip = null;
  openTabMouseDrag = null;
  document.body.classList.remove('is-dragging-open-tab');
  document.querySelectorAll('.page-chip.drag-over').forEach(chip => {
    chip.classList.remove('drag-over');
  });
}

function clearDeferredDragState() {
  if (savedListMouseDrag?.item) savedListMouseDrag.item.classList.remove('dragging');
  savedListMouseDrag = null;
  document.body.classList.remove('is-dragging-deferred');
  document.querySelectorAll('.deferred-list-group.drag-over').forEach(group => {
    group.classList.remove('drag-over');
  });
}

function moveOpenTabChipInDom(draggedId, targetChip, dropAfterTarget) {
  const draggedChip = document.querySelector(`.page-chip[data-tab-id="${CSS.escape(String(draggedId))}"]`);
  if (!draggedChip || !targetChip || draggedChip === targetChip) return;

  const parent = targetChip.parentElement;
  if (!parent || draggedChip.parentElement !== parent) return;

  parent.insertBefore(draggedChip, dropAfterTarget ? targetChip.nextSibling : targetChip);
}

function updateDeferredListCount(group) {
  const countEl = group?.querySelector('.deferred-list-count');
  const itemsEl = group?.querySelector('.deferred-list-items');
  if (!countEl || !itemsEl) return;

  countEl.textContent = itemsEl.querySelectorAll('.deferred-item').length;
}

function moveDeferredItemInDom(draggedId, targetGroup, beforeTabId) {
  const draggedItem = document.querySelector(`.deferred-item[data-deferred-id="${CSS.escape(String(draggedId))}"]`);
  const targetItems = targetGroup?.querySelector('.deferred-list-items');
  if (!draggedItem || !targetItems) return;

  const sourceGroup = draggedItem.closest('.deferred-list-group');
  targetItems.querySelector('.deferred-list-empty')?.remove();
  const beforeItem = beforeTabId
    ? targetItems.querySelector(`.deferred-item[data-deferred-id="${CSS.escape(String(beforeTabId))}"]`)
    : null;

  targetItems.insertBefore(draggedItem, beforeItem);
  updateDeferredListCount(sourceGroup);
  updateDeferredListCount(targetGroup);
}

// ---- Saved-list and open-tab drag and drop ----
document.addEventListener('dragstart', (e) => {
  if (!e.target.closest('.deferred-item, .page-chip[data-tab-id]')) return;
  e.preventDefault();
  clearOpenTabDragState();
  clearDeferredDragState();
});

document.addEventListener('dragend', (e) => {
  const item = e.target.closest('.deferred-item');
  if (item) item.classList.remove('dragging');
  document.querySelectorAll('.deferred-list-group.drag-over').forEach(group => {
    group.classList.remove('drag-over');
  });
});

document.addEventListener('dragover', (e) => {
  const group = e.target.closest('.deferred-list-group');
  if (!group) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  group.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  const group = e.target.closest('.deferred-list-group');
  if (!group || group.contains(e.relatedTarget)) return;
  group.classList.remove('drag-over');
});

document.addEventListener('drop', async (e) => {
  const group = e.target.closest('.deferred-list-group');
  if (!group) return;

  e.preventDefault();
  group.classList.remove('drag-over');

  const tabId = e.dataTransfer.getData('text/plain');
  const dropTarget = getDeferredDropTarget(e.clientX, e.clientY);
  if (!tabId || !dropTarget?.listId) return;

  const moved = await reorderSavedTab(tabId, dropTarget.listId, dropTarget.beforeTabId);
  if (!moved) return;

  moveDeferredItemInDom(tabId, dropTarget.group, dropTarget.beforeTabId);
  const listName = dropTarget.group.querySelector('.deferred-list-name')?.textContent || 'list';
  showToast(`Moved to ${listName}`);
});

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;

  const chip = e.target.closest('.page-chip[data-tab-id]');
  if (chip && !e.target.closest('.chip-action, button')) {
    openTabMouseDrag = {
      id: chip.dataset.tabId,
      chip,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    return;
  }

  const item = e.target.closest('.deferred-item');
  if (!item || e.target.closest('.deferred-checkbox, .deferred-dismiss, .deferred-edit-title')) return;

  savedListMouseDrag = {
    id: item.dataset.deferredId,
    item,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
  };
});

document.addEventListener('mousemove', (e) => {
  if (openTabMouseDrag) {
    const dx = Math.abs(e.clientX - openTabMouseDrag.startX);
    const dy = Math.abs(e.clientY - openTabMouseDrag.startY);
    if (!openTabMouseDrag.active && dx + dy < 8) return;

    openTabMouseDrag.active = true;
    activeOpenTabDragChip = openTabMouseDrag.chip;
    openTabMouseDrag.chip.classList.add('dragging');
    document.body.classList.add('is-dragging-open-tab');

    document.querySelectorAll('.page-chip.drag-over').forEach(chip => {
      chip.classList.remove('drag-over');
    });

    const targetChip = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page-chip[data-tab-id]');
    if (targetChip && targetChip.dataset.tabId !== openTabMouseDrag.id) {
      targetChip.classList.add('drag-over');
    }
    return;
  }

  if (!savedListMouseDrag) return;

  const dx = Math.abs(e.clientX - savedListMouseDrag.startX);
  const dy = Math.abs(e.clientY - savedListMouseDrag.startY);
  if (!savedListMouseDrag.active && dx + dy < 8) return;

  savedListMouseDrag.active = true;
  savedListMouseDrag.item.classList.add('dragging');
  document.body.classList.add('is-dragging-deferred');

  document.querySelectorAll('.deferred-list-group.drag-over').forEach(group => {
    group.classList.remove('drag-over');
  });

  const targetGroup = document.elementFromPoint(e.clientX, e.clientY)?.closest('.deferred-list-group');
  if (targetGroup) targetGroup.classList.add('drag-over');
});

document.addEventListener('mouseup', async (e) => {
  if (openTabMouseDrag) {
    const drag = openTabMouseDrag;
    clearOpenTabDragState();

    if (!drag.active) return;

    suppressNextOpenTabClick = true;
    setTimeout(() => { suppressNextOpenTabClick = false; }, 0);

    const targetChip = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page-chip[data-tab-id]');
    if (!targetChip || targetChip.dataset.tabId === drag.id) return;

    const rect = targetChip.getBoundingClientRect();
    const dropAfterTarget = e.clientY > rect.top + rect.height / 2;
    const moved = await moveOpenTabWithinSection(drag.id, targetChip.dataset.tabId, dropAfterTarget);
    if (!moved) {
      showToast('Can only reorder tabs in the same Chrome window');
      return;
    }

    moveOpenTabChipInDom(drag.id, targetChip, dropAfterTarget);
    showToast('Tab reordered');
    return;
  }

  if (!savedListMouseDrag) return;

  const drag = savedListMouseDrag;
  clearDeferredDragState();

  if (!drag.active) return;

  suppressNextDeferredClick = true;
  setTimeout(() => { suppressNextDeferredClick = false; }, 0);

  const dropTarget = getDeferredDropTarget(e.clientX, e.clientY);
  if (!dropTarget) return;

  const moved = await reorderSavedTab(drag.id, dropTarget.listId, dropTarget.beforeTabId);
  if (!moved) return;

  const listName = dropTarget.group.querySelector('.deferred-list-name')?.textContent || 'list';
  moveDeferredItemInDom(drag.id, dropTarget.group, dropTarget.beforeTabId);
  showToast(`Moved to ${listName}`);
});

window.addEventListener('blur', () => {
  clearOpenTabDragState();
  clearDeferredDragState();
});

document.addEventListener('click', (e) => {
  if (suppressNextOpenTabClick && e.target.closest('.page-chip[data-tab-id]')) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (!suppressNextDeferredClick || !e.target.closest('.deferred-item')) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.name === 'listDeleteMode') {
    const targets = document.getElementById('listDeleteTargets');
    if (targets) targets.classList.toggle('is-disabled', e.target.value !== 'move');
    return;
  }

  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
initThemeMode();
loadArchiveWhenOpened().then(renderDashboard);
dashboardRefresh.attachDashboardRefreshListeners({
  document,
  window,
  chrome,
  render: renderDashboard,
});
