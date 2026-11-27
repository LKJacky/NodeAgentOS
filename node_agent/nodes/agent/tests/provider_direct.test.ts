// The direct provider: a `provider` row dialled in the agent's own process, and the one row that
// still goes over the bus.
//
// The two halves this file holds apart: which seam a selection means (`provider` -> the provider
// package's core in this process, `local-provider` -> the bus as before), and that a call made
// directly carries what the bus path carried - deltas, usage, the stateful handle, the provider's
// own error sentence, a cancel and an idle bound - without ever asking the node to do the model call.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type {
  ChatOutput,
  JsonObject,
  Message as CoreMessage,
  Provider as CoreProvider,
  StreamOutput,
} from '@node-agent/provider/core';
import { DirectProvider, type CoreBuilder } from '../src/direct.ts';
import type { ChatRequest, Message, StreamEvent, ToolSpec } from '../src/types.ts';
import { FakeNet, startAgent } from './harness.ts';

/** One row of the shared node, as the store holds it (api_key and all). */
const ROWS = {
  fast: {
    type: 'openai',
    api_key: 'sk-test',
    model_name: 'gpt-test',
    base_url: 'https://example.test/v1',
  },
};

const USAGE = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };

/** What a wire is asked to do, in the test: yield these chunks, then end. */
type Plan = {
  /** The chunks the stream yields, in order. */
  deltas?: StreamOutput[];
  /** A non-streamed answer. */
  answer?: ChatOutput;
  /** Thrown instead of answering, to see the sentence a caller is left with. */
  error?: Error;
  /** Never yield anything, so a cancel and the idle timeout have something to interrupt. */
  stall?: boolean;
  /** Yield one chunk and then stall. */
  stallAfterFirst?: boolean;
};

/** A provider core that answers from a script and says what it was asked. */
class FakeCore {
  name = '';
  host = 'example.test';
  readonly asked: { messages: CoreMessage[]; tools: unknown; limit: unknown; previous: unknown }[] =
    [];
  readonly streams: { messages: CoreMessage[]; tools: unknown }[] = [];
  closed = 0;
  #pulls = 0;

  readonly plan: Plan;

  constructor(plan: Plan) {
    this.plan = plan;
  }

  dump(): JsonObject {
    return { type: 'openai' };
  }

  async chat(
    messages: CoreMessage[],
    tools?: unknown,
    limit?: unknown,
    previous?: unknown,
  ): Promise<ChatOutput> {
    this.asked.push({ messages, tools, limit, previous });
    if (this.plan.error !== undefined) throw this.plan.error;
    return (
      this.plan.answer ?? {
        message: { content: 'measured' },
        usage: null,
        previous_response_id: null,
      }
    );
  }

  async *chatStream(
    messages: CoreMessage[],
    tools?: unknown,
  ): AsyncGenerator<StreamOutput, void, unknown> {
    this.streams.push({ messages, tools });
    if (this.plan.error !== undefined) throw this.plan.error;
    const deltas = this.plan.deltas ?? [];
    for (const delta of deltas) {
      this.#pulls += 1;
      if (this.plan.stallAfterFirst === true && this.#pulls > 1) await new Promise(() => {});
      yield delta;
    }
    if (this.plan.stall === true || this.plan.stallAfterFirst === true) await new Promise(() => {});
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

/** The builder a test passes in place of the provider package's own: it records the row it was
 *  handed and answers with the script, so nothing is dialled for real. */
function recordingBuilder(core: FakeCore): {
  build: CoreBuilder;
  rows: { config: JsonObject; name: string }[];
} {
  const rows: { config: JsonObject; name: string }[] = [];
  const build: CoreBuilder = (config, _fetcher, name) => {
    rows.push({ config, name });
    core.name = name;
    return core as unknown as CoreProvider;
  };
  return { build, rows };
}

/** The selection a run of `chat` made: every call whose capability is a model call. */
function modelCalls(
  calls: readonly { to: string; payload: { cap: string } }[],
  node: string,
): string[] {
  return calls
    .filter((call) => call.to === node)
    .map((call) => call.payload.cap)
    .filter((cap) => cap === 'chat' || cap === 'start_stream' || cap === 'stream_ready');
}

/** Every row one node was asked for, by name. */
function rowCalls(
  calls: readonly { to: string; payload: { cap: string; args: { name?: unknown } } }[],
  node: string,
): string[] {
  return calls
    .filter((call) => call.to === node && call.payload.cap === 'row')
    .map((call) => String(call.payload.args.name));
}

/** The `provider` node a test talks to: it lists rows and hands one over (`row`), and it refuses to
 *  serve a model call - a bus chat in this file would be the bug the file is about. */
function providerNode(net: FakeNet, rows: Record<string, JsonObject> = ROWS): FakeNet {
  return net.node('provider', 'the shared providers', {
    providers: () => ({
      providers: Object.keys(rows).map((name) => ({ name })),
      persistent: true,
    }),
    row: (args) => {
      const name = String(args.name);
      const config = rows[name];
      if (config === undefined) throw new Error(`no provider "${name}" yet`);
      return { name, config };
    },
    chat: () => {
      throw new Error('a provider row is dialled in this process, not over the bus');
    },
    start_stream: () => {
      throw new Error('a provider row is dialled in this process, not over the bus');
    },
  });
}

test('a provider row is dialled in this process, and the node is never asked to chat', async () => {
  const tenantId = 'direct';
  const net = providerNode(new FakeNet().withHistory());
  const core = new FakeCore({
    deltas: [
      { delta: { reasoning_content: 'thinking ' } },
      { delta: { content: 'Hello ' } },
      { delta: { content: 'there' } },
      { delta: {}, usage: USAGE },
      { delta: {}, provider_state: { cursor: 7 } },
    ],
  });
  const { build, rows } = recordingBuilder(core);
  const agent = await startAgent({ net, tenantId, runtime: { buildProvider: build } });
  try {
    const said = (await agent.call('chat', { msg: { content: 'hi' } })) as Message[];
    const answer = said.at(-1);
    assert.equal(answer?.content, 'Hello there', 'the deltas a direct call yields are the answer');
    assert.equal(answer?.reasoning_content, 'thinking ');
    assert.equal(answer?.tool_calls, undefined, 'a prose answer asks for no tool');
    assert.deepEqual(answer?.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
    assert.deepEqual(answer?.provider_state, { cursor: 7 }, 'the stateful handle survives too');

    assert.deepEqual(
      modelCalls(agent.session.calls, 'provider'),
      [],
      'no chat, start_stream or stream_ready was asked of the provider node',
    );
    // Two requests, two wires: the round measures the transcript with `chat` and then streams the
    // answer, exactly as the bus path builds a provider per call.
    assert.ok(rows.length >= 1);
    assert.deepEqual(
      [...new Set(rows.map((row) => row.name))],
      ['fast'],
      'every wire is the selected row',
    );
    assert.equal(rows[0]?.config['api_key'], 'sk-test', 'with the credentials the store holds');

    // What still goes over the bus: the directory (`providers`), and the one row the agent dials
    // (`row`). The model call is not asked of the node at all.
    assert.deepEqual(
      [...new Set(rowCalls(agent.session.calls, 'provider'))],
      ['fast'],
      'the row the answer is dialled with came from the node, by name',
    );
    assert.ok(
      agent.session.calls.some(
        (call) => call.to === 'provider' && call.payload.cap === 'providers',
      ),
      'listing rows is still the provider node is job',
    );
    assert.ok(
      !net.events.some((event) => JSON.stringify(event.value).includes('sk-test')),
      'nothing about the row is published on this agent topic',
    );
  } finally {
    await agent.stop();
  }
});

test('a local-provider row still goes over the bus, and the core is never built for it', async () => {
  const tenantId = 'local';
  const id = 'a'.repeat(32);
  const net = new FakeNet().withHistory();
  const asked: string[] = [];
  net.node('local-provider', 'the local endpoint', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    // A fresh agent's first turn has no history to measure, so it streams directly. The stream and
    // its start still go to the node; this `chat` handler is here to prove the measurement is not
    // made on that first turn.
    chat: () => ({
      message: { content: '' },
      usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      previous_response_id: null,
    }),
    start_stream: () => {
      asked.push('start_stream');
      return { stream_id: id, topic: `provider.stream.${id}` };
    },
    stream_ready: () => {
      asked.push('stream_ready');
      deliver({ stream_id: id, event: 'chunk', chunk: { delta: { content: 'from the bus' } } });
      deliver({ stream_id: id, event: 'done' });
      return { started: true };
    },
    cancel_stream: () => ({ canceled: true }),
  });
  // A row of the shared node by the same name: the selection decides the path, not the name.
  providerNode(net);
  const core = new FakeCore({ deltas: [{ delta: { content: 'from the core' } }] });
  const { build, rows } = recordingBuilder(core);
  let deliver: (value: unknown) => void = () => undefined;
  const agent = await startAgent({ net, tenantId, runtime: { buildProvider: build } });
  try {
    deliver = (value) => agent.runtime.handleEvent(`provider.stream.${id}`, value);
    const said = (await agent.call('chat', { msg: { content: 'hi' } })) as Message[];
    assert.equal(said.at(-1)?.content, 'from the bus');
    assert.deepEqual(asked, ['start_stream', 'stream_ready']);
    assert.deepEqual(
      modelCalls(agent.session.calls, 'local-provider'),
      ['start_stream', 'stream_ready'],
      'the first-turn measurement is skipped; the stream and its start went to the node',
    );
    assert.deepEqual(modelCalls(agent.session.calls, 'provider'), []);
    assert.deepEqual(rows, [], 'the provider core is not built for a local-provider row');
    assert.equal(core.streams.length, 0);
    assert.deepEqual(
      agent.session.subscriptionNodes.at(-1),
      'local-provider',
      'the stream is read from the node that serves it',
    );
  } finally {
    await agent.stop();
  }
});

test('a direct failure is the provider own sentence, and never a quiet fallback to the bus', async () => {
  const tenantId = 'failure';
  const net = providerNode(new FakeNet().withHistory());
  const core = new FakeCore({
    error: new Error(
      'provider "fast" cannot reach the model endpoint example.test after 8 attempts: fetch failed [kind=connection, code=ECONNREFUSED]',
    ),
  });
  const { build } = recordingBuilder(core);
  const agent = await startAgent({ net, tenantId, runtime: { buildProvider: build } });
  try {
    await assert.rejects(
      () => agent.call('chat', { msg: { content: 'hi' } }),
      /provider "fast" cannot reach the model endpoint example\.test/,
    );
    assert.deepEqual(
      modelCalls(agent.session.calls, 'provider'),
      [],
      'a failed direct call is not retried on the bus',
    );
    assert.equal(((await agent.call('status', {})) as { state: string }).state, 'idle');
  } finally {
    await agent.stop();
  }
});

test('a row the node does not hand over is refused by name, not handed to the bus', async () => {
  const tenantId = 'missing';
  // A node that lists a row it will not hand over: the fix is on the page, not a quiet bus call.
  const net = new FakeNet().withHistory().node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }], persistent: true }),
    row: () => ({ name: 'fast' }),
    chat: () => {
      throw new Error('a provider row is dialled in this process, not over the bus');
    },
  });
  const { build, rows } = recordingBuilder(new FakeCore({}));
  const agent = await startAgent({ net, tenantId, runtime: { buildProvider: build } });
  try {
    await assert.rejects(
      () => agent.call('chat', { msg: { content: 'hi' } }),
      /answered without row "fast".*local-provider row to go through the bus/,
    );
    assert.deepEqual(rows, [], 'no wire was built');
    assert.deepEqual(
      modelCalls(agent.session.calls, 'provider'),
      [],
      'and the bus was not asked to stand in',
    );
  } finally {
    await agent.stop();
  }
});

test('a provider node too old to hand a row over says so instead of dialling nothing', async () => {
  const tenantId = 'old';
  const net = new FakeNet().withHistory().node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }], persistent: true }),
    chat: () => ({ message: { content: 'from the bus' }, previous_response_id: null }),
  });
  const { build, rows } = recordingBuilder(new FakeCore({}));
  const agent = await startAgent({ net, tenantId, runtime: { buildProvider: build } });
  try {
    await assert.rejects(
      () => agent.call('chat', { msg: { content: 'hi' } }),
      /does not serve the "row" capability.*upgrade @node-agent\/provider/,
    );
    assert.deepEqual(rows, [], 'nothing was dialled with an empty row');
    assert.deepEqual(
      modelCalls(agent.session.calls, 'provider'),
      [],
      'and the old node is not asked to answer instead',
    );
  } finally {
    await agent.stop();
  }
});

/** A direct provider over a fixed row, with nothing else in the way. */
function direct(plan: Plan, idleMs = 30): { provider: DirectProvider; core: FakeCore } {
  const core = new FakeCore(plan);
  const { build } = recordingBuilder(core);
  const provider = new DirectProvider('provider.fast', {
    row: 'fast',
    config: async () => ROWS.fast,
    fetcher: globalThis.fetch,
    idleMs: () => idleMs,
    build,
  });
  return { provider, core };
}

async function drain(provider: DirectProvider, request: ChatRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

const REQUEST: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };

/** A tool the model may call, as the transcript carries it. */
const TOOL: ToolSpec = {
  type: 'function',
  function: { name: 'list_nodes', description: 'list them', parameters: { type: 'object' } },
};

test('a direct stream maps every chunk the way the bus path maps an event', async () => {
  const { provider, core } = direct({
    deltas: [
      { delta: { reasoning_content: 'think ' } },
      { delta: { content: 'hel' } },
      { delta: { content: 'lo' } },
      {
        delta: {
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_nodes', arguments: '{' } }],
        },
      },
      { delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } },
      { delta: {}, usage: USAGE },
      { delta: {}, previous_response_id: 'resp-1' },
    ],
  });
  const events = await drain(provider, { ...REQUEST, tools: [TOOL], max_completion_tokens: 64 });
  assert.deepEqual(
    events.map((event) => event.type),
    ['reasoning', 'content', 'content', 'tool_call', 'tool_call', 'usage', 'end'],
  );
  assert.equal((events[0] as { text: string }).text, 'think ');
  assert.equal((events[1] as { text: string }).text, 'hel');
  assert.deepEqual((events[5] as { usage: unknown }).usage, USAGE);
  assert.equal(
    (events.at(-1) as { previous_response_id?: string | null }).previous_response_id,
    'resp-1',
    'the handle a stateful provider returned reaches the model',
  );
  assert.equal(core.streams.length, 1);
  assert.deepEqual(core.asked.at(-1)?.tools, undefined, 'a stream is not measured with a chat');
  assert.equal(core.streams[0]?.messages.at(-1)?.content, 'hi');
  assert.equal(core.closed, 1, 'the wire is closed when the stream ends');
});

test('a direct stream that is cancelled ends on an abort, not on a provider failure', async () => {
  const { provider, core } = direct({
    deltas: [{ delta: { content: 'first' } }],
    stallAfterFirst: true,
  });
  const stop = new AbortController();
  const reading = drain(provider, { ...REQUEST, signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort();
  await assert.rejects(reading, (error: Error) => error.name === 'AbortError');
  assert.equal(core.closed, 1, 'the wire is closed, not left open behind a stopped turn');
});

test('a direct stream that goes quiet past the idle timeout fails the turn', async () => {
  const { provider, core } = direct({ stall: true }, 25);
  await assert.rejects(
    () => drain(provider, REQUEST),
    /provider stream stalled waiting for its next event/,
  );
  assert.equal(core.closed, 1);
});

test('a direct chat reports usage and closes the wire', async () => {
  const { provider, core } = direct({
    answer: { message: { content: 'measured' }, usage: USAGE, previous_response_id: 'resp-2' },
  });
  const reply = await provider.chat({ ...REQUEST, max_completion_tokens: 16 });
  assert.equal(reply.content, 'measured');
  assert.deepEqual(reply.usage, USAGE);
  assert.equal(reply.previous_response_id, 'resp-2');
  assert.equal(core.asked[0]?.limit, 16);
  assert.equal(core.closed, 1);
});

// The last word: the default builder is the provider package's own `buildProvider`, so a `provider`
// row is answered by the same wires the node uses - spoken to in this process, not in the node's.
test('a direct row is served by the provider core itself, over the wire it names', async () => {
  const seen: JsonObject[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      seen.push(JSON.parse(body) as JsonObject);
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (payload: JsonObject): void => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      send({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-test',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'from ' }, finish_reason: null },
        ],
      });
      send({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-test',
        choices: [{ index: 0, delta: { content: 'the wire' }, finish_reason: null }],
      });
      send({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const provider = new DirectProvider('provider.fast', {
      row: 'fast',
      config: async () => ({
        type: 'openai',
        api_key: 'sk-test',
        model_name: 'gpt-test',
        base_url: `http://127.0.0.1:${port}/v1`,
        // A row's extra body reaches the wire the same way it does through the node: the config is
        // the row, whole, and the provider core is the only thing that reads it.
        extra_body: { trace: 'on' },
      }),
      fetcher: globalThis.fetch,
      idleMs: () => 5_000,
    });
    const events = await drain(provider, {
      messages: [
        { role: 'user', content: 'hi', at: '2026-01-01T00:00:00Z', took_ms: 3 } as Message,
      ],
      tools: [TOOL],
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ['content', 'content', 'usage', 'finish', 'end'],
    );
    // The wire's own reason for stopping is handed on, not dropped on the floor.
    assert.equal((events[3] as { reason: string }).reason, 'stop');
    assert.equal((events[0] as { text: string }).text, 'from ');
    assert.equal((events[1] as { text: string }).text, 'the wire');
    assert.deepEqual((events[2] as { usage: unknown }).usage, {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.['model'], 'gpt-test');
    assert.equal(seen[0]?.['stream'], true);
    assert.equal(seen[0]?.['trace'], 'on', "the row's extra body is merged onto the request");
    const messages = seen[0]?.['messages'] as JsonObject[];
    assert.deepEqual(messages, [{ role: 'user', content: 'hi' }], 'the wire shapes the line');
    assert.deepEqual((seen[0]?.['tools'] as JsonObject[])[0]?.['function'], {
      name: 'list_nodes',
      description: 'list them',
      parameters: { type: 'object' },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
