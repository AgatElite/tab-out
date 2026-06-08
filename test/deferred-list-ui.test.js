const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'extension');

function readExtensionFile(fileName) {
  return fs.readFileSync(path.join(extensionDir, fileName), 'utf8');
}

function cssBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : '';
}

test('delete-list modal offers clearing tabs before the destructive delete option', () => {
  const html = readExtensionFile('index.html');
  const clearTabsIndex = html.indexOf('value="clear-tabs"');
  const deleteListIndex = html.indexOf('value="delete"');

  assert.notEqual(clearTabsIndex, -1);
  assert.ok(clearTabsIndex < deleteListIndex);
  assert.match(html, /Delete tabs, keep the list/);
});

test('saved list cards visually distinguish Inbox and separate headers from tab rows', () => {
  const app = readExtensionFile('app.js');
  const css = readExtensionFile('style.css');
  const header = cssBlock(css, '.deferred-list-header');
  const inbox = cssBlock(css, '.deferred-list-group.is-inbox');

  assert.match(app, /is-inbox/);
  assert.match(header, /border-bottom:\s*1px solid/);
  assert.match(inbox, /border-color:/);
});
