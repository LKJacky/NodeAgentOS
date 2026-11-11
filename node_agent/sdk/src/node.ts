import type { CapabilityEntry, NodeEntry, ToolArgs } from './envelope.js';
import type { NodeDefinition } from './host.js';

/** What `createSubNode` takes: a bus name, and either a package to load it from or an explicit
 *  definition. The tenant defaults to the creating scope's. */
export type SubNodeOptions = {
  readonly name: string;
  readonly packageRoot?: string;
  readonly definition?: NodeDefinition;
};

/** A node this host started: its name, its tenant, and the one way to end it. */
export type SubNode = {
  readonly name: string;
  readonly tenantId: string;
  stop(): Promise<void>;
};

/**
 * The object-keeping half of a context: one object per (tenant, key) in the host, of a shape only
 * the node knows. Optional on `NodeContext`, because only a host-built context can keep anything -
 * a context put together by hand (a startup pass, a test) has nothing to keep objects for. Reach it
 * with `requireBindings(ctx)` rather than by testing the members yourself.
 */
export interface NodeBindings {
  bind<T extends object>(key: string, create: (scope: BindingScope) => T): T;
  unbind(key: string): boolean;
}

/**
 * The host-lifetime side of a binding: who the object is, and the bus it keeps talking on.
 *
 * A bound object outlives the invocation that created it (`chat_no_wait`, a streamed answer), so it
 * cannot borrow the invocation's context: that context carries the caller's deadline, their abort
 * signal, and a `call` that dies with the call. Everything here comes from the host's persistent
 * session and lives until the host (or the tenant's binding) is dropped.
 */
export interface BindingScope {
  /** The tenant this object belongs to; the host keeps one scope per tenant. */
  readonly tenantId: string;
  /** The bus name this process answers to. */
  readonly nodeId: string;
  /** Root for persistent node-agent files, from `$NODE_AGENT_HOME`. */
  readonly nodeAgentHome: string;
  /** This node's private directory: `<nodeAgentHome>/<nodeId>`. */
  readonly home: string;
  /** Call a capability with no invocation deadline: the object's work has a lifetime of its own. */
  call<T = unknown>(node: string, cap: string, args: ToolArgs): Promise<T>;
  publish(topic: string, value: unknown): void;
  subscribe(topic: string, node: string): Promise<void>;
  unsubscribe?(topic: string, node: string): Promise<void>;
  listNodes(): Promise<NodeEntry[]>;
  listCapabilities(node: string): Promise<CapabilityEntry[]>;
  readonly fetch: typeof fetch;
  /** Start another node on the same bus, from a package directory or an explicit definition. A
   *  transport that cannot open a second session refuses. */
  createSubNode(options: SubNodeOptions): Promise<SubNode>;
  /** Stop a node this scope started (its own tenant only), and say whether there was one. */
  destroySubNode(name: string): Promise<boolean>;
}

/**
 * The only runtime capabilities a node receives. The host builds one of these
 * per invocation; a node must not keep it beyond dispose().
 */
export interface NodeContext extends Partial<NodeBindings> {
  /** Single-user tenant: this is both the tenant id and the user id. */
  readonly tenantId: string;

  /** Authenticated caller node name for this invocation. */
  readonly from: string;

  /** The bus name this package registered under: the manifest's `name`, after any runtime override
   *  (`ServeOptions.id`, `--name`). This is the node's own address - `from` is the caller's. */
  readonly nodeId: string;

  /** Root for persistent node-agent files, from `$NODE_AGENT_HOME` (default `~/.node_agent`). */
  readonly nodeAgentHome: string;

  /** This node's private directory: `<nodeAgentHome>/<nodeId>`. Every durable file this node owns
   *  belongs under here. */
  readonly home: string;

  /** Epoch milliseconds. Handlers should stop once this has passed. */
  readonly deadline: number;

  /** Aborted when the caller cancels or the host times the invocation out. */
  readonly signal: AbortSignal;

  /**
   * The object this node keeps for a tenant, under a key of its own choosing. Present on every
   * context a NodeHost builds; absent from one built by hand.
   *
   * One object per (tenant, key) in this host: the first call runs `create`, every later call with
   * that key and tenant gets the same object, and another tenant gets another one. The SDK never
   * looks inside it - it calls no method, serializes nothing, and knows no shape - so what the
   * object is (a task manager, a connection pool, a session table) and what it can do is the
   * node's business. `create` runs inside this call; a factory that throws caches nothing, so the
   * next bind tries again. The key must be one the package declared in `node.bindings`.
   */
  bind?<T extends object>(key: string, create: (scope: BindingScope) => T): T;

  /**
   * Forget the object this tenant keeps under `key`, and answer whether there was one.
   *
   * The host drops the reference and returns; it does not call `dispose`, `stop`, `close` or
   * anything else on the object, because it never knew what the object was. If something has to be
   * ended, the node ends it first and then unbinds. Other tenants keep their own objects. The next
   * `bind` of that key runs the factory again.
   */
  unbind?(key: string): boolean;

  /** Call a capability on another node. The host adds caller identity and deadline. */
  call<T = unknown>(node: string, cap: string, args: ToolArgs): Promise<T>;

  /** The bus directory for this tenant, when the host has a transport that can read one. */
  listNodes?(): Promise<NodeEntry[]>;

  /** What one node offers, when the host has a transport that can read a directory. */
  listCapabilities?(node: string): Promise<CapabilityEntry[]>;

  /** Ask the bus to keep this node posted on a topic for this tenant. */
  subscribe?(topic: string, node: string): Promise<void>;

  /** Stop that posting. */
  unsubscribe?(topic: string, node: string): Promise<void>;

  /** The current bus directory. */
  listNodes?(): Promise<import('./envelope.js').NodeEntry[]>;

  /** The capabilities one registered node exposes. Optional: a transport may not answer it, in
   *  which case a caller probes a capability directly instead. */
  listCapabilities?(node: string): Promise<import('./envelope.js').CapabilityEntry[]>;

  /** Start another node on the same bus, when the host can open a second session. */
  createSubNode?(options: SubNodeOptions): Promise<SubNode>;
  /** Stop a node this context's host started. */
  destroySubNode?(name: string): Promise<boolean>;

  /** Fire-and-forget event publication. */
  publish(topic: string, value: unknown): void;

  /** Outbound HTTP for this host; a test host may replace it, production uses the platform fetch. */
  readonly fetch: typeof fetch;
}

/** A context a NodeHost built: it always carries the binding surface. */
export interface NodeHostContext extends NodeContext {
  bind<T extends object>(key: string, create: (scope: BindingScope) => T): T;
  unbind(key: string): boolean;
  createSubNode(options: SubNodeOptions): Promise<SubNode>;
  destroySubNode(name: string): Promise<boolean>;
}

/**
 * The binding surface of a context, or a refusal that says why there is none.
 *
 * A node that keeps something calls this once and uses what it gets back; it never has to test
 * `ctx.bind` itself, and it fails loudly in the one place where bindings cannot exist - a context
 * built by hand, outside a host.
 */
export function requireBindings(ctx: NodeContext): NodeBindings {
  const { bind, unbind } = ctx;
  if (typeof bind !== 'function' || typeof unbind !== 'function')
    throw new Error(
      `ctx.bind is unavailable: this context was not built by a NodeHost (node ${ctx.nodeId})`,
    );
  return { bind, unbind };
}

/** One capability handler. */
export type NodeHandler = (args: ToolArgs) => Promise<unknown> | unknown;

/** Capability name -> handler. NodeHost owns dispatch; a Node never switches on cap. */
export type NodeHandlers = Readonly<Record<string, NodeHandler>>;

/**
 * A user-defined node.
 *
 * One instance is created per invocation and disposed after the handler
 * settles. Do not put request state in module-level variables; use the
 * instance or `this.ctx` for request-scoped values, and `ctx.bind` for the
 * object a tenant keeps between invocations.
 */
export abstract class Node {
  readonly ctx: NodeContext;

  constructor(ctx: NodeContext) {
    this.ctx = ctx;
  }

  /** Every capability this node exposes, keyed by its local name. */
  abstract readonly handlers: NodeHandlers;

  /** Optional cleanup. The host always calls it in a finally block. */
  dispose(): Promise<void> | void {}

  /** Handle one bus event. The host builds a fresh Node for every event, so this method must not
   *  rely on state from an earlier call. */
  onEvent?(topic: string, value: unknown, from: string): Promise<void> | void;
}

/** Constructor shape used by NodeHost. */
export type NodeClass = new (ctx: NodeContext) => Node;
