// Fixtures for the search suite: the node under test, the history it files its key in, and the caller
// that talks to it. Each one is started the way the runtime starts a node -- registered on the bus,
// then connected into one user's directory by a control connection -- so a test only ever sees
// capabilities. The user is what keeps two tests that run in one process apart, exactly as a second
// process would.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Node,
  NodeHost,
  WebSocketBusSession,
  nodeManifestOfPackage,
  type NodeHandlers,
  type NodeManifest,
  type Outcome,
  type ToolArgs,
} from '@node-agent/sdk';
import { Bus } from '../../../bus/src/index.ts';
import { searchNodeClass, type DeepSeekSearchOptions } from '../src/index.ts';

export const TOKEN = 'search-test-token';
const CONTROL = 'search-test-control-token';

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

  /** `search.search` reaches the `search` node's `search` capability. */
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

/** The in-memory database behind the fake history node. A test plants a value here before the search
 *  node joins -- a save the node would refuse to make itself -- and reads one back to prove what an
 *  accepted save wrote. */
export class FakeHistoryStore {
  private readonly units = new Map<string, Unit>();

  load(unit: string): Unit | null {
    const found = this.units.get(unit);
    return found === undefined ? null : structuredClone(found);
  }

  save(unit: string, meta: unknown, expectedRevision?: number): Unit {
    const current = this.units.get(unit);
    if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
      throw new Error(`revision conflict on ${unit}: expected ${expectedRevision}`);
    }
    const saved = { revision: (current?.revision ?? 0) + 1, meta: structuredClone(meta) };
    this.units.set(unit, saved);
    return structuredClone(saved);
  }

  /** What the unit holds, as the file behind a real history node would: `null` when there is none. */
  meta(unit: string): unknown {
    const found = this.load(unit);
    return found === null ? null : found.meta;
  }

  /** Put a value in a unit the way an older version -- or anything else that wrote to it -- might have
   *  left it. */
  plant(unit: string, meta: unknown): void {
    this.units.set(unit, { revision: 1, meta: structuredClone(meta) });
  }
}

/** A history node over the fake store: the two capabilities this node uses, and nothing else. */
function fakeHistoryClass(store: FakeHistoryStore): typeof Node {
  return class extends Node {
    readonly handlers: NodeHandlers = {
      load: async (args: ToolArgs) => ({ unit: store.load(String(args.unitId)) }),
      save: async (args: ToolArgs) => ({
        unit: store.save(
          String(args.unitId),
          args.meta,
          args.expectedRevision === undefined ? undefined : Number(args.expectedRevision),
        ),
      }),
    };
  };
}

export type TestHistory = { readonly store: FakeHistoryStore; close(): Promise<void> };

/** A history node over the store a test hands in, so a restart reads the same units back. */
export async function startHistory(
  fixture: Fixture,
  store: FakeHistoryStore,
): Promise<TestHistory> {
  const host = new NodeHost({
    definition: {
      manifest: manifestOf('history', 'in-memory history for tests', {
        load: { type: 'object', properties: {} },
        save: { type: 'object', properties: {} },
      }),
      Node: fakeHistoryClass(store),
    },
    bus: new WebSocketBusSession(),
  });
  await host.start(fixture.bus.url, TOKEN);
  await fixture.admit('history');
  return { store, close: () => host.stop() };
}

/** Start a search node on a bus. The options are the ones the old package took in its constructor: the
 *  host builds the instance, so they are fixed into the class it hosts. */
export async function joinSearch(
  fixture: Fixture,
  options: DeepSeekSearchOptions = {},
): Promise<NodeHost> {
  const host = new NodeHost({
    definition: {
      manifest: nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url))),
      Node: searchNodeClass(options),
    },
    bus: new WebSocketBusSession(),
  });
  await host.start(fixture.bus.url, TOKEN);
  await fixture.admit(host.manifest.name);
  return host;
}
