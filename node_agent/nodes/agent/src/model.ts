// The model side of the agent: the transcript and its context budget, the transcript written down
// as history units, and the provider nodes a bus carries (`provider` / `local-provider`, one row
// per named model). A compression or a provider switch drops the stateful handle and sends the
// active context again from scratch; a turn writes its new lines, then advances the count unit
// atomically with an expected revision.
import type { BindingScope } from '@node-agent/sdk';
import type { CacheHistory } from './cache.js';
import { emptyUsage, tokenUsage, utcNow } from './helpers.js';
import type {
  ChatReply,
  ChatRequest,
  Message,
  Provider,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolSpec,
  UsageSummary,
} from './types.js';

/** A system line that stands in for context this model has forgotten. */
export const FORGET_MESSAGE: Message = {
  role: 'system',
  content: 'This message represents some context that has been forgotten.',
};

/** What is written when a cut is announced: how many leading messages go, and a quote of the first
 *  and the last of them, so the model can see what it is losing. */
export const COMPRESSION_NOTICE = `{count} earlier messages are too old to keep; they will be dropped from this transcript soon. Only
the first and the last of them are quoted below — the ones in between go with them. If any of it
still matters (a fact, a path, a name, a decision), say it in your reply or save it with a tool
now: after the cut it cannot be recovered.
`;

/** How much of a dropped line the compression notice quotes back, in characters. */
export const SNIPPET_CHARS = 1024;

/** The transcript as a window: the lines still held, and how many older ones were forgotten before
 *  them, so an absolute index survives a cut. */
export class WindowMessages {
  readonly #items: Message[];
  forgotten: number;

  constructor(items: readonly Message[] = [], forgotten = 0) {
    this.#items = [...items];
    this.forgotten = forgotten;
  }

  /** How many lines the transcript has ever had: the window plus what it forgot. */
  get total(): number {
    return this.forgotten + this.#items.length;
  }

  /** How many lines are held right now. */
  get length(): number {
    return this.#items.length;
  }

  /** The line at a window-relative index. */
  at(index: number): Message | undefined {
    return this.#items[index];
  }

  /** The line at an absolute index, counting the forgotten ones. */
  absolute(index: number): Message | undefined {
    return this.#items[index - this.forgotten];
  }

  slice(start: number, end: number): Message[] {
    return this.#items.slice(start, end);
  }

  /** Absolute slice: `[start, end)` counted from the first line the transcript ever had. */
  absoluteSlice(start: number, end: number): Message[] {
    const from = Math.max(start, this.forgotten);
    return this.#items.slice(from - this.forgotten, Math.max(0, end - this.forgotten));
  }

  push(...messages: Message[]): void {
    this.#items.push(...messages);
  }

  /** Forget everything before an absolute index; answers the new base. */
  forgetThrough(index: number): number {
    const keep = Math.max(0, Math.min(index - this.forgotten, this.#items.length));
    this.#items.splice(0, keep);
    this.forgotten += keep;
    return this.forgotten;
  }

  wipe(): void {
    this.#items.length = 0;
    this.forgotten = 0;
  }
}

export type ModelOptions = {
  readonly compressionThreshold?: number;
  readonly compressionTokens?: number;
  /** Called with every line as it is committed: the page hears a turn happen without polling. */
  readonly onCommit?: (messages: readonly Message[]) => Promise<void> | void;
  /** Called with a snapshot of the answer while it streams. Not a transcript entry. */
  readonly onUpdate?: (message: Message) => Promise<void> | void;
};

/** One round's outcome: the assistant line it committed, and whether the turn was cut short. */
export type RoundResult = { readonly message: Message; readonly canceled: boolean };

export class CachedModel {
  messages = new WindowMessages();
  provider: Provider;
  previousResponseId: string | null = null;
  /** How many leading lines of the active context the provider already has. */
  sentMessages = 0;
  readonly usage: UsageSummary = emptyUsage();
  cachedNumTokens = 0;
  readonly compressionThreshold: number;
  readonly compressionTokens: number;
  nextForgetIndex = -1;
  readonly #onCommit: ModelOptions['onCommit'];
  readonly #onUpdate: ModelOptions['onUpdate'];

  constructor(provider: Provider, options: ModelOptions = {}) {
    this.provider = provider;
    this.compressionThreshold = options.compressionThreshold ?? 128 * 1024;
    this.compressionTokens = options.compressionTokens ?? 32 * 1024;
    this.#onCommit = options.onCommit;
    this.#onUpdate = options.onUpdate;
  }

  /** Point the model at another provider. A size belongs to the provider that measured it, so the
   *  cached number is dropped rather than carried over. */
  setProvider(provider: Provider): void {
    this.provider = provider;
    this.previousResponseId = null;
    this.sentMessages = 0;
    this.cachedNumTokens = 0;
  }

  /** The lines the provider should see for the next request. */
  activeMessages(extra: readonly Message[] = []): Message[] {
    const head = this.messages.forgotten > 0 ? [FORGET_MESSAGE] : [];
    return [
      ...head,
      ...this.messages.absoluteSlice(this.messages.forgotten, this.messages.total),
      ...extra,
    ];
  }

  /** What goes on the wire: full context, or the unsent suffix plus the handle that names the rest. */
  requestMessages(extra: readonly Message[] = []): {
    messages: Message[];
    previous: string | null;
  } {
    const active = this.activeMessages(extra);
    if (this.previousResponseId === null || this.sentMessages > active.length) {
      return { messages: active, previous: null };
    }
    return { messages: active.slice(this.sentMessages), previous: this.previousResponseId };
  }

  /** One streamed round: the assistant line it commits, and whether it was cut short. */
  async chatStream(
    tools: readonly ToolSpec[],
    options: { signal?: AbortSignal } = {},
  ): Promise<RoundResult> {
    if (this.cachedNumTokens === 0 && this.messages.length > 0) {
      await this.recomputeCachedNumTokens(tools);
    }
    const started = Date.now();
    await this.maybeCompress(tools);

    const outgoing = this.requestMessages();
    let content = '';
    let reasoning = '';
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let rawUsage: TokenUsage | undefined;
    let providerState: unknown;
    let nextResponseId: string | null | undefined;
    let canceled = false;

    const snapshot = (): Message => {
      const line: Message = { role: 'assistant', content };
      if (reasoning) line.reasoning_content = reasoning;
      const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (ordered.length > 0) {
        line.tool_calls = ordered.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return line;
    };

    try {
      const stream = this.provider.stream({
        messages: outgoing.messages,
        tools,
        previous_response_id: outgoing.previous,
        signal: options.signal,
      });
      for await (const event of stream as AsyncIterable<StreamEvent>) {
        if (options.signal?.aborted) {
          canceled = true;
          break;
        }
        if (event.type === 'content') content += event.text;
        else if (event.type === 'reasoning') reasoning += event.text;
        else if (event.type === 'tool_call') {
          const call = calls.get(event.index) ?? { id: '', name: '', arguments: '' };
          calls.set(event.index, {
            id: event.id ?? call.id,
            name: event.name ?? call.name,
            arguments: call.arguments + (event.arguments ?? ''),
          });
        } else if (event.type === 'usage') rawUsage = event.usage;
        else if (event.type === 'state') providerState = event.state;
        else if (event.type === 'end') nextResponseId = event.previous_response_id ?? null;
        if (this.#onUpdate !== undefined) await this.#onUpdate(snapshot());
      }
    } catch (error) {
      // A stream the reader stopped throws whatever the transport calls an abort; the partial answer
      // is still the round's answer, and the turn ends on it.
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        canceled = true;
      } else {
        throw error;
      }
    }

    const message = snapshot();
    if (rawUsage !== undefined) message.usage = { ...rawUsage };
    if (providerState !== undefined) message.provider_state = providerState;
    message.took_ms = Math.max(0, Date.now() - started);
    const usage = message.usage;
    if (usage !== undefined) {
      const promptTokens = Math.max(0, usage.prompt_tokens - this.cachedNumTokens);
      const completionTokens = usage.completion_tokens;
      const totalTokens = promptTokens + completionTokens;
      this.cachedNumTokens += totalTokens;
      this.usage.model_calls += 1;
      this.usage.reported_calls += 1;
      this.usage.prompt_tokens += promptTokens;
      this.usage.completion_tokens += completionTokens;
      this.usage.total_tokens += totalTokens;
      message.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      };
    } else {
      this.usage.model_calls += 1;
    }

    await this.pushMessages([message]);
    if (!canceled) {
      // A successful round owns the new upstream position. On cancellation the previous one stays,
      // so the partial answer is replayed as a delta next time.
      this.previousResponseId = nextResponseId ?? null;
      this.sentMessages = nextResponseId != null ? this.activeMessages().length : 0;
    }
    return { message, canceled };
  }

  /** Commit lines to the transcript. The line's time is written where it joins the transcript, so a
   *  line replayed from an older file keeps the time it was written with. */
  async pushMessages(messages: readonly Message[]): Promise<void> {
    for (const message of messages) {
      if (message.at === undefined) message.at = utcNow();
    }
    this.messages.push(...messages);
    if (this.#onCommit !== undefined) await this.#onCommit(messages);
  }

  /** Measure the transcript with the provider that is answering now. */
  async recomputeCachedNumTokens(tools: readonly ToolSpec[]): Promise<void> {
    const reply = await this.provider.chat({
      messages: this.activeMessages(),
      tools,
      max_completion_tokens: 16,
      previous_response_id: null,
    });
    this.cachedNumTokens = reply.usage?.prompt_tokens ?? 0;
  }

  /** Warn once, then forget, but only at a round boundary. */
  async maybeCompress(tools: readonly ToolSpec[]): Promise<void> {
    if (this.cachedNumTokens <= this.compressionThreshold) return;
    if (this.nextForgetIndex === -1) {
      const notice = this.getCompressionMsg();
      if (notice !== null) await this.pushMessages([notice]);
    } else if (this.cachedNumTokens > this.compressionThreshold + this.compressionTokens) {
      if (this.getUnclosedToolCalls().length > 0) return;
      let lastUser = -1;
      for (let index = this.messages.length - 1; index >= 0; index -= 1) {
        if (this.messages.at(index)?.role === 'user') {
          lastUser = index;
          break;
        }
      }
      const after = this.messages.slice(lastUser + 1, this.messages.length);
      if (after.some((message) => message.role === 'tool')) return;
      await this.resetForgetIndex(this.nextForgetIndex, tools);
    }
  }

  /** Forget everything before an absolute index, and the plan that led here. */
  async resetForgetIndex(forgetIndex: number, tools: readonly ToolSpec[]): Promise<void> {
    this.messages.forgetThrough(Math.max(forgetIndex, this.messages.forgotten));
    this.nextForgetIndex = -1;
    this.previousResponseId = null;
    this.sentMessages = 0;
    await this.recomputeCachedNumTokens(tools);
  }

  /** The notice `maybeCompress` writes once: how many leading messages are about to go, and a quote
   *  of the first and the last of them. */
  getCompressionMsg(): Message | null {
    if (this.messages.length === 0) return null;
    const snippet = (message: Message, head: boolean): string => {
      let content = String(message.content ?? '');
      if (!content && message.tool_calls !== undefined && message.tool_calls.length > 0) {
        const names = message.tool_calls.map((call) => call.function.name || '?').join(', ');
        content = `(tool_calls: ${names})`;
      }
      const excerpt =
        content.length > SNIPPET_CHARS
          ? head
            ? `${content.slice(0, SNIPPET_CHARS)}\n...`
            : `...\n${content.slice(-SNIPPET_CHARS)}`
          : content;
      return `${message.role}: \n${excerpt}`;
    };

    let forgotten = 0;
    let index = 0;
    for (; index < this.messages.length; index += 1) {
      forgotten += this.messages.at(index)?.usage?.total_tokens ?? 0;
      if (forgotten > this.compressionTokens) break;
    }
    while (index + 1 < this.messages.length && this.messages.at(index + 1)?.role === 'tool')
      index += 1;

    const first = snippet(this.messages.at(0) as Message, true);
    const last = snippet(this.messages.at(index) as Message, false);
    this.nextForgetIndex = this.messages.forgotten + index + 1;
    const count = this.nextForgetIndex - this.messages.forgotten;
    return {
      role: 'system',
      content: `${COMPRESSION_NOTICE.replace('{count}', String(count))}<too-old>\n${first}\n\n...\n\n${last}\n</too-old>`,
    };
  }

  /** Ids of the tool_calls in the newest assistant line that no `tool` line has answered. */
  getUnclosedToolCalls(): string[] {
    let index = this.messages.length - 1;
    const answered = new Set<string | undefined>();
    while (index >= 0 && this.messages.at(index)?.role === 'tool') {
      answered.add(this.messages.at(index)?.tool_call_id);
      index -= 1;
    }
    const line = index >= 0 ? this.messages.at(index) : undefined;
    if (line?.role !== 'assistant' || line.tool_calls === undefined) return [];
    return line.tool_calls.map((call: ToolCall) => call.id).filter((id) => !answered.has(id));
  }

  /** Answer every tool call the turn will never answer, so the transcript stays valid. */
  async appendUnclosedToolResults(content: string): Promise<void> {
    for (const id of this.getUnclosedToolCalls()) {
      await this.pushMessages([{ role: 'tool', tool_call_id: id, content }]);
    }
  }
}

// The transcript written down: one history unit per line (`conversation.<n>`), and one unit naming
// how many there are (`conversation`, meta `{messages, usage, forgotten}`). A turn writes its new
// lines, then advances that count atomically with an expected revision — so a half-written turn is
// never read as a whole one.
export const CONVERSATION_KEY = 'conversation';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class StatedModel extends CachedModel {
  readonly #history: CacheHistory;
  #revision: number | null = null;
  #nextIndex = 0;

  constructor(provider: Provider, history: CacheHistory, options: ModelOptions = {}) {
    super(provider, options);
    this.#history = history;
  }

  static messageUnit(index: number): string {
    return `${CONVERSATION_KEY}.${index}`;
  }

  get revision(): number | null {
    return this.#revision;
  }

  /** Read the transcript back: the count first, then the lines it names. Throws when history is not
   *  there, which is the caller's signal to carry on without persistence. */
  async load(): Promise<void> {
    let unit = await this.#history.load(CONVERSATION_KEY);
    if (unit === null) {
      await this.#history.save(CONVERSATION_KEY, { messages: 0, usage: this.usage });
      unit = await this.#history.load(CONVERSATION_KEY);
    }
    const state = (unit?.meta ?? {}) as {
      messages?: unknown;
      forgotten?: unknown;
      usage?: unknown;
    };
    const total = isCount(state.messages) ? state.messages : 0;
    // A forgotten count past the end of the transcript (a half-written state) must not become the
    // place new lines start: clamp it to what history actually holds.
    const forgotten = Math.max(0, Math.min(isCount(state.forgotten) ? state.forgotten : 0, total));

    const lines: Message[] = [];
    for (let index = forgotten; index < total; index += 1) {
      const line = await this.#history.load(StatedModel.messageUnit(index));
      if (line === null) throw new Error(`history is missing message ${index} of ${total}`);
      lines.push(line.meta as Message);
    }
    this.messages = new WindowMessages(lines, forgotten);
    if (typeof state.usage === 'object' && state.usage !== null) {
      Object.assign(this.usage, state.usage as Partial<UsageSummary>);
    }
    this.#revision = typeof unit?.revision === 'number' ? unit.revision : null;
    this.#nextIndex = this.messages.total;
    await this.appendUnclosedToolResults('unexpected exit');
  }

  /** Every line written is a line stored: a reload continues the same conversation. */
  override async pushMessages(messages: readonly Message[]): Promise<void> {
    await super.pushMessages(messages);
    await this.persist();
  }

  /** Write new transcript entries, then atomically advance the conversation state. */
  async persist(): Promise<void> {
    if (this.#revision === null) return;
    for (let index = this.#nextIndex; index < this.messages.total; index += 1) {
      const line = this.messages.absolute(index);
      if (line === undefined) continue;
      await this.#history.save(StatedModel.messageUnit(index), line);
    }
    const revision = await this.#history.save(
      CONVERSATION_KEY,
      { messages: this.messages.total, usage: this.usage, forgotten: this.messages.forgotten },
      this.#revision,
    );
    if (revision !== null) this.#revision = revision;
    this.#nextIndex = this.messages.total;
  }

  /** Delete every unit this transcript owns; answers the names that would not go. */
  async wipeHistory(): Promise<string[]> {
    const left: string[] = [];
    for (let index = 0; index < this.messages.total; index += 1) {
      const unit = StatedModel.messageUnit(index);
      try {
        await this.#history.remove(unit);
      } catch {
        left.push(unit);
      }
    }
    try {
      await this.#history.remove(CONVERSATION_KEY);
    } catch {
      left.push(CONVERSATION_KEY);
    }
    this.#revision = null;
    this.#nextIndex = 0;
    this.messages = new WindowMessages();
    return left;
  }
}

// The provider a bus carries: `provider` (shared) or `local-provider` (the endpoint the stack runs
// itself), each with its own named rows. A row is addressed as `<node>.<name>`, so both nodes are
// usable by one agent at the same time and the choice is per row. A bare name is still accepted and
// means the near node, so a selection stored before local mode existed keeps working.
//
// This class is stateless: the conversation lives in CachedModel on this side, and the provider node
// only forwards one provider-neutral request, including the upstream handle when it returned one.
export const LOCAL_PROVIDER_NODE = 'local-provider';
export const SHARED_PROVIDER_NODE = 'provider';

/** How long the directory may take before the shared node is assumed: a turn must not fail over
 *  which names to ask. */
const PROVIDER_PROBE_MS = 500;

/** One provider stream's events, handed over as they arrive rather than polled. */
export class EventQueue<T> {
  #items: T[] = [];
  #waiters: ((value: T | undefined) => void)[] = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(value);
    else this.#items.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
  }

  async next(): Promise<T | undefined> {
    if (this.#items.length > 0) return this.#items.shift();
    if (this.#closed) return undefined;
    return await new Promise<T | undefined>((resolve) => this.#waiters.push(resolve));
  }
}

/** How long a stream may stay silent before the provider is called stuck, in milliseconds. This is
 *  an idle timeout and not a deadline for the turn: a provider is allowed to think for a long time
 *  before its first chunk, and an interval between two chunks is thinking too. */
export const STREAM_IDLE_MS = 120_000;

/** The idle timeout in force: NODE_AGENT_STREAM_IDLE_MS when it names a positive whole number of
 *  milliseconds, this package's default otherwise. */
export function streamIdleMs(): number {
  const fromEnv = Number(process.env.NODE_AGENT_STREAM_IDLE_MS ?? '');
  return Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : STREAM_IDLE_MS;
}

/** One read from a stream's queue, bounded in time: a provider that stays quiet for longer than
 *  `idleMs` is stalled, and waiting on would hang the turn. */
async function drainStreamEvent(
  waiting: Promise<Record<string, unknown> | undefined>,
  idleMs: number,
): Promise<Record<string, unknown> | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      waiting,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('provider stream stalled waiting for its next event')),
          idleMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The streams this process is waiting on, by stream id: the event arrives on the bus and the
 *  runtime hands it to the queue that id names. */
export class StreamHub {
  readonly #queues = new Map<string, EventQueue<Record<string, unknown>>>();

  open(streamId: string): EventQueue<Record<string, unknown>> {
    const queue = new EventQueue<Record<string, unknown>>();
    this.#queues.set(streamId, queue);
    return queue;
  }

  close(streamId: string): void {
    const queue = this.#queues.get(streamId);
    this.#queues.delete(streamId);
    queue?.close();
  }

  /** One event from `provider.stream.<id>`; a stream this process is not waiting on is ignored, so
   *  an event from a finished or cancelled stream cannot land in somebody else's answer. */
  deliver(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const event = value as Record<string, unknown>;
    const streamId = event.stream_id;
    if (typeof streamId !== 'string') return;
    this.#queues.get(streamId)?.push(event);
  }

  get size(): number {
    return this.#queues.size;
  }
}

/** The provider nodes this agent may dial, and the rows each one carries. */
export class ProviderNodes {
  readonly #bus: () => BindingScope;

  constructor(bus: () => BindingScope) {
    this.#bus = bus;
  }

  /** The provider nodes the bus carries right now, the near one first. A directory that cannot be
   *  read, or one that answers too slowly, is `provider` and nothing else. */
  async onBindingScope(): Promise<string[]> {
    let names: Set<string>;
    try {
      const nodes = await Promise.race([
        this.#bus().listNodes(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('no directory in time')),
            PROVIDER_PROBE_MS,
          );
          timer.unref?.();
        }),
      ]);
      names = new Set(nodes.map((node) => node.name));
    } catch {
      return [SHARED_PROVIDER_NODE];
    }
    const found = [LOCAL_PROVIDER_NODE, SHARED_PROVIDER_NODE].filter((name) => names.has(name));
    return found.length > 0 ? found : [SHARED_PROVIDER_NODE];
  }

  /** The node a bare provider name means: the near one when the bus carries it. */
  async home(): Promise<string> {
    return (await this.onBindingScope())[0] as string;
  }

  static qualified(node: string, name: string): string {
    return `${node}.${name}`;
  }

  /** `<node>.<name>` as its two halves; a bare name is all name and no node. */
  static split(named: string): { node: string | null; name: string } {
    const at = named.indexOf('.');
    if (at < 0) return { node: null, name: named };
    const node = named.slice(0, at);
    const name = named.slice(at + 1);
    return name !== '' && (node === LOCAL_PROVIDER_NODE || node === SHARED_PROVIDER_NODE)
      ? { node, name }
      : { node: null, name: named };
  }

  /** Which of `rows` a selection names: itself when qualified, else the first row of that name. */
  static rowOf(named: string | null | undefined, rows: readonly string[]): string | null {
    if (!named) return null;
    const { node, name } = ProviderNodes.split(named);
    if (node !== null) return rows.includes(named) ? named : null;
    return rows.find((row) => ProviderNodes.split(row).name === name) ?? null;
  }

  /** Every row on every provider node that answers, each named with the node it lives on. A node
   *  that does not answer its own listing is left out instead of failing the whole list. */
  async names(): Promise<string[]> {
    const rows: string[] = [];
    for (const node of await this.onBindingScope()) {
      try {
        const state = await this.#bus().call<{ providers?: unknown }>(node, 'providers', {
          action: 'list',
        });
        const list = Array.isArray(state?.providers) ? state.providers : [];
        for (const row of list) {
          if (typeof row !== 'object' || row === null) continue;
          const name = (row as { name?: unknown }).name;
          if (typeof name === 'string' && name !== '')
            rows.push(ProviderNodes.qualified(node, name));
        }
      } catch {
        // One silent node must not hide the other's rows.
      }
    }
    return rows;
  }
}

function abortError(): Error {
  const error = new Error('the turn was stopped');
  error.name = 'AbortError';
  return error;
}

/** Resolve with `wait`, or reject as soon as `signal` aborts. The listener is removed when the
 *  wait settles; an abort after that is somebody else's concern. */
function abortable<T>(wait: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return wait;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(abortError());
    signal.addEventListener('abort', stop, { once: true });
    wait.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Maps one provider chunk (`{delta, usage?, previous_response_id?, provider_state?}`) to events. */
function chunkEvents(chunk: unknown, calls: Map<number, string>): StreamEvent[] {
  if (typeof chunk !== 'object' || chunk === null) return [];
  const payload = chunk as {
    delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
    usage?: unknown;
    previous_response_id?: unknown;
    provider_state?: unknown;
  };
  const events: StreamEvent[] = [];
  const delta = payload.delta ?? {};
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
    events.push({ type: 'reasoning', text: delta.reasoning_content });
  }
  if (typeof delta.content === 'string' && delta.content !== '') {
    events.push({ type: 'content', text: delta.content });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const entry of delta.tool_calls) {
      if (typeof entry !== 'object' || entry === null) continue;
      const call = entry as {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const at = typeof call.index === 'number' ? call.index : calls.size;
      if (typeof call.id === 'string' && call.id !== '') calls.set(at, call.id);
      events.push({
        type: 'tool_call',
        index: at,
        ...(typeof call.id === 'string' && call.id !== '' ? { id: call.id } : {}),
        ...(typeof call.function?.name === 'string' && call.function.name !== ''
          ? { name: call.function.name }
          : {}),
        ...(typeof call.function?.arguments === 'string'
          ? { arguments: call.function.arguments }
          : {}),
      });
    }
  }
  const usage: TokenUsage | undefined = tokenUsage(payload.usage);
  if (usage !== undefined) events.push({ type: 'usage', usage });
  if (payload.provider_state !== undefined && payload.provider_state !== null) {
    events.push({ type: 'state', state: payload.provider_state });
  }
  return events;
}

/** The topic one provider stream publishes on: the id the provider minted for that request, and
 *  nothing else - not the caller's name, which would mix two agents' deltas on one topic. */
export const STREAM_TOPIC_PREFIX = 'provider.stream.';

/** Stateless provider proxy to a provider bus node. */
export class NodeProvider implements Provider {
  readonly #bus: () => BindingScope;
  readonly #nodes: ProviderNodes;
  readonly #hub: StreamHub;
  readonly name: string | null;

  constructor(bus: () => BindingScope, nodes: ProviderNodes, hub: StreamHub, name: string | null) {
    this.#bus = bus;
    this.#nodes = nodes;
    this.#hub = hub;
    this.name = name;
  }

  #missing(): string {
    return "no provider node is on the bus — connect node-agent-provider, then select its provider in this agent's page";
  }

  /** Where one provider capability is dialled, and the bare name the node knows the row by. */
  async #route(capability: string): Promise<{ node: string; cap: string; name: string }> {
    const selected = this.name ?? (await this.#nodes.names())[0] ?? null;
    if (selected === null) throw new Error(this.#missing());
    const { node, name } = ProviderNodes.split(selected);
    return { node: node ?? (await this.#nodes.home()), cap: capability, name };
  }

  #request(args: Record<string, unknown>, request: ChatRequest): Record<string, unknown> {
    return {
      ...args,
      messages: request.messages,
      ...(request.tools !== undefined && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(request.max_completion_tokens !== undefined
        ? { max_completion_tokens: request.max_completion_tokens }
        : {}),
      ...(request.previous_response_id !== undefined && request.previous_response_id !== null
        ? { previous_response_id: request.previous_response_id }
        : {}),
    };
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    const { node, cap, name } = await this.#route('chat');
    const reply = await this.#bus().call<{
      message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
      usage?: unknown;
      previous_response_id?: unknown;
    }>(node, cap, this.#request({ name }, request));
    const message = reply?.message ?? {};
    const calls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as ToolCall[])
      : undefined;
    const usage = tokenUsage(reply?.usage);
    return {
      content: typeof message.content === 'string' ? message.content : null,
      ...(typeof message.reasoning_content === 'string'
        ? { reasoning_content: message.reasoning_content }
        : {}),
      ...(calls !== undefined && calls.length > 0 ? { tool_calls: calls } : {}),
      ...(usage !== undefined ? { usage } : {}),
      previous_response_id:
        typeof reply?.previous_response_id === 'string' ? reply.previous_response_id : null,
    };
  }

  /** Stream one answer through the provider node.
   *
   *  Three calls, in this order, because the bus only delivers an event to a node that was already
   *  subscribed when it was published: ask for a stream id, subscribe to `provider.stream.<id>`, and
   *  only then say the stream may start. The provider dials the model on `stream_ready`, so no delta
   *  can be published into a room nobody is in yet - the id comes back first, always. The
   *  subscription is dropped in `finally`, whichever way the stream ends, and a stream that did not
   *  finish is cancelled by that same id. */
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (request.signal?.aborted) throw abortError();
    const { node, name } = await abortable(this.#route('start_stream'), request.signal);
    const started = await abortable(
      this.#bus().call<{ stream_id?: unknown }>(
        node,
        'start_stream',
        this.#request({ name }, request),
      ),
      request.signal,
    );
    const streamId = typeof started?.stream_id === 'string' ? started.stream_id.trim() : '';
    if (streamId === '')
      throw new Error('the provider answered a stream request without a stream id');
    const topic = `${STREAM_TOPIC_PREFIX}${streamId}`;
    // Opened before the subscription, so an event that lands while `subscribe` is still in flight has
    // somewhere to go rather than being dropped as an unknown id.
    const queue = this.#hub.open(streamId);

    let listening = false;
    let completed = false;
    let ended = false;
    const callIndexes = new Map<number, string>();
    let previousResponseId: string | null | undefined;
    // One idle timeout for the whole stream: a provider that stalls between events fails the turn,
    // while one that merely thinks for longer than a chunk usually takes is left alone.
    const idleMs = streamIdleMs();
    try {
      await abortable(this.#bus().subscribe(topic, node), request.signal);
      listening = true;
      await abortable(
        this.#bus().call(node, 'stream_ready', { stream_id: streamId }),
        request.signal,
      );
      while (true) {
        if (request.signal?.aborted) throw abortError();
        const event = await abortable(drainStreamEvent(queue.next(), idleMs), request.signal);
        if (event === undefined) throw new Error('the provider stream ended without a done event');
        const kind = event.event;
        if (kind === 'chunk') {
          // A stateful provider hands back the handle of the answer it is building; the next
          // request sends only what came after it.
          const chunk = event.chunk as { previous_response_id?: unknown } | undefined;
          if (typeof chunk?.previous_response_id === 'string') {
            previousResponseId = chunk.previous_response_id;
          }
          for (const chunkEvent of chunkEvents(event.chunk, callIndexes)) yield chunkEvent;
        } else if (kind === 'error') {
          throw new Error(String(event.error ?? 'provider stream failed'));
        } else if (kind === 'done') {
          completed = true;
          break;
        }
      }
      ended = true;
      yield { type: 'end', previous_response_id: previousResponseId ?? null };
    } finally {
      this.#hub.close(streamId);
      if (!completed && !ended) {
        // Cancel is best effort and must not make stop inherit the provider's delay.
        void this.#bus()
          .call(node, 'cancel_stream', { stream_id: streamId })
          .catch(() => undefined);
      }
      if (listening) await this.#stopListening(topic, node);
    }
  }

  /** Drop the subscription of one finished stream. A bus that cannot unsubscribe has nothing to
   *  undo: the subscription lives as long as this node's connection, and the events of a finished
   *  stream are dropped by `StreamHub` because its id is no longer open. */
  async #stopListening(topic: string, node: string): Promise<void> {
    try {
      await this.#bus().unsubscribe?.(topic, node);
    } catch {
      // A cleanup that cannot be answered does not change how the stream ended.
    }
  }
}
