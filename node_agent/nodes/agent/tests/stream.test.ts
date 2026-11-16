// The delta protocol between the agent and its page: a stream publishes what just arrived, never the
// answer so far, and a page that lost a frame is told how to catch up instead of being handed the
// whole line again.
//
// What is checked here is the size and the shape of what goes on the bus (`stream_start` /
// `stream_delta` / `stream_end`), the line the transcript still commits at the end of the round, two
// readers accumulating the same answer out of the same events, and the two ways a stream ends early:
// a gap a page has to resync and a stop that keeps the partial answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentStatus } from '../src/runtime.ts';
import {
  StreamAssembly,
  seqFollows,
  type StreamDeltaEvent,
  type StreamEnd,
  type StreamEventOut,
  type StreamStart,
  type StreamState,
} from '../src/stream.ts';
import type { ChatReply, ChatRequest, Provider, StreamEvent } from '../src/types.ts';
import { FakeNet, startAgent } from './harness.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(5);
  }
  throw new Error(`the condition never held within ${ms}ms`);
}

/** A provider that streams the events it was given, in order, and then answers with nothing else. */
class ScriptedStream implements Provider {
  readonly #events: readonly StreamEvent[];
  readonly #gate: Promise<void> | null;
  /** How many events it has handed over, so a test can wait until the turn is mid-stream. */
  sent = 0;

  constructor(events: readonly StreamEvent[], gate: Promise<void> | null = null) {
    this.#events = events;
    this.#gate = gate;
  }

  async chat(): Promise<ChatReply> {
    return { content: 'not streamed', previous_response_id: null };
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    for (const event of this.#events) {
      // The gate is awaited *after* an event, so a test can look at the bus while a round is open.
      yield event;
      this.sent += 1;
      if (this.#gate !== null && this.sent === 1) await this.#gate;
    }
  }
}

/** Every stream event one topic carried, in the order it was published. */
function streamEvents(net: FakeNet, topic = 'agent'): StreamEventOut[] {
  return net.events
    .filter((event) => event.topic === topic)
    .map((event) => event.value as StreamEventOut)
    .filter((value) =>
      ['stream_start', 'stream_delta', 'stream_end'].includes((value as { type?: string }).type ?? ''),
    );
}

/** The `messages` arrays one topic carried: a committed line of the transcript. */
function commits(net: FakeNet, topic = 'agent'): unknown[] {
  return net.events
    .filter((event) => event.topic === topic && Array.isArray(event.value))
    .map((event) => event.value);
}

test('consecutive chunks publish only what arrived, never the line so far', async () => {
  const provider = new ScriptedStream([
    { type: 'reasoning', text: 'thinking' },
    { type: 'content', text: 'Hel' },
    { type: 'content', text: 'lo, ' },
    { type: 'content', text: 'world' },
    { type: 'end', previous_response_id: null },
  ]);
  const agent = await startAgent({ net: new FakeNet(), provider });
  try {
    await agent.call('chat', { msg: { role: 'user', content: 'hi' } });

    const events = streamEvents(agent.net);
    const starts = events.filter((event) => event.type === 'stream_start') as StreamStart[];
    const deltas = events.filter((event) => event.type === 'stream_delta') as StreamDeltaEvent[];
    const ends = events.filter((event) => event.type === 'stream_end') as StreamEnd[];

    assert.equal(starts.length, 1, 'one start for the round');
    assert.equal(ends.length, 1, 'and one end');
    assert.equal(starts[0]?.role, 'assistant');
    assert.equal(starts[0]?.agent, 'agent');
    assert.equal(starts[0]?.seq, 0, 'the deltas count on from the start');
    assert.ok(starts[0]?.id && starts[0]?.messageId, 'a stream has an id and a line id');

    assert.deepEqual(
      deltas.map((event) => event.seq),
      [1, 2, 3, 4],
      'each delta is numbered, in order, with no gaps',
    );
    assert.deepEqual(
      deltas.map((event) => event.reasoning_content ?? event.content),
      ['thinking', 'Hel', 'lo, ', 'world'],
    );
    for (const delta of deltas) {
      assert.equal(delta.type, 'stream_delta');
      assert.equal(delta.id, starts[0]?.id, 'every delta names its stream');
      assert.equal(delta.messageId, starts[0]?.messageId);
      assert.equal(delta.agent, 'agent');
    }

    // The whole point: no frame carries the answer as it stands. The largest payload is one chunk.
    const full = 'Hello, world';
    for (const event of events) {
      const wire = JSON.stringify(event);
      assert.ok(!wire.includes(full), `no event carries the accumulated answer: ${wire}`);
      assert.ok(!wire.includes('thinkingHel'), 'nor the accumulated answer with its reasoning');
    }
    const biggest = Math.max(...deltas.map((event) => String(event.content ?? '').length));
    assert.equal(biggest, 'world'.length, 'a delta is one chunk long, not one answer long');
    // A delta carries the delta and nothing else: no role, no usage, no `at`.
    const allowed = ['agent', 'content', 'id', 'messageId', 'reasoning_content', 'seq', 'tool_calls', 'type'];
    for (const delta of deltas) {
      for (const key of Object.keys(delta)) {
        assert.ok(allowed.includes(key), `a delta carries no ${key}`);
      }
      assert.ok(
        delta.content !== undefined || delta.reasoning_content !== undefined,
        'and it is the text that just arrived, not the line so far',
      );
    }
  } finally {
    await agent.stop();
  }
});

test('the round still commits the whole line, after its deltas', async () => {
  const provider = new ScriptedStream([
    { type: 'content', text: 'two ' },
    { type: 'content', text: 'words' },
    { type: 'end', previous_response_id: null },
  ]);
  const agent = await startAgent({ net: new FakeNet(), provider });
  try {
    const lines = (await agent.call('chat', {
      msg: { role: 'user', content: 'say it' },
    })) as { role: string; content: string }[];

    const committed = commits(agent.net).at(-1) as { role: string; content: string }[];
    assert.equal(committed?.at(-1)?.role, 'assistant');
    assert.equal(committed?.at(-1)?.content, 'two words', 'the line the deltas add up to');
    assert.equal(lines.at(-1)?.content, 'two words', 'and the same line to the caller');

    const kinds = agent.net.events
      .filter((event) => event.topic === 'agent')
      .map((event) => (Array.isArray(event.value) ? 'commit' : (event.value as { type?: string }).type));
    const firstCommit = kinds.indexOf('commit');
    const end = kinds.indexOf('stream_end');
    assert.ok(firstCommit >= 0 && end > firstCommit, 'the commit goes out before the end');
    assert.equal(
      kinds.filter((kind) => kind === 'stream_start').length,
      1,
      'and it is still one stream for the round',
    );
  } finally {
    await agent.stop();
  }
});

test('two subscribers accumulate the same answer out of the same deltas', () => {
  // Two pages on two browsers: both get every event (the bus hands each subscriber its own copy), and
  // both have to end up with the same line - which is what the delta protocol promises and a snapshot
  // protocol did not need to.
  const first = new StreamAssembly('agent#1', 'agent', 'm1');
  const second = new StreamAssembly('agent#1', 'agent', 'm1');
  const published: StreamDeltaEvent[] = [
    {
      type: 'stream_delta',
      id: 'agent#1',
      agent: 'agent',
      messageId: 'm1',
      seq: 1,
      reasoning_content: 'hmm',
    },
    { type: 'stream_delta', id: 'agent#1', agent: 'agent', messageId: 'm1', seq: 2, content: 'one ' },
    { type: 'stream_delta', id: 'agent#1', agent: 'agent', messageId: 'm1', seq: 3, content: 'two' },
    {
      type: 'stream_delta',
      id: 'agent#1',
      agent: 'agent',
      messageId: 'm1',
      seq: 4,
      tool_calls: [{ index: 0, id: 'c1', name: 'shell', arguments: '{"comm' }],
    },
    {
      type: 'stream_delta',
      id: 'agent#1',
      agent: 'agent',
      messageId: 'm1',
      seq: 5,
      tool_calls: [{ index: 0, arguments: 'and":"ls"}' }],
    },
  ];
  for (const event of published) {
    assert.ok(seqFollows(first.seq, event.seq), 'the first reader is in step');
    first.seq = event.seq;
    first.apply(event);
    second.apply(event);
    second.seq = event.seq;
  }
  assert.deepEqual(first.message(), second.message(), 'the same line in both readers');
  assert.equal(first.message().content, 'one two');
  assert.equal(first.message().reasoning_content, 'hmm');
  assert.equal(
    first.message().tool_calls?.[0]?.function.arguments,
    '{"command":"ls"}',
    'a call is assembled out of its fragments',
  );
});

test('a gap in the seq is a gap, and the node can say where the stream stands', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new ScriptedStream(
    [
      { type: 'content', text: 'first ' },
      { type: 'content', text: 'second' },
      { type: 'end', previous_response_id: null },
    ],
    gate,
  );
  const agent = await startAgent({ net: new FakeNet(), provider });
  try {
    const turn = agent.call('chat', { msg: { role: 'user', content: 'go' } });
    // Mid-stream: one delta is out, the round is waiting on the gate.
    await until(() => provider.sent >= 1 && streamEvents(agent.net).length >= 2);
    const mid = streamEvents(agent.net);
    const first = mid.at(-1) as StreamDeltaEvent;

    const status = (await agent.call('status', {})) as AgentStatus;
    assert.equal(status.state, 'generating');
    assert.equal(status.stream?.id, first.id, 'status names the stream a page can join');
    assert.equal(status.stream?.seq, first.seq, 'and the last seq it published');
    assert.equal(
      status.stream !== null && 'content' in status.stream,
      false,
      'status carries no text: a read per token must stay small',
    );

    // A page that lost the frame after `first` sees a gap: the delta it holds is not the one that
    // follows. That is the signal to resync, not to glue the two together.
    assert.equal(seqFollows(first.seq, first.seq + 1), true, 'the next one would be fine');
    assert.equal(seqFollows(first.seq, first.seq + 2), false, 'a skipped one is not');

    // What it asks for is the line as it stands - once, not per token.
    const state = (await agent.call('stream', {})) as { stream: StreamState | null };
    assert.equal(state.stream?.id, first.id);
    assert.equal(state.stream?.content, 'first ', 'the text the page missed is here');
    assert.equal(state.stream?.seq, first.seq);
    assert.equal(state.stream?.role, 'assistant');

    // ...and the reader that adopts it is back in step with the stream.
    const reader = new StreamAssembly(state.stream.id, 'agent', state.stream.messageId).adopt(
      state.stream,
    );
    assert.equal(reader.content, 'first ');
    release();
    await turn;
    const rest = streamEvents(agent.net).filter(
      (event) => event.type === 'stream_delta' && event.seq > first.seq,
    ) as StreamDeltaEvent[];
    for (const event of rest) {
      assert.ok(seqFollows(reader.seq, event.seq), 'every later delta follows the one adopted');
      reader.seq = event.seq;
      reader.apply(event);
    }
    assert.equal(reader.message().content, 'first second');
    const done = (await agent.call('stream', {})) as { stream: StreamState | null };
    assert.equal(done.stream, null, 'between rounds there is nothing to resync');
  } finally {
    await agent.stop();
  }
});

test('a stopped round ends its stream and keeps the partial answer', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new ScriptedStream(
    [
      { type: 'content', text: 'half an ' },
      { type: 'content', text: 'answer' },
      { type: 'end', previous_response_id: null },
    ],
    gate,
  );
  const agent = await startAgent({ net: new FakeNet(), provider });
  try {
    const turn = agent.call('chat', { msg: { role: 'user', content: 'go' } });
    await until(() => streamEvents(agent.net).some((event) => event.type === 'stream_delta'));
    // Stop is the abort of the round in flight; the provider is parked on its gate, so the cut lands
    // before it can write the rest of the answer.
    const stopping = agent.call('stop', {});
    await until(async () => ((await agent.call('status', {})) as AgentStatus).state === 'stopping');
    release();
    await stopping;
    await turn.catch(() => undefined);

    const end = streamEvents(agent.net).at(-1) as StreamEnd;
    assert.equal(end.type, 'stream_end');
    assert.equal(end.canceled, true, 'the page is told the stream was cut, not that it finished');
    const committed = commits(agent.net).flat() as { role: string; content: string }[];
    assert.ok(
      committed.some((line) => line.role === 'assistant' && line.content === 'half an '),
      `the partial answer is in the transcript: ${JSON.stringify(committed)}`,
    );
    const state = (await agent.call('stream', {})) as { stream: StreamState | null };
    assert.equal(state.stream, null, 'and no stream is left to resync');
  } finally {
    await agent.stop();
  }
});

test('a sub-agent streams on its own topic, under its own name', async () => {
  const provider = new ScriptedStream([
    { type: 'content', text: 'from ' },
    { type: 'content', text: 'the child' },
    { type: 'end', previous_response_id: null },
  ]);
  const agent = await startAgent({ net: new FakeNet(), provider });
  try {
    await agent.runtime.spawnAgent('helper', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await agent.call('chat', {
      agent: 'helper',
      msg: { role: 'user', content: 'go' },
    });

    const child = streamEvents(agent.net, 'agent.helper');
    assert.ok(child.length >= 4, 'the child published its own start, deltas and end');
    assert.ok(
      child.every((event) => event.type === 'stream_end' || event.agent === 'helper'),
      'every event says which agent is writing',
    );
    const main = streamEvents(agent.net, 'agent');
    assert.deepEqual(main, [], 'and nothing of it leaked onto the main agent topic');
    const state = (await agent.call('stream', { agent: 'helper' })) as {
      stream: StreamState | null;
    };
    assert.equal(state.stream, null, 'one agent\u2019s stream is not the other\u2019s');
  } finally {
    await agent.stop();
  }
});

test('a round that streams no news publishes no stream at all', async () => {
  const provider = new ScriptedStream([{ type: 'end', previous_response_id: null }]);
  const agent = await startAgent({ net: new FakeNet(), provider });
  try {
    await agent.call('chat', { msg: { role: 'user', content: 'go' } });
    assert.deepEqual(streamEvents(agent.net), [], 'nothing was drawn, so nothing was announced');
    const last = commits(agent.net).at(-1) as { role: string; content: string }[];
    assert.equal(last.at(-1)?.role, 'assistant', 'the empty line is still committed');
    assert.equal(last.at(-1)?.content, '');
  } finally {
    await agent.stop();
  }
});
