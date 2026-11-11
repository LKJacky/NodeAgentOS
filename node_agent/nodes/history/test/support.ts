// Fixtures for the history suite: the history node as the runtime hosts it, the agent that writes
// through it, and the caller that talks to either. Each node is registered on the bus and then
// connected into one user's directory by a control connection -- the runtime's own order -- so a test
// only ever sees capabilities.
import { createHash, randomUUID } from 'node:crypto';
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
import { AgentNode } from '../../agent/src/agent.ts';
import type { Provider } from '../../agent/src/types.ts';
import { HistoryNode } from '../src/index.ts';

export const TOKEN = 'history-test-token';
const CONTROL = 'history-test-control-token';

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
  readonly #hosts: NodeHost[] = [];

  private constructor(bus: Bus, user: string, control: WebSocketBusSession) {
    this.bus = bus;
    this.user = user;
    this.#control = control;
  }

  /** A bus and a user nobody else uses. A bus user id is an opaque token of 32 characters or more. */
  static async open(user?: string): Promise<Fixture> {
    const bus = await new Bus(TOKEN, CONTROL).listen();
    const control = new WebSocketBusSession();
    await control.connect(bus.url, CONTROL);
    return new Fixture(bus, user ?? randomUUID(), control);
  }

  /** Put a registered node into this user's directory, as the runtime's supervisor does. */
  async admit(name: string): Promise<void> {
    await this.#control.connectNode(this.user, name);
  }

  /** Host one node here and admit it: the short form every fixture below uses. */
  async host(
    manifest: NodeManifest,
    Node: typeof import('@node-agent/sdk').Node,
  ): Promise<NodeHost> {
    const host = new NodeHost({ definition: { manifest, Node }, bus: new WebSocketBusSession() });
    await host.start(this.bus.url, TOKEN);
    await this.admit(manifest.name);
    this.#hosts.push(host);
    return host;
  }

  async close(): Promise<void> {
    for (const host of this.#hosts.reverse()) await host.stop();
    this.#hosts.length = 0;
    await this.#control.close();
    this.bus.close();
  }
}

/** The user of one history database, so a restart over the same file reads the same units. */
export function userOf(database: string): string {
  return `history-db-${createHash('sha256').update(database).digest('hex').slice(0, 40)}`;
}

/** A node a test talks through: it registers on the bus and nothing else, so every answer a test
 *  reads is the bus's own. */
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

  /** `agent.chat` reaches the `agent` node's `chat` capability. */
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

/** One save as the history node received it. */
export type Saved = { unitId: string; meta: unknown };

/** The history node on the bus. `saved` keeps every save it handled, in order, which is what a test
 *  about "one unit per message" reads. */
export async function startHistory(fixture: Fixture, saved: Saved[] = []): Promise<NodeHost> {
  class RecordingHistory extends HistoryNode {
    constructor(ctx: NodeContext) {
      super(ctx);
      const inner = this.handlers.save!;
      this.handlers.save = async (args: ToolArgs) => {
        saved.push({ unitId: String(args.unitId), meta: args.meta });
        return await inner(args);
      };
    }
  }
  return await fixture.host(
    nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url))),
    RecordingHistory,
  );
}

/** A model that answers the same line every time: no network, no key, no guessing. A turn reads the
 *  stream, so that is where the line comes from; `chat` answers the same for the counting calls. */
export function fixedModel(content = 'durable'): Provider {
  return {
    chat: async () => ({ content }),
    stream: async function* () {
      yield { type: 'content', text: content };
      yield { type: 'end' };
    },
  };
}

/** The agent node on the bus, hosted over the model a test hands it. */
export async function startAgent(fixture: Fixture, provider: Provider): Promise<NodeHost> {
  const Node = class extends AgentNode {
    constructor(ctx: NodeContext) {
      super(ctx, { historyRequired: true, provider });
    }
  };
  return await fixture.host(
    nodeManifestOfPackage(fileURLToPath(new URL('../../agent', import.meta.url))),
    Node,
  );
}
