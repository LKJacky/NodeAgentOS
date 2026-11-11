// The provider seam: which row an agent talks through, the stream a provider node publishes, and
// the one question only a person can answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeProvider, ProviderNodes, STREAM_IDLE_MS, streamIdleMs } from '../src/model.ts';
import { ScriptedProvider } from './scripted_model.ts';
import type { StreamEvent, ToolCall } from '../src/types.ts';
import { FakeNet, startAgent, type TestAgent } from './harness.ts';

/** The agent's own provider seam: a fresh stateless proxy on the runtime's bus and hub. */
const providerOf = (agent: TestAgent) =>
  new NodeProvider(
    () => agent.runtime.bus(),
    new ProviderNodes(() => agent.runtime.bus()),
    agent.runtime.hub,
    'provider.fast',
  );

const providerNode = () =>
  new FakeNet().node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }, { name: 'deep' }], persistent: true }),
    chat: (args) => ({
      message: { content: `answer from ${String(args.name)}` },
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      previous_response_id: null,
    }),
  });

test('the provider rows are named after the node that holds them', async () => {
  const agent = await startAgent({ net: providerNode(), provider: undefined });
  try {
    const listed = (await agent.call('provider', { action: 'list' })) as {
      providers: { name: string }[];
      active: string;
    };
    assert.deepEqual(
      listed.providers.map((row) => row.name),
      ['provider.fast', 'provider.deep'],
    );
    assert.equal(listed.active, 'provider.fast', 'the first row is what an agent starts on');
    const selected = (await agent.call('provider', {
      action: 'select',
      name: 'provider.deep',
    })) as {
      active: string;
    };
    assert.equal(selected.active, 'provider.deep');
    assert.equal(agent.runtime.providerName, 'provider.deep');
    await assert.rejects(
      () => agent.call('provider', { action: 'select', name: 'provider.nope' }),
      /no provider "provider.nope"/,
    );
  } finally {
    await agent.stop();
  }
});

test('a selection stored in history is the one the next process uses', async () => {
  const net = providerNode().withHistory();
  const first = await startAgent({ net, tenantId: 't1' });
  try {
    await first.call('provider', { action: 'select', name: 'provider.deep' });
  } finally {
    await first.stop();
  }
  const second = await startAgent({ net, tenantId: 't1' });
  try {
    const listed = (await second.call('provider', { action: 'list' })) as { active: string };
    assert.equal(listed.active, 'provider.deep');
  } finally {
    await second.stop();
  }
});

test('a stream is asked for by id, subscribed by id, and started only after that', async () => {
  const id = 'a'.repeat(32);
  const net = providerNode();
  let deliver: (value: unknown) => void = () => undefined;
  let subscribedAtStart: string[] = [];
  let subscribedAtReady: string[] = [];
  let seen: { subscribed: string[] } = { subscribed: [] };
  net.node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    start_stream: () => {
      subscribedAtStart = [...seen.subscribed];
      return { stream_id: id, topic: `provider.stream.${id}` };
    },
    stream_ready: (args) => {
      assert.equal(String(args.stream_id), id, 'the stream is started by the id it was given');
      subscribedAtReady = [...seen.subscribed];
      deliver({
        stream_id: id,
        event: 'chunk',
        chunk: { delta: { reasoning_content: 'think ' } },
      });
      deliver({ stream_id: id, event: 'chunk', chunk: { delta: { content: 'hello ' } } });
      deliver({
        stream_id: id,
        event: 'chunk',
        chunk: {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'list_nodes', arguments: '{}' } },
            ],
          },
        },
      });
      deliver({
        stream_id: id,
        event: 'chunk',
        chunk: {
          delta: {},
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          previous_response_id: 'resp-1',
        },
      });
      deliver({ stream_id: id, event: 'done' });
      return { started: true };
    },
  });
  const agent = await startAgent({ net, provider: new ScriptedProvider() });
  try {
    const bus = agent.runtime.bus();
    seen = agent.session;
    deliver = (value) => agent.runtime.handleEvent(`provider.stream.${id}`, value);
    const provider = providerOf(agent);
    const events: StreamEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    assert.deepEqual(
      subscribedAtStart,
      [],
      'nothing is subscribed before there is an id to subscribe to',
    );
    assert.deepEqual(
      subscribedAtReady,
      [`provider.stream.${id}`],
      'the caller listens before the model is dialled, so the first delta cannot miss its room',
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['reasoning', 'content', 'tool_call', 'usage', 'end'],
    );
    assert.equal(agent.session.subscriptionNodes.at(-1), 'provider');
    assert.equal((events[1] as { text: string }).text, 'hello ');
    assert.equal((events[2] as { name?: string }).name, 'list_nodes');
    assert.equal(
      (events.at(-1) as { previous_response_id?: string | null }).previous_response_id,
      'resp-1',
      'the handle a stateful provider returned reaches the model',
    );
    assert.deepEqual(
      agent.session.unsubscribed,
      [`provider.stream.${id}`],
      'a finished stream stops listening on the topic of its own id',
    );
    assert.ok(
      !agent.session.subscribed.includes(`provider.stream.${id}`),
      'and the subscription is gone, not merely ignored',
    );
  } finally {
    await agent.stop();
  }
});

test('the first delta a provider emits as it starts is not lost', async () => {
  const id = 'b'.repeat(32);
  const net = providerNode();
  let deliver: (value: unknown) => void = () => undefined;
  net.node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    start_stream: () => ({ stream_id: id, topic: `provider.stream.${id}` }),
    stream_ready: () => {
      // Synchronously, before the call even returns: the model has already spoken by the time the
      // caller is told the stream started. This is exactly the delta a one-call `chat_stream` lost.
      deliver({ stream_id: id, event: 'chunk', chunk: { delta: { content: 'first ' } } });
      setTimeout(() => {
        deliver({ stream_id: id, event: 'chunk', chunk: { delta: { content: 'second' } } });
        deliver({ stream_id: id, event: 'done' });
      }, 0);
      return { started: true };
    },
  });
  const agent = await startAgent({ net, provider: new ScriptedProvider() });
  try {
    const bus = agent.runtime.bus();
    deliver = (value) => agent.runtime.handleEvent(`provider.stream.${id}`, value);
    const provider = providerOf(agent);
    const events: StreamEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    assert.deepEqual(
      events.map((event) => event.type),
      ['content', 'content', 'end'],
    );
    assert.equal((events[0] as { text: string }).text, 'first ');
    assert.equal((events[1] as { text: string }).text, 'second');
  } finally {
    await agent.stop();
  }
});

test('an error event fails the turn as it is read, and the listener is dropped', async () => {
  const id = 'c'.repeat(32);
  const net = providerNode();
  let deliver: (value: unknown) => void = () => undefined;
  net.node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    start_stream: () => ({ stream_id: id, topic: `provider.stream.${id}` }),
    stream_ready: () => {
      deliver({ stream_id: id, event: 'chunk', chunk: { delta: { content: 'partial' } } });
      deliver({
        stream_id: id,
        event: 'error',
        error: 'the model stream failed: 400 Request Error',
      });
      deliver({ stream_id: id, event: 'done', canceled: false });
      return { started: true };
    },
    cancel_stream: () => {
      throw new Error('a failed stream is not canceled again');
    },
  });
  const agent = await startAgent({ net, provider: new ScriptedProvider() });
  try {
    const bus = agent.runtime.bus();
    deliver = (value) => agent.runtime.handleEvent(`provider.stream.${id}`, value);
    const provider = providerOf(agent);
    const events: StreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(event);
      }
    }, /the model stream failed: 400 Request Error/);
    assert.deepEqual(
      events.map((event) => event.type),
      ['content'],
      'what the model did say before it failed still reaches the caller',
    );
    assert.deepEqual(agent.session.unsubscribed, [`provider.stream.${id}`]);
  } finally {
    await agent.stop();
  }
});

test('a cancelled stream is cancelled by its id, and the listener is dropped', async () => {
  const id = 'd'.repeat(32);
  const net = providerNode();
  const canceled: string[] = [];
  net.node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    start_stream: () => ({ stream_id: id, topic: `provider.stream.${id}` }),
    stream_ready: () => ({ started: true }),
    cancel_stream: (args) => {
      canceled.push(String(args.stream_id));
      return { canceled: true };
    },
  });
  const agent = await startAgent({ net, provider: new ScriptedProvider() });
  try {
    const bus = agent.runtime.bus();
    const stop = new AbortController();
    const provider = providerOf(agent);
    const reading = (async () => {
      for await (const _event of provider.stream({
        messages: [{ role: 'user', content: 'hi' }],
        signal: stop.signal,
      })) {
        // no deltas arrive: the stream is stopped while it is quiet
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    await assert.rejects(reading, /abort/i);
    assert.deepEqual(canceled, [id], 'the provider is told which stream to stop, by id');
    assert.deepEqual(agent.session.unsubscribed, [`provider.stream.${id}`]);
    assert.ok(!agent.session.subscribed.includes(`provider.stream.${id}`));
  } finally {
    await agent.stop();
  }
});

test('the stream idle timeout is two minutes unless the environment names another', () => {
  const before = process.env.NODE_AGENT_STREAM_IDLE_MS;
  try {
    delete process.env.NODE_AGENT_STREAM_IDLE_MS;
    assert.equal(STREAM_IDLE_MS, 120_000);
    assert.equal(streamIdleMs(), 120_000, 'no idle timeout configured is the two-minute default');
    process.env.NODE_AGENT_STREAM_IDLE_MS = '45000';
    assert.equal(streamIdleMs(), 45_000, 'a configured idle timeout is what a stream waits');
    for (const bad of ['', '0', '-1', 'soon', '1.5']) {
      process.env.NODE_AGENT_STREAM_IDLE_MS = bad;
      assert.equal(streamIdleMs(), 120_000, `"${bad}" is not a timeout: the default stands`);
    }
  } finally {
    if (before === undefined) delete process.env.NODE_AGENT_STREAM_IDLE_MS;
    else process.env.NODE_AGENT_STREAM_IDLE_MS = before;
  }
});

test('a provider silent for longer than five seconds is still being read, not stalled', async () => {
  const id = 'e'.repeat(32);
  const net = providerNode();
  let deliver: (value: unknown) => void = () => undefined;
  net.node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    start_stream: () => ({ stream_id: id, topic: `provider.stream.${id}` }),
    stream_ready: () => {
      // Thinking before the first token is the case that used to hand the first chunk a five-second
      // drain: a provider allowed to think must not fail the turn for being slow to speak.
      setTimeout(() => {
        deliver({ stream_id: id, event: 'chunk', chunk: { delta: { content: 'slow but alive' } } });
        deliver({ stream_id: id, event: 'done' });
      }, 5_200);
      return { started: true };
    },
  });
  const agent = await startAgent({ net, provider: new ScriptedProvider() });
  try {
    const bus = agent.runtime.bus();
    deliver = (value) => agent.runtime.handleEvent(`provider.stream.${id}`, value);
    const provider = providerOf(agent);
    const events: StreamEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    assert.deepEqual(
      events.map((event) => event.type),
      ['content', 'end'],
    );
    assert.equal((events[0] as { text: string }).text, 'slow but alive');
  } finally {
    await agent.stop();
  }
});

test('a stream that goes quiet past the idle timeout fails and is canceled', async () => {
  const id = 'f'.repeat(32);
  const net = providerNode();
  const canceled: string[] = [];
  net.node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    start_stream: () => ({ stream_id: id, topic: `provider.stream.${id}` }),
    stream_ready: () => ({ started: true }),
    cancel_stream: (args) => {
      canceled.push(String(args.stream_id));
      return { canceled: true };
    },
  });
  const before = process.env.NODE_AGENT_STREAM_IDLE_MS;
  process.env.NODE_AGENT_STREAM_IDLE_MS = '50';
  const agent = await startAgent({ net, provider: new ScriptedProvider() });
  try {
    const bus = agent.runtime.bus();
    const provider = providerOf(agent);
    const events: StreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(event);
      }
    }, /^Error: provider stream stalled waiting for its next event$/);
    assert.deepEqual(events, [], 'a stall is not a completion: nothing was handed to the model');
    assert.deepEqual(
      canceled,
      [id],
      'the stalled stream is canceled by its id, so the provider stops it',
    );
    assert.deepEqual(agent.session.unsubscribed, [`provider.stream.${id}`]);
  } finally {
    if (before === undefined) delete process.env.NODE_AGENT_STREAM_IDLE_MS;
    else process.env.NODE_AGENT_STREAM_IDLE_MS = before;
    await agent.stop();
  }
});

test('a bare provider name settles on the row it names', () => {
  assert.equal(ProviderNodes.rowOf('fast', ['provider.fast', 'provider.deep']), 'provider.fast');
  assert.equal(
    ProviderNodes.rowOf('fast', ['local-provider.fast', 'provider.fast']),
    'local-provider.fast',
  );
  assert.equal(ProviderNodes.rowOf('provider.deep', ['provider.fast']), null);
  assert.equal(ProviderNodes.rowOf(undefined, ['provider.fast']), null);
  assert.deepEqual(ProviderNodes.split('local-provider.fast'), {
    node: 'local-provider',
    name: 'fast',
  });
  assert.deepEqual(ProviderNodes.split('fast'), { node: null, name: 'fast' });
});

test('ask_user waits for the reader and hands back what they said', async () => {
  const agent = await startAgent({ provider: new ScriptedProvider() });
  try {
    const runtime = agent.runtime;
    await runtime.ready();
    const call: ToolCall = {
      id: 'call_ask',
      type: 'function',
      function: {
        name: 'ask_user',
        arguments: JSON.stringify({ title: 'which file?', selections: ['a.ts', 'b.ts'] }),
      },
    };
    const pending = runtime.env?.execute(call);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const asked = agent.net.events.find(
      (event) => (event.value as { type?: string }).type === 'ask',
    );
    assert.ok(asked !== undefined, 'the page is told a question is waiting');
    assert.equal((asked.value as { message: { title: string } }).message.title, 'which file?');
    assert.equal(await agent.call('answer', { id: 'call_ask', answer: 'a.ts' }), 'a.ts');
    assert.equal(await pending, 'user chose: "a.ts"');
  } finally {
    await agent.stop();
  }
});

test('a question nobody answers says so instead of pretending somebody did', async () => {
  const agent = await startAgent({ provider: new ScriptedProvider() });
  try {
    const runtime = agent.runtime;
    await runtime.ready();
    const result = await runtime.env?.execute({
      id: 'call_late',
      type: 'function',
      function: {
        name: 'ask_user',
        arguments: JSON.stringify({
          title: 'go on?',
          timeout_seconds: 0.02,
          default: 'yes',
        }),
      },
    });
    assert.deepEqual(JSON.parse(String(result)), {
      answered: false,
      reason: 'timeout',
      answer: 'yes',
    });
    assert.ok(
      agent.net.events.some((event) => (event.value as { type?: string }).type === 'ask_timeout'),
      'the page hears that the turn carried on',
    );
    await assert.rejects(
      () => agent.call('answer', { id: 'call_late', answer: 'no' }),
      /ran out of time and used the default "yes"/,
    );
  } finally {
    await agent.stop();
  }
});

test('a bus with no provider still starts the agent and its page', async () => {
  const agent = await startAgent({ net: new FakeNet(), materialize: false });
  try {
    assert.match(String(await agent.call('ui', {})), /const INJECTED = "agent";/);
    assert.deepEqual(await agent.call('provider', { action: 'list' }), {
      providers: [],
      active: '',
      persistent: true,
    });
    assert.equal(((await agent.call('status', {})) as { state: string }).state, 'idle');
    await assert.rejects(
      () => agent.call('chat', { msg: { content: 'hi' } }),
      /no provider node is on the bus/,
    );
    assert.notEqual(agent.runtime.model, null, 'model loading does not require a provider row');
  } finally {
    await agent.stop();
  }
});

test('an agent uses a provider that joins after its model loaded', async () => {
  const net = new FakeNet();
  const agent = await startAgent({ net, materialize: false });
  try {
    await assert.rejects(
      () => agent.call('chat', { msg: { content: 'before' } }),
      /no provider node is on the bus/,
    );
    net.node('provider', 'the shared providers', {
      providers: () => ({ providers: [{ name: 'fast' }] }),
      chat: () => ({
        message: { content: 'provider is ready' },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        previous_response_id: null,
      }),
      start_stream: () => ({
        stream_id: 'a'.repeat(32),
        topic: `provider.stream.${'a'.repeat(32)}`,
      }),
      stream_ready: () => {
        const id = 'a'.repeat(32);
        agent.runtime.handleEvent(`provider.stream.${id}`, {
          stream_id: id,
          event: 'chunk',
          chunk: { delta: { content: 'provider is ready' } },
        });
        agent.runtime.handleEvent(`provider.stream.${id}`, { stream_id: id, event: 'done' });
        return { started: true };
      },
    });

    const answer = (await agent.call('chat', { msg: { content: 'after' } })) as {
      content?: string;
    }[];
    assert.equal(answer.at(-1)?.content, 'provider is ready');
  } finally {
    await agent.stop();
  }
});
