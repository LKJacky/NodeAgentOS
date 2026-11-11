// Sub-agents: one identity, one bus connection, one set of permissions — and a runtime of their own.
//
// A sub-agent used to be a second node on the bus, registered privately for the tenant that created
// it. The bus then asked who was calling, found a node no permission had ever named, and refused it
// the capabilities its own parent could call. These are the tests that keep that from coming back:
// creating a sub-agent registers nothing, it answers through the parent's identity, `run_on_node`
// still reaches it by name, the page can switch to it, and destroying it takes its units with it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { HistoryWindow } from '../src/runtime.ts';
import type { ChatReply, ChatRequest, Provider, StreamEvent, ToolCall } from '../src/types.ts';
import { FakeNet, startAgent, type TestAgent } from './harness.ts';

/** The drawing every `create_agent` in these tests hands over: it is a required part of creating
 *  one, and the page draws it on the tab. */
const ICON = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="7"/></svg>';

/** A tool call, as a model would have asked for it. */
function call(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** One round of a scripted conversation: a tool call, or the prose that ends a turn. */
type Step = { call: ToolCall } | { text: string };

/** A provider that reads its answers off a queue the test wrote. Parent and sub-agent share it — they
 *  share one provider on purpose — so the queue is written in the order the calls happen. */
class Script implements Provider {
  readonly #steps: Step[];
  readonly asked: ChatRequest[] = [];

  constructor(...steps: Step[]) {
    this.#steps = steps;
  }

  async chat(): Promise<ChatReply> {
    return { content: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.asked.push(request);
    const step = this.#steps.shift() ?? { text: 'done' };
    if ('call' in step) {
      yield {
        type: 'tool_call',
        index: 0,
        id: step.call.id,
        name: step.call.function.name,
        arguments: step.call.function.arguments,
      };
      yield { type: 'end', previous_response_id: null };
      return;
    }
    yield { type: 'content', text: step.text };
    yield { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
    yield { type: 'end', previous_response_id: null };
  }
}

/** A provider that answers the main agent at once and holds a sub-agent's turn open until the test
 *  lets it go: the family mid-turn while a reader presses Stop on the main agent's page. */
class Held implements Provider {
  readonly #open: Promise<void>;
  #release!: () => void;

  constructor() {
    this.#open = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  /** Stay in the turn until the test lets it go - or until the turn is cut, which is what a provider
   *  that honours `signal` does: a stream nobody is reading any more writes nothing more. */
  async #hold(signal: AbortSignal | undefined): Promise<void> {
    let cut: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
      cut = resolve;
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', resolve, { once: true });
    });
    try {
      await Promise.race([this.#open, aborted]);
    } finally {
      signal?.removeEventListener('abort', cut);
    }
  }

  async chat(): Promise<ChatReply> {
    return { content: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const last = request.messages.at(-1)?.content;
    const said = typeof last === 'string' ? last : '';
    if (said.includes('start a helper')) {
      yield {
        type: 'tool_call',
        index: 0,
        id: 'call_create',
        name: 'create_agent',
        arguments: JSON.stringify({ name: 'helper', icon: ICON }),
      };
      yield { type: 'end', previous_response_id: null };
      return;
    }
    if (said.includes('keep talking')) {
      yield { type: 'content', text: 'the main agent speaking' };
      await this.#hold(request.signal);
      if (request.signal?.aborted) return;
      yield { type: 'end', previous_response_id: null };
      return;
    }
    if (said.includes('say something')) {
      yield { type: 'content', text: 'the child speaking' };
      await this.#hold(request.signal);
      if (request.signal?.aborted) return;
      yield { type: 'end', previous_response_id: null };
      return;
    }
    yield { type: 'content', text: 'ready' };
    yield { type: 'end', previous_response_id: null };
  }
}

/** Wait for something the turn reaches on its own, failing instead of hanging. */
async function until(condition: () => Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the condition never held within ${ms}ms`);
}

const TENANT = 't1';

/** One agent on a fake bus that carries an `echo` node and a history node. */
async function start(script: Script): Promise<TestAgent> {
  const net = new FakeNet().withHistory().node('echo', 'echoes one line back', {
    say: async (args) => `echo: ${String(args.text ?? '')}`,
  });
  return await startAgent({ net, provider: script, tenantId: TENANT });
}

/** The names of the nodes the bus knows, which is what a sub-agent must not add to. */
async function busNames(agent: TestAgent): Promise<string[]> {
  return (await agent.session.listNodes()).map((node) => node.name);
}

test('a bus node and a sub-agent with the same short name stay apart', async () => {
  const net = new FakeNet().withHistory().node('echo', 'echoes one line back', {
    say: async (args) => `echo: ${String(args.text ?? '')}`,
  });
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
  );
  const agent = await startAgent({ net, provider: script, tenantId: TENANT });
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    // The node joins after the sub-agent was created: `spawnAgent` could not have refused it.
    net.node('helper', 'a late bus node', { chat: async () => 'the bus node' });

    const entries = (await agent.runtime.env?.usable()) ?? [];
    assert.ok(
      entries.some((entry) => entry.node === 'helper' && entry.tool === 'chat'),
      'the bus node keeps its address',
    );
    assert.equal(
      entries.filter((entry) => entry.node.includes('.')).length,
      0,
      'a sub-agent has no address of its own: the family node takes `agent` to name it',
    );
    // The family node's chat with `agent: "helper"` reaches the sub-agent, not the bus node.
    const before = agent.session.calls.filter((one) => one.to === 'helper').length;
    const answer = await agent.runtime.env!.runOnNode({
      node: 'agent',
      tool_name: 'chat',
      tool_args: { agent: 'helper', msg: { content: 'say hi' } },
    });
    assert.doesNotMatch(String(answer), /tool call failed/);
    assert.equal(
      agent.session.calls.filter((one) => one.to === 'helper').length,
      before,
      'no frame went to the bus node of the same name',
    );
  } finally {
    await agent.runtime.close();
  }
});

test('create_agent can choose a provider; leaving it out inherits the parent', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'own', provider: 'default', icon: ICON }) },
    { call: call('create_agent', { name: 'heir', icon: ICON }) },
    { text: 'ready' },
  );
  const agent = await start(script);
  try {
    await agent.call('chat', { msg: { content: 'start two agents' } }, 'alice');
    assert.equal(
      agent.runtime.agent('own').options.providerName,
      'default',
      'the provider named at creation is kept',
    );
    assert.equal(
      agent.runtime.agent('own').options.icon,
      ICON,
      'the drawing named at creation is kept',
    );
    assert.equal(
      agent.runtime.agent('heir').options.providerName,
      undefined,
      'without one, the child follows its parent',
    );
  } finally {
    await agent.stop();
  }
});

test('a restarted parent restores each sub-agent icon and provider', async () => {
  const net = new FakeNet().withHistory();
  const tenantId = 'restore';
  const first = await startAgent({ net, tenantId, provider: new Script({ text: 'main' }) });
  try {
    await first.runtime.spawnAgent('helper', ICON, 'default');
  } finally {
    await first.stop();
  }

  const second = await startAgent({ net, tenantId, provider: new Script({ text: 'main' }) });
  try {
    const helper = second.runtime.agent('helper');
    assert.equal(helper.options.icon, ICON, 'the drawing survives the restart');
    assert.equal(
      helper.options.providerName,
      'default',
      'the chosen provider survives the restart',
    );
  } finally {
    await second.stop();
  }
});

test('a restarted parent still restores the old names-only list', async () => {
  const net = new FakeNet().withHistory();
  const tenantId = 'restore-old';
  net.putUnit('subagents', { names: ['legacy'] }, tenantId);
  const agent = await startAgent({ net, tenantId, provider: new Script({ text: 'main' }) });
  try {
    const legacy = agent.runtime.agent('legacy');
    assert.equal(legacy.options.icon, undefined);
    assert.equal(legacy.options.providerName, undefined);
  } finally {
    await agent.stop();
  }
});

test('creating a sub-agent registers no node and shares the parent identity', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
  );
  const agent = await start(script);
  try {
    const before = await busNames(agent);
    const lines = (await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice')) as {
      role: string;
      content: string | null;
    }[];
    assert.ok(
      lines.some(
        (line) => line.role === 'tool' && /created agent "helper"/.test(String(line.content)),
      ),
      'the model was told the agent was created',
    );

    // Nothing was registered: the family answers to one bus name.
    assert.deepEqual(await busNames(agent), before, 'no node was added to the bus');
    assert.ok(!(await busNames(agent)).includes('helper'));

    // And the sub-agent is a runtime on the parent scope, not a node of its own.
    const child = agent.runtime.agent('helper');
    assert.equal(child.scope, agent.runtime.scope, 'one bus connection for the family');
    assert.equal(child.identity.busName, 'agent', 'the same identity the parent answers to');
    assert.equal(child.identity.topic, 'agent.helper', 'its own topic, for its own page feed');
    assert.notEqual(child, agent.runtime, 'and an agent of its own');

    const rows = (
      (await agent.call('agents', {})) as {
        agents: { name: string; topic: string; parent: string | null; children: number }[];
      }
    ).agents;
    assert.deepEqual(
      rows.map((row) => [row.name, row.topic, row.parent]),
      [
        ['agent', 'agent', null],
        ['helper', 'agent.helper', 'agent'],
      ],
    );
    // Asked from inside the child, the same roster comes back: the family is what the root runs,
    // not the branch one agent can see.
    const fromChild = JSON.parse(
      await child.env!.runOnNode({ node: 'agent', tool_name: 'agents', tool_args: {} }),
    ) as { agents: { name: string }[] };
    assert.deepEqual(
      fromChild.agents.map((row) => row.name),
      ['agent', 'helper'],
    );
  } finally {
    await agent.stop();
  }
});

test('a sub-agent calls ordinary capabilities with the parent identity', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
    { call: call('run_on_node', { node: 'echo', tool_name: 'say', tool_args: { text: 'hi' } }) },
    { text: 'said it' },
  );
  const agent = await start(script);
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    const lines = (await agent.call(
      'chat',
      { agent: 'helper', msg: { content: 'say hi to the bus' } },
      'alice',
    )) as { role: string; content: string | null }[];

    // The caller is the family's one registration, so the capability the bus checks is the one the
    // parent holds; no private node was asked about and nothing was refused.
    const echoed = agent.session.calls.filter((one) => one.to === 'echo');
    assert.equal(echoed.length, 1, 'the sub-agent reached the bus node');
    assert.equal(echoed[0]?.from, 'agent', 'as the identity the parent registered');
    assert.ok(
      lines.some((line) => line.role === 'tool' && String(line.content).includes('echo: hi')),
      'and its turn read the answer',
    );
  } finally {
    await agent.stop();
  }
});

test('list_nodes comes from the bus: no page-only nodes, and this agent last', async () => {
  const net = new FakeNet()
    .withHistory()
    .node('echo', 'says it back', { say: async () => 'echo' })
    .node('panel', 'a page and nothing else', { ui: async () => '<svg/>' });
  const agent = await startAgent({ net, provider: new Script({ text: 'hi' }), tenantId: TENANT });
  try {
    await agent.runtime.spawnAgent('helper', ICON);
    assert.equal(
      await agent.runtime.env!.listNodes(),
      ['- echo', '- agent'].join('\n'),
      'the bus first, and this agent itself last',
    );
    assert.equal(
      await agent.runtime.agent('helper').env!.listNodes(),
      ['- echo', '- agent'].join('\n'),
      'a sub-agent answers on the family node too: one tenant, one identity',
    );
  } finally {
    await agent.stop();
  }
});

test('`agent` names a child of the node it is sent to, never the agent that node is', async () => {
  const agent = await start(new Script({ text: 'the child says hi' }));
  try {
    await agent.runtime.spawnAgent('helper', ICON);
    const env = agent.runtime.env!;
    // The family node hands the turn to the child its `agent` argument names.
    const handed = await env.runOnNode({
      node: 'agent',
      tool_name: 'chat',
      tool_args: { agent: 'helper', msg: { content: 'say hi' } },
    });
    assert.match(handed, /the child says hi/);
    // A sub-agent has no address of its own: naming one as a node is not a call the model can make.
    assert.match(
      String(
        await env.runOnNode({
          node: 'agent.helper',
          tool_name: 'chat',
          tool_args: { msg: { content: 'again' } },
        }),
      ),
      /not in the usable list/,
    );
    // Inside the child, the family node is its own too: naming itself again is refused.
    const child = agent.runtime.agent('helper').env!;
    assert.match(
      String(
        await child.runOnNode({
          node: 'agent',
          tool_name: 'chat',
          tool_args: { agent: 'helper', msg: { content: 'again' } },
        }),
      ),
      /an agent does not act on itself/,
    );
    // Naming the agent the node itself is the same refusal: an agent does not act on itself.
    assert.match(
      String(
        await env.runOnNode({
          node: 'agent',
          tool_name: 'chat',
          tool_args: { agent: 'agent', msg: { content: 'x' } },
        }),
      ),
      /an agent does not act on itself/,
    );
  } finally {
    await agent.stop();
  }
});

test('run_on_node hands a turn to a sub-agent through the family node', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
    {
      call: call('run_on_node', {
        node: 'agent',
        tool_name: 'chat',
        tool_args: { agent: 'helper', msg: { role: 'user', content: 'say hi' } },
      }),
    },
    // The sub-agent's own turn, started by that call.
    {
      call: call('run_on_node', {
        node: 'echo',
        tool_name: 'say',
        tool_args: { text: 'from the child' },
      }),
    },
    { text: 'the child reports: echo: from the child' },
    // Back in the parent, whose turn was waiting on all of that.
    { text: 'done' },
  );
  const agent = await start(script);
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    const lines = (await agent.call('chat', { msg: { content: 'ask it to say hi' } }, 'alice')) as {
      role: string;
      content: string | null;
    }[];

    // `run_on_node` names the family node, which is the one node on the bus: the `agent` argument
    // inside the call is what hands the turn to the sub-agent.
    assert.equal(
      agent.session.calls.filter((one) => one.to === 'agent').length > 0,
      true,
      'the call went to the family node',
    );
    assert.equal(
      agent.session.calls.filter((one) => one.to === 'helper').length,
      0,
      'nothing was addressed to a node called helper',
    );
    assert.ok(
      lines.some((line) => line.role === 'tool' && String(line.content).includes('from the child')),
      "the parent's turn read the sub-agent's answer",
    );
    // The sub-agent ran a turn of its own, on its own transcript.
    const child = (await agent.call('history', { agent: 'helper' })) as HistoryWindow;
    assert.ok(
      child.messages.some((line) => line.content?.includes('from the child')),
      'the sub-agent kept the lines of its turn',
    );
  } finally {
    await agent.stop();
  }
});

test('the page switches agents: history, status and stop follow the selection', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
    { text: 'the child speaking' },
  );
  const agent = await start(script);
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    await agent.call('chat', { agent: 'helper', msg: { content: 'say something' } }, 'alice');

    const main = (await agent.call('history', {})) as HistoryWindow;
    const child = (await agent.call('history', { agent: 'helper' })) as HistoryWindow;
    assert.ok(
      main.messages.some((line) => line.content?.includes('start a helper')),
      'the main transcript is the main one',
    );
    assert.ok(
      !main.messages.some((line) => line.content?.includes('say something')),
      "a sub-agent's turn is not written into the main transcript",
    );
    assert.ok(child.messages.some((line) => line.content?.includes('say something')));
    assert.ok(child.messages.some((line) => line.content?.includes('the child speaking')));

    // The two transcripts are two sets of units under one identity.
    const units = agent.net.unitIds(TENANT);
    assert.ok(units.includes('conversation'), 'the main transcript has its own unit');
    assert.ok(
      units.some((unitId) => unitId.startsWith('sub.helper.conversation')),
      'and the sub-agent files its own, under its own prefix',
    );

    const status = (await agent.call('status', { agent: 'helper' })) as { state: string };
    assert.equal(status.state, 'idle', 'the sub-agent answers for itself');
    assert.equal(await agent.call('stop', { agent: 'helper' }), 'nothing to stop');
    await assert.rejects(
      agent.call('history', { agent: 'nope' }),
      /no agent named "nope" here \(agents: agent, helper\)/,
      'an unknown name is refused, and the names are listed',
    );
  } finally {
    await agent.stop();
  }
});

test('destroying a sub-agent takes its units and its name with it', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
    { text: 'the child speaking' },
    { call: call('destroy_agent', { name: 'helper' }) },
    { text: 'gone' },
  );
  const agent = await start(script);
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    await agent.call('chat', { agent: 'helper', msg: { content: 'say something' } }, 'alice');
    assert.ok(
      agent.net.unitIds(TENANT).some((unitId) => unitId.startsWith('sub.helper.')),
      'the sub-agent wrote units',
    );

    await agent.call('chat', { msg: { content: 'destroy the helper' } }, 'alice');

    const rows = ((await agent.call('agents', {})) as { agents: { name: string }[] }).agents;
    assert.deepEqual(
      rows.map((row) => row.name),
      ['agent'],
      'only the main agent is left',
    );
    assert.deepEqual(
      agent.net.unitIds(TENANT).filter((unitId) => unitId.startsWith('sub.helper.')),
      [],
      'and none of its units are',
    );
    assert.ok(
      agent.net.unitIds(TENANT).includes('conversation'),
      "the main agent's own transcript is untouched",
    );
    await assert.rejects(agent.call('status', { agent: 'helper' }), /no agent named "helper"/);
  } finally {
    await agent.stop();
  }
});

test('a sub-agent cannot create a sub-agent', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
  );
  const agent = await start(script);
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    const child = agent.runtime.agent('helper');
    assert.equal(child.allowSpawn(), false);
    const offered = (child.env?.tools ?? []).map((tool) => tool.function.name);
    assert.ok(!offered.includes('create_agent'), 'the tool is not even offered');
    // Nor is any agent in its usable list: not its parent, not a sibling. It does see itself - under
    // the address its parent reaches it by - with the capabilities its own node answers, and the
    // calls that would act on itself are refused when they are made (see chat.test.ts).
    const childSees = ((await child.env?.usable()) ?? []).filter(
      (entry) => entry.node === 'agent' || entry.node === 'agent.helper',
    );
    assert.equal(
      childSees.every((entry) => entry.node === 'agent'),
      true,
    );
    assert.deepEqual(
      [...new Set(childSees.map((entry) => entry.tool))].sort(),
      ['agents', 'chat', 'chat_no_wait', 'status'],
      'a sub-agent answers on the family node, with what the bus exposes to an ordinary caller',
    );
    // The parent has no address for it either: a sub-agent answers through the family node, whose
    // capabilities take `agent` to name it.
    const parentSees = (await agent.runtime.env?.usable()) ?? [];
    assert.deepEqual(
      [...new Set(parentSees.map((entry) => entry.node))].sort(),
      ['agent', 'echo'],
      'no namespaced address for a sub-agent',
    );
    const ownChat = parentSees.find((entry) => entry.node === 'agent' && entry.tool === 'chat');
    assert.ok(ownChat);
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { node: { caps: Record<string, Record<string, unknown>> } };
    const chat = manifest.node.caps.chat ?? {};
    const { callers: _callers, expose: _expose, ...chatSchema } = chat;
    assert.deepEqual(ownChat.parameters, chatSchema, 'the node uses the manifest schema');
    assert.ok(!parentSees.some((entry) => entry.tool === 'ui'), 'the page is never offered');
    assert.deepEqual(
      [
        ...new Set(parentSees.filter((entry) => entry.node === 'agent').map((entry) => entry.tool)),
      ].sort(),
      ['agents', 'chat', 'chat_no_wait', 'status'],
      'the main agent reaches itself with what the bus exposes to it',
    );
    await assert.rejects(child.spawnAgent('grandchild'), /may not create sub-agents/);
    // The refusal is text the model reads, not a failed turn.
    const answer = await child.env?.execute({
      id: 'call_create_agent',
      type: 'function',
      function: {
        name: 'create_agent',
        arguments: JSON.stringify({ name: 'grandchild', icon: ICON }),
      },
    });
    assert.equal(answer, 'cannot create "grandchild": this agent may not create sub-agents');
  } finally {
    await agent.stop();
  }
});

test('create_agent needs a drawing: the icon is part of creating one', async () => {
  const agent = await start(new Script({ text: 'ready' }));
  try {
    const env = agent.runtime.env!;
    // The tool the model is handed says so before it is called.
    const spec = env.tools.find((tool) => tool.function.name === 'create_agent');
    assert.deepEqual(spec?.function.parameters.required, ['name', 'icon']);

    assert.match(await env.createAgent({ name: 'bare' }), /needs an "icon"/);
    assert.match(
      await env.createAgent({ name: 'scribble', icon: 'a circle, roughly' }),
      /icon must be one <svg>/,
    );
    assert.match(
      await agent.runtime.spawnAgent('noicon'),
      /an icon is required/,
      'and the node refuses one asked for without a drawing',
    );
    assert.deepEqual(
      agent.runtime.agentRows().map((row) => row.name),
      ['agent'],
      'nothing started',
    );

    assert.match(await env.createAgent({ name: 'drawn', icon: ICON }), /created agent "drawn"/);
    assert.equal(agent.runtime.agent('drawn').options.icon, ICON);
  } finally {
    await agent.stop();
  }
});

test('a reserved or malformed name is refused, but a bus node short name is allowed', async () => {
  const agent = await start(new Script({ text: 'hi' }));
  try {
    assert.match(await agent.runtime.spawnAgent('agent'), /"agent" is reserved/);
    assert.match(await agent.runtime.spawnAgent('history'), /"history" is reserved/);
    assert.match(
      await agent.runtime.spawnAgent('two words'),
      /letters, digits, "-" and "_"/,
      'a name is a bus-name segment: the topic it publishes on depends on it',
    );
    // A bus node may keep the short name: the sub-agent is addressed as `agent.echo`, so the two
    // calls never share an address.
    assert.match(await agent.runtime.spawnAgent('echo', ICON), /created agent "echo"/);
  } finally {
    await agent.stop();
  }
});

// A sub-agent manages its provider the same way the main agent does. It is handed a row when it is
// created - its own if one was named, the parent's current row otherwise - and from then on the
// choice is its own: stored under its own history prefix, kept across a restart, and unaffected by
// anything the parent (or a sibling) does later.
type ProviderListing = {
  active: string;
  providers: { name: string; active: boolean }[];
};

/** A bus with a provider node carrying two rows, and the script the main agent answers with. */
async function startWithProviders(
  script: Script,
  tenantId: string,
): Promise<{ net: FakeNet; agent: TestAgent }> {
  // A turn that runs through a bus row after a switch streams like any other: the id comes back
  // first and the answer arrives on its own topic. The holder is filled once the agent exists,
  // because the bus hands stream events to the node, not to a provider.
  const stream = { id: 'b'.repeat(32), publish: (_value: unknown) => undefined as void };
  const net = new FakeNet().withHistory();
  net.node('provider', 'the shared providers', {
    providers: () => ({
      providers: [{ name: 'fast' }, { name: 'deep' }, { name: 'mini' }],
      persistent: true,
    }),
    chat: (args: Record<string, unknown>) => ({
      message: { content: `answer from ${String(args.name)}` },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      previous_response_id: null,
    }),
    start_stream: () => ({ stream_id: stream.id, topic: `provider.stream.${stream.id}` }),
    stream_ready: () => {
      stream.publish({
        stream_id: stream.id,
        event: 'chunk',
        chunk: { delta: { content: 'bus' } },
      });
      stream.publish({
        stream_id: stream.id,
        event: 'chunk',
        chunk: {
          delta: {},
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });
      stream.publish({ stream_id: stream.id, event: 'done' });
      return { started: true };
    },
    cancel_stream: () => ({ canceled: true }),
  });
  const agent = await startAgent({ net, provider: script, tenantId });
  stream.publish = (value) => agent.runtime.handleEvent(`provider.stream.${stream.id}`, value);
  return { net, agent };
}

test('a sub-agent is handed the provider its parent is on, and keeps it when the parent moves', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { call: call('create_agent', { name: 'sibling', icon: ICON }) },
    { text: 'ready' },
  );
  const { net, agent } = await startWithProviders(script, TENANT);
  try {
    await agent.call('chat', { msg: { content: 'start two helpers' } }, 'alice');
    const helper = agent.runtime.agent('helper');
    const sibling = agent.runtime.agent('sibling');
    // The parent had settled on nothing, so its value was the first row: that is what it hands over.
    assert.equal(
      helper.options.providerName,
      'provider.fast',
      'a child is handed the row its parent was on',
    );
    assert.equal(sibling.options.providerName, 'provider.fast', 'and so is every sibling');

    const listed = (await agent.call(
      'provider',
      { action: 'list', agent: 'helper' },
      'alice',
    )) as ProviderListing;
    assert.equal(listed.active, 'provider.fast');

    // The parent moves on. The children were handed their row when they were created, so they stay.
    const main = (await agent.call(
      'provider',
      { action: 'select', name: 'provider.deep' },
      'alice',
    )) as ProviderListing;
    assert.equal(main.active, 'provider.deep');
    assert.equal(helper.options.providerName, 'provider.fast', 'a later switch does not reach it');
    assert.equal(sibling.options.providerName, 'provider.fast');

    // And the child may switch on its own, like any agent.
    const chosen = (await agent.call(
      'provider',
      { action: 'select', name: 'provider.mini', agent: 'helper' },
      'alice',
    )) as ProviderListing;
    assert.equal(chosen.active, 'provider.mini');
    assert.equal(helper.providerName, 'provider.mini', 'the sub-agent holds its own row');
    assert.equal(agent.runtime.providerName, 'provider.deep', 'the main agent keeps its own');
    assert.equal(sibling.providerName, null, 'and a sibling is not affected');

    // Stored where a restart looks for it: the sub-agent own unit, and the parent note on children.
    assert.deepEqual(
      net.unit('sub.helper.active_provider', TENANT),
      { name: 'provider.mini' },
      'the choice is filed under the sub-agent prefix',
    );
    const noted = net.unit('subagents', TENANT) as {
      agents: { name: string; provider?: string }[];
    };
    assert.equal(
      noted.agents.find((each) => each.name === 'helper')?.provider,
      'provider.mini',
      'and the parent records it with the sub-agent it belongs to',
    );
  } finally {
    await agent.stop();
  }
});

test('a sub-agent that chose a provider comes back on it, beside a main agent that changed its own', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
  );
  const first = await startWithProviders(script, TENANT);
  try {
    await first.agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    await first.agent.call('provider', { action: 'select', name: 'provider.deep' }, 'alice');
    await first.agent.call(
      'provider',
      { action: 'select', name: 'provider.fast', agent: 'helper' },
      'alice',
    );
  } finally {
    await first.agent.stop();
  }

  const second = await startAgent({ net: first.net, tenantId: TENANT });
  try {
    assert.equal(
      second.runtime.providerName,
      null,
      'the main agent reads its row on the first use',
    );
    const listed = (await second.call('provider', { action: 'list' })) as ProviderListing;
    assert.equal(listed.active, 'provider.deep', 'the main agent kept its own row');
    assert.equal(
      second.runtime.agent('helper').options.providerName,
      'provider.fast',
      'the sub-agent was restored with the row it chose',
    );
    const child = (await second.call('provider', {
      action: 'list',
      agent: 'helper',
    })) as ProviderListing;
    assert.equal(child.active, 'provider.fast');
  } finally {
    await second.stop();
  }
});

// The tab menu deletes through a capability, not through the model: `destroy_agent` is `agents`'
// other half, and the page calls it the way it calls the list. So the same delete the model can ask
// for is one an ordinary caller can ask for too, with the runtime - not the page - deciding what
// "gone" means: the agent is stopped, its units are deleted, its name leaves the family.
test('the destroy_agent capability deletes a sub-agent', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
    { text: 'the child speaking' },
  );
  const agent = await start(script);
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    await agent.call('chat', { agent: 'helper', msg: { content: 'say something' } }, 'alice');
    assert.ok(
      agent.net.unitIds(TENANT).some((unitId) => unitId.startsWith('sub.helper.')),
      'the sub-agent wrote units',
    );

    const answer = await agent.call('destroy_agent', { name: 'helper' }, 'alice');
    assert.match(String(answer), /destroyed agent "helper"/, 'the runtime says what it did');

    const rows = ((await agent.call('agents', {})) as { agents: { name: string }[] }).agents;
    assert.deepEqual(
      rows.map((row) => row.name),
      ['agent'],
      'the family is the main agent again',
    );
    assert.deepEqual(
      agent.net.unitIds(TENANT).filter((unitId) => unitId.startsWith('sub.helper.')),
      [],
      'and the units it wrote went with it',
    );
    assert.ok(
      agent.net.unitIds(TENANT).includes('conversation'),
      "the main agent's own transcript is untouched",
    );
    await assert.rejects(agent.call('status', { agent: 'helper' }), /no agent named "helper"/);
  } finally {
    await agent.stop();
  }
});

// What the capability will not do: the main agent is the node itself, and a name the family does not
// run is refused with the names it does. Neither is a delete the page may believe it made.
test('the destroy_agent capability refuses the main agent and unknown names', async () => {
  const script = new Script(
    { call: call('create_agent', { name: 'helper', icon: ICON }) },
    { text: 'ready' },
  );
  const agent = await start(script);
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');

    await assert.rejects(
      agent.call('destroy_agent', { name: 'agent' }),
      /the main agent cannot be destroyed/,
      'the node it is does not go away',
    );
    await assert.rejects(agent.call('destroy_agent', { name: '' }), /destroy_agent needs a/);
    const answer = await agent.call('destroy_agent', { name: 'nope' });
    assert.match(
      String(answer),
      /no agent named "nope" was created here \(running: helper\)/,
      'an unknown name answers with what is running',
    );

    const rows = ((await agent.call('agents', {})) as { agents: { name: string }[] }).agents;
    assert.deepEqual(
      rows.map((row) => row.name),
      ['agent', 'helper'],
      'and nothing was deleted by any of it',
    );
  } finally {
    await agent.stop();
  }
});

// A sub-agent with a provider of its own must read that provider's stream.
//
// Every runtime used to keep its own StreamHub, but the bus delivers an event to the *node*, and the
// node hands it to the main runtime's handleEvent. A child that dialled with its own row subscribed
// for itself, so unless the hub is shared across the family its queue was never filled and the turn
// ended in `provider stream stalled` after the idle timeout. A child now also copies its parent's
// row at creation, so this is the ordinary case, not an edge one.
test('a sub-agent reads the stream of the provider it was handed', async () => {
  const before = process.env.NODE_AGENT_STREAM_IDLE_MS;
  process.env.NODE_AGENT_STREAM_IDLE_MS = '300';
  const id = 'f'.repeat(32);
  const net = new FakeNet();
  let deliver: (value: unknown) => void = () => undefined;
  net.node('provider', 'the shared providers', {
    providers: () => ({ providers: [{ name: 'fast' }] }),
    chat: () => ({ message: { content: 'from chat' }, previous_response_id: null }),
    start_stream: () => ({ stream_id: id, topic: `provider.stream.${id}` }),
    stream_ready: () => {
      deliver({ stream_id: id, event: 'chunk', chunk: { delta: { content: 'from the child' } } });
      deliver({
        stream_id: id,
        event: 'chunk',
        chunk: { delta: {}, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      });
      deliver({ stream_id: id, event: 'done' });
      return { started: true };
    },
    cancel_stream: () => ({ canceled: true }),
  });
  const agent = await startAgent({ net });
  try {
    // The bus hands every event of this node to the main runtime, as `AgentNode.onEvent` does.
    deliver = (value) => agent.runtime.handleEvent(`provider.stream.${id}`, value);
    await agent.runtime.spawnAgent('kid', ICON);
    const kid = agent.runtime.agent('kid');
    assert.ok(kid !== null, 'the sub-agent exists');
    assert.equal(kid.options.providerName, 'provider.fast', 'it copied the row its parent was on');
    const said = await kid.chat({ content: 'hi' });
    assert.equal(
      said.at(-1)?.content,
      'from the child',
      'the child reads the delta its own provider published',
    );
  } finally {
    if (before === undefined) delete process.env.NODE_AGENT_STREAM_IDLE_MS;
    else process.env.NODE_AGENT_STREAM_IDLE_MS = before;
    await agent.stop();
  }
});

// Stop is one agent's button. Pressed on the main agent's page it cuts that agent's turn (or, with
// nothing running there, nothing at all) - it does not reach the sub-agents the family holds, whose
// turns are theirs: they were started from another page, they are followed on another topic, and the
// reader who stops one conversation has not asked to end the others.
test('Stop on the main agent leaves the sub-agents and their turns alone', async () => {
  const provider = new Held();
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, provider, tenantId: TENANT });
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');

    // The sub-agent's turn is running and stays open: the model is still writing it.
    const childTurn = agent.call(
      'chat_no_wait',
      { agent: 'helper', msg: { content: 'say something' } },
      'alice',
    );
    await until(
      async () =>
        ((await agent.call('status', { agent: 'helper' })) as { state: string }).state ===
        'generating',
    );

    // The main agent has nothing of its own to stop, so this is the whole answer.
    assert.equal(await agent.call('stop', {}), 'nothing to stop');

    assert.equal(
      ((await agent.call('status', { agent: 'helper' })) as { state: string }).state,
      'generating',
      'the sub-agent is still in the turn it was in',
    );

    // And its turn finishes the way it would have without the press.
    provider.release();
    await childTurn;
    const wrote = async (): Promise<boolean> =>
      ((await agent.call('history', { agent: 'helper' })) as HistoryWindow).messages.some((line) =>
        line.content?.includes('the child speaking'),
      );
    await until(wrote);
    assert.ok(await wrote(), 'the answer it was writing was committed');
  } finally {
    provider.release();
    await agent.stop();
  }
});

// The same press while the main agent is the one generating: its turn ends, and the sub-agent's turn
// keeps going - one Stop does not end the family.
test('Stop on the main agent cuts its own turn and not the sub-agents’', async () => {
  const provider = new Held();
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, provider, tenantId: TENANT });
  const state = async (name?: string): Promise<string> =>
    ((await agent.call('status', name === undefined ? {} : { agent: name })) as { state: string })
      .state;
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    const childTurn = agent.call(
      'chat_no_wait',
      { agent: 'helper', msg: { content: 'say something' } },
      'alice',
    );
    await until(async () => (await state('helper')) === 'generating');

    const mainTurn = agent.call('chat_no_wait', { msg: { content: 'keep talking' } }, 'alice');
    await until(async () => (await state()) === 'generating');

    // The press: the main agent's own turn is what it cuts.
    assert.equal(await agent.call('stop', {}), 'stopped');
    await until(async () => (await state()) !== 'generating');
    assert.equal(await state('helper'), 'generating', 'the sub-agent is still in its turn');

    // And its turn finishes normally.
    provider.release();
    await childTurn;
    await until(async () =>
      ((await agent.call('history', { agent: 'helper' })) as HistoryWindow).messages.some((line) =>
        line.content?.includes('the child speaking'),
      ),
    );
  } finally {
    provider.release();
    await agent.stop();
  }
});

// What a Stop does not do is throw away work the reader did not cut: a line queued behind the turn is
// a turn of its own, and it runs as it would have - the press ends the turn, it does not empty the
// queue.
test('a Stop cuts the turn and leaves the queued line to run', async () => {
  const provider = new Held();
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, provider, tenantId: TENANT });
  const status = async (): Promise<{ state: string; queued: unknown[] }> =>
    (await agent.call('status', {})) as { state: string; queued: unknown[] };
  const mainLines = async (): Promise<number> =>
    ((await agent.call('history', {})) as HistoryWindow).messages.filter((line) =>
      line.content?.includes('the main agent speaking'),
    ).length;
  try {
    await agent.call('chat', { msg: { content: 'start a helper' } }, 'alice');
    const running = agent.call('chat_no_wait', { msg: { content: 'keep talking' } }, 'alice');
    await until(async () => (await status()).state === 'generating');
    const queued = agent.call('chat_no_wait', { msg: { content: 'keep talking too' } }, 'alice');
    await running;
    await queued;
    await until(async () => (await status()).queued.length === 1);

    const before = agent.runtime;
    assert.equal(await agent.call('stop', {}), 'stopped');
    provider.release();

    await until(async () => (await mainLines()) === 2);
    assert.equal(agent.runtime, before, 'the runtime was not closed and dropped by the press');
    assert.equal(
      (await status()).queued.length,
      0,
      'the line behind it was taken by a turn of its own',
    );
  } finally {
    provider.release();
    await agent.stop();
  }
});
