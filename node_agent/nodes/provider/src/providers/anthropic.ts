// The Anthropic (Claude) provider: the Messages API behind the same provider seam.
//
// The wire differences this module translates once: the system prompt stays in place as prefixed user
// text, tool calls are content blocks, max_tokens is always sent, and a stream is named events.
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  blankProviderMessage,
  type ChatOutput,
  type Fetcher,
  type JsonObject,
  type Message,
  endpointHost,
  optionalString,
  type Provider,
  Provider as BaseProvider,
  type StreamOutput,
  thinkingEffort,
  timeoutOf,
  type ToolSpec,
  type Usage,
} from './base.js';

export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TIMEOUT = 120;
const THINKING_ALIASES: Record<string, string> = { minimal: 'low' };

function textOf(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is JsonObject => part !== null && typeof part === 'object')
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n\n');
}

function imageBlock(imageUrl: unknown): JsonObject {
  const url = String((imageUrl as JsonObject | undefined)?.url ?? '');
  if (!url) throw new Error('an image content part needs a url');
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const header = comma >= 0 ? url.slice(0, comma) : url;
    const data = comma >= 0 ? url.slice(comma + 1) : '';
    const mediaType = header.slice(5).split(';')[0] || 'image/png';
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function blocksOf(content: unknown): JsonObject[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content))
    throw new Error('a message content part must be a string or an array');
  const blocks: JsonObject[] = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    const row = part as JsonObject;
    if (row.type === 'text') {
      if (row.text) blocks.push({ type: 'text', text: row.text });
    } else if (row.type === 'image_url') {
      blocks.push(imageBlock(row.image_url));
    } else {
      throw new Error(
        `the anthropic provider does not carry a ${JSON.stringify(row.type)} content part`,
      );
    }
  }
  return blocks;
}

function argumentsOf(value: unknown): JsonObject {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value as JsonObject;
  const text = String(value ?? '').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`a tool call's arguments are not JSON: ${text.slice(0, 200)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`a tool call's arguments must be a JSON object, not ${typeof parsed}`);
  return parsed as JsonObject;
}

function toolUse(call: JsonObject): JsonObject {
  const fn = (call.function as JsonObject | undefined) ?? {};
  return {
    type: 'tool_use',
    id: String(call.id ?? ''),
    name: String(fn.name ?? ''),
    input: argumentsOf(fn.arguments),
  };
}

function toolResult(message: Message): JsonObject {
  const content = message.content;
  const body =
    typeof content === 'string' || content === null || content === undefined
      ? content
      : blocksOf(content);
  return {
    type: 'tool_result',
    tool_use_id: String(message.tool_call_id ?? ''),
    content: body || '',
  };
}

function toolSpec(spec: ToolSpec): JsonObject {
  const fn = spec.function ?? {};
  const tool: JsonObject = { name: String(fn.name ?? '') };
  if (fn.description) tool.description = fn.description;
  const parameters = fn.parameters;
  tool.input_schema =
    parameters && typeof parameters === 'object' && Object.keys(parameters).length > 0
      ? parameters
      : { type: 'object', properties: {} };
  return tool;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const row = value as JsonObject;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalArguments(value: unknown): unknown {
  const text = String(value ?? '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageHash(message: Message): string {
  const calls = (message.tool_calls ?? []).map((call) => ({
    id: call.id ?? null,
    name: call.function?.name ?? null,
    arguments: normalArguments(call.function?.arguments),
  }));
  let content = message.content;
  if (content === '' || (Array.isArray(content) && content.length === 0)) content = null;
  const payload = { role: 'assistant', content, tool_calls: calls };
  return createHash('sha256')
    .update(`anthropic-message-v1|${canonical(payload)}`)
    .digest('hex');
}

function contentHash(content: unknown): string {
  return createHash('sha256')
    .update(`anthropic-content-v1|${canonical(content)}`)
    .digest('hex');
}

function chainSeed(model: string, tools: JsonObject[]): string {
  const payload = { version: 3, model, tools };
  return createHash('sha256')
    .update(`anthropic-prefix-v3|${canonical(payload)}`)
    .digest('hex');
}

function chainStep(prefixHash: string, role: string, blocks: JsonObject[]): string {
  const payload = { role, blocks };
  return createHash('sha256')
    .update(`${prefixHash}|message|${canonical(payload)}`)
    .digest('hex');
}

function stateMatches(
  state: JsonObject | undefined,
  prefixHash: string,
  message: Message,
): boolean {
  if (!state) return false;
  const content = state.content;
  if (
    !Array.isArray(content) ||
    !content.every((block) => block !== null && typeof block === 'object')
  )
    return false;
  const current = messageHash(message);
  return (
    state.prefix_hash === prefixHash &&
    state.content_hash === contentHash(content) &&
    state.message_hash === current &&
    messageHash(messageFromBlocks({ content })) === current
  );
}

function requestMessages(
  messages: Message[],
  model: string,
  tools: JsonObject[],
): { turns: JsonObject[]; prefixHash: string } {
  const turns: JsonObject[] = [];
  let prefixHash = chainSeed(model, tools);
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUser = index;
      break;
    }
  }
  const add = (role: string, blocks: JsonObject[]): void => {
    if (blocks.length === 0) return;
    prefixHash = chainStep(prefixHash, role, blocks);
    const previous = turns.at(-1);
    if (previous && previous.role === role) (previous.content as JsonObject[]).push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };
  for (const [index, message] of messages.entries()) {
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content);
      if (text) add('user', [{ type: 'text', text: `SYSTEM MESSAGE：${text}` }]);
      continue;
    }
    if (role === 'tool') {
      add('user', [toolResult(message)]);
      continue;
    }
    if (role === 'assistant') {
      const state = message.provider_state;
      if (state) {
        if (stateMatches(state, prefixHash, message)) {
          add('assistant', [...(state.content as JsonObject[])]);
          continue;
        }
        if (lastUser >= 0 && index > lastUser)
          throw new Error(
            'the provider state for the current assistant turn no longer matches its wire prefix',
          );
      }
    }
    const blocks = blocksOf(message.content);
    for (const call of message.tool_calls ?? []) blocks.push(toolUse(call as JsonObject));
    add(role === 'assistant' ? 'assistant' : 'user', blocks);
  }
  return { turns, prefixHash };
}

function sealState(state: JsonObject, prefixHash: string, message: Message): void {
  state.prefix_hash = prefixHash;
  state.content_hash = contentHash(state.content);
  state.message_hash = messageHash(message);
}

function refusalMessage(payload: JsonObject): string {
  let details = payload.stop_details;
  if (!details || typeof details !== 'object')
    details = (payload.delta as JsonObject | undefined)?.stop_details;
  if (!details || typeof details !== 'object') details = {};
  const row = details as JsonObject;
  const category = typeof row.category === 'string' && row.category ? row.category : '';
  const explanation =
    typeof row.explanation === 'string' && row.explanation
      ? row.explanation
      : 'the model declined this request';
  return `the model refused this request${category ? ` (${category})` : ''}: ${explanation}`;
}

function usageOf(payload: JsonObject): Usage | null {
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object') return null;
  const row = usage as JsonObject;
  if (!('input_tokens' in row) && !('output_tokens' in row)) return null;
  let prompt = Number(row.input_tokens ?? 0);
  prompt += Number(row.cache_creation_input_tokens ?? 0);
  prompt += Number(row.cache_read_input_tokens ?? 0);
  const completion = Number(row.output_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function providerState(content: unknown): JsonObject | null {
  if (!Array.isArray(content)) return null;
  const hasThinking = content.some(
    (block) =>
      block !== null &&
      typeof block === 'object' &&
      ['thinking', 'redacted_thinking'].includes(String((block as JsonObject).type)),
  );
  return hasThinking ? { content } : null;
}

function messageFromBlocks(payload: JsonObject): Message {
  const texts: string[] = [];
  const reasoning: string[] = [];
  const calls: JsonObject[] = [];
  for (const block of (payload.content as JsonObject[] | undefined) ?? []) {
    if (block.type === 'text') texts.push(String(block.text ?? ''));
    else if (block.type === 'thinking') reasoning.push(String(block.thinking ?? ''));
    else if (block.type === 'tool_use')
      calls.push({
        id: String(block.id ?? ''),
        type: 'function',
        function: {
          name: String(block.name ?? ''),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
  }
  const message: Message = { role: 'assistant', content: texts.join('') };
  if (!message.content && calls.length > 0) message.content = null;
  if (reasoning.length > 0) message.reasoning_content = reasoning.join('');
  if (calls.length > 0) message.tool_calls = calls as Message['tool_calls'];
  const state = providerState(payload.content);
  if (state) message.provider_state = state;
  return message;
}

class StreamState {
  readonly blocks = new Map<number, JsonObject>();
  hasThinking = false;

  feed(payload: JsonObject): void {
    const kind = payload.type;
    const index = Number(payload.index ?? 0);
    if (kind === 'content_block_start') {
      const block = (payload.content_block as JsonObject | undefined) ?? {};
      this.blocks.set(index, JSON.parse(JSON.stringify(block)) as JsonObject);
      if (['thinking', 'redacted_thinking'].includes(String(block.type))) this.hasThinking = true;
      return;
    }
    if (kind === 'content_block_delta') {
      const block = this.blocks.get(index);
      if (!block) return;
      const delta = (payload.delta as JsonObject | undefined) ?? {};
      const type = delta.type;
      if (type === 'text_delta') block.text = String(block.text ?? '') + String(delta.text ?? '');
      else if (type === 'thinking_delta') {
        block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '');
        this.hasThinking = true;
      } else if (type === 'signature_delta')
        block.signature = String(block.signature ?? '') + String(delta.signature ?? '');
      else if (type === 'input_json_delta')
        block._partial_json = String(block._partial_json ?? '') + String(delta.partial_json ?? '');
      return;
    }
    if (kind === 'content_block_stop') {
      const block = this.blocks.get(index);
      if (!block) return;
      const partial = block._partial_json;
      delete block._partial_json;
      if (partial !== undefined) {
        try {
          block.input = String(partial).trim() ? JSON.parse(String(partial)) : {};
        } catch {
          block.input = {};
        }
      }
    }
  }

  value(): JsonObject | null {
    if (!this.hasThinking) return null;
    return {
      content: [...this.blocks.keys()].sort((a, b) => a - b).map((index) => this.blocks.get(index)),
    };
  }
}

function streamChunks(payload: JsonObject): StreamOutput[] {
  const kind = payload.type;
  if (kind === 'message_start')
    return [{ delta: {}, usage: usageOf((payload.message as JsonObject | undefined) ?? {}) }];
  if (kind === 'content_block_start') {
    const block = (payload.content_block as JsonObject | undefined) ?? {};
    const index = Number(payload.index ?? 0);
    if (block.type === 'tool_use')
      return [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: String(block.id ?? ''),
                type: 'function',
                function: { name: String(block.name ?? ''), arguments: '' },
              },
            ],
          },
          usage: null,
        },
      ];
    if (block.text) return [{ delta: { content: block.text }, usage: null }];
    return [];
  }
  if (kind === 'content_block_delta') {
    const delta = (payload.delta as JsonObject | undefined) ?? {};
    if (delta.type === 'text_delta')
      return [{ delta: { content: String(delta.text ?? '') }, usage: null }];
    if (delta.type === 'thinking_delta')
      return [{ delta: { reasoning_content: String(delta.thinking ?? '') }, usage: null }];
    if (delta.type === 'input_json_delta')
      return [
        {
          delta: {
            tool_calls: [
              {
                index: Number(payload.index ?? 0),
                function: { arguments: String(delta.partial_json ?? '') },
              },
            ],
          },
          usage: null,
        },
      ];
    return [];
  }
  if (kind === 'message_delta') {
    const stop = payload.stop_reason ?? (payload.delta as JsonObject | undefined)?.stop_reason;
    if (stop === 'refusal') throw new Error(refusalMessage(payload));
    return [{ delta: {}, usage: usageOf(payload) }];
  }
  if (kind === 'error') {
    const error = (payload.error as JsonObject | undefined) ?? {};
    throw new Error(`the model stream failed: ${String(error.message ?? JSON.stringify(payload))}`);
  }
  return [];
}

export class AnthropicProvider extends BaseProvider implements Provider {
  readonly apiKey: string | null;
  readonly modelName: string;
  readonly baseUrl: string | null;
  readonly timeout: number | null;
  readonly effort: string | null;
  readonly fetcher: Fetcher;
  readonly client: Anthropic | null;
  readonly host: string;

  static build(data: JsonObject, fetcher: Fetcher): AnthropicProvider {
    return new AnthropicProvider({
      apiKey: optionalString(data, 'api_key'),
      modelName: optionalString(data, 'model_name') ?? '',
      baseUrl: optionalString(data, 'base_url'),
      timeout: timeoutOf(data, 'Anthropic'),
      effort: thinkingEffort(data),
      fetcher,
    });
  }

  constructor(options: {
    apiKey?: string | null;
    modelName?: string;
    baseUrl?: string | null;
    timeout?: number | null;
    effort?: string | null;
    fetcher: Fetcher;
  }) {
    super();
    this.apiKey = options.apiKey ?? null;
    this.modelName = options.modelName ?? '';
    this.baseUrl = options.baseUrl ?? null;
    this.timeout = options.timeout ?? null;
    this.effort = options.effort ?? null;
    this.fetcher = options.fetcher;
    this.host = endpointHost(this.baseUrl, DEFAULT_BASE_URL);
    let root = (this.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    if (root.endsWith('/v1')) root = root.slice(0, -3);
    // The official client owns auth, the version header, SSE framing and the API's error types;
    // its retries are off because the attempts this node documents are the only ones.
    this.client = this.apiKey
      ? new Anthropic({
          apiKey: this.apiKey,
          baseURL: root,
          timeout: (this.timeout ?? DEFAULT_TIMEOUT) * 1000,
          maxRetries: 0,
          fetch: this.fetcher,
        })
      : null;
  }

  dump(): JsonObject {
    return {
      type: 'anthropic',
      api_key: this.apiKey,
      model_name: this.modelName,
      base_url: this.baseUrl,
      timeout: this.timeout,
      thinking_effort: this.effort,
    };
  }

  private requestWithHash(
    messages: Message[],
    tools?: ToolSpec[] | null,
    limit?: number | null,
  ): { request: JsonObject; prefixHash: string } {
    if (!this.modelName || !this.apiKey) throw new Error(blankProviderMessage());
    const toolsWire = (tools ?? []).map(toolSpec);
    const { turns, prefixHash } = requestMessages(messages, this.modelName, toolsWire);
    const request: JsonObject = {
      model: this.modelName,
      max_tokens: limit || DEFAULT_MAX_TOKENS,
      messages: turns,
    };
    if (toolsWire.length > 0) request.tools = toolsWire;
    if (this.effort === 'none') request.thinking = { type: 'disabled' };
    else if (this.effort) {
      request.thinking = { type: 'adaptive' };
      request.output_config = { effort: THINKING_ALIASES[this.effort] ?? this.effort };
    }
    return { request, prefixHash };
  }

  async chat(
    messages: Message[],
    tools?: ToolSpec[] | null,
    maxCompletionTokens?: number | null,
    _previousResponseId?: string | null,
  ): Promise<ChatOutput> {
    const { request, prefixHash } = this.requestWithHash(messages, tools, maxCompletionTokens);
    if (this.client === null) throw new Error(blankProviderMessage());
    const client = this.client;
    const response = await this.attempt(() => client.messages.create(request as never));
    const payload = JSON.parse(JSON.stringify(response)) as JsonObject;
    if (payload.stop_reason === 'refusal') throw new Error(refusalMessage(payload));
    const message = messageFromBlocks(payload);
    if (message.provider_state) sealState(message.provider_state, prefixHash, message);
    return { message, usage: usageOf(payload), previous_response_id: null };
  }

  async *chatStream(
    messages: Message[],
    tools?: ToolSpec[] | null,
    maxCompletionTokens?: number | null,
    _previousResponseId?: string | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamOutput, void, unknown> {
    const { request, prefixHash } = this.requestWithHash(messages, tools, maxCompletionTokens);
    if (this.client === null) throw new Error(blankProviderMessage());
    const state = new StreamState();
    const client = this.client;
    yield* this.attemptStream(async function* () {
      const stream = await client.messages.create({ ...request, stream: true } as never, {
        signal,
      });
      try {
        for await (const event of stream as unknown as AsyncIterable<unknown>) {
          const payload = JSON.parse(JSON.stringify(event)) as JsonObject;
          state.feed(payload);
          const chunks = streamChunks(payload);
          const sealed = payload.type === 'message_delta' ? state.value() : null;
          if (chunks.length > 0 && sealed) {
            sealState(sealed, prefixHash, messageFromBlocks({ content: sealed.content }));
            const last = chunks[chunks.length - 1];
            if (last) last.provider_state = sealed;
          }
          for (const chunk of chunks) yield chunk;
        }
      } finally {
        (stream as { controller?: AbortController }).controller?.abort();
      }
    }, signal);
  }
}
