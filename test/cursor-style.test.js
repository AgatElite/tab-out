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

test('open tab rows use pointer normally and grabbing only while actively dragging', () => {
  const openTab = cssBlock('.page-chip.clickable');
  const draggedChip = cssBlock('.page-chip.dragging');
  const draggingBody = cssBlock('body.is-dragging-open-tab,\nbody.is-dragging-open-tab *');

  assert.match(openTab, /cursor:\s*pointer\b/);
  assert.match(draggedChip, /cursor:\s*grabbing\b/);
  assert.match(draggingBody, /cursor:\s*grabbing\b/);
});

test('saved tab rows use pointer normally and grabbing only while actively dragging', () => {
  const savedItem = cssBlock('.deferred-item');
  const draggedItem = cssBlock('.deferred-item.dragging');
  const draggingBody = cssBlock('body.is-dragging-deferred,\nbody.is-dragging-deferred *');

  assert.match(savedItem, /cursor:\s*pointer\b/);
  assert.match(draggedItem, /cursor:\s*grabbing\b/);
  assert.match(draggingBody, /cursor:\s*grabbing\b/);
});

test('saved tab rows do not opt into native browser dragging', () => {
  const app = fs.readFileSync(appPath, 'utf8');

  assert.doesNotMatch(app, /class="deferred-item"[^`]*draggable="true"/);
});
