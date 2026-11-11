#!/usr/bin/env node
// Carry the memos of the `memory` node over to the `notes` node it was renamed to.
//
// The history node files every unit under the name of the node that wrote it, and the notes node
// reads its own name — correctly: one node's units are not another node's to read (that is what
// keeps a transcript, a key or a settings file out of a stranger's reach). So the memos written
// before the rename, filed under `memory` (`memos` for the index, one `memos.<id>` per memo), are
// not something the renamed node can pick up by itself. This copies them across, once:
//
//   * the unit ids are kept exactly (`memos`, `memos.1`, …), as are the revision and the value — so
//     the notes node reads them as its own store, and a document's revision still means what it
//     meant (a tab holding revision 3 is still at revision 3);
//   * a unit `notes` already holds is left untouched: a store that has been running is never
//     overwritten by an older copy;
//   * the `memory` units are not deleted — running this twice is harmless, and going back to the
//     old node still finds its data.
//
// It opens the SQLite file the history node keeps its units in, so it has to run where that file is
// (a deployment whose history is a server copies them on the server instead). Stop the stack first:
//
//   node node_agent/nodes/notes/scripts/migrate-memos-from-memory.mjs [path] [--dry-run]
//
// `path` defaults to $NODE_AGENT_HOME/history/sqlite, then ~/.node_agent/history/sqlite —
// the same file node-agent-history resolves its own store to.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

/** The node name the memos were filed under, and the one they are filed under now. */
const FROM = 'memory';
const TO = 'notes';

/** Where the local history store is, by the same rules the store itself uses. */
export function historyPath(env = process.env) {
  const home = env.NODE_AGENT_HOME?.trim() || join(homedir(), '.node_agent');
  return join(home, 'history', 'sqlite');
}

/**
 * Copy every unit `from` wrote to `to`, and answer what happened: `copied` units were written,
 * `kept` ones were already there under the new name (left as they are), `found` is how many the old
 * name holds at all. `dryRun` goes through the same statements and rolls back, so a trial run says
 * exactly what the real one would do.
 */
export function copyMemos(database, { from = FROM, to = TO, dryRun = false } = {}) {
  const rows = database
    .prepare(
      `SELECT user_id, unit_id, revision, meta_json, created_at, updated_at FROM units
       WHERE node_name = ? ORDER BY user_id, unit_id`,
    )
    .all(from);
  const present = database.prepare(
    'SELECT 1 AS there FROM units WHERE user_id = ? AND node_name = ? AND unit_id = ?',
  );
  const insert = database.prepare(
    `INSERT INTO units (user_id, node_name, unit_id, revision, meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const kept = [];
  let copied = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (present.get(row.user_id, to, row.unit_id) !== undefined) {
        kept.push({ user: row.user_id, unit: row.unit_id });
        continue;
      }
      insert.run(
        row.user_id,
        to,
        row.unit_id,
        row.revision,
        row.meta_json,
        row.created_at,
        row.updated_at,
      );
      copied += 1;
    }
    database.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return { from, to, found: rows.length, copied, kept, dryRun };
}

function main(argv) {
  const options = argv.filter((value) => value.startsWith('--'));
  const [named] = argv.filter((value) => !value.startsWith('--'));
  const unknown = options.filter((value) => value !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`unknown option: ${unknown[0]} (only --dry-run is understood)`);
    process.exitCode = 2;
    return;
  }

  const dryRun = options.includes('--dry-run');
  const path = named ?? historyPath();
  if (!existsSync(path)) {
    console.error(`no history database at ${path}: there is nothing to migrate`);
    process.exitCode = 1;
    return;
  }

  const database = new DatabaseSync(path);
  try {
    const table = database
      .prepare("SELECT 1 AS there FROM sqlite_master WHERE type = 'table' AND name = 'units'")
      .get();
    if (table === undefined)
      throw new Error(`${path} has no units table: is it the history database?`);

    const result = copyMemos(database, { dryRun });
    if (result.found === 0) {
      console.log(`no memos filed under "${FROM}": nothing to migrate`);
      return;
    }
    console.log(
      `${dryRun ? 'would copy' : 'copied'} ${result.copied} of ${result.found} unit(s) ` +
        `from "${FROM}" to "${TO}" in ${path}`,
    );
    if (result.kept.length > 0) {
      const which = result.kept.map(({ user, unit }) => `${user}/${unit}`).join(', ');
      console.log(`already there under "${TO}", left as they are: ${which}`);
    }
    console.log(
      `the "${FROM}" units are untouched: this is safe to run again, and the old node still finds them`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
