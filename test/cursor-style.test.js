const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylePath = path.join(__dirname, '..', 'extension', 'style.css');

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
