// The shapes that cross this package: the chat API's own message and tool types, the numbers a
// provider reports, and the events a streaming provider emits. Nothing here knows about a bus.

export type ToolCall = {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
};

export type ToolSpec = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

export type TokenUsage = {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
};

/** Cumulative estimated new input and reported output tokens for this agent process. */
export type UsageSummary = {
  model_calls: number;
  reported_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

/** One line of a transcript, in the chat API's fields plus the four this package keeps for the
 *  reader: `reasoning_content` (a reasoning model's thinking), `usage` (what the round cost),
 *  `at` (when the line was committed) and `took_ms` (how long its round took). */
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  usage?: TokenUsage;
  at?: string;
  took_ms?: number;
  /** An opaque handle a stateful provider returned with this answer (`provider_state`). */
  provider_state?: unknown;
};

/** One event of a streamed answer: the provider speaks in deltas, the transcript in lines. */
export type StreamEvent =
  | { readonly type: 'content'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | {
      readonly type: 'tool_call';
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly arguments?: string;
    }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'state'; readonly state: unknown }
  | { readonly type: 'end'; readonly previous_response_id?: string | null };

/** One provider-neutral request. Everything a provider may be handed, and nothing it may not. */
export type ChatRequest = {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly max_completion_tokens?: number;
  readonly previous_response_id?: string | null;
  /** Aborting ends the turn, and the stream that turn opened is cancelled by its own id. */
  readonly signal?: AbortSignal;
};

/** A non-streamed answer: the same line a stream adds up to. */
export type ChatReply = {
  readonly content: string | null;
  readonly reasoning_content?: string;
  readonly tool_calls?: ToolCall[];
  readonly usage?: TokenUsage;
  readonly previous_response_id?: string | null;
  readonly provider_state?: unknown;
};

/** The seam between the agent and whoever serves the model. */
export interface Provider {
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
  chat(request: ChatRequest): Promise<ChatReply>;
  close?(): Promise<void> | void;
}
