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

test('deletes a list and its active saved tabs', () => {
  const deferred = [
    { id: 'a', title: 'A', listId: 'list-work', completed: false },
    { id: 'b', title: 'B', listId: 'list-reading', completed: false },
  ];
  const lists = [
    { id: 'list-work', name: 'Work' },
    { id: 'list-reading', name: 'Reading' },
  ];

  const result = deleteDeferredList({ deferred, lists, listId: 'list-work', mode: 'delete' });

  assert.deepEqual(result.lists.map(list => list.id), ['list-reading']);
  assert.deepEqual(result.deferred, [
    { id: 'a', title: 'A', listId: 'list-work', completed: false, dismissed: true },
    { id: 'b', title: 'B', listId: 'list-reading', completed: false },
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
    { id: 'a', completed: false },
    { id: 'b', completed: false },
  ];
  const updated = bulkUpdateDeferredTabs(deferred, ['a'], 'archive', undefined, '2026-05-28T12:00:00.000Z');

  assert.deepEqual(updated, [
    { id: 'a', completed: true, completedAt: '2026-05-28T12:00:00.000Z' },
    { id: 'b', completed: false },
  ]);
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

test('deletes selected saved tabs in bulk', () => {
  const deferred = [
    { id: 'a', dismissed: false },
    { id: 'b', dismissed: false },
  ];

  assert.deepEqual(bulkUpdateDeferredTabs(deferred, ['b'], 'delete'), [
    { id: 'a', dismissed: false },
    { id: 'b', dismissed: true },
  ]);
});
