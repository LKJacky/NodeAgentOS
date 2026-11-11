// The history node: durable units for every node on the bus, filed under the calling tenant and the
// caller's node name. Where units live is a setting; whose they are is the bus tenant, never a field
// in the request. A local SQLite store uses the tenant as its namespace; an HTTP store gets one client
// per tenant, and that tenant's token is its bearer.
import { Node, type NodeContext, type NodeHandlers, type ToolArgs } from '@node-agent/sdk';
import { HttpHistoryStore } from './http.js';
import {
  SqliteHistoryStore,
  defaultHistoryPath,
  identifier,
  positiveInteger,
  serializeMeta,
  type HistoryStore,
  type MaybePromise,
} from './store.js';

export {
  RevisionConflictError,
  SqliteHistoryStore,
  UnitNotFoundError,
  defaultHistoryPath,
  nodeAgentHome,
} from './store.js';
export type { HistoryStore, MaybePromise, PersistentUnit, PersistentUnitSummary } from './store.js';
export { HttpHistoryStore } from './http.js';

export const DEFAULT_HISTORY_USER = 'default';

export function defaultHistoryUser(): string {
  return process.env.NODE_AGENT_HISTORY_USER?.trim() || DEFAULT_HISTORY_USER;
}

export function defaultHistoryTarget(): string {
  const url = process.env.NODE_AGENT_HISTORY_URL?.trim();
  return url ? url : defaultHistoryPath();
}

export function openHistoryStore(
  target: string,
  token = process.env.NODE_AGENT_HISTORY_TOKEN?.trim() ?? process.env.NODE_AGENT_TOKEN?.trim(),
): HistoryStore {
  const named = target.trim();
  if (named === '') throw new Error('a history target is either an http(s) URL or a file path');
  if (/^https?:\/\//i.test(named)) return new HttpHistoryStore(named, { token });
  if (named.includes('://')) {
    throw new Error(
      `a history target is an http(s) URL or a SQLite file path, not ${JSON.stringify(target)}`,
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

function isHttpTarget(target: string): boolean {
  return /^https?:\/\//i.test(target.trim());
}

/** One store per backend identity in this process. NodeHost creates a HistoryNode per invocation, so
 *  the store has to outlive the instance; the process ends it, not a handler. A local SQLite store is
 *  shared by all tenants and takes the tenant as a method argument; an HTTP store is one client per
 *  tenant because its bearer token is the tenant's identity. */
const states = new Map<string, HistoryState>();

function stateFor(target: string, userId: string): HistoryState {
  const user = identifier(userId, 'userId');
  const key = isHttpTarget(target) ? `${target}\u0000${user}` : target;
  let state = states.get(key);
  if (state === undefined) {
    state = {
      store: openHistoryStore(target, isHttpTarget(target) ? user : undefined),
      userId: user,
    };
    states.set(key, state);
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
    throw new Error(`history only provides load / save / delete / list (got "${cap}")`);
  }
}

export default HistoryNode;
