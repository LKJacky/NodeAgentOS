// A node's own storage: private nodes use SQLite, shared nodes call history. Scope decides.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NodeEntry, ToolArgs } from './envelope.js';
export interface UnitContext {
  readonly tenantId: string;
  readonly nodeId: string;
  readonly home: string;
  call<T = unknown>(node: string, cap: string, args: ToolArgs): Promise<T>;
  listNodes?(): Promise<NodeEntry[]>;
}
export type UnitClass<T> = new (ctx: UnitContext, unitId: string) => T;
export interface HistoryUnit<T = unknown> {
  revision: number;
  meta: T;
  createdAt: string;
  updatedAt: string;
}
export class UnitConflictError extends Error {}
interface Backend {
  load<T>(tenant: string, unitId: string): Promise<HistoryUnit<T> | null>;
  save<T>(
    tenant: string,
    unitId: string,
    meta: T,
    expectedRevision: number,
  ): Promise<HistoryUnit<T>>;
  delete(tenant: string, unitId: string, expectedRevision: number): Promise<void>;
}
const SELECT =
  'SELECT revision, meta_json, created_at, updated_at FROM units WHERE tenant_id = ? AND unit_id = ?';
function unitOf<T>(row: Record<string, unknown> | undefined): HistoryUnit<T> | null {
  if (!row) return null;
  return {
    revision: Number(row.revision),
    meta: JSON.parse(String(row.meta_json)) as T,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

class LocalBackend implements Backend {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  #open(): DatabaseSync {
    mkdirSync(dirname(this.#path), { recursive: true });
    const db = new DatabaseSync(this.#path);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    db.exec(`CREATE TABLE IF NOT EXISTS units (
      tenant_id TEXT NOT NULL, unit_id TEXT NOT NULL, revision INTEGER NOT NULL,
      meta_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, unit_id))`);
    return db;
  }
  async load<T>(tenant: string, unitId: string): Promise<HistoryUnit<T> | null> {
    const db = this.#open();
    try {
      return unitOf<T>(
        db.prepare(SELECT).get(tenant, unitId) as Record<string, unknown> | undefined,
      );
    } finally {
      db.close();
    }
  }
  async save<T>(
    tenant: string,
    unitId: string,
    meta: T,
    expected: number,
  ): Promise<HistoryUnit<T>> {
    const value = JSON.stringify(meta)!;
    const now = new Date().toISOString();
    const db = this.#open();
    try {
      const result = expected
        ? db
            .prepare(
              'UPDATE units SET revision = revision + 1, meta_json = ?, updated_at = ? WHERE tenant_id = ? AND unit_id = ? AND revision = ?',
            )
            .run(value, now, tenant, unitId, expected)
        : db
            .prepare('INSERT OR IGNORE INTO units VALUES (?, ?, 1, ?, ?, ?)')
            .run(tenant, unitId, value, now, now);
      if (!Number(result.changes)) {
        throw new UnitConflictError(`unit ${unitId} is not at revision ${expected}`);
      }
      return unitOf<T>(
        db.prepare(SELECT).get(tenant, unitId) as Record<string, unknown> | undefined,
      )!;
    } finally {
      db.close();
    }
  }
  async delete(tenant: string, unitId: string, expected: number): Promise<void> {
    const db = this.#open();
    try {
      const result = db
        .prepare('DELETE FROM units WHERE tenant_id = ? AND unit_id = ? AND revision = ?')
        .run(tenant, unitId, expected);
      if (!Number(result.changes)) {
        throw new UnitConflictError(`unit ${unitId} is not at revision ${expected}`);
      }
    } finally {
      db.close();
    }
  }
}

class BusBackend implements Backend {
  readonly #ctx: UnitContext;
  constructor(ctx: UnitContext) {
    this.#ctx = ctx;
  }
  async load<T>(tenant: string, unitId: string): Promise<HistoryUnit<T> | null> {
    const reply = await this.#ctx.call<{ unit?: HistoryUnit<T> | null }>('history', 'load', {
      unitId,
    });
    return reply.unit ?? null;
  }
  async save<T>(
    tenant: string,
    unitId: string,
    meta: T,
    expectedRevision: number,
  ): Promise<HistoryUnit<T>> {
    const reply = await this.#ctx.call<{ unit?: HistoryUnit<T> | null }>('history', 'save', {
      unitId,
      meta,
      expectedRevision,
    });
    return reply.unit!;
  }
  async delete(tenant: string, unitId: string, expectedRevision: number): Promise<void> {
    void tenant;
    await this.#ctx.call('history', 'delete', { unitId, expectedRevision });
  }
}

async function backend(ctx: UnitContext): Promise<Backend> {
  if (typeof ctx.listNodes !== 'function')
    throw new Error(`node ${ctx.nodeId} has no bus directory`);
  const self = (await ctx.listNodes()).find((node) => node.name === ctx.nodeId);
  if (!self) throw new Error(`node ${ctx.nodeId} is not in its bus directory`);
  return self.scope === 'private'
    ? new LocalBackend(join(ctx.home, 'history.sqlite'))
    : new BusBackend(ctx);
}

export class Unit<T = unknown> {
  meta!: T;
  readonly unitId: string;
  readonly #ctx: UnitContext;
  revision = 0;
  constructor(ctx: UnitContext, unitId: string) {
    this.#ctx = ctx;
    this.unitId = unitId;
  }
  async load(): Promise<void> {
    const store = await backend(this.#ctx);
    const unit = await store.load<T>(this.#ctx.tenantId, this.unitId);
    if (unit) {
      this.meta = unit.meta;
      this.revision = unit.revision;
    }
  }
  async save(): Promise<void> {
    if (JSON.stringify(this.meta) === undefined)
      throw new Error('unit meta must be JSON serializable');
    const store = await backend(this.#ctx);
    const unit = await store.save<T>(this.#ctx.tenantId, this.unitId, this.meta, this.revision);
    this.revision = unit.revision;
  }
  async delete(): Promise<void> {
    const store = await backend(this.#ctx);
    await store.delete(this.#ctx.tenantId, this.unitId, this.revision);
    this.revision = 0;
  }
}
