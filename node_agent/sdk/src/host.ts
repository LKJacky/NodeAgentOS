import { randomUUID } from 'node:crypto';
import {
  type CallEnvelope,
  type CapabilityEntry,
  type EventEnvelope,
  type NodeEntry,
  type NodeManifest,
  type Outcome,
  type OutboundCallEnvelope,
  type OutboundEventEnvelope,
  type ResultEnvelope,
  type ToolArgs,
} from './envelope.js';
import {
  type BindingScope,
  type Node,
  type NodeClass,
  type NodeContext,
  type NodeHandler,
  type NodeHostContext,
  type SubNode,
  type SubNodeOptions,
} from './node.js';
import { nodeAgentDir, nodeAgentHome } from './home.js';
import { isBindingKey, loadNodePackage, nodeManifestOfPackage } from './package.js';

/** How long a call may take when nobody named a deadline — the one default for every caller: a
 *  child call whose inbound frame carried none (the python wire has no field for one, and a NaN
 *  deadline must not mean "fail at once"), a call a *bound* object makes (it has no caller's clock
 *  to borrow), and an event handler's turn. A turn that streams a long answer takes more than two
 *  minutes, so it is a knob: NODE_AGENT_CALL_DEADLINE_MS (ms). */
export const CALL_DEADLINE_MS = Number(process.env.NODE_AGENT_CALL_DEADLINE_MS ?? '') || 60000_000;

/** The deadline one invocation runs under. The caller's own, when it sent one that has not passed;
 *  a fresh default otherwise — an absent deadline is a wire that has no field for it, not a caller
 *  asking for no time at all. */
function deadlineOf(call: CallEnvelope): number {
  const now = Date.now();
  return Number.isFinite(call.deadline) && call.deadline > now
    ? call.deadline
    : now + CALL_DEADLINE_MS;
}

/** One entry of a tenant's table: the object a node keeps, or the tombstone of one it dropped. */
interface Kept {
  /** The object itself; null once the key was unbound, which also stamps the unbind. */
  readonly value: object | null;
  /** Bumped by every unbind, so a bind that straddled one knows not to cache its object. */
  readonly epoch: number;
}

/** A node package: manifest plus the class instantiated per invocation. */
export interface NodeDefinition {
  readonly manifest: NodeManifest;
  readonly Node: NodeClass;
}

/** Read one package's manifest from package.json and pair it with its Node class. */
export function nodeDefinitionOfPackage(directory: string, Node: NodeClass): NodeDefinition {
  return { manifest: nodeManifestOfPackage(directory), Node };
}

/**
 * The only bus surface a NodeHost needs. A real WebSocket bus and a test
 * double both implement this session; the host cannot tell which one it received.
 */
export interface BusSession {
  connect(url: string, token: string): Promise<void>;
  close(): Promise<void>;

  register(manifest: NodeManifest): Promise<void>;
  unregister(name: string): Promise<void>;

  /** Put a freshly registered node into one user's directory (used by createSubNode). */
  connectNode?(user: string, node: string): Promise<void>;

  /** Mint (or reuse) a private credential binding a sub-node to one tenant. */
  privateTokenFor?(tenant: string): string;

  /** The bus calls this for every inbound capability call. */
  onCall(handler: (call: CallEnvelope) => Promise<void> | void): void;

  /** The transport calls this for every event it has been asked to deliver. */
  onEvent?(handler: (event: EventEnvelope) => void): void;

  /** Read a user's bus directory; `*` is the internal service user. */
  listNodes(tenantId?: string): Promise<NodeEntry[]>;

  /** The capabilities one registered node exposes; optional for transports without a directory
   *  that carries them. */
  listCapabilities?(node: string, tenantId?: string): Promise<CapabilityEntry[]>;

  /** Ask the transport to deliver events on a topic for one tenant. */
  subscribe?(topic: string, tenantId: string | undefined, node: string): Promise<void>;

  /** Stop delivering one topic for one tenant. */
  unsubscribe?(topic: string, tenantId: string | undefined, node: string): Promise<void>;

  /** Reply to an inbound call; the BusSession fills `from` and `to`. */
  reply(call: CallEnvelope, outcome: Outcome): Promise<void>;

  /** Make a child call; the BusSession fills `from`. */
  call(call: OutboundCallEnvelope): Promise<ResultEnvelope>;

  /** Fire-and-forget event publication; the BusSession fills `from`. */
  publish(event: OutboundEventEnvelope): void;

  /** A fresh, unconnected session with this transport's settings, for a sub-node. */
  fork?(): BusSession;
}

export interface NodeHostOptions {
  readonly definition: NodeDefinition;
  readonly bus: BusSession;
  /** Optional outbound HTTP implementation, handed to each invocation. */
  readonly fetch?: typeof fetch;
}

/**
 * Stable capability endpoint. The manifest is registered once; each inbound
 * call gets a fresh Node instance and is disposed in a finally block.
 */
export class NodeHost {
  readonly manifest: NodeManifest;

  readonly #Node: NodeClass;
  readonly #bus: BusSession;
  readonly #fetch: typeof fetch;
  /** The keys this node declared in its manifest; anything else is refused, bind and unbind alike. */
  readonly #bindings: ReadonlySet<string>;
  /** tenant id -> key -> the object the node asked the host to keep for that tenant. Opaque: the
   *  host holds the reference and never calls, inspects or serializes what it holds. */
  readonly #shared = new Map<string, Map<string, Kept>>();
  /** tenant -> the host-lifetime scope handed to its bound objects. */
  readonly #scopes = new Map<string, BindingScope>();
  readonly #inflight = new Set<AbortController>();
  #started = false;
  #stopped = false;
  #url = '';
  #token = '';
  /** Nodes this host started itself, by bus name; each owns its own session. */
  readonly #subnodes = new Map<string, { host: NodeHost; tenantId: string }>();
  /** Events are handled one at a time, so a stateless handler cannot race itself. */
  #events: Promise<void> = Promise.resolve();

  constructor(options: NodeHostOptions) {
    this.manifest = options.definition.manifest;
    this.#Node = options.definition.Node;
    this.#bus = options.bus;
    this.#fetch = options.fetch ?? fetch;
    this.#bindings = new Set(this.manifest.bindings ?? []);
  }

  async start(url: string, token: string): Promise<void> {
    if (this.#stopped) throw new Error('host is stopped');
    if (this.#started) return;

    this.#url = url;
    this.#token = token;
    await this.#bus.connect(url, token);
    this.#bus.onCall((call) => this.#handleCall(call));
    this.#bus.onEvent?.((event) => {
      this.#events = this.#events.then(() => this.#handleEvent(event));
    });
    await this.#bus.register(this.manifest);
    this.#started = true;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    // Children first: a sub-node stops only after the host that started it says so.
    for (const child of this.#subnodes.values()) await child.host.stop();
    this.#subnodes.clear();
    for (const controller of this.#inflight) {
      controller.abort(new Error('host stopped'));
    }
    // The objects a node kept for its tenants go with the host. Nothing is called on them: the
    // host only ever held the reference, so stopping one (a queue, a pool) is the node's own code.
    this.#shared.clear();
    this.#scopes.clear();

    if (this.#started) {
      await this.#bus.unregister(this.manifest.name);
    }
    await this.#bus.close();
    this.#started = false;
  }

  /** Execute one call. Public for direct tests. */
  async invoke(call: CallEnvelope): Promise<Outcome> {
    return this.#invoke(call);
  }

  async #handleCall(call: CallEnvelope): Promise<void> {
    await this.#bus.reply(call, await this.invoke(call));
  }

  async #invoke(call: CallEnvelope): Promise<Outcome> {
    if (!this.#started) return { ok: false, error: 'host is not started' };
    if (this.#stopped) return { ok: false, error: 'host is stopped' };

    if (call.to !== this.manifest.name) {
      return { ok: false, error: `wrong node: ${call.to}` };
    }

    const cap = call.payload.cap;
    if (!Object.hasOwn(this.manifest.caps, cap)) {
      return { ok: false, error: `unknown capability: ${cap}` };
    }

    const deadline = deadlineOf(call);
    const timeout = deadline - Date.now();
    if (timeout <= 0) return { ok: false, error: 'deadline exceeded' };

    const controller = new AbortController();
    this.#inflight.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('deadline exceeded')), timeout);
    const aborted = abortPromise(controller.signal);

    let node: Node | undefined;

    try {
      const ctx = this.#context(call.tenantId, call.from, controller.signal, deadline);
      node = new this.#Node(ctx);
      const handler: NodeHandler | undefined = node.handlers[cap];

      if (!handler) {
        return {
          ok: false,
          error: `node ${this.manifest.name} has no handler for ${cap}`,
        };
      }

      const value = await Promise.race([Promise.resolve(handler(call.payload.args)), aborted]);
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
      this.#inflight.delete(controller);
      await node?.dispose();
    }
  }

  async #handleEvent(event: EventEnvelope): Promise<void> {
    if (this.#stopped) return;
    const deadline = Date.now() + CALL_DEADLINE_MS;
    const controller = new AbortController();
    this.#inflight.add(controller);
    const timer = setTimeout(
      () => controller.abort(new Error('deadline exceeded')),
      CALL_DEADLINE_MS,
    );
    let node: Node | undefined;
    try {
      const ctx = this.#context(event.tenantId, event.from, controller.signal, deadline);
      node = new this.#Node(ctx);
      if (typeof node.onEvent !== 'function') return;
      await Promise.race([
        Promise.resolve(node.onEvent(event.payload.topic, event.payload.value, event.from)),
        abortPromise(controller.signal),
      ]);
    } catch {
      // An event has no caller to answer; a handler that fails must not crash the host.
    } finally {
      clearTimeout(timer);
      this.#inflight.delete(controller);
      await node?.dispose();
    }
  }

  /** Refuse a key the package did not declare: the manifest says what a node keeps. */
  #declared(key: string): void {
    if (typeof key !== 'string' || !isBindingKey(key))
      throw new Error(`bind wants a binding name, got ${String(key)}`);
    if (this.#bindings.size === 0)
      throw new Error(
        `node ${this.manifest.name} declares no bindings; add node.bindings to its package.json`,
      );
    if (!this.#bindings.has(key))
      throw new Error(`node ${this.manifest.name} does not declare a binding named ${key}`);
  }

  /** The object a tenant keeps under one key: created on the first bind, kept until it is unbound. */
  #bind<T extends object>(tenantId: string, key: string, create: (scope: BindingScope) => T): T {
    if (this.#stopped) throw new Error('host is stopped');
    this.#declared(key);
    if (typeof create !== 'function') throw new Error('bind wants a factory function');

    const kept = this.#table(tenantId);
    const current = kept.get(key);
    if (current !== undefined && current.value !== null) return current.value as T;

    // The factory runs to completion inside this call, so nothing else can interleave with it - bar
    // code the factory itself re-enters with. An unbind that lands in that window wins: the object
    // this call just made goes to this caller and is not put back into the table.
    const epoch = current?.epoch ?? 0;
    const created = create(this.#scope(tenantId));
    if ((kept.get(key)?.epoch ?? 0) === epoch) kept.set(key, { value: created, epoch });
    return created;
  }

  /** Drop this tenant's object under one key, and say whether there was one. */
  #unbind(tenantId: string, key: string): boolean {
    if (this.#stopped) throw new Error('host is stopped');
    this.#declared(key);

    const kept = this.#table(tenantId);
    const current = kept.get(key);
    const existed = current !== undefined && current.value !== null;
    // The empty slot is a tombstone: it remembers the unbind, so a bind that was running while it
    // landed knows not to cache what it made.
    kept.set(key, { value: null, epoch: (current?.epoch ?? 0) + 1 });
    return existed;
  }

  /** The scope an object bound for this tenant gets: tenant identity and the host's own bus, with
   *  no invocation deadline, signal or context behind it. Memoised per tenant, so two tenants never
   *  see the same scope (or the same bus identity). */
  #scope(tenantId: string): BindingScope {
    const cached = this.#scopes.get(tenantId);
    if (cached !== undefined) return cached;

    const scope: BindingScope = {
      tenantId,
      nodeId: this.manifest.name,
      nodeAgentHome: nodeAgentHome(),
      home: nodeAgentDir(this.manifest.name),
      call: async <T>(node: string, cap: string, args: ToolArgs): Promise<T> => {
        if (this.#stopped) throw new Error('host is stopped');
        // A bound object has no invocation to borrow a deadline from: its work may outlive the
        // call that started it by minutes. This is the ceiling, not the caller's clock.
        return (await this.#call(
          tenantId,
          node,
          cap,
          args,
          Date.now() + CALL_DEADLINE_MS,
          null,
        )) as T;
      },
      publish: (topic: string, value: unknown): void => {
        if (topic === '') throw new Error('publish wants a topic');
        this.#bus.publish({
          id: randomUUID(),
          type: 'event',
          to: '*',
          tenantId,
          payload: { topic, value },
        });
      },
      subscribe: async (topic: string, node: string): Promise<void> => {
        if (topic === '') throw new Error('subscribe wants a topic');
        await this.#bus.subscribe?.(topic, tenantId, node);
      },
      unsubscribe: async (topic: string, node: string): Promise<void> => {
        if (topic === '') throw new Error('unsubscribe wants a topic');
        if (this.#bus.unsubscribe === undefined)
          throw new Error('this transport cannot unsubscribe from topics');
        await this.#bus.unsubscribe(topic, tenantId, node);
      },
      listNodes: () => this.#bus.listNodes(tenantId),
      listCapabilities: async (node: string): Promise<CapabilityEntry[]> => {
        if (this.#bus.listCapabilities === undefined) {
          throw new Error('this transport cannot list capabilities');
        }
        return await this.#bus.listCapabilities(node, tenantId);
      },
      fetch: this.#fetch,
      createSubNode: (options) => this.#createSubNode(tenantId, options),
      destroySubNode: (name) => this.#destroySubNode(tenantId, name),
    };
    this.#scopes.set(tenantId, scope);
    return scope;
  }

  /** Send one call and unwrap the answer. The only difference between an invocation's call and a
   *  bound object's is the deadline they carry and whether the caller can still abort it. */
  async #call(
    tenantId: string,
    node: string,
    cap: string,
    args: ToolArgs,
    deadline: number,
    signal: AbortSignal | null,
  ): Promise<unknown> {
    if (node === '' || cap === '') throw new Error('call wants a node name and a capability');
    const sent = this.#bus.call({
      id: randomUUID(),
      type: 'call',
      to: node,
      tenantId,
      deadline,
      payload: { cap, args },
    });
    const result = signal === null ? await sent : await Promise.race([sent, abortPromise(signal)]);
    if (!result.payload.ok) throw new Error(result.payload.error);
    return result.payload.value;
  }

  /** Start another node on the same bus: its own session, its own registration. */
  async #createSubNode(tenantId: string, options: SubNodeOptions): Promise<SubNode> {
    if (this.#stopped) throw new Error('host is stopped');
    if (!this.#started) throw new Error('host is not started');
    const name = options.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new Error(`"${name}" is not a usable node name: letters, digits, _ and - only`);
    }
    if (this.#subnodes.has(name)) throw new Error(`a sub-node named "${name}" already runs here`);
    const bus = this.#bus.fork?.();
    if (bus === undefined) throw new Error('this transport cannot create sub-nodes');
    let definition = options.definition;
    if (definition === undefined) {
      if (options.packageRoot === undefined) {
        throw new Error('createSubNode wants a packageRoot or a definition');
      }
      const loaded = await loadNodePackage(options.packageRoot);
      definition = { manifest: loaded.manifest, Node: loaded.Node };
    }
    // The name is the caller's, not the package's: a sub-node from one package can answer as
    // several names on the same bus.
    definition = { ...definition, manifest: { ...definition.manifest, name } };
    const host = new NodeHost({ definition, bus, fetch: this.#fetch });
    const token = this.#bus.privateTokenFor?.(tenantId) ?? this.#token;
    await host.start(this.#url, token);
    try {
      // A private registration is visible to its owner without a user-table connect. Transports
      // without private credentials fall back to connecting the shared registration explicitly.
      if (this.#bus.privateTokenFor === undefined) await bus.connectNode?.(tenantId, name);
    } catch (error) {
      await host.stop();
      throw error;
    }
    const childTenant = tenantId;
    this.#subnodes.set(name, { host, tenantId: childTenant });
    return {
      name,
      tenantId: childTenant,
      stop: async () => {
        await host.stop();
        this.#subnodes.delete(name);
      },
    };
  }

  /** Stop a sub-node this tenant started; another tenant cannot reach it. */
  async #destroySubNode(tenantId: string, name: string): Promise<boolean> {
    const child = this.#subnodes.get(name);
    if (child === undefined || child.tenantId !== tenantId) return false;
    this.#subnodes.delete(name);
    await child.host.stop();
    return true;
  }

  #table(tenantId: string): Map<string, Kept> {
    let kept = this.#shared.get(tenantId);
    if (kept === undefined) {
      kept = new Map();
      this.#shared.set(tenantId, kept);
    }
    return kept;
  }

  #context(tenantId: string, from: string, signal: AbortSignal, deadline: number): NodeHostContext {
    // Everything that does not depend on this invocation is the tenant scope's own: one definition
    // of publish/subscribe/directory/fetch, not two copies that can drift apart.
    const scope = this.#scope(tenantId);
    return {
      // The registered name, which the runner has already rewritten when a runtime overrode it:
      // this is the same string `#invoke` checks `call.to` against.
      nodeId: this.manifest.name,
      nodeAgentHome: nodeAgentHome(),
      home: nodeAgentDir(this.manifest.name),
      tenantId,
      from,
      deadline,
      signal,
      bind: <T extends object>(key: string, create: (scope: BindingScope) => T): T =>
        this.#bind(tenantId, key, create),
      unbind: (key: string): boolean => this.#unbind(tenantId, key),
      call: async <T>(node: string, cap: string, args: ToolArgs): Promise<T> => {
        if (Date.now() >= deadline) throw new Error('deadline exceeded');
        return (await this.#call(tenantId, node, cap, args, deadline, signal)) as T;
      },
      subscribe: scope.subscribe,
      unsubscribe: scope.unsubscribe,
      listNodes: scope.listNodes,
      listCapabilities:
        this.#bus.listCapabilities === undefined ? undefined : scope.listCapabilities,
      fetch: scope.fetch,
      publish: scope.publish,
      createSubNode: (options) => this.#createSubNode(tenantId, options),
      destroySubNode: (name) => this.#destroySubNode(tenantId, name),
    };
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('invocation aborted'));
    };

    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}
