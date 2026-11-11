// The OpenAI Responses provider: `/responses`, behind the same provider seam.
//
// The conversation is items (messages, function calls and their outputs), tools are flat, the system
// prompt is `instructions`, the limit is `max_output_tokens`, and a stream is named events.
import OpenAI from 'openai';
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

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export const DEFAULT_TIMEOUT = 120;

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

function contentOf(content: unknown): string | JsonObject[] | null {
  if (content === null || content === undefined || typeof content === 'string')
    return content ?? null;
  if (!Array.isArray(content)) return null;
  const parts: JsonObject[] = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    const row = part as JsonObject;
    if (row.type === 'text') {
      if (row.text) parts.push({ type: 'input_text', text: row.text });
    } else if (row.type === 'image_url') {
      const url = String((row.image_url as JsonObject | undefined)?.url ?? '');
      if (!url) throw new Error('an image content part needs a url');
      parts.push({ type: 'input_image', image_url: url });
    } else {
      throw new Error(
        `the responses provider does not carry a ${JSON.stringify(row.type)} content part`,
      );
    }
  }
  if (parts.every((part) => part.type === 'input_text'))
    return parts.map((part) => String(part.text ?? '')).join('\n\n');
  return parts;
}

function toolCall(item: JsonObject): JsonObject {
  const fn = (item.function as JsonObject | undefined) ?? {};
  return {
    type: 'function_call',
    call_id: String(item.id ?? ''),
    name: String(fn.name ?? ''),
    arguments: String(fn.arguments ?? '{}'),
  };
}

function toolOutput(message: Message): JsonObject {
  return {
    type: 'function_call_output',
    call_id: String(message.tool_call_id ?? ''),
    output: textOf(message.content),
  };
}

function toolSpec(spec: ToolSpec): JsonObject {
  const fn = spec.function ?? {};
  const tool: JsonObject = { type: 'function', name: String(fn.name ?? '') };
  if (fn.description) tool.description = fn.description;
  const parameters = fn.parameters;
  tool.parameters =
    parameters && typeof parameters === 'object' && Object.keys(parameters).length > 0
      ? parameters
      : { type: 'object', properties: {} };
  return tool;
}

function requestItems(messages: Message[]): { instructions: string; items: JsonObject[] } {
  const instructions: string[] = [];
  const items: JsonObject[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === 'tool') {
      items.push(toolOutput(message));
      continue;
    }
    const content = contentOf(message.content);
    if (content) items.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
    for (const call of message.tool_calls ?? []) items.push(toolCall(call as JsonObject));
  }
  return { instructions: instructions.join('\n\n'), items };
}

function usageOf(payload: JsonObject): Usage | null {
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object') return null;
  const row = usage as JsonObject;
  if (!('input_tokens' in row) && !('output_tokens' in row)) return null;
  const prompt = Number(row.input_tokens ?? 0);
  const completion = Number(row.output_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function messageOfPayload(payload: JsonObject): Message {
  const texts: string[] = [];
  const reasoning: string[] = [];
  const calls: JsonObject[] = [];
  for (const item of (payload.output as JsonObject[] | undefined) ?? []) {
    if (item.type === 'message') {
      for (const part of (item.content as JsonObject[] | undefined) ?? [])
        if (part.type === 'output_text') texts.push(String(part.text ?? ''));
    } else if (item.type === 'function_call') {
      calls.push({
        id: String(item.call_id ?? ''),
        type: 'function',
        function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') },
      });
    } else if (item.type === 'reasoning') {
      for (const part of (item.summary as JsonObject[] | undefined) ?? [])
        reasoning.push(String(part.text ?? ''));
    }
  }
  const message: Message = { role: 'assistant', content: texts.join('') };
  if (!message.content && calls.length > 0) message.content = null;
  if (reasoning.length > 0) message.reasoning_content = reasoning.join('');
  if (calls.length > 0) message.tool_calls = calls as Message['tool_calls'];
  return message;
}

function streamChunks(payload: JsonObject): StreamOutput[] {
  if (payload.type === 'response.output_text.delta')
    return [{ delta: { content: String(payload.delta ?? '') }, usage: null }];
  if (payload.type === 'response.reasoning_summary_text.delta')
    return [{ delta: { reasoning_content: String(payload.delta ?? '') }, usage: null }];
  if (payload.type === 'response.output_item.added') {
    const item = (payload.item as JsonObject | undefined) ?? {};
    if (item.type === 'function_call')
      return [
        {
          delta: {
            tool_calls: [
              {
                index: Number(payload.output_index ?? 0),
                id: String(item.call_id ?? ''),
                type: 'function',
                function: { name: String(item.name ?? ''), arguments: '' },
              },
            ],
          },
          usage: null,
        },
      ];
    return [];
  }
  if (payload.type === 'response.function_call_arguments.delta')
    return [
      {
        delta: {
          tool_calls: [
            {
              index: Number(payload.output_index ?? 0),
              function: { arguments: String(payload.delta ?? '') },
            },
          ],
        },
        usage: null,
      },
    ];
  if (payload.type === 'response.completed') {
    const response = (payload.response as JsonObject | undefined) ?? {};
    const id = response.id;
    return [
      {
        delta: {},
        usage: usageOf(response),
        previous_response_id: typeof id === 'string' ? id : null,
      },
    ];
  }
  if (payload.type === 'error' || payload.type === 'response.failed') {
    const error =
      (payload.error as JsonObject | undefined) ??
      ((payload.response as JsonObject | undefined)?.error as JsonObject | undefined) ??
      {};
    throw new Error(`the model stream failed: ${String(error.message ?? JSON.stringify(payload))}`);
  }
  return [];
}

export class ResponsesProvider extends BaseProvider implements Provider {
  readonly apiKey: string | null;
  readonly modelName: string;
  readonly baseUrl: string | null;
  readonly timeout: number | null;
  readonly effort: string | null;
  readonly fetcher: Fetcher;
  readonly client: OpenAI | null;
  readonly host: string;

  static build(data: JsonObject, fetcher: Fetcher): ResponsesProvider {
    return new ResponsesProvider({
      apiKey: optionalString(data, 'api_key'),
      modelName: optionalString(data, 'model_name') ?? '',
      baseUrl: optionalString(data, 'base_url'),
      timeout: timeoutOf(data, 'Responses'),
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
    this.client = this.apiKey
      ? new OpenAI({
          apiKey: this.apiKey,
          baseURL: this.baseUrl ?? DEFAULT_BASE_URL,
          timeout: (this.timeout ?? DEFAULT_TIMEOUT) * 1000,
          maxRetries: 0,
          fetch: this.fetcher,
        })
      : null;
  }

  dump(): JsonObject {
    return {
      type: 'responses',
      api_key: this.apiKey,
      model_name: this.modelName,
      base_url: this.baseUrl,
      timeout: this.timeout,
      thinking_effort: this.effort,
    };
  }

  private request(
    messages: Message[],
    tools?: ToolSpec[] | null,
    limit?: number | null,
    previousResponseId?: string | null,
  ): JsonObject {
    if (!this.modelName || !this.apiKey) throw new Error(blankProviderMessage());
    const { instructions, items } = requestItems(messages);
    const request: JsonObject = {
      model: this.modelName,
      input: items,
      max_output_tokens: limit || DEFAULT_MAX_OUTPUT_TOKENS,
      store: true,
    };
    if (previousResponseId !== null && previousResponseId !== undefined)
      request.previous_response_id = previousResponseId;
    if (this.effort) request.reasoning = { effort: this.effort };
    if (instructions) request.instructions = instructions;
    if (tools && tools.length > 0) request.tools = tools.map(toolSpec);
    return request;
  }

  async chat(
    messages: Message[],
    tools?: ToolSpec[] | null,
    maxCompletionTokens?: number | null,
    previousResponseId?: string | null,
  ): Promise<ChatOutput> {
    const request = this.request(messages, tools, maxCompletionTokens, previousResponseId);
    if (this.client === null) throw new Error(blankProviderMessage());
    const client = this.client;
    const response = await this.attempt(() => client.responses.create(request as never));
    const payload = JSON.parse(JSON.stringify(response)) as JsonObject;
    const id = payload.id;
    return {
      message: messageOfPayload(payload),
      usage: usageOf(payload),
      previous_response_id: typeof id === 'string' ? id : null,
    };
  }

  async *chatStream(
    messages: Message[],
    tools?: ToolSpec[] | null,
    maxCompletionTokens?: number | null,
    previousResponseId?: string | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamOutput, void, unknown> {
    const request = this.request(messages, tools, maxCompletionTokens, previousResponseId);
    if (this.client === null) throw new Error(blankProviderMessage());
    const client = this.client;
    yield* this.attemptStream(async function* () {
      const stream = await client.responses.create({ ...request, stream: true } as never, {
        signal,
      });
      try {
        for await (const event of stream as unknown as AsyncIterable<unknown>) {
          const payload = JSON.parse(JSON.stringify(event)) as JsonObject;
          for (const chunk of streamChunks(payload)) yield chunk;
        }
      } finally {
        (stream as { controller?: AbortController }).controller?.abort();
      }
    }, signal);
  }
}
