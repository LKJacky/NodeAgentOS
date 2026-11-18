// The direct provider: a `provider` row dialled here, in this process.
//
// A row on the shared `provider` node is this stack's own credentials for a model endpoint, so
// asking another process for an answer only to get the same text back costs a bus round trip, a
// topic per stream and a subscribe/start dance for every round. What this class does instead is
// import the provider package's core - the same `buildProvider` the node uses, and the same wires -
// and speak to the endpoint itself: the deltas arrive as the generator yields them, usage and the
// stateful handle come from the same chunks, and a failure is the same sentence the node would have
// sent.
//
// The row (credentials included) comes from the node's `row` capability, because the rows are filed
// in the bus history under the *node's* name and no other node can read them. That is one small
// directory read per request; the model call - the part that must not be a bus trip - is this one.
// The config is never logged and never published: only the endpoint sees the key.
//
// `local-provider` is deliberately not this: its rows belong to the stack's own endpoint on this
// machine and the bus is the only path that knows where that endpoint is, so a `local-provider` row
// stays on `NodeProvider`. The runtime is what decides which of the two a selection means.
import {
  buildProvider,
  isAbortFailure,
  type ChatOutput,
  type Fetcher,
  type JsonObject,
  type Message as CoreMessage,
  type Provider as CoreProvider,
  type StreamOutput,
  type ToolSpec as CoreToolSpec,
} from '@node-agent/provider/core';
import { tokenUsage } from './helpers.js';
import { abortError, abortable, chunkEvents, streamIdleMs } from './model.js';
import type {
  ChatReply,
  ChatRequest,
  Message,
  Provider,
  StreamEvent,
  ToolCall,
  ToolSpec,
} from './types.js';

/** How one row becomes a wire: the provider package's `buildProvider`, or a stand-in an embedder
 *  (or a test) passes to keep the network out of the loop. */
export type CoreBuilder = (config: JsonObject, fetcher: Fetcher, name: string) => CoreProvider;

export type DirectProviderOptions = {
  /** The bare row name on the shared node: what the node knows it by. */
  readonly row: string;
  /** The row as the node holds it, fetched from its `row` capability when a request is dialled. */
  readonly config: () => Promise<JsonObject>;
  /** What this process posts with: the bus scope's `fetch`, so a proxy or a trace wrapper still
   *  applies to a call the agent makes itself. */
  readonly fetcher: Fetcher;
  /** The node the row came from, for the sentence that says one did not come back. */
  readonly node?: string;
  /** The idle timeout in force, read per stream: it is a setting, and a setting changes without the
   *  provider object being rebuilt. */
  readonly idleMs?: () => number;
  /** Build the wire for one row. Defaults to the provider core's own builder. */
  readonly build?: CoreBuilder;
};

/** What a caller reads when the node answered without a row: which two ways out there are. Never a
 *  silent hand-off to the bus - a turn that cannot be answered must say so. */
export function missingConfig(row: string, node: string): string {
  return `the provider node "${node}" answered without row "${row}" — this agent dials a provider row itself, so it needs the row the node has (check the row on the provider page, or select a local-provider row to go through the bus)`;
}

/** One read from the wire, bounded in time: a provider that stays quiet for longer than `idleMs` is
 *  stalled, and waiting on would hang the turn. The same bound, and the same sentence, as the bus
 *  path applies to an event that never arrives. */
async function withinIdle<T>(waiting: Promise<T>, idleMs: number): Promise<T> {
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

/** The message shape the provider core reads: the same fields, and nothing added. */
function coreMessages(messages: readonly Message[]): CoreMessage[] {
  return messages.map((message) => ({ ...message }) as CoreMessage);
}

/** The tools, in the neutral shape the wires translate from. */
function coreTools(tools: readonly ToolSpec[] | undefined): CoreToolSpec[] | null {
  if (tools === undefined || tools.length === 0) return null;
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

/** A tool call as the core reports it, in the shape this package's transcript holds: an id and a
 *  name are what the model's next turn has to echo back, so a call without them is not one. */
function toolCallsOf(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ToolCall[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const id = typeof call.id === 'string' ? call.id : '';
    const name = typeof call.function?.name === 'string' ? call.function.name : '';
    const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
    // A call the model cannot be asked about is not a call: the next turn echoes these three fields
    // back, and a nameless one has nothing to run.
    if (name === '') continue;
    calls.push({ id, type: 'function', function: { name, arguments: args } });
  }
  return calls.length > 0 ? calls : undefined;
}

/** One non-streamed answer, translated into this package's reply. */
function replyOf(answer: ChatOutput): ChatReply {
  const message = answer?.message ?? {};
  const calls = toolCallsOf(message.tool_calls);
  const usage = tokenUsage(answer?.usage);
  return {
    content: typeof message.content === 'string' ? message.content : null,
    ...(typeof message.reasoning_content === 'string'
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(calls !== undefined ? { tool_calls: calls } : {}),
    ...(usage !== undefined ? { usage } : {}),
    previous_response_id:
      typeof answer?.previous_response_id === 'string' ? answer.previous_response_id : null,
    ...(message.provider_state !== undefined && message.provider_state !== null
      ? { provider_state: message.provider_state }
      : {}),
  };
}

export class DirectProvider implements Provider {
  /** The row as a selection names it (`provider.fast`), for the page and for a log line. */
  readonly name: string;
  readonly #options: DirectProviderOptions;
  readonly #build: CoreBuilder;

  constructor(name: string, options: DirectProviderOptions) {
    this.name = name;
    this.#options = options;
    this.#build = options.build ?? buildProvider;
  }

  /** The row's config, as the provider node holds it. Read per call: a row the page saved a second
   *  ago is the row the next round dials, and the reply is a directory read, not a model call. */
  async #config(): Promise<JsonObject> {
    const config = await this.#options.config();
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(missingConfig(this.#options.row, this.#options.node ?? 'provider'));
    }
    return config;
  }

  /** A cancel is a cancel, whichever layer noticed it: an abort raised by the wire is reported the
   *  way the bus path reports one, so a stopped turn is `canceled` and not a failed turn. */
  #failed(error: unknown, signal?: AbortSignal): Error {
    if (signal?.aborted === true || isAbortFailure(error)) return abortError();
    return error instanceof Error ? error : new Error(String(error));
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    if (request.signal?.aborted) throw abortError();
    const wire = this.#build(
      await abortable(this.#config(), request.signal),
      this.#options.fetcher,
      this.#options.row,
    );
    try {
      const answer = await abortable(
        wire.chat(
          coreMessages(request.messages),
          coreTools(request.tools),
          request.max_completion_tokens ?? null,
          request.previous_response_id ?? null,
        ),
        request.signal,
      );
      return replyOf(answer);
    } catch (error) {
      throw this.#failed(error, request.signal);
    } finally {
      await wire.close();
    }
  }

  /** One streamed round, straight from the wire.
   *
   *  The rows are read, the wire is built, and then the generator is pulled: every chunk becomes the
   *  same events the bus path publishes (`content`, `reasoning`, `tool_call`, `usage`, `state`), so
   *  the model above this seam cannot tell the two paths apart. A canceled request ends the wire and
   *  is reported as an abort; a stream that goes quiet past the idle timeout fails the turn; a
   *  provider error is the provider's own sentence, which names the row and the host. */
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (request.signal?.aborted) throw abortError();
    const wire = this.#build(
      await abortable(this.#config(), request.signal),
      this.#options.fetcher,
      this.#options.row,
    );
    const idleMs = this.#options.idleMs?.() ?? streamIdleMs();
    const calls = new Map<number, string>();
    let previousResponseId: string | null | undefined;
    let ended = false;
    const stream: AsyncGenerator<StreamOutput> = wire.chatStream(
      coreMessages(request.messages),
      coreTools(request.tools),
      request.max_completion_tokens ?? null,
      request.previous_response_id ?? null,
      request.signal,
    );
    try {
      while (true) {
        if (request.signal?.aborted) throw abortError();
        const next = await abortable(withinIdle(stream.next(), idleMs), request.signal);
        if (next.done === true) break;
        const chunk = next.value;
        // A stateful provider hands back the handle of the answer it is building; the next request
        // sends only what came after it.
        if (typeof chunk?.previous_response_id === 'string') {
          previousResponseId = chunk.previous_response_id;
        }
        for (const event of chunkEvents(chunk, calls)) yield event;
      }
      ended = true;
      yield { type: 'end', previous_response_id: previousResponseId ?? null };
    } catch (error) {
      throw this.#failed(error, request.signal);
    } finally {
      // A stream that was cut short is let go rather than abandoned: the wire's request is still
      // open until it is, and a canceled turn should not leave one behind. It is not awaited - a
      // generator suspended on a read that will never answer cannot be returned out of, and a
      // stopped turn must not wait for one - so the close rides along with the rejection.
      if (!ended) void stream.return(undefined).catch(() => undefined);
      await wire.close();
    }
  }
}
