const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateChromeMoveIndex,
  positionDraggedId,
} = require('../extension/drag-order.js');

test('calculates Chrome tab move index when moving downward', () => {
  assert.equal(calculateChromeMoveIndex({
    draggedIndex: 1,
    targetIndex: 4,
    dropAfterTarget: true,
  }), 4);
});

test('calculates Chrome tab move index when moving upward before target', () => {
  assert.equal(calculateChromeMoveIndex({
    draggedIndex: 4,
    targetIndex: 1,
    dropAfterTarget: false,
  }), 1);
});

test('positions dragged id before a target id', () => {
  assert.deepEqual(positionDraggedId(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
});

test('positions dragged id at the end when there is no target id', () => {
  assert.deepEqual(positionDraggedId(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
});
