// The rename from `memory` to `notes` leaves the memos written before it filed under the old node
// name, and the history node files units by the name of the node that wrote them — so they are not
// something the renamed node can read, and they are what the copy script is for. What it promises is
// what this file checks: same ids, same revisions, same values, nothing overwritten, nothing lost,
// and a second run that does nothing.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { copyMemos, historyPath } from '../scripts/migrate-memos-from-memory.mjs';

/** The history store's own table, so a unit written here is the shape the store reads. */
function unitsTable(database) {
  database.exec(`
    CREATE TABLE units (
      user_id TEXT NOT NULL,
      node_name TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      meta_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, node_name, unit_id)
    ) STRICT;
  `);
}

function write(database, user, node, unit, revision, meta) {
  database
    .prepare(
      `INSERT INTO units (user_id, node_name, unit_id, revision, meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(user, node, unit, revision, JSON.stringify(meta), '2026-01-01', '2026-01-02');
}

function units(database, node) {
  return database
    .prepare(
      `SELECT user_id, unit_id, revision, meta_json, created_at, updated_at FROM units
       WHERE node_name = ? ORDER BY user_id, unit_id`,
    )
    .all(node)
    .map((row) => ({ ...row }));
}

/** The memos the old node left behind: the index, and two documents under it. */
function oldStore() {
  const database = new DatabaseSync(':memory:');
  unitsTable(database);
  write(database, 'default', 'memory', 'memos', 4, { ids: [1, 2], nextId: 3 });
  write(database, 'default', 'memory', 'memos.1', 2, { id: 1, title: 'kept', text: 'body' });
  write(database, 'default', 'memory', 'memos.2', 1, { id: 2, title: 'also', text: '' });
  return database;
}

test('the old memos arrive under notes with their ids, revisions and values', () => {
  const database = oldStore();

  const result = copyMemos(database);

  assert.equal(result.found, 3);
  assert.equal(result.copied, 3);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(
    units(database, 'notes').map(({ unit_id, revision }) => [unit_id, revision]),
    [
      ['memos', 4],
      ['memos.1', 2],
      ['memos.2', 1],
    ],
    'the index and one unit per memo, at the revisions they had',
  );
  assert.deepEqual(
    units(database, 'notes')[1],
    units(database, 'memory')[1],
    'a copied unit is the old one, value and timestamps included',
  );
});

test('the memory units stay where they are, so a downgrade still finds them', () => {
  const database = oldStore();
  const before = units(database, 'memory');

  copyMemos(database);

  assert.deepEqual(units(database, 'memory'), before, 'nothing under the old name is touched');
});

test('a second run copies nothing', () => {
  const database = oldStore();
  copyMemos(database);

  const again = copyMemos(database);

  assert.equal(again.copied, 0);
  assert.equal(again.kept.length, 3, 'every unit is already there under notes');
  assert.equal(units(database, 'notes').length, 3, 'and the copy did not double up');
});

test('a unit notes already holds is left alone, not overwritten', () => {
  const database = oldStore();
  // The notes node has been writing: its own index says nextId 9.
  write(database, 'default', 'notes', 'memos', 7, { ids: [1, 2, 8], nextId: 9 });

  const result = copyMemos(database);

  assert.equal(result.copied, 2);
  assert.deepEqual(result.kept, [{ user: 'default', unit: 'memos' }]);
  assert.deepEqual(units(database, 'notes').find(({ unit_id }) => unit_id === 'memos'), {
    user_id: 'default',
    unit_id: 'memos',
    revision: 7,
    meta_json: JSON.stringify({ ids: [1, 2, 8], nextId: 9 }),
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
  });
});

test('a dry run says what it would do and writes nothing', () => {
  const database = oldStore();

  const result = copyMemos(database, { dryRun: true });

  assert.equal(result.copied, 3);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(units(database, 'notes'), [], 'the transaction was rolled back');
});

test('every user is migrated, and only from the old node name', () => {
  const database = oldStore();
  write(database, 'alice', 'memory', 'memos', 1, { ids: [], nextId: 1 });
  write(database, 'alice', 'agent', 'conversation', 1, { usage: {} });

  const result = copyMemos(database);

  assert.equal(result.found, 4, 'three for default, one for alice');
  assert.deepEqual(
    units(database, 'notes').map(({ user_id, unit_id }) => [user_id, unit_id]),
    [
      ['alice', 'memos'],
      ['default', 'memos'],
      ['default', 'memos.1'],
      ['default', 'memos.2'],
    ],
  );
  assert.deepEqual(
    units(database, 'agent'),
    [{ user_id: 'alice', unit_id: 'conversation', revision: 1, meta_json: '{"usage":{}}', created_at: '2026-01-01', updated_at: '2026-01-02' }],
    "another node's units are not a source",
  );
});

test('the database path is the store’s own: the home, then the default', () => {
  assert.equal(historyPath({ NODE_AGENT_HOME: '/srv/home' }), '/srv/home/history/sqlite');
  assert.match(historyPath({}), /[\\/]\.node_agent[\\/]history[\\/]sqlite$/);
});
