// The backend a history node keeps its units in: one contract, two implementations. SQLite on local
// disk is what a node opens when nothing says otherwise; http.ts is the client of a history server
// (history-serve) that holds the units of a whole fleet. Everything above this file — the node, the
// agents, the migrations — behaves the same whichever one is underneath: the same names, the same
// revision rule, the same two refusals, so a deployment moves between backends without learning a
// second set of answers.
//
// An answer is a value *or* a promise, because a local store has it at once and a server is a network
// away. Saying so is what keeps a node on local SQLite exactly as synchronous as it was.
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nodeAgentDir } from '@node-agent/sdk';

export { nodeAgentHome } from '@node-agent/sdk';

/** An answer that is already here (local) or still on its way (network). */
export type MaybePromise<T> = T | Promise<T>;

/** What a history node needs of a backend: four operations over units filed under
 *  `(user, calling node, unitId)`, and the revision that makes a write safe.
 *
 *  The `user` argument is the caller's namespace on a local store, which keeps several people's units
 *  in one file. A backend that authenticates (http.ts) takes the user from its credentials and drops
 *  the argument: there the token is the identity, and a caller cannot name another user at all.
 *
 *  `save` without `expectedRevision` creates the unit or replaces what it holds; with it, the write
 *  is an update of exactly that revision — a unit that is missing, or that has moved on, is refused
 *  rather than overwritten. `delete` always names a revision, so a unit cannot be dropped without
 *  having been read. `load` says `null` for a unit that is not there; a refusal is what `save` and
 *  `delete` answer with, because those are the two operations that would otherwise lose a write.
 *  `close` releases whatever the backend holds — a file handle, or nothing at all. */
export interface HistoryStore {
  load(user: string, node: string, unit: string): MaybePromise<PersistentUnit | null>;
  save(
    user: string,
    node: string,
    unit: string,
    meta: unknown,
    expectedRevision?: number,
  ): MaybePromise<PersistentUnit>;
  delete(user: string, node: string, unit: string, expectedRevision: number): MaybePromise<void>;
  list(user: string, node: string): MaybePromise<PersistentUnitSummary[]>;
  /** What this user keeps, grouped by calling node. Optional so a test double can omit it. */
  usage?(user: string): MaybePromise<HistoryUsage>;
  /** Delete every unit one calling node stored for this user, and answer how many were removed. */
  reset?(user: string, node: string): MaybePromise<number>;
  close(): void;
}

/** `save` / `delete` named a revision the unit is not at: someone else wrote first. It is its own kind
 *  of error so that a backend which has to say this over HTTP — a status code plus a message — can
 *  answer with the very error a local store throws, and so that a caller can tell a conflict from a
 *  bug without reading the message. */
export class RevisionConflictError extends Error {}

/** The unit the caller named is not there at all — the other way a write named by its revision is
 *  refused, and worth telling apart from a conflict: there is nothing to re-read and retry. */
export class UnitNotFoundError extends Error {}

/** A write would put one user over the storage ceiling the history server was given. */
export class StorageLimitError extends Error {}

const SCHEMA_VERSION = 4;

/** One unit: the value its owner put there, and the revision it is at. */
export type PersistentUnit<T = unknown> = {
  revision: number;
  meta: T;
  createdAt: string;
  updatedAt: string;
};

/** What `list` answers with: which units exist, never what they hold. */
export type PersistentUnitSummary = {
  unitId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** What one calling node has stored for a user, measured as UTF-8 JSON bytes. */
export type HistoryUsageNode = {
  node: string;
  units: number;
  bytes: number;
  /** Filled by the history node from the bus directory; absent when it cannot be read. */
  running?: boolean;
};

/** The one account a history node serves: every calling node, its unit count and its JSON bytes. */
export type HistoryUsage = {
  nodes: HistoryUsageNode[];
  units: number;
  bytes: number;
};

/** One unit as an older schema held it, with its list of messages separated from the rest. */
type LegacyUnit = {
  user: string;
  node: string;
  unit: string;
  revision: number;
  meta: unknown;
  messages: unknown[];
  createdAt: string;
  updatedAt: string;
};

export function defaultHistoryPath(): string {
  return join(nodeAgentDir('history'), 'sqlite');
}

/** A name (a user, a calling node, a unit) as every end of the wire spells it: the node refuses one
 *  it will not file, the server refuses the same one in a URL, and both say it the same way. */
export function identifier(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new Error(`${field} must be a non-empty string of at most 255 characters`);
  }
  return value;
}

/** A revision as it is written everywhere: a positive safe integer, never 0 or a float. */
export function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

/** The value of a unit as JSON. Exported because a node checks it before a byte leaves, whichever
 *  backend it is talking to, so both refuse the same values with the same wording. */
export function serializeMeta(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('undefined is not JSON');
    return json;
  } catch (error) {
    throw new Error('meta must be JSON serializable', { cause: error });
  }
}

function parseMeta(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error('invalid persisted unit meta', { cause: error });
  }
}

/** A JSON object: what every request body must be. Shared so both ends of the wire judge one the same
 *  way. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Separate an older unit's value into the part that stays and the message list that becomes a unit
 *  each. Only a `messages` key is treated this way, so every other unit carries over untouched. */
function splitMessages(data: unknown): { meta: unknown; messages: unknown[] } {
  if (!isRecord(data)) return { meta: data, messages: [] };
  const { messages, ...meta } = data;
  if (messages === undefined) return { meta: data, messages: [] };
  if (!Array.isArray(messages)) throw new Error('persisted unit has a non-array messages field');
  return { meta, messages };
}

export class SqliteHistoryStore implements HistoryStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path = defaultHistoryPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  /** Write one unit and answer with it as stored. Naming the revision you expect makes this an
   *  update of that exact revision — a unit that is missing, or has moved on, is then an error
   *  rather than an overwrite. Without it the unit is created, or replaced. */
  save(
    user: string,
    node: string,
    unit: string,
    meta: unknown,
    expectedRevision?: number,
  ): PersistentUnit {
    return this.transaction(() => {
      const now = new Date().toISOString();
      if (expectedRevision === undefined) {
        this.database
          .prepare(
            `INSERT INTO units (user_id, node_name, unit_id, revision, meta_json, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT (user_id, node_name, unit_id) DO UPDATE SET
               revision = revision + 1, meta_json = excluded.meta_json, updated_at = excluded.updated_at`,
          )
          .run(user, node, unit, serializeMeta(meta), now, now);
      } else if (expectedRevision === 0) {
        const result = this.database
          .prepare(
            `INSERT INTO units (user_id, node_name, unit_id, revision, meta_json, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT (user_id, node_name, unit_id) DO NOTHING`,
          )
          .run(user, node, unit, serializeMeta(meta), now, now);
        if (result.changes !== 1) this.throwConflict(user, node, unit, expectedRevision);
      } else {
        const result = this.database
          .prepare(
            `UPDATE units SET revision = revision + 1, meta_json = ?, updated_at = ?
             WHERE user_id = ? AND node_name = ? AND unit_id = ? AND revision = ?`,
          )
          .run(serializeMeta(meta), now, user, node, unit, expectedRevision);
        if (result.changes !== 1) this.throwConflict(user, node, unit, expectedRevision);
      }
      const saved = this.load(user, node, unit);
      if (saved === null) throw new Error('saved unit unexpectedly disappeared');
      return saved;
    });
  }

  load(user: string, node: string, unit: string): PersistentUnit | null {
    const row = this.database
      .prepare(
        `SELECT revision, meta_json, created_at, updated_at FROM units
         WHERE user_id = ? AND node_name = ? AND unit_id = ?`,
      )
      .get(user, node, unit) as
      { revision: number; meta_json: string; created_at: string; updated_at: string } | undefined;
    if (row === undefined) return null;
    return {
      revision: row.revision,
      meta: parseMeta(row.meta_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  delete(user: string, node: string, unit: string, expectedRevision: number): void {
    this.transaction(() => {
      const result = this.database
        .prepare(
          `DELETE FROM units
           WHERE user_id = ? AND node_name = ? AND unit_id = ? AND revision = ?`,
        )
        .run(user, node, unit, expectedRevision);
      if (result.changes !== 1) this.throwConflict(user, node, unit, expectedRevision);
    });
  }

  list(user: string, node: string): PersistentUnitSummary[] {
    const rows = this.database
      .prepare(
        `SELECT unit_id, revision, created_at, updated_at FROM units
         WHERE user_id = ? AND node_name = ? ORDER BY unit_id`,
      )
      .all(user, node) as unknown as {
      unit_id: string;
      revision: number;
      created_at: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      unitId: row.unit_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  usage(user: string): HistoryUsage {
    const rows = this.database
      .prepare(
        `SELECT node_name, COUNT(*) AS units, COALESCE(SUM(length(CAST(meta_json AS BLOB))), 0) AS bytes
         FROM units WHERE user_id = ? GROUP BY node_name ORDER BY node_name`,
      )
      .all(user) as unknown as { node_name: string; units: number; bytes: number }[];
    const nodes = rows.map((row) => ({
      node: row.node_name,
      units: row.units,
      bytes: row.bytes,
    }));
    return {
      nodes,
      units: nodes.reduce((total, one) => total + one.units, 0),
      bytes: nodes.reduce((total, one) => total + one.bytes, 0),
    };
  }

  reset(user: string, node: string): number {
    return this.transaction(() => {
      const result = this.database
        .prepare('DELETE FROM units WHERE user_id = ? AND node_name = ?')
        .run(user, node);
      return Number(result.changes);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private transaction<T>(run: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private throwConflict(user: string, node: string, unit: string, expected: number): never {
    const current = this.load(user, node, unit);
    if (current === null)
      throw new UnitNotFoundError(`persistent unit "${user}/${node}/${unit}" does not exist`);
    throw new RevisionConflictError(
      `persistent unit "${user}/${node}/${unit}" changed concurrently ` +
        `(expected revision ${expected}, found ${current.revision})`,
    );
  }

  /** Bring any older database to the current schema in one transaction: read the old shape into
   *  memory, replace the table, then write every unit again. */
  private migrate(): void {
    const version = (this.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `history database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`,
      );
    }
    if (version === SCHEMA_VERSION) return;

    const legacy = this.readLegacy(version);
    this.transaction(() => {
      this.database.exec(`
        DROP TABLE IF EXISTS items;
        DROP TABLE IF EXISTS messages;
        DROP TABLE IF EXISTS histories;
        DROP TABLE IF EXISTS units;
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
      const insert = this.database.prepare(
        `INSERT INTO units (user_id, node_name, unit_id, revision, meta_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of legacy) this.writeMigratedUnit(insert, entry);
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
  }

  /** A migrated unit keeps its revision and its value, and each message it used to carry becomes a
   *  unit of its own — `<unit>.0`, `<unit>.1`, … — with the count written where the list was, which
   *  is the layout the agents read and write. */
  private writeMigratedUnit(insert: ReturnType<DatabaseSync['prepare']>, entry: LegacyUnit): void {
    insert.run(
      entry.user,
      entry.node,
      entry.unit,
      entry.revision,
      serializeMeta(this.withMessageCount(entry.meta, entry.messages.length)),
      entry.createdAt,
      entry.updatedAt,
    );
    entry.messages.forEach((message, index) => {
      insert.run(
        entry.user,
        entry.node,
        `${entry.unit}.${index}`,
        1,
        serializeMeta(message),
        entry.createdAt,
        entry.updatedAt,
      );
    });
  }

  /** Only a unit whose value was a list of messages, or that had some, learns how many there are:
   *  anything else keeps its value exactly as it was. */
  private withMessageCount(meta: unknown, count: number): unknown {
    if (!isRecord(meta)) return meta;
    if (count === 0 && !('messages' in meta)) return meta;
    return { ...meta, messages: count };
  }

  private readLegacy(version: number): LegacyUnit[] {
    if (version === 1) return this.readVersion1();
    if (version === 2) return this.readVersion2();
    if (version === 3) return this.readVersion3();
    return [];
  }

  /** Schema 1 kept the agent's transcript as `histories` + `messages` rows. */
  private readVersion1(): LegacyUnit[] {
    const histories = this.database
      .prepare('SELECT user_id, usage_json, updated_at FROM histories')
      .all() as unknown as { user_id: string; usage_json: string; updated_at: string }[];
    const messages = this.database
      .prepare('SELECT user_id, sequence, payload_json FROM messages ORDER BY user_id, sequence')
      .all() as unknown as { user_id: string; sequence: number; payload_json: string }[];

    return histories.map((history) => ({
      user: history.user_id,
      node: 'agent',
      unit: 'conversation',
      revision: 1,
      meta: { usage: parseMeta(history.usage_json) },
      messages: messages
        .filter((entry) => entry.user_id === history.user_id)
        .map((entry, index) => {
          if (entry.sequence !== index) {
            throw new Error(`persisted history for user "${history.user_id}" has a sequence gap`);
          }
          return parseMeta(entry.payload_json);
        }),
      createdAt: history.updated_at,
      updatedAt: history.updated_at,
    }));
  }

  /** Schema 2 kept one JSON blob per unit, with the transcript under a `messages` key. */
  private readVersion2(): LegacyUnit[] {
    const rows = this.database
      .prepare(
        `SELECT user_id, node_name, unit_id, revision, data_json, created_at, updated_at FROM units`,
      )
      .all() as unknown as {
      user_id: string;
      node_name: string;
      unit_id: string;
      revision: number;
      data_json: string;
      created_at: string;
      updated_at: string;
    }[];

    return rows.map((row) => {
      const { meta, messages } = splitMessages(parseMeta(row.data_json));
      return {
        user: row.user_id,
        node: row.node_name,
        unit: row.unit_id,
        revision: row.revision,
        meta,
        messages,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  /** Schema 3 kept the messages as rows of their own in an `items` table. */
  private readVersion3(): LegacyUnit[] {
    const rows = this.database
      .prepare(
        `SELECT user_id, node_name, unit_id, revision, meta_json, created_at, updated_at FROM units`,
      )
      .all() as unknown as {
      user_id: string;
      node_name: string;
      unit_id: string;
      revision: number;
      meta_json: string;
      created_at: string;
      updated_at: string;
    }[];
    const items = this.database.prepare(
      `SELECT item_json FROM items WHERE user_id = ? AND node_name = ? AND unit_id = ? ORDER BY seq`,
    );

    return rows.map((row) => ({
      user: row.user_id,
      node: row.node_name,
      unit: row.unit_id,
      revision: row.revision,
      meta: parseMeta(row.meta_json),
      messages: (
        items.all(row.user_id, row.node_name, row.unit_id) as unknown as {
          item_json: string;
        }[]
      ).map((item) => parseMeta(item.item_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
