const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylePath = path.join(__dirname, '..', 'extension', 'style.css');
const appPath = path.join(__dirname, '..', 'extension', 'app.js');

function cssBlock(selector) {
  const css = fs.readFileSync(stylePath, 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : '';
}

test('open tab drag styles do not use closed-hand cursor', () => {
  const draggedChip = cssBlock('.page-chip.dragging');
  const draggingBody = cssBlock('body.is-dragging-open-tab,\nbody.is-dragging-open-tab *');

  assert.doesNotMatch(draggedChip, /cursor:\s*grabbing\b/);
  assert.doesNotMatch(draggingBody, /cursor:\s*grabbing\b/);
});

test('saved tab drag styles do not use hand cursors', () => {
  const savedItem = cssBlock('.deferred-item');
  const draggedItem = cssBlock('.deferred-item.dragging');
  const draggingBody = cssBlock('body.is-dragging-deferred,\nbody.is-dragging-deferred *');

  assert.doesNotMatch(savedItem, /cursor:\s*grab(?:bing)?\b/);
  assert.doesNotMatch(draggedItem, /cursor:\s*grab(?:bing)?\b/);
  assert.doesNotMatch(draggingBody, /cursor:\s*grab(?:bing)?\b/);
});

test('saved tab rows do not opt into native browser dragging', () => {
  const app = fs.readFileSync(appPath, 'utf8');

  assert.doesNotMatch(app, /class="deferred-item"[^`]*draggable="true"/);
});
