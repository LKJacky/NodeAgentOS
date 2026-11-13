// The history node: durable units for every node on the bus, filed under the calling tenant and the
// caller's node name. Where units live is a setting; whose they are is the bus tenant, never a field
// in the request. A local SQLite store uses the tenant as its namespace; an HTTP store gets one client
// per tenant, and that tenant's token is its bearer.
import { readFileSync } from 'node:fs';
import { Node, type NodeContext, type NodeHandlers, type ToolArgs } from '@node-agent/sdk';
import {
  SqliteHistoryStore,
  defaultHistoryPath,
  identifier,
  positiveInteger,
  serializeMeta,
  type HistoryStore,
  type HistoryUsage,
  type MaybePromise,
} from './store.js';

export {
  RevisionConflictError,
  SqliteHistoryStore,
  StorageLimitError,
  UnitNotFoundError,
  defaultHistoryPath,
  nodeAgentHome,
  identifier,
  isRecord,
  positiveInteger,
  serializeMeta,
} from './store.js';
export type {
  HistoryStore,
  HistoryUsage,
  HistoryUsageNode,
  MaybePromise,
  PersistentUnit,
  PersistentUnitSummary,
} from './store.js';

export const DEFAULT_HISTORY_USER = 'default';

/** The one capability whose answer is the history page itself. */
const PANEL = 'ui';
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

export function defaultHistoryUser(): string {
  return process.env.NODE_AGENT_HISTORY_USER?.trim() || DEFAULT_HISTORY_USER;
}

export function defaultHistoryTarget(): string {
  return defaultHistoryPath();
}

export function openHistoryStore(target: string): HistoryStore {
  const named = target.trim();
  if (named === '') throw new Error('a history target is a SQLite file path');
  if (named.includes('://')) {
    throw new Error(
      `a local history node keeps a SQLite file; a network history client lives in the cloud deployment (got ${JSON.stringify(target)})`,
    );
  }
  return new SqliteHistoryStore(target);
}

function answer(key: string, value: MaybePromise<unknown>): unknown {
  return value instanceof Promise
    ? value.then((settled) => ({ [key]: settled }))
    : { [key]: value };
}

interface HistoryState {
  store: HistoryStore;
  userId: string;
}

/** One store per SQLite file in this process. NodeHost creates a HistoryNode per invocation, so the
 *  store has to outlive the instance; the process ends it, not a handler. The SQLite store is shared
 *  by all tenants and takes the tenant as a method argument. */
const states = new Map<string, HistoryState>();

function stateFor(target: string, userId: string): HistoryState {
  const user = identifier(userId, 'userId');
  let state = states.get(target);
  if (state === undefined) {
    state = { store: openHistoryStore(target), userId: user };
    states.set(target, state);
  }
  return state;
}

export class HistoryNode extends Node {
  readonly store: HistoryStore;
  readonly userId: string;
  readonly handlers: NodeHandlers;

  private readonly target: string;

  constructor(ctx: NodeContext, target = defaultHistoryTarget(), userId = defaultHistoryUser()) {
    super(ctx);
    this.target = target;
    this.userId = identifier(userId, 'userId');
    this.store = stateFor(target, this.userId).store;
    this.handlers = {
      load: (args) => this.handle('load', args, this.ctx.from),
      save: (args) => this.handle('save', args, this.ctx.from),
      delete: (args) => this.handle('delete', args, this.ctx.from),
      list: (args) => this.handle('list', args, this.ctx.from),
      usage: (args) => this.handle('usage', args, this.ctx.from),
      reset: (args) => this.handle('reset', args, this.ctx.from),
      ui: (args) => this.handle(PANEL, args, this.ctx.from),
    };
  }

  /** The bus tenant is the user; a hand-built context keeps the constructor argument. */
  private callerUser(): string {
    const tenant = (this.ctx as { tenantId?: unknown } | undefined)?.tenantId;
    return typeof tenant === 'string' && tenant.trim()
      ? identifier(tenant, 'tenantId')
      : this.userId;
  }

  /** Private nodes are the user's own; history is shared infrastructure and does not serve them. */
  private rejectPrivate(from: string): Error | null | Promise<Error | null> {
    const listNodes = (
      this.ctx as { listNodes?: () => Promise<{ name: string; scope: string }[]> } | undefined
    )?.listNodes;
    if (typeof listNodes !== 'function') return null;
    return listNodes.call(this.ctx).then((nodes) => {
      const caller = nodes.find((node) => node.name === from);
      return caller?.scope === 'private'
        ? new Error(`history does not serve the private node "${from}"`)
        : null;
    });
  }

  handle(cap: string, args: ToolArgs, from: string): unknown {
    const refused = this.rejectPrivate(from);
    if (refused instanceof Promise)
      return refused.then((error) => {
        if (error !== null) throw error;
        return this.run(cap, args, from);
      });
    if (refused !== null) throw refused;
    return this.run(cap, args, from);
  }

  private run(cap: string, args: ToolArgs, from: string): unknown {
    const user = this.callerUser();
    const store = stateFor(this.target, user).store;
    const node = identifier(from, 'calling node name');
    if (cap === 'list') return answer('units', store.list(user, node));
    if (cap === 'usage') {
      if (typeof store.usage !== 'function') throw new Error('this history store cannot report usage');
      return this.usageWithRunning(store.usage(user));
    }
    if (cap === 'reset') {
      if (typeof store.reset !== 'function') throw new Error('this history store cannot reset a node');
      const target = identifier(args.node, 'node');
      return answer('deleted', store.reset(user, target));
    }
    if (cap === PANEL) return PAGE.replace('__NODE__', () => this.ctx.nodeId);

    const unit = identifier(args.unitId, 'unitId');
    if (cap === 'load') return answer('unit', store.load(user, node, unit));
    if (cap === 'save') {
      const expected =
        args.expectedRevision === undefined
          ? undefined
          : args.expectedRevision === 0
            ? 0
            : positiveInteger(args.expectedRevision, 'expectedRevision');
      serializeMeta(args.meta);
      return answer('unit', store.save(user, node, unit, args.meta, expected));
    }
    const expectedRevision = positiveInteger(args.expectedRevision, 'expectedRevision');
    if (cap === 'delete') {
      const deleted = store.delete(user, node, unit, expectedRevision);
      return deleted instanceof Promise
        ? deleted.then(() => 'persistent unit deleted')
        : 'persistent unit deleted';
    }
    throw new Error(
      `history only provides load / save / delete / list / usage / reset / ui (got "${cap}")`,
    );
  }

  /** Add live bus status to usage. A directory that cannot be read leaves the status unknown. */
  private async usageWithRunning(value: MaybePromise<HistoryUsage>): Promise<HistoryUsage> {
    const usage = await value;
    let live: Set<string> | null = null;
    try {
      if (typeof this.ctx.listNodes === 'function') {
        live = new Set((await this.ctx.listNodes()).map((entry) => entry.name));
      }
    } catch {
      live = null;
    }
    return {
      ...usage,
      nodes: usage.nodes.map((node) =>
        live === null ? node : { ...node, running: live.has(node.node) },
      ),
    };
  }
}

export default HistoryNode;
