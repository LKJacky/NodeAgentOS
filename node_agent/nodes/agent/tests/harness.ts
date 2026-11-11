// A bus in one process: the agent under test, a few sibling nodes to call, a history node that
// remembers units in a map, and a way to read what the agent published. No socket, no clock.
import {
  NodeHost,
  type BusSession,
  type CallEnvelope,
  type CapabilityEntry,
  type NodeContext,
  type NodeEntry,
  type NodeManifest,
  type OutboundCallEnvelope,
  type OutboundEventEnvelope,
  type Outcome,
  type ResultEnvelope,
  type ToolArgs,
} from '@node-agent/sdk';
import { AgentNode, CAPABILITIES, RUNTIME_BINDING } from '../src/agent.ts';
import { CAPS } from '../src/manifest.ts';
import type { AgentRuntime, RuntimeOptions } from '../src/runtime.ts';
import type { Provider } from '../src/types.ts';

type CallIdentity = { tenantId: string; from: string };
type Handler = (args: ToolArgs, call: CallIdentity) => Promise<unknown> | unknown;
type Sibling = { name: string; desc: string; caps: Record<string, Handler> };

/** One stored history unit, with the revision that makes a write conditional. */
export type Unit = { meta: unknown; revision: number };

export class FakeNet {
  readonly siblings = new Map<string, Sibling>();
  readonly units = new Map<string, Unit>();
  readonly events: { tenantId: string; topic: string; value: unknown }[] = [];
  #revision = 0;

  node(name: string, desc: string, caps: Record<string, Handler>): this {
    this.siblings.set(name, { name, desc, caps });
    return this;
  }

  /** A history node that behaves like the real one, one process per tenant: a unit is one meta
   *  blob and one revision, and two tenants never share a key. */
  withHistory(): this {
    const key = (tenantId: string, unitId: unknown): string => `${tenantId}/${String(unitId)}`;
    this.node('history', 'conversation units', {
      load: (args, call) => {
        const unit = this.units.get(key(call.tenantId, args.unitId));
        return { unit: unit === undefined ? null : { meta: unit.meta, revision: unit.revision } };
      },
      save: (args, call) => {
        const at = key(call.tenantId, args.unitId);
        const current = this.units.get(at);
        const expected = args.expectedRevision;
        if (typeof expected === 'number' && (current?.revision ?? null) !== expected) {
          throw new Error(`revision conflict on ${at}`);
        }
        this.#revision += 1;
        this.units.set(at, { meta: args.meta, revision: this.#revision });
        return { unit: { meta: args.meta, revision: this.#revision } };
      },
      delete: (args, call) => {
        this.units.delete(key(call.tenantId, args.unitId));
        return { ok: true };
      },
      // One caller's units, the way the real history node answers: a sub-agent shares its parent's
      // calling node, so this list carries every agent of one identity and the prefix is what sorts
      // them out.
      list: (_args, call) => ({
        units: [...this.units.entries()]
          .filter(([at]) => at.startsWith(`${call.tenantId}/`))
          .map(([at, unit]) => ({
            unitId: at.slice(`${call.tenantId}/`.length),
            revision: unit.revision,
          })),
      }),
    });
    return this;
  }

  /** The meta of one unit, for one tenant — the tenant is not optional on purpose. */
  unit(unitId: string, tenantId: string): unknown {
    return this.units.get(`${tenantId}/${unitId}`)?.meta;
  }

  /** Every unit id one tenant holds, oldest name first: what a destroy has to have removed. */
  unitIds(tenantId: string): string[] {
    const at = `${tenantId}/`;
    return [...this.units.keys()]
      .filter((key) => key.startsWith(at))
      .map((key) => key.slice(at.length))
      .sort();
  }

  /** Write one unit directly, for a test that starts from a stored transcript. */
  putUnit(unitId: string, meta: unknown, tenantId: string): void {
    this.#revision += 1;
    this.units.set(`${tenantId}/${unitId}`, { meta, revision: this.#revision });
  }
}

export class FakeSession implements BusSession {
  readonly net: FakeNet;
  readonly calls: OutboundCallEnvelope[] = [];
  readonly subscribed: string[] = [];
  /** What answers a frame addressed to the node this session registered - the bus hands such a call
   *  back to the node, and `run_on_node` reaches the family's own node exactly that way. */
  self?: (
    cap: string,
    args: Record<string, unknown>,
    from: string,
    tenantId: string,
  ) => Promise<unknown>;
  readonly subscriptionNodes: string[] = [];
  #manifest: NodeManifest | null = null;

  constructor(net: FakeNet) {
    this.net = net;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async register(manifest: NodeManifest): Promise<void> {
    this.#manifest = manifest;
  }
  async unregister(): Promise<void> {
    this.#manifest = null;
  }
  onCall(): void {}
  onEvent(): void {}

  async listNodes(): Promise<NodeEntry[]> {
    const nodes: NodeEntry[] = [];
    if (this.#manifest !== null) {
      nodes.push({
        name: this.#manifest.name,
        desc: this.#manifest.desc,
        packageId: this.#manifest.packageId,
        version: this.#manifest.version,
        scope: 'shared',
      });
    }
    for (const sibling of this.net.siblings.values()) {
      nodes.push({
        name: sibling.name,
        desc: sibling.desc,
        packageId: sibling.name,
        version: '0.1.0',
        scope: 'shared',
      });
    }
    return nodes;
  }

  async listCapabilities(node: string): Promise<CapabilityEntry[]> {
    // The bus answers for the node that registered on it, exactly as a real one does: its own
    // capabilities come from the manifest it joined with, and `expose: false` - the caps a sibling
    // may not call - is invisible to an ordinary caller.
    if (this.#manifest !== null && node === this.#manifest.name) {
      return Object.entries(this.#manifest.caps)
        .filter(([, parameters]) => (parameters as { expose?: unknown }).expose !== false)
        .map(([cap, parameters]) => ({
          cap,
          parameters: parameters as Record<string, unknown>,
        }));
    }
    const sibling = this.net.siblings.get(node);
    if (sibling === undefined) throw new Error(`no node "${node}"`);
    return Object.entries(sibling.caps).map(([cap]) => ({
      cap,
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'the line' } },
        required: ['text'],
      },
    }));
  }

  async subscribe(topic: string, _tenantId: string, node: string): Promise<void> {
    this.subscribed.push(topic);
    this.subscriptionNodes.push(node);
  }

  /** The topics dropped again, so a test can see that a finished stream stopped listening. */
  readonly unsubscribed: string[] = [];

  async unsubscribe(topic: string, _tenantId: string, node: string): Promise<void> {
    this.unsubscribed.push(topic);
    const at = this.subscribed.lastIndexOf(topic);
    if (at >= 0) this.subscribed.splice(at, 1);
    void node;
  }

  async reply(): Promise<void> {}

  async call(envelope: OutboundCallEnvelope): Promise<ResultEnvelope> {
    // A transport fills the sender and keeps one per connection; the caller never names itself.
    const call = { ...envelope, from: this.#manifest?.name ?? 'unknown' };
    this.calls.push(call);
    let outcome: Outcome;
    const sibling = this.net.siblings.get(call.to);
    if (this.#manifest !== null && call.to === this.#manifest.name && this.self !== undefined) {
      try {
        outcome = {
          ok: true,
          value: await this.self(call.payload.cap, call.payload.args, call.from, call.tenantId),
        };
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    } else if (sibling === undefined) {
      outcome = { ok: false, error: `no such node: ${call.to}` };
    } else {
      const handler = sibling.caps[call.payload.cap];
      if (handler === undefined) {
        outcome = { ok: false, error: `no such capability: ${call.payload.cap}` };
      } else {
        try {
          outcome = {
            ok: true,
            value: await handler(call.payload.args, {
              tenantId: call.tenantId,
              from: call.from,
            }),
          };
        } catch (error) {
          outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    return {
      id: call.id,
      type: 'result',
      from: call.to,
      to: call.to,
      tenantId: call.tenantId,
      payload: outcome,
    };
  }

  publish(event: OutboundEventEnvelope): void {
    const payload = event.payload as { topic: string; value: unknown };
    this.net.events.push({ tenantId: event.tenantId, topic: payload.topic, value: payload.value });
  }
}

export type TestAgent = {
  net: FakeNet;
  session: FakeSession;
  host: NodeHost;
  /** The runtime the host bound for one tenant. */
  runtimeOf: (tenantId: string) => AgentRuntime;
  /** The invocation context one tenant's last call saw, for tests that poison it afterwards. */
  contextOf: (tenantId: string) => NodeContext;

  /** The runtime the host bound for this tenant, once a handler ran. */
  runtime: AgentRuntime;
  call: (cap: string, args: ToolArgs, from?: string, as?: string) => Promise<unknown>;
  stop: () => Promise<void>;
};

let tenant = 0;

export function manifestOf(name = 'agent'): NodeManifest {
  return {
    packageId: name,
    name,
    desc: 'the agent under test',
    version: '0.1.0',
    publisher: 'node-agent',
    icon: '',
    // The manifest the package really carries: the model is shown these schemas, and the bus hides
    // the `expose: false` ones from an ordinary caller.
    caps: Object.fromEntries(
      CAPABILITIES.map((cap) => [cap, CAPS[cap] ?? { type: 'object', properties: {} }]),
    ),
    bindings: [RUNTIME_BINDING],
  };
}

/** Start one agent on a fake bus, with a provider that never reaches a network. */
export async function startAgent(
  options: {
    net?: FakeNet;
    provider?: Provider;
    /** A provider per tenant, for a test that runs two tenants on one host. */
    providers?: Record<string, Provider>;
    runtime?: RuntimeOptions;
    name?: string;
    tenantId?: string;
    /** Bind the runtime before returning (a `status` call); false leaves it unbound. */
    materialize?: boolean;
    /** Extra tenants to pin on the same host, for an isolation test. */
    tenants?: string[];
  } = {},
): Promise<TestAgent> {
  const name = options.name ?? 'agent';
  const net = options.net ?? new FakeNet();
  const session = new FakeSession(net);
  tenant += 1;
  const tenantId = options.tenantId ?? `t${tenant}`;

  const providers: Record<string, Provider> = { ...options.providers };
  if (options.provider !== undefined) providers[tenantId] = options.provider;
  const seen = new Map<string, AgentRuntime>();
  const contexts = new Map<string, NodeContext>();
  class TestAgentNode extends AgentNode {
    constructor(ctx: NodeContext) {
      const provider = providers[ctx.tenantId];
      super(ctx, { ...options.runtime, ...(provider !== undefined ? { provider } : {}) });
      // `this.runtime` is `ctx.bind`'s object; keeping it here is the test's handle, not the
      // node's state (the node builds one per invocation and keeps nothing).
      seen.set(ctx.tenantId, this.runtime);
      contexts.set(ctx.tenantId, ctx);
    }
  }

  const host = new NodeHost({
    definition: { manifest: manifestOf(name), Node: TestAgentNode },
    bus: session,
  });
  await host.start('ws://fake', 'token');
  // A frame addressed to this node comes back to it, the way a bus delivers a call to the node that
  // registered for it - which is how `run_on_node` reaches the family's own node.
  session.self = async (cap, args, from, as) => {
    const outcome = await host.invoke({
      id: `${Math.random()}`,
      type: 'call',
      from,
      to: name,
      tenantId: as,
      deadline: Date.now() + 60_000,
      payload: { cap, args },
    });
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };

  /** One capability call. `as` lets a test speak as another tenant on the same host. */
  const call = async (
    cap: string,
    args: ToolArgs,
    from = 'tester',
    as = tenantId,
  ): Promise<unknown> => {
    const envelope: CallEnvelope = {
      id: `${Math.random()}`,
      type: 'call',
      from,
      to: name,
      tenantId: as,
      deadline: Date.now() + 60_000,
      payload: { cap, args },
    };
    const outcome = await host.invoke(envelope);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };

  // Materialise this tenant's runtime once: `status` reads no model and adds no usage.
  if (options.materialize !== false) await call('status', {});

  return {
    net,
    session,
    host,
    runtimeOf: (id: string): AgentRuntime => {
      const runtime = seen.get(id);
      if (runtime === undefined) throw new Error(`no runtime is bound for tenant ${id}`);
      return runtime;
    },
    contextOf: (id: string): NodeContext => {
      const ctx = contexts.get(id);
      if (ctx === undefined) throw new Error(`tenant ${id} has not made a call`);
      return ctx;
    },
    get runtime(): AgentRuntime {
      return this.runtimeOf(tenantId);
    },
    call,
    stop: async () => {
      // Close the objects the way a process shutdown would, then drop the bindings.
      for (const runtime of seen.values()) await runtime.close();
      await host.stop();
    },
  };
}
