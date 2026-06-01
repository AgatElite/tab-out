(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.TabOutDeferredLists = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_DEFERRED_LIST_ID = 'inbox';
  const DEFAULT_DEFERRED_LIST = {
    id: DEFAULT_DEFERRED_LIST_ID,
    name: 'Inbox',
    isDefault: true,
  };

  function slugifyListName(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'list';
  }

  function createDeferredList(name, createdAt = new Date().toISOString()) {
    const trimmedName = String(name || '').trim();
    return {
      id: `list-${slugifyListName(trimmedName)}`,
      name: trimmedName,
      createdAt,
    };
  }

  function normalizeDeferredLists(lists = []) {
    const seen = new Set([DEFAULT_DEFERRED_LIST_ID]);
    const normalized = [{ ...DEFAULT_DEFERRED_LIST }];

    for (const list of lists) {
      if (!list || !list.id || list.id === DEFAULT_DEFERRED_LIST_ID || seen.has(list.id)) continue;
      const name = String(list.name || '').trim();
      if (!name) continue;
      seen.add(list.id);
      normalized.push({ ...list, name });
    }

    return normalized;
  }

  function groupDeferredTabsByList(activeTabs = [], lists = []) {
    const normalizedLists = normalizeDeferredLists(lists);
    const knownListIds = new Set(normalizedLists.map(list => list.id));
    const groups = normalizedLists.map(list => ({ list, items: [] }));
    const groupById = Object.fromEntries(groups.map(group => [group.list.id, group]));

    for (const tab of activeTabs) {
      const listId = knownListIds.has(tab.listId) ? tab.listId : DEFAULT_DEFERRED_LIST_ID;
      groupById[listId].items.push(tab);
    }

    return groups;
  }

  function moveDeferredTabToList(deferred = [], tabId, listId) {
    return deferred.map(tab => {
      if (tab.id !== tabId) return tab;
      return { ...tab, listId };
    });
  }

  function reorderDeferredTab(deferred = [], tabId, listId, beforeTabId = null) {
    const moving = deferred.find(tab => tab.id === tabId);
    if (!moving || !listId) return deferred;

    const withoutMoving = deferred.filter(tab => tab.id !== tabId);
    const moved = { ...moving, listId };
    const beforeIndex = beforeTabId
      ? withoutMoving.findIndex(tab => tab.id === beforeTabId)
      : -1;

    if (beforeIndex === -1) return [...withoutMoving, moved];

    return [
      ...withoutMoving.slice(0, beforeIndex),
      moved,
      ...withoutMoving.slice(beforeIndex),
    ];
  }

  function deleteDeferredList({
    deferred = [],
    lists = [],
    listId,
    mode,
    targetListId,
  }) {
    if (!listId || listId === DEFAULT_DEFERRED_LIST_ID) {
      return { deferred, lists };
    }

    const normalizedLists = normalizeDeferredLists(lists);
    const knownListIds = new Set(normalizedLists.map(list => list.id));
    const canMove = mode === 'move' && targetListId && targetListId !== listId && knownListIds.has(targetListId);
    const nextLists = lists.filter(list => list.id !== listId);
    const nextDeferred = deferred.map(tab => {
      if (tab.listId !== listId) return tab;
      if (canMove) return { ...tab, listId: targetListId };
      if (tab.completed) return tab;
      return { ...tab, dismissed: true };
    });

    return { deferred: nextDeferred, lists: nextLists };
  }

  function renameDeferredList(lists = [], listId, name) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName || listId === DEFAULT_DEFERRED_LIST_ID) return lists;

    return lists.map(list => {
      if (list.id !== listId) return list;
      return { ...list, name: trimmedName };
    });
  }

  function updateDeferredTabTitle(deferred = [], tabId, title) {
    const trimmedTitle = String(title || '').trim();
    if (!trimmedTitle) return deferred;

    return deferred.map(tab => {
      if (tab.id !== tabId) return tab;
      return { ...tab, title: trimmedTitle };
    });
  }

  function bulkUpdateDeferredTabs(deferred = [], tabIds = [], action, targetListId, now = new Date().toISOString()) {
    const selectedIds = new Set(tabIds);
    if (selectedIds.size === 0) return deferred;

    return deferred.map(tab => {
      if (!selectedIds.has(tab.id)) return tab;
      if (action === 'archive') return { ...tab, completed: true, completedAt: now };
      if (action === 'move' && targetListId) return { ...tab, listId: targetListId };
      if (action === 'delete') return { ...tab, dismissed: true };
      return tab;
    });
  }

  return {
    DEFAULT_DEFERRED_LIST_ID,
    DEFAULT_DEFERRED_LIST,
    createDeferredList,
    normalizeDeferredLists,
    groupDeferredTabsByList,
    moveDeferredTabToList,
    reorderDeferredTab,
    deleteDeferredList,
    renameDeferredList,
    updateDeferredTabTitle,
    bulkUpdateDeferredTabs,
  };
});
