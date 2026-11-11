// Fixtures for the notes suites: the node under test, the history it files its units in, and the
// caller that talks to it. Each one is started the way the runtime starts a node -- registered on the
// bus, then connected into one user's directory by a control connection -- so a test only ever sees
// capabilities. The user is what keeps two tests that run in one process apart, exactly as a second
// process would.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Node,
  NodeHost,
  WebSocketBusSession,
  nodeManifestOfPackage,
  type NodeContext,
  type NodeHandlers,
  type NodeManifest,
  type Outcome,
  type ToolArgs,
} from '@node-agent/sdk';
import { Bus } from '../../../bus/src/index.ts';
import { NotesNode } from '../src/index.ts';

export const TOKEN = 'notes-test-token';
const CONTROL = 'notes-test-control-token';

/** The manifest of a node a test registers: a name, and the capabilities it answers. */
function manifestOf(name: string, desc: string, caps: Record<string, unknown> = {}): NodeManifest {
  return {
    packageId: `test-${name}`,
    caps: caps as NodeManifest['caps'],
    name,
    desc,
    version: '0.1.0',
    publisher: 'test',
    icon: '<svg/>',
  };
}

/** One bus, one user, and the control connection that puts a node in that user's directory. */
export class Fixture {
  readonly bus: Bus;
  readonly user: string;
  readonly #control: WebSocketBusSession;

  private constructor(bus: Bus, user: string, control: WebSocketBusSession) {
    this.bus = bus;
    this.user = user;
    this.#control = control;
  }

  /** A bus and a user nobody else uses. A bus user id is an opaque token of 32 characters or more. */
  static async open(): Promise<Fixture> {
    const bus = await new Bus(TOKEN, CONTROL).listen();
    const control = new WebSocketBusSession();
    await control.connect(bus.url, CONTROL);
    return new Fixture(bus, randomUUID(), control);
  }

  /** Put a registered node into this user's directory, as the runtime's supervisor does. */
  async admit(name: string): Promise<void> {
    await this.#control.connectNode(this.user, name);
  }

  async close(): Promise<void> {
    await this.#control.close();
    this.bus.close();
  }
}

/** A node a test talks through: it registers on the bus and nothing else, so every answer a test
 *  reads is the bus's own -- a refusal included. */
export class Caller {
  readonly #session: WebSocketBusSession;
  readonly #fixture: Fixture;

  private constructor(session: WebSocketBusSession, fixture: Fixture) {
    this.#session = session;
    this.#fixture = fixture;
  }

  static async join(fixture: Fixture, name = 'caller'): Promise<Caller> {
    const session = new WebSocketBusSession();
    await session.connect(fixture.bus.url, TOKEN);
    await session.register(manifestOf(name, 'a test caller'));
    await fixture.admit(name);
    return new Caller(session, fixture);
  }

  /** `notes.add` reaches the `notes` node's `add` capability. */
  async call(capability: string, args: ToolArgs = {}): Promise<Outcome> {
    const split = capability.lastIndexOf('.');
    const result = await this.#session.call({
      id: randomUUID(),
      type: 'call',
      to: capability.slice(0, split),
      tenantId: this.#fixture.user,
      deadline: Date.now() + 10_000,
      payload: { cap: capability.slice(split + 1), args },
    });
    return result.payload;
  }

  async close(): Promise<void> {
    await this.#session.close();
  }
}

/** One unit as the fake history keeps it. */
type Unit = { revision: number; meta: unknown };

/** The in-memory database behind the fake history node. */
export class FakeHistoryStore {
  private readonly units = new Map<string, Unit>();

  load(user: string, node: string, unit: string): Unit | null {
    const found = this.units.get(`${user}\u0000${node}\u0000${unit}`);
    return found === undefined ? null : structuredClone(found);
  }

  save(user: string, node: string, unit: string, meta: unknown, expectedRevision?: number): Unit {
    const key = `${user}\u0000${node}\u0000${unit}`;
    const current = this.units.get(key);
    if (expectedRevision === 0) {
      if (current !== undefined) this.conflict(user, node, unit, expectedRevision);
      const created = { revision: 1, meta: structuredClone(meta) };
      this.units.set(key, created);
      return structuredClone(created);
    }
    if (expectedRevision !== undefined) {
      if (current === undefined || current.revision !== expectedRevision) {
        this.conflict(user, node, unit, expectedRevision);
      }
      const updated = { revision: current!.revision + 1, meta: structuredClone(meta) };
      this.units.set(key, updated);
      return structuredClone(updated);
    }
    const replaced = { revision: (current?.revision ?? 0) + 1, meta: structuredClone(meta) };
    this.units.set(key, replaced);
    return structuredClone(replaced);
  }

  delete(user: string, node: string, unit: string, expectedRevision: number): void {
    const key = `${user}\u0000${node}\u0000${unit}`;
    const current = this.units.get(key);
    if (current === undefined || current.revision !== expectedRevision) {
      this.conflict(user, node, unit, expectedRevision);
    }
    this.units.delete(key);
  }

  list(user: string, node: string): { unitId: string; revision: number }[] {
    const prefix = `${user}\u0000${node}\u0000`;
    return [...this.units.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, unit]) => ({ unitId: key.slice(prefix.length), revision: unit.revision }));
  }

  private conflict(user: string, node: string, unit: string, expected: number | undefined): never {
    throw new Error(
      `persistent unit "${user}/${node}/${unit}" changed concurrently ` +
        `(expected revision ${expected ?? 'none'})`,
    );
  }
}

/** The user every fake unit is filed under. The real history node files by the bus user; this stand-in
 *  keeps one table, which is what a test of the notes node wants to look at. */
const FAKE_USER = 'default';

/** A history node for tests: the four capabilities the notes node calls, over a memory store. A unit
 *  is filed under the calling node's name, exactly as the real node files it. */
function fakeHistoryClass(store: FakeHistoryStore): typeof Node {
  return class extends Node {
    readonly handlers: NodeHandlers = {
      load: async (args: ToolArgs) => ({
        unit: store.load(FAKE_USER, this.ctx.from, String(args.unitId)),
      }),
      list: async () => ({ units: store.list(FAKE_USER, this.ctx.from) }),
      save: async (args: ToolArgs) => ({
        unit: store.save(
          FAKE_USER,
          this.ctx.from,
          String(args.unitId),
          args.meta,
          args.expectedRevision === undefined ? undefined : Number(args.expectedRevision),
        ),
      }),
      delete: async (args: ToolArgs) => {
        store.delete(FAKE_USER, this.ctx.from, String(args.unitId), Number(args.expectedRevision));
        return 'persistent unit deleted';
      },
    };
  };
}

/** The fake history the suites read back: its store, and the one way to stop it. */
export type TestHistory = { readonly store: FakeHistoryStore; close(): Promise<void> };

const histories = new Map<string, FakeHistoryStore>();

/** A fresh history node over a memory store that survives a restart for the same database name. */
export async function startHistory(fixture: Fixture, database?: string): Promise<TestHistory> {
  const store = database === undefined ? new FakeHistoryStore() : storeFor(database);
  const host = new NodeHost({
    definition: {
      manifest: manifestOf('history', 'in-memory history for tests', {
        load: { type: 'object', properties: {} },
        save: { type: 'object', properties: {} },
        delete: { type: 'object', properties: {} },
        list: { type: 'object', properties: {} },
      }),
      Node: fakeHistoryClass(store),
    },
    bus: new WebSocketBusSession(),
  });
  await host.start(fixture.bus.url, TOKEN);
  await fixture.admit('history');
  return { store, close: () => host.stop() };
}

/** Start a fresh notes node on a bus. Tests use capabilities, exactly as a caller does. */
export async function joinNotes(fixture: Fixture): Promise<NodeHost> {
  const host = new NodeHost({
    definition: {
      manifest: nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url))),
      Node: NotesNode,
    },
    bus: new WebSocketBusSession(),
  });
  await host.start(fixture.bus.url, TOKEN);
  await fixture.admit('notes');
  return host;
}

/** A context for a test that only wants the page or the schema: no bus, no history. */
export function testContext(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    nodeId: 'notes',
    tenantId: 'default',
    from: 'test',
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    call: async () => {
      throw new Error('no node provides that capability');
    },
    publish: () => {},
    fetch,
    ...overrides,
  };
}

/** The page the node hands out, exactly as a browser gets it. */
export async function pageOf(): Promise<string> {
  const node = new NotesNode(testContext());
  return String(await node.handlers.ui!({}));
}

/** The store behind a named database, so a test can seed a unit before the node joins. */
export function storeFor(database: string): FakeHistoryStore {
  const store = histories.get(database) ?? new FakeHistoryStore();
  histories.set(database, store);
  return store;
}
