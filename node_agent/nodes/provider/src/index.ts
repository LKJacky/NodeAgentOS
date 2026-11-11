// provider: the stack's LLM credentials, served to whoever asks.
//
// The node keeps no conversation. A caller sends the whole transcript, gets an answer, and the node
// remembers nothing between requests. Named rows live in history - or, in local mode, in the file
// `mode.ts` names, because that node serves this stack's own endpoint - and, without either, in this
// process; each row picks one of three wires: openai, anthropic or responses.
//
//   providers {action: list | save | delete, name?, config?}
//   chat {name, messages, tools?, max_completion_tokens?, previous_response_id?}
//   start_stream {name, messages, tools?, max_completion_tokens?, previous_response_id?} -> {stream_id, topic}
//   stream_ready {stream_id} -> {started}
//   cancel_stream {stream_id} -> {canceled}
//   ui
//
// A stream is three calls, not one, because a bus event is only delivered to a node that was already
// subscribed when it was published. The caller asks for a stream and is told its id, subscribes to
// `provider.stream.<id>`, and only then says the stream may start: the model is dialled after
// `stream_ready`, so not one delta can be published into a room nobody is in yet. The id is the
// whole address - never the caller's name, which would mix two agents' deltas and outlive the
// request - and it is forgotten as soon as the stream ends, fails or is cancelled.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Node,
  loadResource,
  paintPage,
  type NodeContext,
  type NodeHandlers,
  type Resource,
  type ToolArgs,
} from '@node-agent/sdk';
import {
  type ChatOutput,
  type Provider,
  type StreamOutput,
  type ToolSpec,
} from './providers/base.js';
import { buildProvider } from './providers/index.js';
import { localConfigPath } from './mode.js';
import { providerStore, type ProviderStore, validateName } from './persistency/index.js';
import type { JsonObject, Message } from './providers/base.js';

export type ProviderConfig = JsonObject;
export type InstalledProvider = { name: string; config: ProviderConfig; has_api_key: boolean };
export type ProviderState = { providers: InstalledProvider[]; persistent: boolean };

const PANEL = 'ui';
const MODEL_TIMEOUT = 120;

const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

/** The page's words, read from beside the compiled JS (`npm run build` copies src/i18n there). */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

let mutation: Promise<void> = Promise.resolve();

/** Serialise provider mutations so two saves never race over one history revision. */
async function withMutation<T>(work: () => Promise<T>): Promise<T> {
  const previous = mutation;
  let release: () => void = () => {};
  mutation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

/** How long a stream id waits for its `stream_ready` before it is dropped: a caller that asked for a
 *  stream and never opened it must not leave a row of session state behind forever. */
export const STREAM_PENDING_MS = 60_000;

/** One stream this node is serving, or is about to serve. */
type StreamSession = {
  readonly id: string;
  readonly topic: string;
  readonly provider: Provider;
  readonly messages: Message[];
  readonly tools: ToolSpec[] | null;
  readonly limit: number | null;
  readonly previous: string | null;
  readonly controller: AbortController;
  /** True once `stream_ready` said go: the model is being dialled, or has answered. */
  started: boolean;
  /** The timer that drops a stream nobody ever opened. */
  expiry: ReturnType<typeof setTimeout> | null;
};

/** The streams this node is serving, keyed by the id it handed out for each one. */
const activeStreams = new Map<string, StreamSession>();

function missingProvider(name: string, known: string[]): string {
  const others = [...known].sort().join(', ');
  return `no provider "${name}" yet — open the provider page and add one${others ? ` (configured: ${others})` : ''}`;
}

function environmentProvider(): ProviderConfig | null {
  const url = (process.env.NODE_AGENT_MODEL_URL ?? '').trim();
  const key = (process.env.NODE_AGENT_MODEL_KEY ?? '').trim();
  const model = (process.env.NODE_AGENT_MODEL_NAME ?? '').trim();
  if (!url || !key || !model) return null;
  return {
    type: 'openai',
    api_key: key,
    model_name: model,
    base_url: url.replace(/\/$/, '').replace(/\/chat\/completions$/, ''),
    timeout: MODEL_TIMEOUT,
    thinking_effort: null,
  };
}

class ProviderManager {
  readonly ctx: NodeContext;
  /** Where the rows live: this bus's history, or this machine's file (see `persistency/`). */
  readonly store: ProviderStore;
  providers: Record<string, ProviderConfig> = {};
  persistence = false;

  constructor(ctx: NodeContext, store: ProviderStore) {
    this.ctx = ctx;
    this.store = store;
  }

  state(): ProviderState {
    return {
      providers: Object.entries(this.providers).map(([name, config]) => {
        const row = { ...config };
        const apiKey = row.api_key;
        delete row.api_key;
        return { name, config: row, has_api_key: typeof apiKey === 'string' && apiKey !== '' };
      }),
      persistent: this.persistence,
    };
  }

  /** Load the saved rows, then the environment, then one blank row.
   *
   * Which rows are "saved" is the store's business: history for the shared provider, a file for the
   * local one, whose endpoint and credentials belong to the stack that started it. `persistence` is
   * the store's answer to "will these survive this process", which is what the page shows.
   */
  async load(): Promise<void> {
    const saved = await this.store.read();
    this.persistence = this.store.persistent;
    this.providers = saved ?? this.seeded();
  }

  /** What a stack nobody configured starts with: the three model variables, else one blank row. */
  private seeded(): Record<string, ProviderConfig> {
    const env = environmentProvider();
    return env ? { default: env } : { default: { type: 'openai' } };
  }

  /** The rows as the provider's own `dump()`, which is the shape both stores hold. */
  private dumped(): Record<string, ProviderConfig> {
    return Object.fromEntries(
      Object.entries(this.providers).map(([name, config]) => [
        name,
        buildProvider(config, this.ctx.fetch).dump(),
      ]),
    );
  }

  async persist(): Promise<void> {
    await this.store.write(this.dumped());
  }

  async handle(args: ToolArgs): Promise<ProviderState> {
    await this.load();
    const action = String(args.action ?? 'list');
    if (action === 'list') return this.state();
    return await withMutation(async () => {
      await this.load();
      const name = validateName(args.name);
      if (action === 'delete') {
        if (!(name in this.providers)) throw new Error(`provider "${name}" does not exist`);
        const remaining = { ...this.providers };
        delete remaining[name];
        if (Object.keys(remaining).length === 0) throw new Error('cannot delete the last provider');
        this.providers = remaining;
        await this.persist();
        return this.state();
      }
      if (action !== 'save') throw new Error(`unknown provider action "${action}"`);
      const raw = args.config;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('saving a provider needs a config object');
      const config = { ...(raw as ProviderConfig) };
      delete config.has_api_key;
      const existing = this.providers[name];
      if (!config.api_key && existing) config.api_key = existing['api_key'];
      if (!String(config.model_name ?? '').trim())
        throw new Error('provider model_name must be set');
      if (!config.api_key)
        throw new Error(
          'this provider needs an API key: leave the field blank only to keep the one it has',
        );
      // Rebuild once before saving: an unknown type or a bad timeout is refused here, not on a call.
      buildProvider(config, this.ctx.fetch);
      this.providers = { ...this.providers, [name]: config };
      await this.persist();
      return this.state();
    });
  }

  chatRequest(args: ToolArgs): {
    provider: Provider;
    messages: Message[];
    tools: ToolSpec[] | null;
    limit: number | null;
    previous: string | null;
  } {
    const name = validateName(args.name);
    const config = this.providers[name];
    if (!config) throw new Error(missingProvider(name, Object.keys(this.providers)));
    const messages = args.messages;
    if (!Array.isArray(messages)) throw new Error('provider chat needs a messages array');
    const tools = args.tools;
    if (tools !== undefined && tools !== null && !Array.isArray(tools))
      throw new Error('provider chat tools must be an array or null');
    const limit = args.max_completion_tokens;
    if (
      limit !== undefined &&
      limit !== null &&
      (!Number.isInteger(limit) || typeof limit === 'boolean')
    )
      throw new Error('max_completion_tokens must be an integer or null');
    const previous = args.previous_response_id;
    if (previous !== undefined && previous !== null && typeof previous !== 'string')
      throw new Error('previous_response_id must be a string or null');
    return {
      // The row's name travels with the provider: a connection that fails says which row and which
      // host, instead of the SDK's bare "Connection error."
      provider: buildProvider(config, this.ctx.fetch, name),
      messages: messages as Message[],
      tools: (tools as ToolSpec[] | undefined) ?? null,
      limit: (limit as number | undefined) ?? null,
      previous: (previous as string | undefined) ?? null,
    };
  }

  async chat(args: ToolArgs): Promise<ChatOutput> {
    await this.load();
    const request = this.chatRequest(args);
    try {
      return await request.provider.chat(
        request.messages,
        request.tools,
        request.limit,
        request.previous,
      );
    } finally {
      await request.provider.close();
    }
  }

  /** Ask for a stream: answer with its id, and dial nothing yet.
   *
   *  The row, the transcript and the tools are checked here, so a caller that named an unknown
   *  provider or a broken tool list is told at once instead of through a stream event. What is
   *  deliberately not done here is the request itself: the model must not answer before the caller
   *  has subscribed to `provider.stream.<id>` (see `streamReady`). */
  async startStream(args: ToolArgs): Promise<{ stream_id: string; topic: string }> {
    await this.load();
    const request = this.chatRequest(args);
    const id = randomUUID().replaceAll('-', '');
    const topic = `provider.stream.${id}`;
    const session: StreamSession = {
      id,
      topic,
      provider: request.provider,
      messages: request.messages,
      tools: request.tools,
      limit: request.limit,
      previous: request.previous,
      controller: new AbortController(),
      started: false,
      expiry: null,
    };
    session.expiry = setTimeout(() => {
      void this.#dropStream(session).catch(() => undefined);
    }, STREAM_PENDING_MS);
    session.expiry.unref?.();
    activeStreams.set(id, session);
    return { stream_id: id, topic };
  }

  /** Say the caller is listening: only now is the model dialled, and the answer arrives as events.
   *
   *  Answering before the first delta exists is the whole point, so this never throws for a failure
   *  of the model: that failure is published as `error` on the stream's own topic, where the caller
   *  that is already listening will see it. */
  streamReady(args: ToolArgs): { started: boolean } {
    const session = this.#streamOf(args.stream_id);
    if (session.started) return { started: true };
    session.started = true;
    if (session.expiry !== null) {
      clearTimeout(session.expiry);
      session.expiry = null;
    }
    void this.#runStream(session).catch(() => undefined);
    return { started: true };
  }

  /** Stop the stream the id names, whether it has started or not. */
  cancelStream(args: ToolArgs): { canceled: boolean } {
    const id = String(args.stream_id ?? '').trim();
    const session = activeStreams.get(id);
    if (session === undefined) return { canceled: false };
    if (session.started) {
      session.controller.abort();
      return { canceled: true };
    }
    void this.#dropStream(session, true).catch(() => undefined);
    return { canceled: true };
  }

  /** The stream one id names, or the refusal that says why there is none. */
  #streamOf(value: unknown): StreamSession {
    const id = String(value ?? '').trim();
    if (id === '') throw new Error('a provider stream call needs a stream_id');
    const session = activeStreams.get(id);
    if (session === undefined) throw new Error(`no provider stream "${id}"`);
    return session;
  }

  /** Publish one event of a stream, and never let a bus that has gone away turn a finished stream
   *  into a crash. These publishes happen after the call that asked for the stream was already
   *  answered, so a throw here has no caller to go to: it would end the whole node process, and
   *  every other caller's stream with it. */
  #emit(session: StreamSession, value: Record<string, unknown>): void {
    try {
      this.ctx.publish(session.topic, value);
    } catch {
      // The bus is gone; so is every reader of this event.
    }
  }

  /** Publish one stream's events until it ends, then forget it however it ended. */
  async #runStream(session: StreamSession): Promise<void> {
    const { id, controller } = session;
    let canceled = false;
    try {
      const stream: AsyncGenerator<StreamOutput> = session.provider.chatStream(
        session.messages,
        session.tools,
        session.limit,
        session.previous,
        controller.signal,
      );
      for await (const chunk of stream) {
        if (controller.signal.aborted) {
          canceled = true;
          break;
        }
        this.#emit(session, { stream_id: id, event: 'chunk', chunk });
      }
      // An iterator that ends without throwing after a cancel ended it is still a cancelled stream:
      // the caller asked for it to stop, and the `done` must say so.
      if (controller.signal.aborted) canceled = true;
    } catch (error) {
      if (controller.signal.aborted) canceled = true;
      else
        this.#emit(session, {
          stream_id: id,
          event: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (activeStreams.get(id) === session) activeStreams.delete(id);
      if (session.expiry !== null) {
        clearTimeout(session.expiry);
        session.expiry = null;
      }
      try {
        await session.provider.close();
      } catch {
        // Closing the wire is the provider's business; a stream that already ended says no more.
      }
      this.#emit(session, { stream_id: id, event: 'done', canceled });
    }
  }

  /** Forget a stream that never ran: the caller asked for it and never opened it, or cancelled it
   *  before the model was dialled. The provider row is closed so the wire does not outlive it. */
  async #dropStream(session: StreamSession, canceled = false): Promise<void> {
    if (session.started) return;
    if (activeStreams.get(session.id) === session) activeStreams.delete(session.id);
    if (session.expiry !== null) {
      clearTimeout(session.expiry);
      session.expiry = null;
    }
    try {
      await session.provider.close();
    } catch {
      // Nothing was in flight: a close that cannot answer changes nothing.
    }
    this.#emit(session, { stream_id: session.id, event: 'done', canceled });
  }
}

export class ProviderNode extends Node {
  readonly handlers: NodeHandlers;

  constructor(ctx: NodeContext) {
    super(ctx);
    const manager = new ProviderManager(
      ctx,
      providerStore(ctx, localConfigPath(ctx.nodeId, process.env, ctx.home)),
    );
    this.handlers = {
      providers: (args) => manager.handle(args),
      chat: (args) => manager.chat(args),
      start_stream: (args) => manager.startStream(args),
      stream_ready: (args) => manager.streamReady(args),
      cancel_stream: (args) => manager.cancelStream(args),
      // The registered bus name, not the package id: the page calls back with it.
      // `paintPage` writes the page's words in the language this visit asked for, and leaves the
      // markers the browser half redraws when the user switches language.
      [PANEL]: (args) =>
        paintPage(PAGE, RESOURCE, args).replace('"__NODE__"', () => JSON.stringify(ctx.nodeId)),
    };
  }
}

export default ProviderNode;
