// chat, the tool loop, the queue, the stop button and what `status` says while all of that runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentStatus, HistoryWindow } from '../src/runtime.ts';
import { ScriptedProvider } from './scripted_model.ts';
import type {
  ChatReply,
  ChatRequest,
  Message,
  Provider,
  StreamEvent,
  ToolCall,
} from '../src/types.ts';
import { FakeNet, startAgent } from './harness.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a condition the turn reaches on its own, and fail the test instead of hanging if it
 *  does not: a stop test that waits forever is a stop test that proves nothing. */
async function until(condition: () => Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(5);
  }
  throw new Error(`the condition never held within ${ms}ms`);
}

/** A tool call, as a model would have asked for it. */
function call(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** A provider that asks for one tool call, then writes down what that tool answered. */
class ToolCallProvider implements Provider {
  #call: ToolCall | null;

  constructor(wanted: ToolCall) {
    this.#call = wanted;
  }

  async chat(): Promise<ChatReply> {
    return { content: '', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const call = this.#call;
    if (call !== null) {
      this.#call = null;
      yield {
        type: 'tool_call',
        index: 0,
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      };
      yield { type: 'end', previous_response_id: null };
      return;
    }
    const said = request.messages
      .filter((line) => line.role === 'tool')
      .map((line) => String(line.content ?? ''))
      .join('\n');
    yield { type: 'content', text: `done:\n${said}` };
    yield { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
    yield { type: 'end', previous_response_id: null };
  }
}

/** A provider that must not be reached: a system-only transcript is history, not a question. */
class NeverProvider implements Provider {
  calls = 0;

  async chat(): Promise<ChatReply> {
    this.calls += 1;
    throw new Error('the model must not run for a system-only transcript');
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    this.calls += 1;
    throw new Error('the model must not run for a system-only transcript');
  }
}

/** A provider whose answer the test releases when it likes. */
class GatedProvider implements Provider {
  readonly #gate: Promise<void>;
  release!: () => void;
  readonly answers: string[];

  constructor(answers: string[]) {
    this.answers = answers;
    this.#gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    void request;
    return { content: '', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    await this.#gate;
    const answer = this.answers.shift() ?? 'done';
    yield { type: 'content', text: answer };
    yield { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
    yield { type: 'end', previous_response_id: null };
  }
}

/** A provider that streams slowly enough for the test to press stop. */
class SlowProvider implements Provider {
  async chat(): Promise<ChatReply> {
    return { content: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    for (let index = 0; index < 200; index += 1) {
      if (request.signal?.aborted) {
        const error = new Error('stopped');
        error.name = 'AbortError';
        throw error;
      }
      yield { type: 'content', text: 'x' };
      await sleep(5);
    }
    yield { type: 'end', previous_response_id: null };
  }
}

test('a turn calls a node and ends on the answer the model writes', async () => {
  const net = new FakeNet().node('echo', 'says what it is given', {
    say: (args) => `echo: ${String(args.text ?? '')}`,
  });
  const agent = await startAgent({ net, provider: new ScriptedProvider() });
  try {
    const lines = (await agent.call('chat', {
      msg: { role: 'user', content: 'hello' },
    })) as Message[];
    assert.ok(lines.length > 0, 'the turn added lines');
    assert.equal(lines.at(-1)?.role, 'assistant');
    assert.match(String(lines.at(-1)?.content), /done:\necho: FROM: tester/);
    const called = lines.filter((line) => line.role === 'tool');
    assert.equal(called.length, 3, 'list_nodes, list_node_tools and run_on_node were all run');
    assert.match(String(called.at(-1)?.content), /echo: FROM: tester/);
  } finally {
    await agent.stop();
  }
});

test('the caller is named in front of the line the model reads', async () => {
  const agent = await startAgent({ provider: new GatedProvider(['hi']) });
  try {
    const pending = agent.call('chat', { msg: { content: 'hello' } }, 'report');
    await sleep(20);
    (agent.runtime.options.provider as GatedProvider).release();
    await pending;
    // The answer carries the lines the turn added, not the line it was handed; the transcript does.
    const history = (await agent.call('history', {})) as HistoryWindow;
    const user = history.messages.find((line) => line.role === 'user');
    assert.match(
      String(user?.content),
      /^FROM: report, TIME: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\+08:00\n\nhello$/,
    );
  } finally {
    await agent.stop();
  }
});

test('a system-only transcript is stored without a model round', async () => {
  const provider = new NeverProvider();
  const agent = await startAgent({ provider });
  try {
    assert.equal(
      await agent.call('chat_no_wait', {
        msg: { role: 'system', content: 'you are the stack instruction' },
      }),
      'queued',
    );
    await until(async () => ((await agent.call('history', {})) as HistoryWindow).total === 1);
    const history = (await agent.call('history', {})) as HistoryWindow;
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ['system'],
    );
    assert.ok(history.messages[0]?.content?.endsWith('you are the stack instruction'));
    assert.equal(provider.calls, 0, 'the model was not asked to answer a system line');
    assert.equal(((await agent.call('status', {})) as AgentStatus).state, 'idle');
  } finally {
    await agent.stop();
  }
});

test('chat_no_wait answers at once and the turn runs behind it', async () => {
  const provider = new GatedProvider(['first']);
  const agent = await startAgent({ provider });
  try {
    assert.equal(await agent.call('chat_no_wait', { msg: { content: 'go' } }), 'queued');
    const status = (await agent.call('status', {})) as AgentStatus;
    assert.ok(['generating', 'tool'].includes(status.state), `state was ${status.state}`);
    provider.release();
    await sleep(50);
    const history = (await agent.call('history', {})) as HistoryWindow;
    assert.equal(history.messages.at(-1)?.content, 'first');
    assert.equal(((await agent.call('status', {})) as AgentStatus).state, 'idle');
  } finally {
    await agent.stop();
  }
});

test('an interpret line goes into the next round, ahead of a queued one', async () => {
  const provider = new GatedProvider(['first', 'second', 'third']);
  const agent = await startAgent({ provider });
  try {
    const first = agent.call('chat', { msg: { content: 'one' } });
    await sleep(10);
    assert.equal(
      await agent.call('chat_no_wait', { msg: { content: 'queued' }, priority: 'queue' }),
      'queued',
    );
    assert.equal(
      await agent.call('chat_no_wait', { msg: { content: 'interrupt' }, priority: 'interpret' }),
      'interpreted',
    );
    const queued = ((await agent.call('status', {})) as AgentStatus).queued;
    assert.deepEqual(
      queued.map((message) => message.content?.split('\n').at(-1)),
      ['interrupt', 'queued'],
    );
    provider.release();
    const lines = (await first) as Message[];
    assert.equal(lines.at(-1)?.content, 'first', 'chat answers with its own turn only');
    await sleep(80);
    const history = (await agent.call('history', {})) as HistoryWindow;
    const users = history.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content?.split('\n').at(-1));
    assert.deepEqual(users, ['one', 'interrupt', 'queued']);
  } finally {
    await agent.stop();
  }
});

// Stop is about the turn, and only the turn: the runtime stays bound (closing it belongs to whoever
// owns it, not to a button), and the transcript the cut turn wrote is still what the next call reads.
test('stop cuts the turn short, keeps the runtime, and the transcript survives', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, provider: new SlowProvider() });
  try {
    const before = agent.runtime;
    await agent.call('chat_no_wait', { msg: { content: 'go' } });
    await sleep(30);
    assert.equal(((await agent.call('status', {})) as AgentStatus).state, 'generating');
    assert.equal(await agent.call('stop', {}), 'stopped');

    const history = (await agent.call('history', {})) as HistoryWindow;
    assert.equal(history.messages.at(-1)?.content, 'aborted by user');
    assert.equal(agent.runtime, before, 'the same runtime carries on: a stop is not a close');
    assert.equal(((await agent.call('status', {})) as AgentStatus).state, 'idle');
    assert.equal(await agent.call('stop', {}), 'nothing to stop');
  } finally {
    await agent.stop();
  }
});

test('stop ends the turn instead of waiting for a tool that never answers', async () => {
  // A node whose capability never comes back: the bus call stays out, and the turn must not.
  const net = new FakeNet().withHistory().node('hang', 'never answers', {
    forever: () => new Promise(() => {}),
  });
  const provider = new ToolCallProvider(
    call('run_on_node', { node: 'hang', tool_name: 'forever', tool_args: {} }),
  );
  const agent = await startAgent({ net, provider });
  try {
    await agent.call('chat_no_wait', { msg: { content: 'go' } });
    await until(async () => ((await agent.call('status', {})) as AgentStatus).state === 'tool');

    const started = Date.now();
    const stopped = await Promise.race([
      agent.call('stop', {}),
      sleep(2000).then(() => 'still waiting for the tool'),
    ]);
    const took = Date.now() - started;
    assert.equal(stopped, 'stopped', `stop answered in ${took}ms, long before the tool could`);
    assert.ok(took < 1500, `stop answered in ${took}ms, not on the tool's schedule`);

    const history = (await agent.call('history', {})) as HistoryWindow;
    const tool = history.messages.filter((line) => line.role === 'tool').at(-1);
    assert.equal(tool?.content, 'cancelled by user', 'the tool line says why it is empty');
    assert.equal(history.messages.at(-1)?.content, 'aborted by user');
    assert.equal(((await agent.call('status', {})) as AgentStatus).state, 'idle');
  } finally {
    await agent.stop();
  }
});

test('stop ends a turn while the provider is still handing out a stream id', async () => {
  const net = new FakeNet().withHistory();
  let streamStarted = false;
  let canceled = 0;
  net.node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    chat: () => ({
      message: { content: '' },
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      previous_response_id: null,
    }),
    start_stream: () => {
      streamStarted = true;
      return new Promise(() => {});
    },
    stream_ready: () => ({ started: true }),
    cancel_stream: () => {
      canceled += 1;
      // A provider that is stuck creating the stream may not answer the cancel either. Stop must
      // not inherit that delay.
      return new Promise(() => {});
    },
  });

  const agent = await startAgent({ net });
  try {
    await agent.call('chat_no_wait', { msg: { content: 'go' } });
    await until(async () => streamStarted);

    const started = Date.now();
    const stopped = await Promise.race([
      agent.call('stop', {}),
      sleep(2000).then(() => 'still waiting for the provider'),
    ]);
    const took = Date.now() - started;
    assert.equal(stopped, 'stopped', `stop answered in ${took}ms, before the stream was created`);
    assert.ok(took < 1500, `stop answered in ${took}ms, not on the provider's schedule`);
    assert.equal(
      canceled,
      0,
      'no id came back, so there is no stream to cancel: the model was never dialled',
    );

    const history = (await agent.call('history', {})) as HistoryWindow;
    assert.equal(history.messages.at(-1)?.content, 'aborted by user');
    assert.equal(((await agent.call('status', {})) as AgentStatus).state, 'idle');
  } finally {
    await agent.stop();
  }
});

test("stop ends a turn that is waiting on the reader's answer", async () => {
  const net = new FakeNet().withHistory();
  const provider = new ToolCallProvider(call('ask_user', { title: 'which file', input: 'text' }));
  const agent = await startAgent({ net, provider });
  try {
    await agent.call('chat_no_wait', { msg: { content: 'go' } });
    await until(async () =>
      agent.net.events.some((event) => (event.value as { type?: string }).type === 'ask'),
    );

    const stopped = await Promise.race([
      agent.call('stop', {}),
      sleep(2000).then(() => 'still waiting for the answer'),
    ]);
    assert.equal(stopped, 'stopped');

    const history = (await agent.call('history', {})) as HistoryWindow;
    const tool = history.messages.filter((line) => line.role === 'tool').at(-1);
    assert.equal(tool?.content, 'cancelled by user');
    assert.equal(history.messages.at(-1)?.content, 'aborted by user');
  } finally {
    await agent.stop();
  }
});

test('a tool that answers is handed its answer, not a cancellation', async () => {
  const net = new FakeNet().node('echo', 'says what it is given', {
    say: (args) => `echo: ${String(args.text ?? '')}`,
  });
  const provider = new ToolCallProvider(
    call('run_on_node', { node: 'echo', tool_name: 'say', tool_args: { text: 'hi' } }),
  );
  const agent = await startAgent({ net, provider });
  try {
    const lines = (await agent.call('chat', { msg: { content: 'go' } })) as Message[];
    const tool = lines.filter((line) => line.role === 'tool').at(-1);
    assert.equal(tool?.content, 'echo: hi');
    assert.match(String(lines.at(-1)?.content), /done:\necho: hi/);
    assert.ok(
      !lines.some((line) => String(line.content).includes('cancelled by user')),
      'nothing was cancelled',
    );
  } finally {
    await agent.stop();
  }
});

test('usage adds up the reported counts and counts every call', async () => {
  const agent = await startAgent({ provider: new GatedProvider(['first', 'second']) });
  try {
    const pending = agent.call('chat', { msg: { content: 'one' } });
    await sleep(10);
    (agent.runtime.options.provider as GatedProvider).release();
    await pending;
    const status = (await agent.call('status', {})) as AgentStatus;
    assert.equal(status.usage.model_calls, 1);
    assert.equal(status.usage.reported_calls, 1);
    assert.equal(status.usage.completion_tokens, 5);
    // The first round measures the transcript it is about to send (`prompt_tokens: 10`), so the
    // reported 20 arrive as 10 new input tokens; 10 + 5 is what the turn cost.
    assert.equal(status.usage.prompt_tokens, 10);
    assert.equal(status.usage.total_tokens, 15);
  } finally {
    await agent.stop();
  }
});

// An agent had no way to say anything while it worked: `usable()` dropped its own node, so the one
// call that answers without waiting - `chat_no_wait` - was out of reach, and a turn that wanted to
// post progress had to end first. It is offered now, under the agent's own address, and answered in
// this process; anything else about itself stays out (a `chat` on itself would wait for the turn
// that is asking, a `stop` would cut it).
test('an agent posts a line about its own work with chat_no_wait', async () => {
  const agent = await startAgent({
    provider: new ToolCallProvider(
      call('run_on_node', {
        node: 'agent',
        tool_name: 'chat_no_wait',
        tool_args: { msg: { content: 'still reading the repository' }, priority: 'interpret' },
      }),
    ),
  });
  try {
    const lines = (await agent.call('chat', { msg: { content: 'go' } })) as Message[];
    const answer = lines.filter((line) => line.role === 'tool').map((line) => line.content);
    assert.match(String(answer.at(-1)), /interpreted/, 'the line went into the turn in progress');

    // The reader sees it at once: it is a line of this agent's own transcript.
    const history = (await agent.call('history', {})) as HistoryWindow;
    const posted = history.messages.filter(
      (line) => line.role === 'user' && String(line.content).includes('still reading'),
    );
    assert.equal(posted.length, 1, 'the note is in the transcript');
    assert.match(String(posted[0]?.content), /FROM: agent/, 'and it says it came from this agent');

    // What it may do to itself stays off the two calls that would hang or cut the turn asking, and
    // `agent` is not a way round that: naming itself is refused whether the call needs it or not.
    const self = { node: 'agent' };
    const refused = async (tool: string, toolArgs: Record<string, unknown>): Promise<string> =>
      String(await agent.runtime.env?.runOnNode({ ...self, tool_name: tool, tool_args: toolArgs }));
    assert.match(
      await refused('chat', { msg: { content: 'and another thing' } }),
      /cannot chat with itself/,
    );
    assert.match(
      await refused('chat_no_wait', { msg: { content: 'note' }, agent: 'agent' }),
      /cannot name "agent" in "agent": an agent does not act on itself/,
      'the agent selector cannot name the agent that is asking',
    );
    // The rest of what the bus exposes to an ordinary caller answers as the node would: nothing a
    // turn must wait on, and nothing the bus keeps to the page (`history`, `stop`, `provider`,
    // `answer` carry `expose: false`, so they are not in the list to begin with).
    assert.match(await refused('status', {}), /generating|idle/);
    assert.match(await refused('agents', {}), /"agents"/);
    for (const hidden of ['history', 'provider', 'answer', 'stop']) {
      assert.match(
        await refused(hidden, {}),
        /not in the usable list/,
        `the bus does not expose ${hidden} to an ordinary caller`,
      );
    }
  } finally {
    await agent.stop();
  }
});
