const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_DEFERRED_LIST_ID,
  createDeferredList,
  normalizeDeferredLists,
  groupDeferredTabsByList,
  moveDeferredTabToList,
  reorderDeferredTab,
  deleteDeferredList,
  restoreArchivedDeferredTab,
  deleteArchivedDeferredTab,
  renameDeferredList,
  updateDeferredTabTitle,
  bulkUpdateDeferredTabs,
} = require('../extension/deferred-lists.js');

test('normalizes saved lists with Inbox first', () => {
  const lists = normalizeDeferredLists([
    { id: 'reading', name: 'Reading' },
    { id: DEFAULT_DEFERRED_LIST_ID, name: 'Later' },
  ]);

  assert.deepEqual(lists.map(list => list.id), [DEFAULT_DEFERRED_LIST_ID, 'reading']);
  assert.equal(lists[0].name, 'Inbox');
});

test('creates a named list with a stable slug id', () => {
  const list = createDeferredList('Weekend Reading', '2026-05-28T12:00:00.000Z');

  assert.deepEqual(list, {
    id: 'list-weekend-reading',
    name: 'Weekend Reading',
    createdAt: '2026-05-28T12:00:00.000Z',
  });
});

test('groups existing unassigned tabs into Inbox', () => {
  const groups = groupDeferredTabsByList(
    [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', listId: 'research' }],
    [{ id: 'research', name: 'Research' }],
  );

  assert.deepEqual(
    groups.map(group => [group.list.id, group.items.map(item => item.id)]),
    [
      [DEFAULT_DEFERRED_LIST_ID, ['a']],
      ['research', ['b']],
    ],
  );
});

test('moves a saved tab to a different list without mutating other tabs', () => {
  const deferred = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B', listId: 'research' },
  ];

  assert.deepEqual(moveDeferredTabToList(deferred, 'a', 'research'), [
    { id: 'a', title: 'A', listId: 'research' },
    { id: 'b', title: 'B', listId: 'research' },
  ]);
});

test('reorders a saved tab before another tab in the same list', () => {
  const deferred = [
    { id: 'a', listId: 'inbox' },
    { id: 'b', listId: 'inbox' },
    { id: 'c', listId: 'inbox' },
  ];

  assert.deepEqual(reorderDeferredTab(deferred, 'c', 'inbox', 'a'), [
    { id: 'c', listId: 'inbox' },
    { id: 'a', listId: 'inbox' },
    { id: 'b', listId: 'inbox' },
  ]);
});

test('reorders a saved tab into another list before a target item', () => {
  const deferred = [
    { id: 'a', listId: 'inbox' },
    { id: 'b', listId: 'list-reading' },
    { id: 'c', listId: 'list-reading' },
  ];

  assert.deepEqual(reorderDeferredTab(deferred, 'a', 'list-reading', 'c'), [
    { id: 'b', listId: 'list-reading' },
    { id: 'a', listId: 'list-reading' },
    { id: 'c', listId: 'list-reading' },
  ]);
});

test('deletes a list and archives its active saved tabs', () => {
  const deferred = [
    { id: 'a', title: 'A', listId: 'list-work', completed: false },
    { id: 'b', title: 'B', listId: 'list-reading', completed: false },
  ];
  const lists = [
    { id: 'list-work', name: 'Work' },
    { id: 'list-reading', name: 'Reading' },
  ];

  const result = deleteDeferredList({
    deferred,
    lists,
    listId: 'list-work',
    mode: 'delete',
    now: '2026-05-28T12:00:00.000Z',
  });

  assert.deepEqual(result.lists.map(list => list.id), ['list-reading']);
  assert.deepEqual(result.deferred, [
    {
      id: 'a',
      title: 'A',
      listId: 'list-work',
      completed: true,
      completedAt: '2026-05-28T12:00:00.000Z',
      dismissed: false,
      archivedFromListId: 'list-work',
      archivedFromListName: 'Work',
    },
    { id: 'b', title: 'B', listId: 'list-reading', completed: false },
  ]);
});

test('archives active saved tabs from a list without deleting the list', () => {
  const deferred = [
    { id: 'a', title: 'A', listId: 'list-work', completed: false },
    { id: 'b', title: 'B', listId: 'list-work', completed: true },
    { id: 'c', title: 'C', listId: 'list-reading', completed: false },
  ];
  const lists = [
    { id: 'list-work', name: 'Work' },
    { id: 'list-reading', name: 'Reading' },
  ];

  const result = deleteDeferredList({
    deferred,
    lists,
    listId: 'list-work',
    mode: 'clear-tabs',
    now: '2026-05-28T12:00:00.000Z',
  });

  assert.deepEqual(result.lists.map(list => list.id), ['list-work', 'list-reading']);
  assert.deepEqual(result.deferred, [
    {
      id: 'a',
      title: 'A',
      listId: 'list-work',
      completed: true,
      completedAt: '2026-05-28T12:00:00.000Z',
      dismissed: false,
      archivedFromListId: 'list-work',
      archivedFromListName: 'Work',
    },
    { id: 'b', title: 'B', listId: 'list-work', completed: true },
    { id: 'c', title: 'C', listId: 'list-reading', completed: false },
  ]);
});

test('deletes a list and moves its tabs to a selected list', () => {
  const deferred = [
    { id: 'a', title: 'A', listId: 'list-work', completed: false },
    { id: 'b', title: 'B', listId: 'list-reading', completed: false },
  ];
  const lists = [
    { id: 'list-work', name: 'Work' },
    { id: 'list-reading', name: 'Reading' },
  ];

  const result = deleteDeferredList({
    deferred,
    lists,
    listId: 'list-work',
    mode: 'move',
    targetListId: 'list-reading',
  });

  assert.deepEqual(result.lists.map(list => list.id), ['list-reading']);
  assert.deepEqual(result.deferred, [
    { id: 'a', title: 'A', listId: 'list-reading', completed: false },
    { id: 'b', title: 'B', listId: 'list-reading', completed: false },
  ]);
});

test('renames a non-default list', () => {
  const lists = [
    { id: 'list-work', name: 'Work' },
    { id: DEFAULT_DEFERRED_LIST_ID, name: 'Inbox' },
  ];

  assert.deepEqual(renameDeferredList(lists, 'list-work', 'Deep Work'), [
    { id: 'list-work', name: 'Deep Work' },
    { id: DEFAULT_DEFERRED_LIST_ID, name: 'Inbox' },
  ]);
});

test('does not rename Inbox', () => {
  const lists = [{ id: DEFAULT_DEFERRED_LIST_ID, name: 'Inbox' }];

  assert.deepEqual(renameDeferredList(lists, DEFAULT_DEFERRED_LIST_ID, 'Later'), lists);
});

test('updates a saved tab title', () => {
  const deferred = [
    { id: 'a', title: 'Old title', url: 'https://example.com' },
    { id: 'b', title: 'Another title', url: 'https://example.org' },
  ];

  assert.deepEqual(updateDeferredTabTitle(deferred, 'a', 'New title'), [
    { id: 'a', title: 'New title', url: 'https://example.com' },
    { id: 'b', title: 'Another title', url: 'https://example.org' },
  ]);
});

test('archives selected saved tabs in bulk', () => {
  const deferred = [
    { id: 'a', listId: 'list-work', completed: false },
    { id: 'b', listId: 'list-reading', completed: false },
  ];
  const lists = [
    { id: 'list-work', name: 'Work' },
    { id: 'list-reading', name: 'Reading' },
  ];
  const updated = bulkUpdateDeferredTabs(deferred, ['a'], 'archive', undefined, '2026-05-28T12:00:00.000Z', lists);

  assert.deepEqual(updated, [
    {
      id: 'a',
      listId: 'list-work',
      completed: true,
      completedAt: '2026-05-28T12:00:00.000Z',
      dismissed: false,
      archivedFromListId: 'list-work',
      archivedFromListName: 'Work',
    },
    { id: 'b', listId: 'list-reading', completed: false },
  ]);
});

test('restores archived tabs to their original list when it still exists with the same name', () => {
  const deferred = [
    {
      id: 'a',
      listId: 'list-work',
      completed: true,
      completedAt: '2026-05-28T12:00:00.000Z',
      archivedFromListId: 'list-work',
      archivedFromListName: 'Work',
    },
  ];
  const lists = [{ id: 'list-work', name: 'Work' }];

  assert.deepEqual(restoreArchivedDeferredTab(deferred, lists, 'a'), [
    { id: 'a', listId: 'list-work', completed: false, dismissed: false },
  ]);
});

test('restores archived tabs to Inbox when the original list is missing or renamed', () => {
  const deferred = [
    {
      id: 'a',
      listId: 'list-work',
      completed: true,
      archivedFromListId: 'list-work',
      archivedFromListName: 'Work',
    },
    {
      id: 'b',
      listId: 'list-old',
      completed: true,
      archivedFromListId: 'list-old',
      archivedFromListName: 'Old',
    },
  ];
  const lists = [{ id: 'list-work', name: 'Renamed Work' }];

  assert.deepEqual(restoreArchivedDeferredTab(deferred, lists, 'a'), [
    {
      id: 'b',
      listId: 'list-old',
      completed: true,
      archivedFromListId: 'list-old',
      archivedFromListName: 'Old',
    },
    { id: 'a', listId: DEFAULT_DEFERRED_LIST_ID, completed: false, dismissed: false },
  ]);

  assert.deepEqual(restoreArchivedDeferredTab(deferred, lists, 'b'), [
    {
      id: 'a',
      listId: 'list-work',
      completed: true,
      archivedFromListId: 'list-work',
      archivedFromListName: 'Work',
    },
    { id: 'b', listId: DEFAULT_DEFERRED_LIST_ID, completed: false, dismissed: false },
  ]);
});

test('restores archived tabs to a selected target list when dragged there', () => {
  const deferred = [
    { id: 'a', listId: 'list-work', completed: true, completedAt: '2026-05-28T12:00:00.000Z' },
    { id: 'b', listId: 'list-reading', completed: false },
  ];
  const lists = [
    { id: 'list-work', name: 'Work' },
    { id: 'list-reading', name: 'Reading' },
  ];

  assert.deepEqual(restoreArchivedDeferredTab(deferred, lists, 'a', 'list-reading', 'b'), [
    { id: 'a', listId: 'list-reading', completed: false, dismissed: false },
    { id: 'b', listId: 'list-reading', completed: false },
  ]);
});

test('deletes only archived tabs permanently', () => {
  const deferred = [
    { id: 'a', completed: true, dismissed: false },
    { id: 'b', completed: false, dismissed: false },
  ];

  assert.deepEqual(deleteArchivedDeferredTab(deferred, 'a'), [
    { id: 'a', completed: true, dismissed: true },
    { id: 'b', completed: false, dismissed: false },
  ]);

  assert.deepEqual(deleteArchivedDeferredTab(deferred, 'b'), deferred);
});

test('moves selected saved tabs in bulk', () => {
  const deferred = [
    { id: 'a', listId: 'inbox' },
    { id: 'b', listId: 'list-work' },
  ];

  assert.deepEqual(bulkUpdateDeferredTabs(deferred, ['a', 'b'], 'move', 'list-reading'), [
    { id: 'a', listId: 'list-reading' },
    { id: 'b', listId: 'list-reading' },
  ]);
});

test('bulk delete only permanently deletes archived tabs', () => {
  const deferred = [
    { id: 'a', completed: false, dismissed: false },
    { id: 'b', completed: true, dismissed: false },
  ];

  assert.deepEqual(bulkUpdateDeferredTabs(deferred, ['a', 'b'], 'delete'), [
    { id: 'a', completed: false, dismissed: false },
    { id: 'b', completed: true, dismissed: true },
  ]);
});
