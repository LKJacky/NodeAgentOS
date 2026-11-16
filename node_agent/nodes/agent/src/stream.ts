// The stream a page follows, and the one rule that keeps it cheap: a delta carries only what just
// arrived, never the line so far.
//
// The node used to publish a full snapshot of the answer on every token (the whole message, rebuilt
// and serialised per chunk), which made one bus frame per token grow with the length of the answer.
// What it publishes now is the three events below — a start, the deltas, an end — and the page is the
// one that assembles them. The transcript is still the only truth: the assembled line is committed
// with `messages`/`onCommit` when the round ends, and a page that lost a delta resyncs from the
// node rather than guessing (see `seqGap` and `StreamAssembly`).
//
// Nothing here touches a bus: the assembly is a pure function of the deltas, which is what lets the
// runtime answer a resync with the line as it stands, and a test accumulate the same line twice.
import type { Message, ToolCall } from './types.js';

/** One tool call's fragment: `arguments` is the text that just arrived, not the call so far. */
export type ToolCallDelta = {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
};

/** One increment of an answer. At least one field is set; none of them is the accumulated text. */
export type StreamDelta = {
  readonly content?: string;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly ToolCallDelta[];
};

/** Published once, before the first delta of one round. */
export type StreamStart = {
  readonly type: 'stream_start';
  /** The stream (`<agent>#<round>`): what a delta says to be joined with its own start. */
  readonly id: string;
  /** The agent writing it: the main one, or a sub-agent's name. */
  readonly agent: string;
  /** The assistant line this stream will become when the round commits it. */
  readonly messageId: string;
  readonly role: 'assistant';
  /** Always 0: the deltas that follow count on from here. */
  readonly seq: 0;
};

/** One increment, numbered so a page can tell a lost delta from the next one. */
export type StreamDeltaEvent = StreamDelta & {
  readonly type: 'stream_delta';
  readonly id: string;
  readonly agent: string;
  readonly messageId: string;
  readonly seq: number;
};

/** Published once, after the round's line is committed (or after a stop cut it short). */
export type StreamEnd = {
  readonly type: 'stream_end';
  readonly id: string;
  readonly agent: string;
  readonly messageId: string;
  readonly seq: number;
  /** The turn was cut short: the line that was committed is the partial answer. */
  readonly canceled: boolean;
};

/** Everything one topic carries about a stream in progress. */
export type StreamEventOut = StreamStart | StreamDeltaEvent | StreamEnd;

/** The answer as it stands, for a page that has lost a delta and has to be brought up to date.
 *  Read on demand only (`stream` capability), never published per token: this is the line so far,
 *  and it is the one payload the protocol allows to carry it. */
export type StreamState = {
  readonly id: string;
  readonly agent: string;
  readonly messageId: string;
  readonly role: 'assistant';
  readonly seq: number;
  readonly content: string;
  readonly reasoning_content: string;
  readonly tool_calls: readonly ToolCall[];
};

/** What one delta says about the line: a delta with no field is nothing to draw. */
export function isEmptyDelta(delta: StreamDelta): boolean {
  if (typeof delta.content === 'string' && delta.content !== '') return false;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') return false;
  return !(delta.tool_calls ?? []).some(
    (call) =>
      (call.id ?? '') !== '' || (call.name ?? '') !== '' || (call.arguments ?? '') !== '',
  );
}

/** Whether `seq` is the delta that follows `expected`: a page that receives anything else has a gap
 *  (a lost frame, a reconnected stream, a stream it never saw start) and must resync. */
export function seqFollows(expected: number, seq: number): boolean {
  return Number.isInteger(seq) && seq === expected + 1;
}

/** One answer being assembled out of deltas. `apply` is what both the runtime (to answer a resync)
 *  and a page (to draw the tail) do, and it is the same function in both places. */
export class StreamAssembly {
  readonly id: string;
  readonly agent: string;
  readonly messageId: string;
  seq = 0;
  content = '';
  reasoning = '';
  readonly calls = new Map<number, { id: string; name: string; arguments: string }>();

  constructor(id: string, agent: string, messageId: string) {
    this.id = id;
    this.agent = agent;
    this.messageId = messageId;
  }

  /** Add one delta. The seq is the caller's business (`bump` is what numbers the next one). */
  apply(delta: StreamDelta): this {
    if (typeof delta.content === 'string' && delta.content !== '') {
      this.content += delta.content;
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      this.reasoning += delta.reasoning_content;
    }
    for (const part of delta.tool_calls ?? []) {
      const call = this.calls.get(part.index) ?? { id: '', name: '', arguments: '' };
      this.calls.set(part.index, {
        id: part.id ?? call.id,
        name: part.name ?? call.name,
        arguments: call.arguments + (part.arguments ?? ''),
      });
    }
    return this;
  }

  /** Adopt a state the node answered with (a resync): the page replaces what it had. */
  adopt(state: StreamState): this {
    this.seq = state.seq;
    this.content = state.content;
    this.reasoning = state.reasoning_content;
    this.calls.clear();
    for (const [index, call] of state.tool_calls.entries()) {
      this.calls.set(index, { id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    return this;
  }

  /** The draft line, in the shape the transcript commits it. */
  message(): Message {
    const line: Message = { role: 'assistant', content: this.content };
    if (this.reasoning !== '') line.reasoning_content = this.reasoning;
    const ordered = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (ordered.length > 0) {
      line.tool_calls = ordered.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return line;
  }

  /** The same line, plus where the stream stands: what a page needs to catch up and keep going. */
  state(): StreamState {
    return {
      id: this.id,
      agent: this.agent,
      messageId: this.messageId,
      role: 'assistant',
      seq: this.seq,
      content: this.content,
      reasoning_content: this.reasoning,
      tool_calls: this.message().tool_calls ?? [],
    };
  }
}
