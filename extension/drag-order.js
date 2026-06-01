(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.TabOutDragOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function calculateChromeMoveIndex({ draggedIndex, targetIndex, dropAfterTarget }) {
    if (!Number.isInteger(draggedIndex) || !Number.isInteger(targetIndex)) return null;

    let targetMoveIndex = targetIndex + (dropAfterTarget ? 1 : 0);
    if (draggedIndex < targetMoveIndex) targetMoveIndex -= 1;
    return Math.max(0, targetMoveIndex);
  }

  function positionDraggedId(ids = [], draggedId, beforeId = null) {
    if (!draggedId || !ids.includes(draggedId)) return ids;

    const withoutDragged = ids.filter(id => id !== draggedId);
    if (!beforeId) return [...withoutDragged, draggedId];

    const beforeIndex = withoutDragged.indexOf(beforeId);
    if (beforeIndex === -1) return [...withoutDragged, draggedId];

    return [
      ...withoutDragged.slice(0, beforeIndex),
      draggedId,
      ...withoutDragged.slice(beforeIndex),
    ];
  }

  return {
    calculateChromeMoveIndex,
    positionDraggedId,
  };
});
