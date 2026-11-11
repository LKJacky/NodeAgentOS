// Fixtures for the todo suite: the node under test, the history it files its units in, the caller
// that talks to it, and a stand-in press target. Each one is started the way the runtime starts a
// node -- registered on the bus, then connected into one user's directory by a control connection --
// so a test only ever sees capabilities. The user is what keeps two tests that run in one process
// apart, exactly as a second process would.
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
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
import { HistoryNode, openHistoryStore } from '../../history/src/index.ts';
import { TodoNode } from '../src/index.ts';

export const TOKEN = 'todo-test-token';
const CONTROL = 'todo-test-control-token';

let users = 0;

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

/** The history node as this suite hosts it: the four capabilities a todo node calls. Written out
 *  here rather than read from the package so a todo suite needs no built history package. */
const historyManifest: NodeManifest = manifestOf('history', 'history for the todo tests', {
  load: { type: 'object', properties: {} },
  save: { type: 'object', properties: {} },
  delete: { type: 'object', properties: {} },
  list: { type: 'object', properties: {} },
});

/** One bus, one user, and the control connection that puts a node in that user's directory. Every
 *  fixture below registers against it, so a test says `startTodo(fixture)` and nothing else. */
export class Fixture {
  readonly bus: Bus;
  readonly user: string;
  readonly #control: WebSocketBusSession;

  private constructor(bus: Bus, user: string, control: WebSocketBusSession) {
    this.bus = bus;
    this.user = user;
    this.#control = control;
  }

  /** A bus and a user nobody else uses. A bus user id is an opaque token of 32 characters or more,
   *  so the name carries a uuid. */
  static async open(user?: string): Promise<Fixture> {
    users += 1;
    const bus = await new Bus(TOKEN, CONTROL).listen();
    const control = new WebSocketBusSession();
    await control.connect(bus.url, CONTROL);
    return new Fixture(bus, user ?? `todo-test-${users}-${randomUUID()}`, control);
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

/** The user of one history database, so a restart over the same file sees the same units. */
export function userOf(database: string): string {
  return `todo-db-${createHash('sha256').update(database).digest('hex').slice(0, 40)}`;
}

/** A node a test talks through: it registers on the bus and nothing else, so every answer a test
 *  reads is the bus's own -- a refusal included. */
export class Caller {
  readonly #session: WebSocketBusSession;
  readonly #fixture: Fixture;
  readonly #name: string;
  #listener: ((topic: string, value: unknown) => void) | null = null;

  private constructor(session: WebSocketBusSession, fixture: Fixture, name: string) {
    this.#session = session;
    this.#fixture = fixture;
    this.#name = name;
    session.onEvent((event) => this.#listener?.(event.payload.topic, event.payload.value));
  }

  static async join(fixture: Fixture, name = 'caller'): Promise<Caller> {
    const session = new WebSocketBusSession();
    await session.connect(fixture.bus.url, TOKEN);
    await session.register(manifestOf(name, 'a test caller'));
    await fixture.admit(name);
    return new Caller(session, fixture, name);
  }

  /** `todo.add` reaches the `todo` node's `add` capability. */
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

  /** Every event this node is handed from now on. */
  onEvent(listener: (topic: string, value: unknown) => void): void {
    this.#listener = listener;
  }

  /** Listen to a topic a node publishes: `subscribe('todo')` is the snapshot the todo node sends
   *  on its own topic, and a second argument names another node's channel. */
  async subscribe(topic: string, owner = topic): Promise<void> {
    await this.#session.subscribe(topic, this.#fixture.user, owner);
  }

  async close(): Promise<void> {
    await this.#session.close();
  }
}

/** The todo node on a bus, started the way the runtime starts it: a host that builds one instance per
 *  call and disposes it after. A test therefore talks to it through capabilities only, exactly as
 *  the model, the page and curl do -- which is also what makes "the store is the state" a real test. */
export async function startTodo(fixture: Fixture, target?: string): Promise<NodeHost> {
  const host = new NodeHost({
    definition: {
      manifest: nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url))),
      Node: class extends TodoNode {
        constructor(ctx: NodeContext) {
          super(ctx, target);
        }
      },
    },
    bus: new WebSocketBusSession(),
  });
  await host.start(fixture.bus.url, TOKEN);
  await fixture.admit(host.manifest.name);
  return host;
}

/** What every fake press target said, by user and node name: the host is per test, the record out
 *  lives the instances it started. */
const said = new Map<string, string[]>();

function recordFor(user: string, name: string): string[] {
  const key = `${user}\u0000${name}`;
  const found = said.get(key);
  if (found !== undefined) return found;
  const created: string[] = [];
  said.set(key, created);
  return created;
}

/** The press target: `chat_no_wait` writes the message down and answers; `chat` only answers, which
 *  is the target a press cannot reach. Nothing else exists, so the manifest is the whole truth. */
function pressTarget(caps: readonly string[], messages: string[]): typeof Node {
  return class extends Node {
    readonly handlers: NodeHandlers = Object.fromEntries(
      caps.map((cap) => [
        cap,
        async (args: ToolArgs) => {
          if (cap === 'chat') return { ok: true };
          messages.push((args.msg as { content: string }).content);
          return { queued: true };
        },
      ]),
    );
  };
}

export type FakeAgent = { said: string[]; stop(): Promise<void> };

/** A target that can take a message: it writes down what it was asked to say, and its name is the one
 *  a press is sent to when it is `agent` (the default) or whatever the node was told. */
export async function startFakeAgent(
  fixture: Fixture,
  name = 'agent',
  caps: readonly string[] = ['chat_no_wait'],
): Promise<FakeAgent> {
  const messages = recordFor(fixture.user, name);
  const host = new NodeHost({
    definition: {
      manifest: manifestOf(
        name,
        'a target that takes a message without waiting',
        Object.fromEntries(caps.map((cap) => [cap, { type: 'object', properties: {} }])),
      ),
      Node: pressTarget(caps, messages),
    },
    bus: new WebSocketBusSession(),
  });
  await host.start(fixture.bus.url, TOKEN);
  await fixture.admit(name);
  return { said: messages, stop: () => host.stop() };
}

/** One unit as the history store keeps it, read back the way a test wants to see it. */
export type StoredUnit = { revision: number; meta: unknown } | null;

/** The history node on the bus, plus a look at what it wrote for this user's todo node. The store it
 *  points at is the file the node itself files into under `NODE_AGENT_HOME`, opened a second time
 *  for the test to read. */
export type TestHistory = {
  load(unit: string): StoredUnit;
  store: { load(user: string, node: string, unit: string): StoredUnit };
  stop(): Promise<void>;
};

export async function startHistory(fixture: Fixture, database: string): Promise<TestHistory> {
  const previous = process.env.NODE_AGENT_HOME;
  process.env.NODE_AGENT_HOME = dirname(dirname(database));
  const host = new NodeHost({
    definition: { manifest: historyManifest, Node: HistoryNode },
    bus: new WebSocketBusSession(),
  });
  await host.start(fixture.bus.url, TOKEN);
  await fixture.admit('history');
  const store = openHistoryStore(database) as TestHistory['store'];
  return {
    store,
    load: (unit: string) => store.load(fixture.user, 'todo', unit),
    stop: async () => {
      await host.stop();
      if (previous === undefined) delete process.env.NODE_AGENT_HOME;
      else process.env.NODE_AGENT_HOME = previous;
    },
  };
}
