// Fixtures for the files suites: a fake history node and a fake NodeContext.
//
// The node under test lives entirely on top of `history`: every capability reads and writes units
// through `ctx.call('history', …)` and keeps nothing in the process. So the honest double is a store
// with the same four answers (`load`, `save`, `delete`, and the two revisions rules that make a
// write safe), not a real bus - a test can then look at the units a call left behind, and even put a
// second writer in the way at the one moment that matters.
import type { NodeContext, NodeHandlers, ToolArgs } from '@node-agent/sdk';
import { FilesNode } from '../src/index.ts';

/** One unit as the fake history holds it: history's own fields, so the node can be read the way a
 *  real store would be. */
export type FakeUnit = { revision: number; meta: unknown; createdAt: string; updatedAt: string };

/** A history node in a Map: the same answers and the same wording the real one gives, including the
 *  two sentences the files node tells a conflict from a missing unit by. */
export class FakeHistory {
  readonly units = new Map<string, FakeUnit>();
  /** How many saves were attempted, retries included. */
  saves = 0;
  /** Await this before every save, so a test can land a second writer in the gap. */
  beforeSave: ((unitId: string) => Promise<void> | void) | null = null;

  private clock = Date.UTC(2026, 0, 1);
  private readonly options: { registered?: boolean };

  constructor(options: { registered?: boolean } = {}) {
    this.options = options;
  }

  /** One `ctx.call('history', cap, args)`. */
  async call(node: string, cap: string, args: ToolArgs = {}): Promise<unknown> {
    if (this.options.registered === false) throw new Error(`no such node for user: ${node}`);
    if (node !== 'history') throw new Error(`no such node for user: ${node}`);

    const unitId = String(args.unitId ?? '');
    if (cap === 'load') {
      const unit = this.units.get(unitId);
      return { unit: unit === undefined ? null : { ...unit } };
    }
    if (cap === 'save') return await this.save(unitId, args);
    if (cap === 'delete') return await this.delete(unitId, args);
    throw new Error(`no node provides the capability ${cap}`);
  }

  private async save(unitId: string, args: ToolArgs): Promise<unknown> {
    const expected = args.expectedRevision;
    if (
      expected !== undefined &&
      (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0)
    )
      throw new Error('expectedRevision must be a whole number, zero or more');

    this.saves += 1;
    await this.beforeSave?.(unitId);

    const existing = this.units.get(unitId);
    if (expected === 0) {
      if (existing !== undefined) this.conflict(unitId, 0);
      const now = this.now();
      const created: FakeUnit = {
        revision: 1,
        meta: structuredClone(args.meta),
        createdAt: now,
        updatedAt: now,
      };
      this.units.set(unitId, created);
      return { unit: { ...created } };
    }
    if (expected !== undefined) {
      if (existing === undefined) this.missing(unitId);
      if (existing!.revision !== expected) this.conflict(unitId, expected);
      const updated: FakeUnit = {
        revision: existing!.revision + 1,
        meta: structuredClone(args.meta),
        createdAt: existing!.createdAt,
        updatedAt: this.now(),
      };
      this.units.set(unitId, updated);
      return { unit: { ...updated } };
    }
    const now = this.now();
    const saved: FakeUnit = {
      revision: (existing?.revision ?? 0) + 1,
      meta: structuredClone(args.meta),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.units.set(unitId, saved);
    return { unit: { ...saved } };
  }

  private async delete(unitId: string, args: ToolArgs): Promise<unknown> {
    const expected = args.expectedRevision;
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1)
      throw new Error('expectedRevision must be a positive safe integer');

    await this.beforeSave?.(unitId);
    const existing = this.units.get(unitId);
    if (existing === undefined) this.missing(unitId);
    if (existing!.revision !== expected) this.conflict(unitId, expected);
    this.units.delete(unitId);
    return { deleted: true };
  }

  /** The wording the real history node uses, because the words are how the two ends agree on what a
   *  refused write meant. */
  private conflict(unitId: string, expected: number): never {
    const current = this.units.get(unitId);
    if (current === undefined) this.missing(unitId);
    throw new Error(
      `persistent unit "default/files/${unitId}" changed concurrently ` +
        `(expected revision ${expected}, found ${current!.revision})`,
    );
  }

  private missing(unitId: string): never {
    throw new Error(`persistent unit "default/files/${unitId}" does not exist`);
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

/** A NodeContext the way a host builds one for one invocation, with `call` answered by the fake. */
export function fakeContext(
  history: FakeHistory,
  options: { from?: string; tenantId?: string } = {},
): NodeContext {
  const context = {
    tenantId: options.tenantId ?? 'default',
    from: options.from ?? 'agent',
    nodeId: 'files',
    nodeAgentHome: '/tmp/node-agent-files-test',
    home: '/tmp/node-agent-files-test/files',
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    call: (node: string, cap: string, args: ToolArgs) => history.call(node, cap, args),
    publish: () => {},
    fetch: globalThis.fetch,
  };
  return context as unknown as NodeContext;
}

/** The capabilities of one instance - one per invocation, exactly as the host makes them. */
export function handlersOf(history: FakeHistory, from = 'agent'): NodeHandlers {
  return new FilesNode(fakeContext(history, { from })).handlers;
}

/** One call the way a caller makes it: a fresh instance, a fresh context, the same history. */
export async function call<T>(
  history: FakeHistory,
  cap: string,
  args: ToolArgs = {},
  from = 'agent',
): Promise<T> {
  const handler = handlersOf(history, from)[cap];
  if (handler === undefined) throw new Error(`files has no capability ${cap}`);
  return (await handler(args)) as T;
}

/** The message of a call that has to be refused - a call that was accepted is the failure. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the call was accepted');
}
