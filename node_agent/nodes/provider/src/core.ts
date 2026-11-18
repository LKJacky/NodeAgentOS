// The provider core: everything this package does that is not a node.
//
// The node is the address - a manifest, a page, the `start_stream` / `stream_ready` / `cancel_stream`
// dance that lets a caller subscribe before the model is dialled. None of that is how a model is
// called. What a model call needs is here: the rows (where they are kept, and what a row means), the
// wires that speak to each endpoint, and one place that turns a checked request into an answer or a
// stream. Both the node and an agent that dials a `provider` row in its own process use this module,
// so there is exactly one implementation of a model request and exactly one set of error sentences.
//
// Nothing here is a node and nothing here publishes: this module can be imported by a process that
// has no bus at all.
import type { ToolArgs } from '@node-agent/sdk';
import type {
  ChatOutput,
  Fetcher,
  JsonObject,
  Message,
  Provider,
  ToolSpec,
} from './providers/base.js';
import { buildProvider } from './providers/index.js';
import { type ProviderRows, validateName } from './persistency/index.js';

export * from './providers/index.js';
export * from './persistency/index.js';
export { HistoryStore } from './persistency/history.js';
export { LocalStore } from './persistency/local.js';
export * from './mode.js';

/** What a caller is told when it names a row no store holds: which rows there were. */
export function missingProvider(name: string, known: string[]): string {
  const others = [...known].sort().join(', ');
  return `no provider "${name}" yet — open the provider page and add one${others ? ` (configured: ${others})` : ''}`;
}

/** How long one model request may take when the environment's row names no time of its own. */
export const MODEL_TIMEOUT = 120;

/** The row the environment describes: the three model variables, when all three are set.
 *
 * A stack is often configured before anybody opened the provider page, so the row this makes is
 * what "nothing has been saved yet" falls back to. It is read from the process, so the agent and
 * the node read the same variables and reach the same row. */
export function environmentProvider(): JsonObject | null {
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

/** The rows a process starts with when nothing has been saved: the environment's row, or one blank
 *  row the page can fill in. The node shows these and the agent dials them, so they must agree. */
export function seededRows(): ProviderRows {
  const env = environmentProvider();
  return env ? { default: env } : { default: { type: 'openai' } };
}

/** One row, checked and named: the config a caller dials and the name it is known by.
 *
 * The node's `row` capability and its own `chat` both come through here, so "which row" is answered
 * once - and a caller that dials the model itself is handed exactly what the node would have used. */
export function providerRow(rows: ProviderRows, args: ToolArgs): { name: string; config: JsonObject } {
  const name = validateName(args.name);
  const config = rows[name];
  if (!config) throw new Error(missingProvider(name, Object.keys(rows)));
  return { name, config };
}

/** One request that has already been checked and dialled: everything a provider needs, and the wire
 *  that will carry it. Building it is the validation step both callers share, so a malformed call is
 *  refused with the same sentence whether it came over the bus or out of the agent's own process. */
export type ProviderRequest = {
  readonly provider: Provider;
  readonly messages: Message[];
  readonly tools: ToolSpec[] | null;
  readonly limit: number | null;
  readonly previous: string | null;
};

/** Check one `chat` / `start_stream` argument set against the rows, and build the wire it names.
 *
 * `name` is the row; the failure sentences name the row and the host rather than the SDK's own
 * "Connection error." so an operator can tell two rows apart in one log. */
export function providerRequest(
  rows: ProviderRows,
  args: ToolArgs,
  fetcher: Fetcher,
  build: (data: JsonObject, fetcher: Fetcher, name: string) => Provider = buildProvider,
): ProviderRequest {
  const { name, config } = providerRow(rows, args);
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
    provider: build(config, fetcher, name),
    messages: messages as Message[],
    tools: (tools as ToolSpec[] | undefined) ?? null,
    limit: (limit as number | undefined) ?? null,
    previous: (previous as string | undefined) ?? null,
  };
}

/** One non-streamed answer, with the wire closed whichever way it ended. */
export async function runChat(request: ProviderRequest): Promise<ChatOutput> {
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
