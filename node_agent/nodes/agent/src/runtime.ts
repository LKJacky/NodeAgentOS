// One agent: its transcript, queue, turns and stop. A family of agents is one runtime each, held
// together by `AgentFamily`; this object never knows a sibling.
//
// The SDK builds one Node per invocation, so nothing here may live in the Node: this runtime is one
// per agent, made on the first call and shared by every invocation that follows. It owns the one
// model, the one queue and the one turn, which is what makes `stop` from one call stop the turn
// another call opened.
//
// One turn is one round at a time: take the highest-priority message waiting, run the model, run the
// tools it asked for, and go round again until the model answers in prose and nothing is left in the
// `interpret` lane. `chat` is "queue a message with a promise and await it"; `priority` is the
// queue's order: `interpret` (in at the end of the round that is running) or `queue` (the default).
import type { BindingScope } from '@node-agent/sdk';
import type { JsonObject } from '@node-agent/provider/core';
import { Cache } from './cache.js';
import {
  activeProviderStorage,
  listUnits,
  settingsStorage,
  storageAvailable,
  storedUnit,
  subagentsStorage,
  type StoredAgent,
} from './storage.js';
import { agentLog } from './log.js';
import { agentNameOf } from './names.js';
import { AgentBusEnv, CANCELLED } from './env.js';
import { DirectProvider, missingConfig, type CoreBuilder } from './direct.js';
import {
  emptyUsage,
  charCount,
  headOf,
  PRIORITY_RANK,
  priorityOf,
  QUEUE,
  tailOf,
  utcIn,
  utcNow,
  type Priority,
} from './helpers.js';
import {
  CachedModel,
  NodeProvider,
  ProviderNodes,
  SHARED_PROVIDER_NODE,
  STREAM_TOPIC_PREFIX,
  StatedModel,
  StreamHub,
  streamIdleMs,
  type ModelOptions,
} from './model.js';
import {
  StreamAssembly,
  type StreamDelta,
  type StreamDeltaEvent,
  type StreamEnd,
  type StreamEventOut,
  type StreamStart,
  type StreamState,
} from './stream.js';
import {
  DEFAULT_SETTINGS,
  effectiveSettings,
  envNumber,
  mergePatches,
  parseSettingsPatch,
  readStoredSettings,
  settingsUnit,
  SETTINGS_NAMES,
  RESTART_REQUIRED_SETTINGS,
  LIVE_SETTINGS,
  type AgentSettings,
  type SettingsPatch,
} from './settings.js';
import type { Message, Provider, ToolCall, ToolSpec, UsageSummary } from './types.js';

/** The default question timeout, in seconds: what `ask_user` waits when the asker names no deadline.
 *  The deployment's number, not a setting: an agent that needs another one passes `timeout_seconds`
 *  on the call itself. */
export const ASK_TIMEOUT_SECONDS = 300;

/** How many times one save is tried when the history node says someone else wrote first. */
const SETTINGS_SAVE_ATTEMPTS = 3;

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

/** How long a sub-agent runtime may sit idle after a turn before it is closed and dropped. */
export const DEFAULT_IDLE_DESTROY_MS = 30_000;

export type RuntimeOptions = {
  readonly historyRequired?: boolean;
  /** Whether this runtime may ask the reader at all: what an embedder passes is the floor, and the
   *  agent's own `allowAskUser` setting is laid over it. */
  readonly allowAskUser?: boolean;
  /** Whether this runtime may start sub-agents; a sub-agent itself never may, and the agent's
   *  `allowSpawn` setting can only make it narrower. */
  readonly allowSpawn?: boolean;
  readonly maxAgents?: number;
  readonly cacheSize?: number;
  readonly maxInputPerTurn?: number;
  readonly compressionThreshold?: number;
  readonly compressionTokens?: number;
  /** How many tokens one round may answer with; 0 leaves the model server's own default. */
  readonly maxCompletionTokens?: number;
  /** What the model is told when the oldest messages are cut away; the agent's own notice otherwise. */
  readonly compressionNotice?: string;
  /** A provider handed in by the caller (a test, or an embedder that holds its own model). */
  readonly provider?: Provider;
  /** How a `provider` row is dialled when this process does it: the provider package's core, unless
   *  an embedder (or a test) passes its own builder. `local-provider` rows never take this path. */
  readonly buildProvider?: CoreBuilder;
  /** The provider row to start from when history has none (Python's provider_name). */
  readonly providerName?: string;
  /** A tab drawing for this agent's own panel (validated `<svg>...</svg>`). */
  readonly icon?: string;
  /** How long a sub-agent runtime may sit idle after a turn before it is closed and dropped.
   *  Defaults to `DEFAULT_IDLE_DESTROY_MS`. */
  readonly idleDestroyMs?: number;
  /** Called with every line committed to the transcript, for the page. */
  readonly onCommit?: ModelOptions['onCommit'];
  /** Called with every stream event published on this agent's topic, for an embedder that draws its
   *  own page. The bus is the default: the events go to whoever subscribed. */
  readonly onStream?: (event: StreamEventOut) => void;
};

/** What `agent.status` answers: what the agent is doing, what is waiting behind it, what it spent,
 *  and where the answer it is writing has got to. */
export type AgentStatus = {
  state: 'idle' | 'generating' | 'tool' | 'stopping';
  queued: Message[];
  usage: UsageSummary;
  /** The stream a page can join: its id, the line it will become, and the last seq published. No
   *  text: the whole draft is only ever sent when a page asks for it (`stream`). */
  stream: { id: string; messageId: string; seq: number } | null;
};

/** One row of the page's agent switch: who is there to look at, and what each one is doing. */
export type AgentRow = {
  /** What an `agent` argument names it with. */
  name: string;
  /** The topic its transcript, its stream and its questions are published on. */
  topic: string;
  /** The agent that started it, or null for the main agent. */
  parent: string | null;
  state: 'idle' | 'generating' | 'tool' | 'stopping';
  /** How many sub-agents it runs (a sub-agent always answers 0). */
  children: number;
  /** The drawing it was created with, when it was given one. */
  icon?: string;
};

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

/** The family a runtime belongs to: the shared hub and the operations that span agents. A
 *  runtime never reaches into a sibling; it asks the family. */
export interface RuntimeGroup {
  readonly hub: StreamHub;
  spawnAgent(name: string, icon?: string, provider?: string): Promise<string>;
  destroyAgent(name: string): Promise<string>;
  /** Close an idle runtime without deleting its transcript. */
  retireAgent(name: string): Promise<void>;
  agentsChanged(): Promise<void>;
  settingsChanged(source: AgentRuntime): Promise<void>;
}

/** What one runtime is made of. The host's `ctx.bind` owns the instance; this type says only what
 *  it needs to exist. */
export type RuntimeInit = {
  /** The family this runtime belongs to. */
  readonly group: RuntimeGroup;
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
  /** The runtime that started this one, or none for the main agent. */
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

export class AgentRuntime {
  /** The tenant's bus, and the only place this object reads who it is: identity, calls, publish,
   *  directory, fetch. Never an invocation's context. */
  readonly scope: BindingScope;
  /** The opaque strings derived once from the scope; nothing here reads tenant/node ids. */
  readonly identity: RuntimeIdentity;
  /** The name one `agent` argument uses for this runtime: the bus name, or a sub-agent's own. */
  readonly name: string;
  /** The family this runtime belongs to. */
  readonly group: RuntimeGroup;
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
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #seq = 0;
  /** The answer this runtime is writing right now, or null between rounds. One per runtime: a
   *  sub-agent's page sees only its own topic, so two answers never meet in one assembly. */
  #live: StreamAssembly | null = null;
  #streamSeq = 0;
  #step: { controller: AbortController; tool: ToolCall | null } | null = null;
  #duringStop = false;
  #closed = false;
  #provider: Provider | null = null;
  #providerName: string | null = null;
  #providerRevision: number | null = null;
  /** This agent's own settings, as its page last saved them: only the fields somebody chose, so a
   *  field nobody touched keeps following the deployment's default. */
  #stored: SettingsPatch = {};
  /** The revision of the settings unit this process last saw, so a save names what it replaces. */
  #settingsRevision: number | undefined;

  readonly #asks = new Map<string, PendingAsk>();
  readonly #timedOut = new Map<string, string | null>();
  readonly #earlyAnswers = new Map<string, string>();
  #askSeq = 0;

  constructor(init: RuntimeInit) {
    const { scope } = init;
    this.scope = scope;
    this.identity = identityOf(scope, init.topic);
    this.name = init.name ?? this.identity.busName;
    this.group = init.group;
    this.parent = init.parent ?? null;
    this.hub = init.group.hub;
    this.unitPrefix = init.unitPrefix ?? '';
    this.options = init.options ?? {};
    const fromEnv = Number(process.env.NODE_AGENT_CACHE_SIZE ?? '');
    this.cache = new Cache(
      this.options.cacheSize ??
        (Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SETTINGS.cacheSize),
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
        defaultReadLength: () => this.#maxInput(),
        ask: (callId, args) => this.ask(callId, args),
        spawnAgent: (name, icon, provider) => this.group.spawnAgent(name, icon, provider),
        destroyAgent: (name) => this.group.destroyAgent(name),
      },
      {
        // What the settings allow is applied again by `#applyRuntimeSettings` once they are read: a
        // stored switch is in force on the first turn and not only on the turn after a restart.
        allowAskUser: this.allowAskUser,
        allowSpawn: this.allowSpawn(),
        allowSearchCache: this.settings.allowSearchCache,
      },
    );
    const persistent = await storageAvailable(this.bus());
    this.cache.useScope(persistent ? this.bus() : null, this.unitPrefix);
    await this.cache.restore();
    await this.#loadSettings();
    // The numbers a component reads once are handed to it here, so a stored value is in force on the
    // first turn this process runs and not only on the one after a restart.
    await this.applyRuntimeSettings();
    // The children a previous run saved are always started again: `restoreAgents` was removed, so the
    // behaviour that used to be the setting's default is the only one left.
    agentLog('info', 'agent.ready', {
      agent: this.name,
      history: persistent,
      ms: Date.now() - started,
    });
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
    const persistent = this.cache.enabled;
    const provider = await this.#resolveProvider();
    const options: ModelOptions = {
      // The compression pair the agent runs on: read from its settings when the model is built, and
      // handed to it again after every save, so a model that already exists compresses at the new
      // number from the next round on.
      compressionThreshold: this.settings.compressionThreshold,
      compressionTokens: this.settings.compressionTokens,
      // 0 is "no cap of our own": the wire carries no max_completion_tokens then, and the model
      // server's own default answers.
      maxCompletionTokens:
        this.settings.maxCompletionTokens > 0 ? this.settings.maxCompletionTokens : null,
      compressionNotice: this.settings.compressionNotice,
      radicalForget: this.settings.radicalForget,
      onCommit: this.options.onCommit ?? ((messages) => this.#announce(messages)),
      onDelta: (delta) => this.#announceDelta(delta),
    };
    let model: CachedModel = persistent
      ? new StatedModel(provider, this.bus(), this.unitPrefix, options)
      : new CachedModel(provider, options);
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
    this.#provider = this.#makeProvider(chosen);
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

  /** Publish one stream event, on this agent's topic and to an embedder that asked for them. A bus
   *  that cannot publish is not a failed turn: watching one is a convenience, not a deliverable. */
  #announceStream(event: StreamEventOut): void {
    const onStream = this.options.onStream;
    if (onStream !== undefined) {
      try {
        onStream(event);
      } catch {
        // An embedder that throws must not fail the turn it was watching.
      }
    }
    try {
      this.scope.publish(this.identity.topic, event);
    } catch {
      // A listener that is gone is not a turn that failed.
    }
  }

  /** The start of one round's answer: the id a delta names, the agent writing it and the line it will
   *  become when the round commits. Published lazily - on the first delta - so a round that streams
   *  no news spends no events on an empty draft. */
  #startStream(): StreamAssembly {
    this.#streamSeq += 1;
    const id = `${this.name}#${this.#streamSeq}`;
    const live = new StreamAssembly(id, this.name, `m${this.#streamSeq}`);
    this.#live = live;
    const start: StreamStart = {
      type: 'stream_start',
      id,
      agent: this.name,
      messageId: live.messageId,
      role: 'assistant',
      seq: 0,
    };
    this.#announceStream(start);
    return live;
  }

  /** One delta of the answer being written: only what just arrived, and the seq that says which one
   *  it is. This is the whole point of the protocol - the accumulated line is never republished. */
  #announceDelta(delta: StreamDelta): void {
    const live = this.#live ?? this.#startStream();
    live.apply(delta);
    live.seq += 1;
    const event: StreamDeltaEvent = {
      type: 'stream_delta',
      id: live.id,
      agent: live.agent,
      messageId: live.messageId,
      seq: live.seq,
      ...delta,
    };
    this.#announceStream(event);
  }

  /** The round is over: its line is committed (or a stop cut it short) and the draft is done. The
   *  transcript is the truth from here, so this only tells a page to drop the tail it assembled. */
  #endStream(canceled: boolean): void {
    const live = this.#live;
    this.#live = null;
    if (live === null) return;
    const end: StreamEnd = {
      type: 'stream_end',
      id: live.id,
      agent: live.agent,
      messageId: live.messageId,
      seq: live.seq + 1,
      canceled,
    };
    this.#announceStream(end);
  }

  /** What is being written right now, as it stands, or null between rounds. The one payload that
   *  carries the line so far: a page that lost a delta - a dropped frame, a reconnected stream, a
   *  gap in the seq - asks for it once instead of guessing what it missed. */
  streamState(): StreamState | null {
    return this.#live === null ? null : this.#live.state();
  }

  /** History files units under the calling node, and the whole family shares one calling node: the
   *  prefix (`''` for the main agent, `sub.<name>.` for a sub-agent) is what keeps one agent's
   *  transcript, cache and provider row apart from the others'. */
  /** Start an agent under this runtime's identity. A sub-agent is a runtime of this same class,
   *  held here: it publishes on its own topic, files its units under its own prefix, and is not a
   *  node - so nothing about its permissions is separate from its parent's.
   *
   *  `icon` is required - its tab has to be told apart from the others - and `provider` is not. Only
   *  a restore passes less: a `subagents` unit written before icons were required keeps no drawing,
   *  and the page falls back to its own. */
  /** The provider row a child would start on: the one it names, else this agent's current row,
   *  else the first row the provider node offers. */
  async providerRowFor(provider: string | undefined): Promise<string> {
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

  /** Whether this agent may start a sub-agent at all. Two things decide it: what it was started
   *  with (a sub-agent itself never may), and its own `allowSpawn` setting - which `settings` has
   *  already kept inside that floor. */
  allowSpawn(): boolean {
    return this.settings.allowSpawn;
  }

  /** Whether this agent may ask the reader anything: its `allowAskUser` setting over what it was
   *  started with (a sub-agent may not, and its page has nobody to ask). */
  get allowAskUser(): boolean {
    return this.settings.allowAskUser;
  }

  /** Delete every unit this agent filed under its own prefix, and answer what would not go. The main
   *  agent's prefix is empty: its own wipe takes its sub-agents' units with it, which is what closing
   *  the family means. */
  async destroySelf(): Promise<string[]> {
    const left: string[] = [];
    const listed = async (): Promise<{ unitId: string; revision?: number }[]> => {
      try {
        return await listUnits(this.bus(), this.unitPrefix);
      } catch (error) {
        left.push(`*: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    };
    for (const unit of await listed()) {
      try {
        const localId = unit.unitId.slice(this.unitPrefix.length);
        const stored = storedUnit(this.bus(), this.unitPrefix, localId);
        await stored.load();
        if (stored.revision > 0) await stored.delete();
      } catch (error) {
        left.push(`${unit.unitId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const unit of await listed()) left.push(`${unit.unitId}: still there after delete`);
    return left;
  }

  #makeNodeProvider(name: string | null): NodeProvider {
    // The idle timeout is the deployment's, read every time a stream starts: `streamIdleMs()` is
    // NODE_AGENT_STREAM_IDLE_MS with this package's default under it, and is no longer a setting.
    return new NodeProvider(() => this.bus(), this.providerNodes, this.hub, name, streamIdleMs);
  }

  /** A `provider` row, dialled here: the provider package's own core, the row as the node holds it,
   *  and this process's `fetch`. No `chat` and no stream crosses the bus for it. */
  #makeDirectProvider(name: string): DirectProvider {
    const { node, name: row } = ProviderNodes.split(name);
    const owner = node ?? SHARED_PROVIDER_NODE;
    return new DirectProvider(name, {
      row,
      node: owner,
      config: () => this.#directConfig(owner, row),
      fetcher: this.bus().fetch,
      idleMs: streamIdleMs,
      ...(this.options.buildProvider !== undefined ? { build: this.options.buildProvider } : {}),
    });
  }

  /** Which seam a selected row means.
   *
   *  A row of the shared `provider` node is dialled in this process (`DirectProvider`), because its
   *  rows are this stack's own and the node would only hand the same request back over the bus. A
   *  `local-provider` row is not: that node is the stack's own endpoint, and the bus is the only path
   *  that knows where it is. A bare name, or none at all, keeps the old bus behaviour, where the node
   *  picks the nearest row itself. */
  #makeProvider(name: string | null): Provider {
    const { node } = ProviderNodes.split(name ?? '');
    if (node === SHARED_PROVIDER_NODE && name !== null) return this.#makeDirectProvider(name);
    return this.#makeNodeProvider(name);
  }

  /** One row of a `provider` node, as the node holds it: what this process dials with.
   *
   *  The rows are filed in the bus history under the *node's* own name, so no other node can read
   *  them; the node's `row` capability - declared for `agent` alone - is the one way to them. What
   *  travels is the row itself. It is never published on a topic and never logged: the only place
   *  the key goes from here is the endpoint's own request. */
  async #directConfig(node: string, row: string): Promise<JsonObject> {
    let reply: { config?: unknown } | null;
    try {
      reply = await this.bus().call<{ config?: unknown } | null>(node, 'row', { name: row });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A node from before direct inference has no `row` at all. Say so, rather than reporting the
      // bus's bare "no such capability" as though the row were the problem.
      if (/no such capability/i.test(message)) {
        throw new Error(
          `the provider node "${node}" cannot hand over row "${row}": it does not serve the "row" capability (${message}) — upgrade @node-agent/provider, or select a local-provider row to go through the bus`,
        );
      }
      throw error;
    }
    const config = reply?.config;
    if (config === undefined || config === null) throw new Error(missingConfig(row, node));
    return config as JsonObject;
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
      const unit = activeProviderStorage(this.bus(), this.unitPrefix);
      await unit.load();
      return unit.revision > 0 && typeof unit.meta.name === 'string' ? unit.meta.name : null;
    } catch {
      return null;
    }
  }

  async #persistActiveProvider(name: string): Promise<void> {
    if (!this.cache.enabled) return;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const unit = activeProviderStorage(this.bus(), this.unitPrefix);
        await unit.load();
        unit.meta = { name };
        try {
          await unit.save();
          this.#providerRevision = unit.revision;
          return;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    } catch (error) {
      console.warn(`agent: could not store the active provider: ${String(error)}`);
    }
  }

  // settings

  /** What this agent falls back to: its parent's settings (a sub-agent is one of the family), or the
   *  deployment's own defaults - the package's, with the environment's numbers over them when it
   *  names any. */
  get defaults(): AgentSettings {
    if (this.parent !== null) {
      // A sub-agent inherits the family's numbers, but not the two switches: it was started unable to
      // spawn one of its own and with nobody to ask, so that is what its settings say - otherwise its
      // page would offer a switch that is on and does nothing.
      return this.#withinFloor(this.parent.settings);
    }
    return {
      ...DEFAULT_SETTINGS,
      maxAgents:
        this.options.maxAgents ?? envNumber('NODE_AGENT_MAX_AGENTS') ?? DEFAULT_SETTINGS.maxAgents,
      maxInputLengthPerTurn:
        this.options.maxInputPerTurn ??
        envNumber('NODE_AGENT_MAX_INPUT_LENGTH_PER_TURN') ??
        DEFAULT_SETTINGS.maxInputLengthPerTurn,
      // An embedder that handed the runtime a pair starts from it, the way it may start from a cap;
      // a saved value is laid over it like every other field's.
      compressionThreshold:
        this.options.compressionThreshold ?? DEFAULT_SETTINGS.compressionThreshold,
      compressionTokens: this.options.compressionTokens ?? DEFAULT_SETTINGS.compressionTokens,
      // `NODE_AGENT_MAX_COMPLETION_TOKENS` was the way a deployment capped one answer before there
      // was a setting: it is still the fallback, and a saved value is laid over it.
      compressionNotice: this.options.compressionNotice ?? DEFAULT_SETTINGS.compressionNotice,
      maxCompletionTokens:
        this.options.maxCompletionTokens ??
        envNumber('NODE_AGENT_MAX_COMPLETION_TOKENS') ??
        DEFAULT_SETTINGS.maxCompletionTokens,
      // `NODE_AGENT_CACHE_SIZE` was the way a deployment sized the cache before there was a setting:
      // it is still the fallback, and a saved value is laid over it.
      cacheSize:
        this.options.cacheSize ?? envNumber('NODE_AGENT_CACHE_SIZE') ?? DEFAULT_SETTINGS.cacheSize,
      // The switches default to what an agent could do before they existed. What an embedder passed
      // is the floor: a runtime told it may not spawn cannot turn that back on from its page.
      allowSpawn: this.options.allowSpawn ?? DEFAULT_SETTINGS.allowSpawn,
      allowAskUser: this.options.allowAskUser ?? DEFAULT_SETTINGS.allowAskUser,
      allowSearchCache: DEFAULT_SETTINGS.allowSearchCache,
      radicalForget: DEFAULT_SETTINGS.radicalForget,
    };
  }

  /** The same settings with the two switches kept inside what this runtime was started with: a
   *  sub-agent (or an embedder's runtime) may be told it cannot spawn or ask, and neither a stored
   *  unit nor an inherited setting may turn that back on. */
  #withinFloor(settings: AgentSettings): AgentSettings {
    const allowSpawn = this.#startedWith('allowSpawn') && settings.allowSpawn;
    const allowAskUser = this.#startedWith('allowAskUser') && settings.allowAskUser;
    if (allowSpawn === settings.allowSpawn && allowAskUser === settings.allowAskUser)
      return settings;
    return { ...settings, allowSpawn, allowAskUser };
  }

  /** Whether this runtime was started allowed to do one of the two switched things. A sub-agent is
   *  started without both, which is why its own setting can never say otherwise. */
  #startedWith(name: 'allowSpawn' | 'allowAskUser'): boolean {
    return name === 'allowSpawn'
      ? (this.options.allowSpawn ?? true)
      : (this.options.allowAskUser ?? true);
  }

  /** The settings in force here: what this agent falls back to, with its own saved choices over it,
   *  kept inside what it was started with (the two switches have a floor no save can lift).
   *  Synchronous on purpose - the input limit is read per tool answer, the sub-agent cap per spawn - and
   *  cheap: it is a handful of fields laid over another handful. */
  get settings(): AgentSettings {
    return this.#withinFloor(effectiveSettings(this.defaults, this.#stored));
  }

  /** Put the numbers a component reads for itself in force: the cache's cap and a model's compression
   *  pair. Both are built once, so a save would otherwise sit in storage with nothing reading it;
   *  this is what makes "a saved setting is in force from the next turn on" true for them too. */
  async applyRuntimeSettings(propagate = true): Promise<void> {
    const settings = this.settings;
    if (this.cache.maxSize !== settings.cacheSize) await this.cache.setMaxSize(settings.cacheSize);
    if (this.model !== null) {
      this.model.setCompression(settings.compressionThreshold, settings.compressionTokens);
      this.model.setMaxCompletionTokens(
        settings.maxCompletionTokens > 0 ? settings.maxCompletionTokens : null,
      );
      this.model.setCompressionNotice(settings.compressionNotice);
      this.model.setRadicalForget(settings.radicalForget);
    }
    // The two switches are read per round (the tools the model is offered) and per call (the refusal
    // a tool that is off answers), so handing them to the environment is all a save has to do.
    this.env?.gate({
      allowAskUser: this.allowAskUser,
      allowSpawn: this.allowSpawn(),
      allowSearchCache: settings.allowSearchCache,
    });
    // A child inherits what it did not set, so a save made here reaches the children's own cache
    // and model too: the numbers a sub-agent runs on are the parent's new ones from the next round.
    if (propagate) await this.group.settingsChanged(this);
  }

  /** Read this agent's own unit once, when the runtime starts. A unit that cannot be read is a unit
   *  that was never written: the agent starts on its defaults rather than not starting at all. */
  async #loadSettings(): Promise<void> {
    if (!this.cache.enabled) return;
    try {
      const unit = settingsStorage(this.bus(), this.unitPrefix);
      await unit.load();
      if (unit.revision > 0) {
        this.#stored = readStoredSettings(unit.meta);
        this.#settingsRevision = unit.revision;
      }
    } catch {
      // A history node that cannot answer leaves the defaults in force.
    }
  }

  /** Read or change this agent's settings: `get` answers what is in force, and `update` saves the
   *  fields it was given (or, with `reset`, forgets every one of them). */
  async handleSettings(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ready();
    const action = String(args.action ?? 'get');
    if (action === 'get') return await this.#settingsAnswer();
    if (action !== 'update') {
      throw new Error(`unknown settings action "${action}": use get or update`);
    }
    if (args.reset === true) {
      await this.#resetSettings();
      return await this.#settingsAnswer();
    }
    const given: Record<string, unknown> = { ...args };
    delete given.action;
    delete given.agent;
    const { values, problems } = parseSettingsPatch(given, true);
    if (problems.length > 0) throw new Error(`cannot save settings: ${problems.join('; ')}`);
    // A switch this runtime was started without cannot be turned on from a page: a sub-agent never
    // starts one of its own and has nobody to ask, so saving `true` would write a value nothing reads.
    const floor: string[] = [];
    if (values.allowSpawn === true && !this.#startedWith('allowSpawn')) {
      floor.push(
        'allowSpawn cannot be turned on: this agent was started unable to start sub-agents',
      );
    }
    if (values.allowAskUser === true && !this.#startedWith('allowAskUser')) {
      floor.push('allowAskUser cannot be turned on: this agent was started with nobody to ask');
    }
    if (floor.length > 0) throw new Error(`cannot save settings: ${floor.join('; ')}`);
    if (Object.keys(values).length === 0) {
      throw new Error(
        'cannot save settings: no setting was given (send one of ' +
          `${SETTINGS_NAMES.join(', ')}, or reset: true)`,
      );
    }
    await this.#saveSettings(values);
    return await this.#settingsAnswer();
  }

  /** What the page and any other caller is told: the settings in force, what they fall back to, what
   *  a save of each one costs, and the provider row that is in force (read, never chosen here - the
   *  `provider` capability is the one place a provider is switched). */
  async #settingsAnswer(): Promise<Record<string, unknown>> {
    let active = '';
    try {
      const listed = await this.handleProvider({ action: 'list' });
      active = typeof listed.active === 'string' ? listed.active : '';
    } catch {
      // A bus without a provider node still has settings.
    }
    return {
      // Which agent these are: a sub-agent's page hides the three fields that only mean something
      // for an agent that may start one of its own (the cap and the two switches), because for it
      // they are not knobs at all.
      agent: { name: this.name, parent: this.parent?.name ?? null },
      settings: this.settings,
      defaults: this.defaults,
      provider: { active },
      live: [...LIVE_SETTINGS],
      restartRequired: [...RESTART_REQUIRED_SETTINGS],
      persistent: this.cache.enabled,
    };
  }

  /** Save a patch. The unit is written with the revision this process last saw, so a save that lost a
   *  race is refused instead of overwriting what the other writer said; the retry then reads their
   *  unit again and lays this patch over it, which keeps both writers' fields. `replace` is what a
   *  reset is: the patch becomes the whole unit rather than a layer over what was there. */
  async #saveSettings(values: SettingsPatch, replace = false): Promise<void> {
    if (!this.cache.enabled) {
      this.#stored = replace ? values : mergePatches(this.#stored, values);
      await this.applyRuntimeSettings();
      return;
    }
    for (let attempt = 1; attempt <= SETTINGS_SAVE_ATTEMPTS; attempt += 1) {
      const merged = replace ? values : mergePatches(this.#stored, values);
      const unit = settingsStorage(this.bus(), this.unitPrefix);
      await unit.load();
      const expected = this.#settingsRevision ?? 0;
      if (unit.revision !== expected) {
        if (attempt === SETTINGS_SAVE_ATTEMPTS) {
          throw new Error('the settings changed concurrently');
        }
        // Someone else wrote first: their unit is the new base, and this patch goes over it.
        this.#stored = readStoredSettings(unit.meta);
        this.#settingsRevision = unit.revision > 0 ? unit.revision : undefined;
        continue;
      }
      try {
        unit.meta = settingsUnit(merged);
        await unit.save();
      } catch (error) {
        if (attempt === SETTINGS_SAVE_ATTEMPTS) throw error;
        await unit.load();
        this.#stored = readStoredSettings(unit.meta);
        this.#settingsRevision = unit.revision > 0 ? unit.revision : undefined;
        continue;
      }
      this.#stored = merged;
      this.#settingsRevision = unit.revision;
      // The cache and the model are already built: hand them the numbers this save put in force.
      await this.applyRuntimeSettings();
      return;
    }
  }

  /** Forget every stored value: the unit is written empty rather than deleted, so the same revision
   *  rule covers a reset, and the agent falls back to its parent's settings or its deployment's. */
  async #resetSettings(): Promise<void> {
    await this.#saveSettings({}, true);
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
    if (this.settings.addMetaInfo)
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
    if (this.settings.addMetaInfo)
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
    this.#touch();
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
          for (const round of this.#takeInterpret()) await this.#startRoundSafely(round);
        }
        if (turnEnded) {
          const round = await this.#nextRound();
          if (round === null) break;
          await this.#startRoundSafely(round);
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
          this.#armIdleExit();
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
          this.#armIdleExit();
        }
      }
    } finally {
      this.#pumping = false;
      this.#markIdle();
    }
  }

  /** Cancel a pending idle retirement: a new line is about to join the queue. */
  #touch(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  /** After a turn, a sub-agent with nothing queued may close itself when it has been idle long enough. */
  #armIdleExit(): void {
    this.#touch();
    if (this.parent === null || this.#closed || this.#step !== null || this.#queue.length > 0)
      return;
    const after = this.options.idleDestroyMs ?? DEFAULT_IDLE_DESTROY_MS;
    if (after <= 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      void this.#retireIfIdle();
    }, after);
    this.#idleTimer.unref?.();
  }

  async #retireIfIdle(): Promise<void> {
    if (this.#closed || this.#step !== null || this.#queue.length > 0) return;
    try {
      await this.group.retireAgent(this.name);
    } catch (error) {
      agentLog('warn', 'agent.retire.failed', {
        agent: this.name,
        error: error instanceof Error ? error.message : String(error),
      });
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

  /** Start one round, answering its caller if the line cannot be written: a round that is waiting on
   *  a history that vanished must fail the request, not leave the caller silent until its deadline. */
  async #startRoundSafely(round: Round): Promise<void> {
    try {
      await this.#startRound(round);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      agentLog('error', 'turn.start.failed', { agent: this.name, seq: round.seq, error });
      const at = this.#waiting.indexOf(round);
      if (at >= 0) this.#waiting.splice(at, 1);
      round.reject(error);
    }
  }

  /** One model round, then the tools it asked for. A stopped round keeps its partial answer. */
  async #chatStep(signal: AbortSignal): Promise<boolean> {
    const started = Date.now();
    const model = await this.#ensureModel();
    const tools = this.env?.tools ?? [];
    agentLog('debug', 'step.start', { agent: this.name, tools: tools.length });
    const { message, canceled: streamed } = await this.#runRound(model, tools, signal);
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

  /** One model round with its stream closed whatever happens: a round that raised after publishing
   *  some deltas still has to tell the page to stop drawing a tail that will never be committed, and
   *  a stopped round says so in the event that ends it. */
  async #runRound(
    model: CachedModel,
    tools: readonly ToolSpec[],
    signal: AbortSignal,
  ): Promise<{ message: Message; canceled: boolean }> {
    let round: { message: Message; canceled: boolean };
    try {
      round = await model.chatStream(tools, { signal });
    } catch (error) {
      this.#endStream(signal.aborted);
      throw error;
    }
    this.#endStream(round.canceled);
    return round;
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
    const length = charCount(text);
    if (length <= maxLength) return text;
    const keep = Math.max(0, Math.floor(maxLength / 2));
    const entry = await this.cache.add(text);
    const warning =
      `<warning>Inputted Context is too long over the maximum allowed length of ${maxLength} ` +
      `characters. Therefore it has been trimmed; the whole text (${length} characters) is in cache entry ${entry} ` +
      '(read it with read_cache).</warning>';
    return [headOf(text, keep), '', warning, '', tailOf(text, keep)].join('\n');
  }

  /** One line longer than this does not go to the model whole: this agent's own setting, the one the
   *  embedder handed it, NODE_AGENT_MAX_INPUT_LENGTH_PER_TURN, or 8192 characters. */
  #maxInput(): number {
    return this.settings.maxInputLengthPerTurn;
  }

  // reads

  status(): AgentStatus {
    const model = this.model;
    const live = this.#live;
    return {
      state: this.phase(),
      queued: this.queuedMessages(),
      usage: { ...(model?.usage ?? emptyUsage()) },
      stream: live === null ? null : { id: live.id, messageId: live.messageId, seq: live.seq },
    };
  }

  phase(): 'idle' | 'generating' | 'tool' | 'stopping' {
    if (this.#duringStop) return 'stopping';
    if (this.#step === null) return 'idle';
    return this.#step.tool !== null ? 'tool' : 'generating';
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
    this.#touch();
    // A page still drawing a tail has to be told the turn it was watching is over.
    this.#endStream(true);
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
    if (!this.allowAskUser) return 'ask_user is switched off for this agent';
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
    // No setting behind this any more: an ask waits ASK_TIMEOUT_SECONDS (five minutes) unless the
    // model gave the question a deadline of its own.
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
      throw new Error('no provider node is on the bus — connect @node-agent/provider first');
    if (this.phase() !== 'idle')
      throw new Error('cannot switch providers while the agent is running');
    const wanted = String(args.name ?? '');
    const row = ProviderNodes.rowOf(wanted, rows);
    if (row === null) {
      const available = rows.length > 0 ? ` (available: ${rows.join(', ')})` : '';
      throw new Error(`no provider "${wanted}"${available}`);
    }
    this.#providerName = row;
    const provider = this.#makeProvider(row);
    this.#provider = provider;
    this.model?.setProvider(provider);
    await this.#persistActiveProvider(row);
    if (this.parent !== null) await this.group.agentsChanged();
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
