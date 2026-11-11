// The shared placement: the bus's history, one unit holding every row.
//
// This is the store behind `provider` - the node a whole bus may use, whose rows are the bus's own
// business. It carries two things the other store has no use for: the revision a save is written
// against, and the fallback for a bus that has no history node at all, where the rows live in this
// process and nowhere else (the page then says `persistent: false`, which is the truth).
import type { NodeContext } from '@node-agent/sdk';
import type { JsonObject } from '../providers/base.js';
import { type ProviderRows, type ProviderStore, rowsIn } from './index.js';

const HISTORY_KEY = 'providers';

/** Rows saved while the bus has no history node. One process is one lifetime. */
const ephemeral = new Map<string, { rows: ProviderRows; revision: number | null }>();

export class HistoryStore implements ProviderStore {
  readonly ctx: NodeContext;
  revision: number | null = null;
  persistent = false;

  constructor(ctx: NodeContext) {
    this.ctx = ctx;
  }

  private get tenant(): string {
    return this.ctx.tenantId || 'default';
  }

  async read(): Promise<ProviderRows | null> {
    try {
      const reply = await this.ctx.call<{ unit?: JsonObject | null }>('history', 'load', {
        unitId: HISTORY_KEY,
      });
      this.persistent = true;
      const unit = reply.unit ?? null;
      if (unit === null) return null;
      const rows = rowsIn((unit.meta as JsonObject | undefined)?.providers);
      this.revision = typeof unit.revision === 'number' ? unit.revision : null;
      return Object.keys(rows).length > 0 ? rows : null;
    } catch {
      // No history on this bus (or no unit yet): this process keeps the rows instead.
      this.persistent = false;
      const local = ephemeral.get(this.tenant);
      this.revision = local?.revision ?? null;
      return local && Object.keys(local.rows).length > 0 ? local.rows : null;
    }
  }

  async write(rows: ProviderRows): Promise<void> {
    if (!this.persistent) {
      ephemeral.set(this.tenant, { rows, revision: this.revision });
      return;
    }
    const request: JsonObject = { unitId: HISTORY_KEY, meta: { providers: rows } };
    if (this.revision !== null) request.expectedRevision = this.revision;
    const reply = await this.ctx.call<{ unit?: { revision?: unknown } }>(
      'history',
      'save',
      request,
    );
    const revision = reply.unit?.revision;
    if (typeof revision === 'number') this.revision = revision;
  }
}
