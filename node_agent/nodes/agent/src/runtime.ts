// The agent itself — transcript, queue, turns, stop — kept apart from the node that serves it.
//
// The SDK builds one Node per invocation, so nothing here may live in the Node: this runtime is one
// per bus name, made on the first call and shared by every invocation that follows. It owns the one
// model, the one queue and the one turn, which is what makes `stop` from one call stop the turn
// another call opened.
//
// One turn is one round at a time: take the highest-priority message waiting, run the model, run the
// tools it asked for, and go round again until the model answers in prose and nothing is left in the
// `interpret` lane. `chat` is "queue a message with a promise and await it"; `priority` is the
// queue's order: `interpret` (in at the end of the round that is running) or `queue` (the default).
//
// Sub-agents are runtimes of this same class, held by their parent in this process, not nodes on the
// bus: one tenant registers one identity, and a node the bus does not know has no permission on it,
// which is why a sub-agent used to be refused capabilities its own parent could call. A sub-agent
// keeps its own transcript, queue, round budget and stop, and reaches the bus through its parent's
// identity - so it may call whatever the parent may call.
import type { BindingScope } from '@node-agent/sdk';
import { Cache, historyOverBus, type CacheHistory } from './cache.js';
import { agentLog } from './log.js';
import { agentNameOf } from './names.js';
import { AgentBusEnv, CANCELLED } from './env.js';
import {
  emptyUsage,
  PRIORITY_RANK,
  priorityOf,
  QUEUE,
  utcIn,
  utcNow,
  type Priority,
} from './helpers.js';
import {
  CachedModel,
  NodeProvider,
  ProviderNodes,
  STREAM_TOPIC_PREFIX,
  StatedModel,
  StreamHub,
  type ModelOptions,
} from './model.js';
import type { Message, Provider, ToolCall, UsageSummary } from './types.js';

/** How many messages one `history` answer may carry. */
export const HISTORY_MAX = 200;

/** The default question timeout, in seconds. */
export const ASK_TIMEOUT_SECONDS = 300;

/** One line handed to the agent, with the promise its caller is waiting on. */
type Round = {
  readonly message: Message;
  readonly priority: Priority;
  readonly seq: number;
  start: number;
  resolve: (messages: Message[]) => void;
  reject: (error: Error) => void;
};

/** A question the model asked and the reader has not answered yet. */
type PendingAsk = {
  readonly id: string;
  readonly input: 'button' | 'text';
  readonly default: string | null;
  readonly deadline: string | null;
  settle: (answer: string | null) => void;
  timer?: NodeJS.Timeout;
};

export type RuntimeOptions = {
  readonly historyRequired?: boolean;
  readonly allowAskUser?: boolean;
  /** Whether this runtime may start sub-agents; a sub-agent itself never may. */
  readonly allowSpawn?: boolean;
  readonly maxAgents?: number;
  readonly cacheSize?: number;
  readonly maxInputPerTurn?: number;
  readonly compressionThreshold?: number;
  readonly compressionTokens?: number;
  /** A provider handed in by the caller (a test, or an embedder that holds its own model). */
  readonly provider?: Provider;
  /** The provider row to start from when history has none (Python's provider_name). */
  readonly providerName?: string;
  /** A tab drawing for this agent's own panel (validated `<svg>...</svg>`). */
  readonly icon?: string;
  /** Called with every line committed to the transcript, for the page. */
  readonly onCommit?: ModelOptions['onCommit'];
  readonly onUpdate?: ModelOptions['onUpdate'];
};

/** What `agent.status` answers: what the agent is doing, what is waiting behind it, what it spent. */
export type AgentStatus = {
  state: 'idle' | 'generating' | 'tool' | 'stopping';
  queued: Message[];
  usage: UsageSummary;
};

/** One row of the page's agent switch: who is there to look at, and what each one is doing. */
export type AgentRow = {
  /** What an `agent` argument names it with. */
  name: string;
  /** The topic its transcript, snapshots and questions are published on. */
  topic: string;
  /** The agent that started it, or null for the main agent. */
  parent: string | null;
  state: 'idle' | 'generating' | 'tool' | 'stopping';
  /** How many sub-agents it runs (a sub-agent always answers 0). */
  children: number;
  /** The drawing it was created with, when it was given one. */
  icon?: string;
};

/** One sub-agent as the `subagents` history unit stores it. */
type StoredAgent = { name: string; icon?: string; provider?: string };

/** Read either the current `{agents:[{...}]}` shape or the old `{names:[...]}` one. */
function storedAgentOf(value: unknown): StoredAgent | null {
  if (typeof value === 'string') return { name: value };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const saved = value as { name?: unknown; icon?: unknown; provider?: unknown };
  if (typeof saved.name !== 'string' || saved.name === '') return null;
  return {
    name: saved.name,
    ...(typeof saved.icon === 'string' ? { icon: saved.icon } : {}),
    ...(typeof saved.provider === 'string' ? { provider: saved.provider } : {}),
  };
}

/** What `agent.history` answers: a window of the transcript and where it sits in it. */
export type HistoryWindow = { from: number; total: number; messages: Message[] };

function messageOf(value: unknown): Message {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('a chat message must be an object like { role: "user", content: "..." }');
  }
  const raw = value as Record<string, unknown>;
  const role = raw.role ?? 'user';
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
    throw new Error(`unknown message role: ${String(role)}`);
  }
  const content = raw.content;
  if (typeof content !== 'string') throw new Error('a chat message needs content as a string');
  return { role, content };
}

function stamp(): string {
  // The reader's clock, as the Python twin writes it: `2026-10-29 16:29:18 UTC+08:00`.
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const text = now.toISOString().replace('T', ' ').slice(0, 19);
  return `${text} UTC+08:00`;
}

/** The caller's name and its clock, in front of the line the model reads: a message handed over by
 *  another node says who handed it over. */
export function addMetaInfo(source: string, content: string): string {
  return `FROM: ${source}, TIME: ${stamp()}\n\n${content}`;
}

/** What one runtime is made of. The host's `ctx.bind` owns the instance; this type says only what
 *  it needs to exist. */
export type RuntimeInit = {
  readonly options?: RuntimeOptions;
  /** The host-lifetime bus of this tenant: identity, call, publish, directory, fetch. Never an
   *  invocation's context - a background turn outlives the call that opened it. */
  readonly scope: BindingScope;
  /** The name this agent answers to in the page and in `run_on_node`'s `node`: the bus name for the
   *  main agent, its own name for a sub-agent. */
  readonly name?: string;
  /** The topic this agent publishes its transcript and its questions on. A sub-agent publishes on
   *  `<the bus name>.<its own name>`, so a page can follow one agent at a time. */
  readonly topic?: string;
  /** What every history unit of this agent starts with: `''` for the main agent, `sub.<name>.` for a
   *  sub-agent. One bus identity holds one transcript per agent, kept apart by this. */
  readonly unitPrefix?: string;
  /** The runtime that started this one. A sub-agent inherits its identity, its provider and its
   *  cache from it, and may not start one of its own. */
  readonly parent?: AgentRuntime;
};

/** What one invocation tells the object it hands work to. The object keeps none of the context
 *  itself; `from` names the caller in the line the model reads, `deadline` is theirs to watch. */
export type ChatMeta = {
  readonly from?: string;
  readonly deadline?: number;
};

/** The opaque strings derived once from the scope. A bus name is a wire fact: the identity every
 *  agent of one family shares, and the node history files a unit under. The topic is where one
 *  agent's transcript is published, which is what keeps a main agent and its sub-agents apart on
 *  one identity. History is the server's: it names its own user and tenant, and a calling node
 *  sends neither. */
/** Why an icon cannot be a tab drawing, or null when it can: one `<svg>...</svg>`, no script. */
function iconProblem(icon: unknown): string | null {
  if (typeof icon !== 'string') return 'icon must be a string of SVG source';
  if (new TextEncoder().encode(icon).length > 8192) return 'icon is longer than 8192 bytes';
  const drawing = icon.trim();
  if (!drawing.startsWith('<svg') || !drawing.endsWith('</svg>')) {
    return 'icon must be one <svg>…</svg> element, and nothing else';
  }
  if (/<script|on\w+\s*=|javascript:/i.test(drawing)) {
    return 'icon carries <script>, an on…= handler or javascript:';
  }
  return null;
}

type RuntimeIdentity = {
  /** The bus name the whole family answers to: one tenant, one registration. */
  readonly busName: string;
  /** Where this agent publishes: the bus name, or `<bus name>.<its own name>` for a sub-agent. */
  readonly topic: string;
};

function identityOf(scope: BindingScope, topic?: string): RuntimeIdentity {
  if (scope.nodeId === '') throw new Error('the binding scope has no identity');
  return { busName: scope.nodeId, topic: topic ?? scope.nodeId };
}

/** A sub-agent's name: what the page shows, what `run_on_node`'s `node` names and what its history
 *  units are filed under, so it holds the bus-name alphabet and nothing else. */
const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function agentNameProblem(name: string, busName: string): string | null {
  if (name === '') return 'a name is required';
  if (!AGENT_NAME.test(name)) {
    return 'a name may hold letters, digits, "-" and "_", at most 64 of them';
  }
  if (name === busName || name === 'agent' || name === 'history') return `"${name}" is reserved`;
  return null;
}

export class AgentRuntime {
  /** The tenant's bus, and the only place this object reads who it is: identity, calls, publish,
   *  directory, fetch. Never an invocation's context. */
  readonly scope: BindingScope;
  /** The opaque strings derived once from the scope; nothing here reads tenant/node ids. */
  readonly identity: RuntimeIdentity;
  /** The name one `agent` argument uses for this runtime: the bus name, or a sub-agent's own. */
  readonly name: string;
  /** The runtime that started this one, or null for the main agent. */
  readonly parent: AgentRuntime | null;
  /** What this agent's history units start with: `''`, or `sub.<name>.` for a sub-agent. */
  readonly unitPrefix: string;
  readonly options: RuntimeOptions;
  readonly cache: Cache;
  readonly providerNodes: ProviderNodes;
  /** The streams this family is waiting on. One hub for the main agent and every sub-agent: the bus
   *  delivers an event to the node, the node hands it to the main runtime, and a sub-agent that chose
   *  a provider of its own has its queue in the same place. Stream ids are unique, so sharing costs
   *  nothing and a child's stream cannot be missed. */
  readonly hub: StreamHub;
  env: AgentBusEnv | null = null;
  model: CachedModel | null = null;

  #starting: Promise<void> | null = null;
  #loading: Promise<CachedModel> | null = null;
  #queue: Round[] = [];
  #waiting: Round[] = [];
  #wake: (() => void) | null = null;
  #idleWaiters: (() => void)[] = [];
  #pumping = false;
  #seq = 0;
  #step: { controller: AbortController; tool: ToolCall | null } | null = null;
  #duringStop = false;
  #closed = false;
  #provider: Provider | null = null;
  readonly #children = new Map<string, AgentRuntime>();
  #restored = false;
  #providerName: string | null = null;
  #providerRevision: number | null = null;

  readonly #asks = new Map<string, PendingAsk>();
  readonly #timedOut = new Map<string, string | null>();
  readonly #earlyAnswers = new Map<string, string>();
  #askSeq = 0;

  constructor(init: RuntimeInit) {
    const { scope } = init;
    this.scope = scope;
    this.identity = identityOf(scope, init.topic);
    this.name = init.name ?? this.identity.busName;
    this.parent = init.parent ?? null;
    this.hub = this.parent?.hub ?? new StreamHub();
    this.unitPrefix = init.unitPrefix ?? '';
    this.options = init.options ?? {};
    const fromEnv = Number(process.env.NODE_AGENT_CACHE_SIZE ?? '');
    this.cache = new Cache(
      this.options.cacheSize ?? (Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : 500),
      null,
    );
    this.providerNodes = new ProviderNodes(() => this.bus());
  }

  /** The tenant's bus, viewed through the same small interface the rest of the package uses. */
  bus(): BindingScope {
    return this.scope;
  }

  get providerName(): string | null {
    return this.#providerName;
  }

  /** Bind the bus this runtime talks through and initialize its cache and environment. The model is
   *  deliberately lazy: the agent and its page stay available while no provider is on the bus. */
  async ready(): Promise<void> {
    if (this.#starting === null) this.#starting = this.#start();
    await this.#starting;
  }

  async #start(): Promise<void> {
    const started = Date.now();
    agentLog('info', 'agent.start', { agent: this.name, parent: this.parent?.name });
    const bus = this.bus();
    this.env = new AgentBusEnv(
      {
        busName: this.identity.busName,
        selfName: this.name,
        bus,
        cache: this.cache,
        ask: (callId, args) => this.ask(callId, args),
        spawnAgent: (name, icon, provider) => this.spawnAgent(name, icon, provider),
        destroyAgent: (name) => this.destroyAgent(name),
      },
      {
        allowAskUser: this.options.allowAskUser ?? true,
        allowSpawn: this.allowSpawn(),
      },
    );
    const history = await this.#historyIfPresent();
    this.cache.useHistory(history);
    await this.cache.restore();
    await this.#restoreAgents();
    agentLog('info', 'agent.ready', {
      agent: this.name,
      history: history !== null,
      ms: Date.now() - started,
    });
  }

  /** The history node's surface, or null when this bus has none: a transcript kept in memory only is
   *  what a stack without history gets, rather than an agent that does not start. */
  async #historyIfPresent(): Promise<CacheHistory | null> {
    try {
      const nodes = await this.bus().listNodes();
      if (!nodes.some((node) => node.name === 'history')) return null;
    } catch {
      return null;
    }
    return this.#history();
  }

  /** Build the model on the first turn: the provider it will use, and the transcript it continues. */
  async #ensureModel(): Promise<CachedModel> {
    if (this.model !== null) return this.model;
    if (this.#loading === null) {
      const loading = this.#loadModel();
      this.#loading = loading;
      void loading.catch(() => {
        if (this.#loading === loading) this.#loading = null;
      });
    }
    return await this.#loading;
  }

  async #loadModel(): Promise<CachedModel> {
    const history = this.cache.enabled ? await this.#historyIfPresent() : null;
    const provider = await this.#resolveProvider();
    const options: ModelOptions = {
      compressionThreshold: this.options.compressionThreshold,
      compressionTokens: this.options.compressionTokens,
      onCommit: this.options.onCommit ?? ((messages) => this.#announce(messages)),
      onUpdate: this.options.onUpdate ?? ((message) => this.#announceStream(message)),
    };
    let model: CachedModel =
      history === null
        ? new CachedModel(provider, options)
        : new StatedModel(provider, history, options);
    if (model instanceof StatedModel) {
      try {
        await model.load();
      } catch (error) {
        if (this.options.historyRequired ?? true) throw error;
        console.warn(
          `agent: failed to load history; persistent history is disabled: ${error instanceof Error ? error.message : String(error)}`,
        );
        model = new CachedModel(provider, options);
      }
    }
    this.model = model;
    agentLog('info', 'model.loaded', {
      agent: this.name,
      provider: this.providerName,
      persistent: model instanceof StatedModel,
    });
    return model;
  }

  /** The provider this agent talks through: a row of a provider node on the bus, or the one an
   *  embedder passed in. The bus is the only production source — there is no keyless stand-in, so a
   *  bus without a provider answers with an error instead of an invented answer.
   *
   *  A sub-agent is no different from the main agent here: it was handed a row when it was created
   *  (its parent's, unless it was given one), it keeps its own copy of that choice in its own
   *  history, and a switch by the parent afterwards does not reach it. */
  async #resolveProvider(): Promise<Provider> {
    if (this.#provider !== null) return this.#provider;
    if (this.options.provider !== undefined) {
      this.#provider = this.options.provider;
      return this.#provider;
    }
    let rows: string[] = [];
    try {
      rows = await this.providerNodes.names();
    } catch {
      rows = [];
    }
    const stored = await this.#loadActiveProvider();
    const selected = this.#providerName ?? stored ?? this.options.providerName ?? null;
    const chosen = ProviderNodes.rowOf(selected, rows) ?? selected ?? rows[0] ?? null;
    this.#providerName = chosen;
    this.#provider = this.#makeNodeProvider(chosen);
    return this.#provider;
  }

  /** Tell the page that a line was committed; a bus that cannot publish is not a failed turn. */
  #announce(messages: readonly Message[]): void {
    try {
      this.scope.publish(this.identity.topic, messages);
    } catch {
      // A listener that is gone is not a turn that failed.
    }
  }

  /** A snapshot of the answer while it streams. Not a transcript entry. */
  #announceStream(message: Message): void {
    try {
      this.scope.publish(this.identity.topic, { type: 'stream', message });
    } catch {
      // Same: watching a turn is a convenience, not a deliverable.
    }
  }

  /** History files units under the calling node, and the whole family shares one calling node: the
   *  prefix (`''` for the main agent, `sub.<name>.` for a sub-agent) is what keeps one agent's
   *  transcript, cache and provider row apart from the others'. */
  #history(): CacheHistory {
    return historyOverBus(this.bus(), this.unitPrefix);
  }

  /** Start an agent under this runtime's identity. A sub-agent is a runtime of this same class,
   *  held here: it publishes on its own topic, files its units under its own prefix, and is not a
   *  node - so nothing about its permissions is separate from its parent's.
   *
   *  `icon` is required - its tab has to be told apart from the others - and `provider` is not. Only
   *  a restore passes less: a `subagents` unit written before icons were required keeps no drawing,
   *  and the page falls back to its own. */
  async spawnAgent(name: string, icon?: string, provider?: string): Promise<string> {
    return await this.#spawnAgent(name, icon, provider, true);
  }

  /** The row a new sub-agent starts on: the one it was named with, else the row its parent is on
   *  right now - copied once, at creation, so a later switch by the parent does not reach it. Empty
   *  when neither names a row (no provider node on the bus yet): the child then settles on the first
   *  row itself, exactly as the main agent would. */
  async #providerForChild(provider: string | undefined): Promise<string> {
    const named = typeof provider === 'string' ? provider.trim() : '';
    if (named !== '') return named;
    const own = await this.#ownProviderName();
    if (own !== null) return own;
    let rows: string[] = [];
    try {
      rows = await this.providerNodes.names();
    } catch {
      rows = [];
    }
    const chosen = rows[0] ?? '';
    if (chosen !== '') this.#providerName = chosen;
    return chosen;
  }

  async #spawnAgent(
    name: string,
    icon: string | undefined,
    provider: string | undefined,
    persist: boolean,
  ): Promise<string> {
    if (!this.allowSpawn()) throw new Error('this agent may not create sub-agents');
    const wanted = name.trim();
    const problem = agentNameProblem(wanted, this.identity.busName);
    if (problem !== null) return `cannot create "${wanted}": ${problem}`;
    // An agent asked for by a model comes with its drawing: a tab with no icon is a tab the reader
    // cannot tell from the others. A restore is the one caller that may pass nothing, because the
    // unit it reads may have been written before this was required.
    if (persist && (icon === undefined || icon.trim() === '')) {
      return (
        `cannot create "${wanted}": an icon is required - the tab drawing as one <svg>...</svg> ` +
        'of SVG source'
      );
    }
    if (this.#children.has(wanted)) return `an agent named "${wanted}" already runs here`;
    const fromEnv = Number(process.env.NODE_AGENT_MAX_AGENTS ?? '');
    const max =
      this.options.maxAgents ?? (Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : 32);
    if (this.#children.size >= max) {
      return `cannot create "${wanted}": too many agents are running`;
    }
    if (icon !== undefined) {
      const bad = iconProblem(icon);
      if (bad !== null) return `cannot create "${wanted}": ${bad}`;
    }
    // A sub-agent manages its provider exactly like the main agent does: it is given a row when it
    // is created - its own if one was named, the parent's current row otherwise - and after that the
    // choice is its own. Nothing follows the parent's later switches.
    const selectedProvider = await this.#providerForChild(provider);
    const child = new AgentRuntime({
      scope: this.scope,
      parent: this,
      name: wanted,
      topic: `${this.identity.topic}.${wanted}`,
      unitPrefix: `sub.${wanted}.`,
      options: {
        historyRequired: this.options.historyRequired,
        compressionThreshold: this.options.compressionThreshold,
        compressionTokens: this.options.compressionTokens,
        cacheSize: this.cache.maxSize,
        allowAskUser: false,
        allowSpawn: false,
        ...(icon !== undefined ? { icon: icon.trim() } : {}),
        ...(selectedProvider !== '' ? { providerName: selectedProvider } : {}),
        // An embedder that handed this runtime a provider object hands it to the children too: a
        // bus row is what a deployment uses, and this is the in-process stand-in for one.
        ...(selectedProvider === '' && this.options.provider !== undefined
          ? { provider: this.options.provider }
          : {}),
      },
    });
    await child.ready();
    this.#children.set(wanted, child);
    agentLog('info', 'agent.spawned', { parent: this.name, agent: wanted });
    if (persist) await this.#saveAgents();
    return (
      `created agent "${wanted}". Hand it a turn with run_on_node ` +
      `{node: "${this.identity.busName}", tool_name: "chat", ` +
      `tool_args: {agent: "${wanted}", msg: {role: "user", content: "..."}}}; ` +
      'it shares this bus identity with you and keeps its own transcript, round budget and stop, ' +
      'so ask it for a short report back. It cannot create agents of its own.'
    );
  }

  allowSpawn(): boolean {
    return this.options.allowSpawn ?? true;
  }

  /** The agents this agent runs: itself first, then the sub-agents it started. A sub-agent never
   *  appears here as a node, because it is not one. */
  agentRows(): AgentRow[] {
    const own: AgentRow = {
      name: this.name,
      topic: this.identity.topic,
      parent: this.parent?.name ?? null,
      state: this.phase(),
      children: this.#children.size,
      ...(this.options.icon !== undefined ? { icon: this.options.icon } : {}),
    };
    const rows: AgentRow[] = [own];
    for (const [name, child] of this.#children) {
      rows.push({
        name,
        topic: child.identity.topic,
        parent: this.name,
        state: child.phase(),
        children: 0,
        ...(child.options.icon !== undefined ? { icon: child.options.icon } : {}),
      });
    }
    return rows;
  }

  /** Every agent of this family, asked from wherever the caller stands: the root's own row first,
   *  then the sub-agents it started. A sub-agent holds no reference to its siblings, so the walk
   *  goes up: the family is what the root runs, not what one branch can see. */
  familyRows(): AgentRow[] {
    let root: AgentRuntime = this;
    while (root.parent !== null) root = root.parent;
    return root.agentRows();
  }

  /** The runtime one `agent` argument names: this one, a sub-agent of this one, or a refusal that
   *  says which names there are. */
  agent(name: unknown): AgentRuntime {
    const wanted = typeof name === 'string' ? agentNameOf(name.trim()) : '';
    if (wanted === '' || wanted === this.name) return this;
    const child = this.#children.get(wanted);
    if (child !== undefined) return child;
    const known = [this.name, ...this.#children.keys()].join(', ');
    throw new Error(`no agent named "${wanted}" here (agents: ${known})`);
  }

  /** Stop a sub-agent and delete the units it wrote: only this identity can list them, which is why
   *  the delete happens here and not in the sub-agent's own process-shaped copy. */
  async destroyAgent(name: string): Promise<string> {
    agentLog('info', 'agent.destroy', { parent: this.name, agent: name });
    const child = this.#children.get(name);
    if (child === undefined) {
      return `no agent named "${name}" was created here (running: ${[...this.#children.keys()].join(', ') || 'none'})`;
    }
    await child.close();
    const left = await child.destroySelf();
    this.#children.delete(name);
    await this.#saveAgents();
    if (left.length > 0) {
      return `destroyed agent "${name}" (${left.length} of its persisted units could not be deleted: ${left.join('; ')})`;
    }
    return `destroyed agent "${name}" (its transcript is deleted)`;
  }

  /** Delete every unit this agent filed under its own prefix, and answer what would not go. The main
   *  agent's prefix is empty: its own wipe takes its sub-agents' units with it, which is what closing
   *  the family means. */
  async destroySelf(): Promise<string[]> {
    const left: string[] = [];
    const history = this.#history();
    const listed = async (): Promise<{ unitId: string; revision?: number }[]> => {
      try {
        const units = await history.units();
        return units.filter((unit) => unit.unitId.startsWith(this.unitPrefix));
      } catch (error) {
        left.push(`*: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    };
    for (const unit of await listed()) {
      try {
        await this.bus().call('history', 'delete', {
          unitId: unit.unitId,
          ...(unit.revision !== undefined ? { expectedRevision: unit.revision } : {}),
        });
      } catch (error) {
        left.push(`${unit.unitId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const unit of await listed()) left.push(`${unit.unitId}: still there after delete`);
    return left;
  }

  async #saveAgents(): Promise<void> {
    try {
      const agents: StoredAgent[] = [...this.#children.entries()].map(([name, child]) => {
        const provider = child.providerName ?? child.options.providerName;
        return {
          name,
          ...(child.options.icon !== undefined ? { icon: child.options.icon } : {}),
          ...(provider !== undefined ? { provider } : {}),
        };
      });
      // `names` stays for a reader written before `agents` existed; the new shape is what keeps
      // the drawing and the provider choice across a restart.
      await this.#history().save('subagents', {
        names: agents.map((agent) => agent.name),
        agents,
      });
    } catch {
      // A note about children may not fail the turn.
    }
  }

  async #restoreAgents(): Promise<void> {
    if (this.#restored || !this.allowSpawn()) return;
    this.#restored = true;
    try {
      const unit = await this.#history().load('subagents');
      const meta = unit?.meta as { names?: unknown; agents?: unknown } | undefined;
      const listed = Array.isArray(meta?.agents)
        ? meta.agents
        : Array.isArray(meta?.names)
          ? meta.names
          : [];
      for (const row of listed) {
        const saved = storedAgentOf(row);
        if (saved === null) continue;
        try {
          const answer = await this.#spawnAgent(saved.name, saved.icon, saved.provider, false);
          if (answer.startsWith('cannot create')) throw new Error(answer);
        } catch {
          // One unavailable child must not prevent the remaining children from being restored.
        }
      }
    } catch {
      // Names that cannot be read are names that are not there.
    }
  }

  #makeNodeProvider(name: string | null): NodeProvider {
    return new NodeProvider(() => this.bus(), this.providerNodes, this.hub, name);
  }

  /** The provider this agent has chosen for itself: the row it settled on, the one it stored, or the
   *  one it was created with. Null means it has never chosen: a sub-agent then answers through the
   *  main agent's provider, and follows that choice when it changes. */
  async #ownProviderName(): Promise<string | null> {
    if (this.#providerName !== null) return this.#providerName;
    const stored = this.options.providerName ?? (await this.#loadActiveProvider());
    if (stored !== null) this.#providerName = stored;
    return stored;
  }

  async #loadActiveProvider(): Promise<string | null> {
    if (!this.cache.enabled) return null;
    try {
      const unit = await this.#history().load('active_provider');
      const meta = unit?.meta as { name?: unknown } | undefined;
      return typeof meta?.name === 'string' ? meta.name : null;
    } catch {
      return null;
    }
  }

  async #persistActiveProvider(name: string): Promise<void> {
    if (!this.cache.enabled) return;
    try {
      const history = this.#history();
      const revision = await history.save(
        'active_provider',
        { name },
        this.#providerRevision ?? undefined,
      );
      if (revision !== null) this.#providerRevision = revision;
    } catch (error) {
      console.warn(`agent: could not store the active provider: ${String(error)}`);
    }
  }

  // chat

  /** Queue a message and answer with the lines its turn added. */
  async chat(
    value: unknown,
    meta: ChatMeta = {},
    priorityValue: unknown = QUEUE,
  ): Promise<Message[]> {
    await this.ready();
    const priority = priorityOf(priorityValue);
    const line = messageOf(value);
    line.content = addMetaInfo(meta.from ?? 'unknown', line.content ?? '');
    await this.#ensureModel();
    // The promise exists before the line joins the queue: a turn that runs to its end inside the
    // first microtasks must find a place to answer already there.
    let settle!: { resolve: (messages: Message[]) => void; reject: (error: Error) => void };
    const answered = new Promise<Message[]>((resolve, reject) => {
      settle = { resolve, reject };
    });
    agentLog('debug', 'message.queued', {
      agent: this.name,
      priority,
      bytes: typeof line.content === 'string' ? line.content.length : 0,
    });
    this.#enqueue(line, priority, settle);
    void this.#pump();
    return await answered;
  }

  /** Queue a message without waiting for the turn it starts. */
  async chatNoWait(
    value: unknown,
    meta: ChatMeta = {},
    priorityValue: unknown = QUEUE,
  ): Promise<string> {
    await this.ready();
    const priority = priorityOf(priorityValue);
    const line = messageOf(value);
    line.content = addMetaInfo(meta.from ?? 'unknown', line.content ?? '');
    await this.#ensureModel();
    agentLog('debug', 'message.queued', {
      agent: this.name,
      priority,
      bytes: typeof line.content === 'string' ? line.content.length : 0,
    });
    this.#enqueue(line, priority);
    void this.#pump();
    return priority === 'interpret' ? 'interpreted' : 'queued';
  }

  #enqueue(
    message: Message,
    priority: Priority,
    settle: { resolve: (messages: Message[]) => void; reject: (error: Error) => void } = {
      resolve: () => undefined,
      reject: () => undefined,
    },
  ): Round {
    this.#seq += 1;
    const round: Round = {
      message,
      priority,
      seq: this.#seq,
      start: 0,
      resolve: settle.resolve,
      reject: settle.reject,
    };
    this.#queue.push(round);
    this.#sortQueue();
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
    return round;
  }

  #sortQueue(): void {
    this.#queue.sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq,
    );
  }

  /** The messages waiting behind the turn that is running, in the order the loop will read them. */
  queuedMessages(): Message[] {
    return [...this.#queue]
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq)
      .map((round) => round.message);
  }

  // the loop

  async #nextRound(): Promise<Round | null> {
    if (this.#queue.length > 0) return this.#queue.shift() as Round;
    if (this.#closed) return null;
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    if (this.#closed || this.#queue.length === 0) return null;
    return this.#queue.shift() as Round;
  }

  /** Take every `interpret` line waiting, in queue order, stopping at the first `queue` line. */
  #takeInterpret(): Round[] {
    const taken: Round[] = [];
    while (this.#queue.length > 0) {
      const head = this.#queue[0] as Round;
      if (head.priority !== 'interpret') break;
      taken.push(this.#queue.shift() as Round);
    }
    return taken;
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    let turnEnded = true;
    try {
      while (!this.#closed) {
        if (!turnEnded) {
          for (const round of this.#takeInterpret()) await this.#startRound(round);
        }
        if (turnEnded) {
          const round = await this.#nextRound();
          if (round === null) break;
          await this.#startRound(round);
        }

        // A stack starts with one system line: its instruction. That line is the history the next
        // turn needs, not a prompt to answer. Keep it and end the round without asking the model.
        const model = this.model;
        const onlySystemPrompt =
          model !== null && model.messages.length === 1 && model.messages.at(0)?.role === 'system';
        if (onlySystemPrompt) {
          agentLog('debug', 'turn.system-only', { agent: this.name });
          turnEnded = true;
          this.#finish(null);
          this.#markIdle();
          continue;
        }

        let error: Error | null = null;
        let ended = true;
        const controller = new AbortController();
        this.#step = { controller, tool: null };
        try {
          ended = await this.#chatStep(controller.signal);
        } catch (caught) {
          error = caught instanceof Error ? caught : new Error(String(caught));
          ended = true;
        } finally {
          this.#step = null;
          this.#duringStop = false;
        }
        turnEnded = ended;

        if (turnEnded) {
          if (error !== null) await this.#recordFailure(error);
          this.#finish(error);
          this.#markIdle();
        }
      }
    } finally {
      this.#pumping = false;
      this.#markIdle();
    }
  }

  /** Resolves once no turn is running: every chat caller has its answer, so a caller may close the
   *  runtime (and let the context drop it) without cutting anyone's reply short. */
  #idle(): Promise<void> {
    if (this.#step === null && this.#waiting.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  #markIdle(): void {
    for (const waiter of this.#idleWaiters.splice(0)) waiter();
  }

  async #startRound(round: Round): Promise<void> {
    agentLog('debug', 'turn.start', {
      agent: this.name,
      seq: round.seq,
      priority: round.priority,
      bytes: typeof round.message.content === 'string' ? round.message.content.length : 0,
    });
    // Registered before the first await: if writing the line fails, the turn's cleanup still sees
    // this unit and answers its caller instead of leaving it waiting forever.
    this.#waiting.push(round);
    const model = await this.#ensureModel();
    const message: Message = { ...round.message };
    if (typeof message.content === 'string') {
      message.content = await this.shrink(message.content, this.#maxInput());
    }
    await model.pushMessages([message]);
    round.start = model.messages.total;
  }

  /** One model round, then the tools it asked for. A stopped round keeps its partial answer. */
  async #chatStep(signal: AbortSignal): Promise<boolean> {
    const started = Date.now();
    const model = await this.#ensureModel();
    const tools = this.env?.tools ?? [];
    agentLog('debug', 'step.start', { agent: this.name, tools: tools.length });
    const { message, canceled: streamed } = await model.chatStream(tools, { signal });
    agentLog('debug', 'step.end', {
      agent: this.name,
      canceled: streamed,
      calls: message.tool_calls?.length ?? 0,
      ms: Date.now() - started,
    });
    let canceled = streamed;
    const calls = message.tool_calls ?? [];

    if (!canceled) {
      const perTool = Math.max(1, Math.floor(this.#maxInput() / Math.max(1, calls.length)));
      for (const call of calls) {
        const toolStarted = Date.now();
        agentLog('debug', 'tool.start', { agent: this.name, tool: call.function.name });
        if (this.#step !== null) this.#step.tool = call;
        let content: string;
        try {
          // The turn's signal goes with the call: a node that has not answered when the user
          // presses stop is left behind, and the model reads a cancellation instead.
          content = await (this.env as AgentBusEnv).execute(call, signal);
        } catch (error) {
          content = signal.aborted
            ? CANCELLED
            : `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (this.#step !== null) this.#step.tool = null;
        agentLog('debug', 'tool.end', {
          agent: this.name,
          tool: call.function.name,
          ok: !content.startsWith('Error:'),
          ms: Date.now() - toolStarted,
        });
        if (signal.aborted) canceled = true;
        await model.pushMessages([
          {
            role: 'tool',
            tool_call_id: call.id,
            content: await this.shrink(content, perTool),
          },
        ]);
        if (canceled) break;
      }
    }

    if (canceled) {
      // A line written between an assistant's tool_calls and the tool lines answering it makes the
      // transcript invalid, so the unanswered calls are closed first, at a round boundary.
      await model.appendUnclosedToolResults(CANCELLED);
      await model.pushMessages([{ role: 'system', content: 'aborted by user' }]);
      return true;
    }
    return calls.length === 0;
  }

  /** Put a round that raised into the transcript, so the turn does not end on silence. */
  async #recordFailure(error: Error): Promise<void> {
    const model = this.model;
    if (model === null) return;
    try {
      await model.pushMessages([
        { role: 'system', content: `the model round failed: ${error.message}` },
      ]);
    } catch {
      // A transcript that cannot be written must not fail the turn twice.
    }
  }

  #finish(error: Error | null): void {
    agentLog(error === null ? 'info' : 'error', 'turn.end', {
      agent: this.name,
      ok: error === null,
      messages: this.model?.messages.total,
      error,
    });
    const model = this.model;
    const end = model === null ? 0 : model.messages.total;
    const waiting = this.#waiting.splice(0);
    for (const round of waiting) {
      if (error !== null) {
        round.reject(error);
        continue;
      }
      const lines = model === null ? [] : model.messages.absoluteSlice(round.start, end);
      round.resolve(lines);
    }
  }

  /** The text one line is committed with: anything longer than `maxLength` is kept whole in the
   *  cache and comes back as its head, a warning naming the entry, and its tail. */
  async shrink(content: unknown, maxLength: number): Promise<string> {
    const text = typeof content === 'string' ? content : String(content ?? '');
    if (text.length <= maxLength) return text;
    const keep = Math.max(0, Math.floor(maxLength / 2));
    const entry = await this.cache.add(text);
    const warning =
      `<warning>Inputted Context is too long over the maximum allowed length of ${maxLength} ` +
      `characters. Therefore it has been trimmed; the whole text is in cache entry ${entry} ` +
      '(read it with read_cache).</warning>';
    return [text.slice(0, keep), '', warning, '', text.slice(-keep)].join('\n');
  }

  /** One line longer than this does not go to the model whole; the Python twin reads the same
   *  variable. */
  #maxInput(): number {
    const fromEnv = Number(process.env.NODE_AGENT_MAX_INPUT_LENGTH_PER_TURN ?? '');
    return (
      this.options.maxInputPerTurn ??
      (Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : 8192)
    );
  }

  // reads

  status(): AgentStatus {
    const model = this.model;
    return {
      state: this.phase(),
      queued: this.queuedMessages(),
      usage: { ...(model?.usage ?? emptyUsage()) },
    };
  }

  phase(): 'idle' | 'generating' | 'tool' | 'stopping' {
    if (this.#duringStop) return 'stopping';
    if (this.#step === null) return 'idle';
    return this.#step.tool !== null ? 'tool' : 'generating';
  }

  /** A window of the transcript: `{from, count}` reads `count` messages starting at `from`, and
   *  without `from` the newest `count`. */
  async history(args: Record<string, unknown>): Promise<HistoryWindow> {
    const messages = (await this.#ensureModel()).messages;
    const total = messages.total;
    const oldest = messages.forgotten;
    const count = historyCount(args.count);
    const from =
      args.from === undefined
        ? Math.max(oldest, total - count)
        : Math.max(oldest, historyFrom(args.from, total));
    return { from, total, messages: messages.absoluteSlice(from, Math.min(from + count, total)) };
  }

  /** Cut the turn that is running short, and answer its callers before returning. */
  async stop(): Promise<string> {
    agentLog('info', 'agent.stop', { agent: this.name });
    const step = this.#step;
    if (step === null) return 'nothing to stop';
    this.#duringStop = true;
    step.controller.abort(new Error('stopped by user'));
    await this.#idle();
    return 'stopped';
  }

  /** Stop and close: nothing queued runs, and every caller is answered. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const child of this.#children.values()) await child.close();
    this.#children.clear();
    this.#step?.controller.abort(new Error('agent is closed'));
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
    const error = new Error('agent is closed');
    for (const round of this.#queue.splice(0)) round.reject(error);
    for (const round of this.#waiting.splice(0)) round.reject(error);
    for (const ask of this.#asks.values()) {
      if (ask.timer !== undefined) clearTimeout(ask.timer);
      ask.settle(null);
    }
    this.#asks.clear();
    this.#markIdle();
  }

  // events

  /** Stream events arrive on `provider.stream.<id>`, one topic per request the provider started.
   *  The id is the whole address: an event for a stream this process is not waiting on is dropped
   *  by the hub, and no fixed topic outlives the request that caused it. */
  handleEvent(topic: string, value: unknown): void {
    if (!topic.startsWith(STREAM_TOPIC_PREFIX)) return;
    this.hub.deliver(value);
  }

  // the reader's answers

  /** Put one question in front of the reader and wait; answers the tool's text. */
  async ask(callId: string | undefined, args: Record<string, unknown>): Promise<string> {
    const title = String(args.title ?? '').trim();
    if (title === '') return 'ask_user needs a "title": the one-line heading of the question';

    const selections = Array.isArray(args.selections)
      ? args.selections.map((one) => String(one))
      : [];
    const asked = args.input;
    const mode =
      asked === 'button' || asked === 'text' ? asked : selections.length > 0 ? 'button' : 'text';
    if (mode === 'button' && selections.length === 0) {
      return 'ask_user asked for "button" input but named no selections: add them, or ask for "text"';
    }

    const timeout = args.timeout_seconds;
    let seconds: number | null;
    if (timeout === undefined || timeout === null) seconds = ASK_TIMEOUT_SECONDS;
    else if (typeof timeout !== 'number' || Number.isNaN(timeout)) {
      return `ask_user needs "timeout_seconds" to be a number of seconds, got ${String(timeout)}`;
    } else seconds = timeout <= 0 ? null : timeout;

    const fallback = args.default;
    if (Array.isArray(fallback) || (typeof fallback === 'object' && fallback !== null)) {
      return 'ask_user needs "default" to be that one answer, not a list or an object';
    }
    const carried =
      fallback === undefined || fallback === null ? null : String(fallback).trim() || null;

    this.#askSeq += 1;
    const id = callId !== undefined && callId !== '' ? callId : `ask${this.#askSeq}`;
    const question = {
      id,
      title,
      content: String(args.content ?? ''),
      selections,
      input: mode,
      deadline: seconds === null ? null : utcIn(seconds),
      ...(carried !== null ? { default: carried } : {}),
    };

    const early = this.#earlyAnswers.get(id);
    this.#earlyAnswers.delete(id);

    this.bus().publish(this.identity.topic, { type: 'ask', message: question });

    const answer = early ?? (await this.#awaitAnswer(id, seconds, carried));
    if (answer === null) {
      this.#timedOut.set(id, carried);
      if (this.#timedOut.size > 16)
        this.#timedOut.delete(this.#timedOut.keys().next().value as string);
      this.bus().publish(this.identity.topic, {
        type: 'ask_timeout',
        message: { id, default: carried },
      });
      return JSON.stringify({ answered: false, reason: 'timeout', answer: carried });
    }
    return mode === 'button' ? `user chose: "${answer}"` : `user answered: "${answer}"`;
  }

  async #awaitAnswer(
    id: string,
    seconds: number | null,
    carried: string | null,
  ): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
      const pending: PendingAsk = {
        id,
        input: 'button',
        default: carried,
        deadline: seconds === null ? null : utcIn(seconds),
        settle: (answer) => {
          this.#asks.delete(id);
          resolve(answer);
        },
      };
      if (seconds !== null) {
        pending.timer = setTimeout(() => pending.settle(null), seconds * 1000);
        pending.timer.unref?.();
      }
      this.#asks.set(id, pending);
    });
  }

  /** The page's way back in: the answer to a question this agent asked. */
  answer(args: Record<string, unknown>): string {
    const id = String(args.id ?? '');
    const answer = String(args.answer ?? '').trim();
    if (id === '' || answer === '') {
      throw new Error("agent.answer needs {id, answer}: the question's id and the reply");
    }
    if (this.#timedOut.has(id)) {
      const carried = this.#timedOut.get(id) ?? null;
      const used = carried !== null ? ` and used the default "${carried}"` : '';
      throw new Error(`question "${id}" ran out of time${used}: the turn has already carried on`);
    }
    const pending = this.#asks.get(id);
    if (pending === undefined) {
      if (this.#step !== null) {
        this.#earlyAnswers.set(id, answer);
        return `held the answer to "${id}" until its question is asked`;
      }
      throw new Error(`no question is waiting with id "${id}"`);
    }
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.settle(answer);
    return answer;
  }

  // providers

  /** The rows this agent may talk through, and the one it settled on - the same shape and the same
   *  rules for a sub-agent as for the main agent. A child was handed its row when it was created, so
   *  there is nothing here that reads the parent's choice. */
  async handleProvider(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ready();
    const action = String(args.action ?? 'list');
    let rows: string[] = [];
    try {
      rows = await this.providerNodes.names();
    } catch {
      rows = [];
    }
    if (action === 'list') {
      // No provider node is not an error here: the page asks for the list before one is connected.
      if (rows.length === 0)
        return { providers: [], active: '', persistent: this.options.historyRequired ?? true };
      if (this.#providerName === null && rows.length > 0) {
        const selected = (await this.#loadActiveProvider()) ?? this.options.providerName ?? null;
        this.#providerName = ProviderNodes.rowOf(selected, rows) ?? selected ?? (rows[0] as string);
      }
      const active = this.#providerName ?? '';
      return {
        providers: rows.map((name) => ({ name, active: name === active })),
        active,
        persistent: this.options.historyRequired ?? true,
      };
    }
    if (action !== 'select') throw new Error(`unknown provider action "${action}"`);
    if (rows.length === 0)
      throw new Error('no provider node is on the bus — connect node-agent-provider first');
    if (this.phase() !== 'idle')
      throw new Error('cannot switch providers while the agent is running');
    const wanted = String(args.name ?? '');
    const row = ProviderNodes.rowOf(wanted, rows);
    if (row === null) {
      const available = rows.length > 0 ? ` (available: ${rows.join(', ')})` : '';
      throw new Error(`no provider "${wanted}"${available}`);
    }
    this.#providerName = row;
    const provider = this.#makeNodeProvider(row);
    this.#provider = provider;
    this.model?.setProvider(provider);
    await this.#persistActiveProvider(row);
    if (this.parent !== null) await this.parent.#saveAgents();
    return {
      providers: rows.map((name) => ({ name, active: name === row })),
      active: row,
      persistent: this.options.historyRequired ?? true,
    };
  }

  /** The named clock a transcript line carries, for a caller that wants it. */
  static now(): string {
    return utcNow();
  }
}

/** `count`, defaulted and bounded: one answer never carries more than HISTORY_MAX messages. */
export function historyCount(value: unknown): number {
  if (value === undefined || value === null) return HISTORY_MAX;
  const count = Number(value);
  if (!Number.isFinite(count)) return HISTORY_MAX;
  return Math.max(0, Math.min(Math.trunc(count), HISTORY_MAX));
}

/** A message index inside a transcript of `total` messages, clamped to it: an index past the end
 *  reads as the end, which is how a caller learns the transcript is shorter than it thought. */
export function historyFrom(value: unknown, total: number): number {
  const index = Number(value);
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.trunc(index), total));
}
