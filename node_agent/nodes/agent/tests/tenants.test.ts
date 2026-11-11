// Two tenants on one bus, one node id: `ctx.bind` keeps one runtime per tenant, and no transcript,
// queue, cache, hub or context bus crosses over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NodeContext } from '@node-agent/sdk';
import { AgentNode, RUNTIME_BINDING, runtimeFor } from '../src/agent.ts';
import { AgentRuntime } from '../src/runtime.ts';
import { ScriptedProvider } from './scripted_model.ts';
import type { ChatReply, Message, Provider, StreamEvent } from '../src/types.ts';
import { FakeNet, startAgent } from './harness.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A provider that answers only when the test opens its gate. */
class GatedProvider implements Provider {
  release!: () => void;
  readonly #gate: Promise<void>;

  constructor() {
    this.#gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async chat(): Promise<ChatReply> {
    return { content: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    await this.#gate;
    yield { type: 'content', text: 't1 answer' };
    yield { type: 'end', previous_response_id: null };
  }
}

/** A provider that answers prose at once, so a turn needs no tools. */
class ProseProvider implements Provider {
  readonly #answer: string;

  constructor(answer: string) {
    this.#answer = answer;
  }

  async chat(): Promise<ChatReply> {
    return { content: '', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    yield { type: 'content', text: this.#answer };
    yield { type: 'end', previous_response_id: null };
  }
}

/** A host-like set of contexts: `bind` keeps one object per tenant and key, exactly the SDK rule. */
function scopeOf(tenantId: string): BindingScope {
  return {
    tenantId,
    nodeId: 'agent',
    call: async <T>(): Promise<T> => undefined as T,
    publish: () => undefined,
    subscribe: async () => undefined,
    listNodes: async () => [],
    listCapabilities: async () => [],
    fetch,
  };
}

function hostContexts(): {
  context: (tenantId: string, from?: string) => NodeContext;
  opened: AgentRuntime[];
  closeAll: () => Promise<void>;
} {
  const tables = new Map<string, Map<string, object>>();
  const opened: AgentRuntime[] = [];
  const context = (tenantId: string, from = 'caller'): NodeContext => ({
    tenantId,
    from,
    nodeId: 'agent',
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    call: async <T>(): Promise<T> => undefined as T,
    listNodes: async () => [],
    listCapabilities: async () => [],
    subscribe: async () => undefined,
    publish: () => undefined,
    fetch,
    bind<T extends object>(key: string, create: (scope: BindingScope) => T): T {
      let table = tables.get(tenantId);
      if (table === undefined) {
        table = new Map();
        tables.set(tenantId, table);
      }
      const found = table.get(key) as T | undefined;
      if (found !== undefined) return found;
      const made = create(scopeOf(tenantId));
      table.set(key, made);
      opened.push(made as AgentRuntime);
      return made;
    },
    unbind(key: string): boolean {
      return tables.get(tenantId)?.delete(key) ?? false;
    },
  });
  return {
    context,
    opened,
    closeAll: async () => {
      for (const runtime of opened.splice(0)) await runtime.close();
      tables.clear();
    },
  };
}

test('bind gives one runtime per tenant, and unbind makes the next call build a new one', async () => {
  const host = hostContexts();
  const t1 = host.context('t1');
  const first = runtimeFor(t1, { provider: new ProseProvider('one') });
  const again = runtimeFor(host.context('t1'));
  assert.equal(again, first, 'the same tenant keeps the same runtime');

  const other = runtimeFor(host.context('t2'), { provider: new ProseProvider('two') });
  assert.notEqual(other, first, 'another tenant gets its own runtime');

  // `agent.stop` closes the object and then drops it; the next call builds a fresh runtime.
  await first.close();
  assert.equal(t1.unbind?.(RUNTIME_BINDING), true);
  const rebuilt = runtimeFor(t1, { provider: new ProseProvider('one') });
  assert.notEqual(rebuilt, first, 'an unbound runtime is not handed out again');
  assert.equal(await t1.unbind?.(RUNTIME_BINDING), true);
  await host.closeAll();
});

test('a runtime takes its name from the scope, and an empty one is refused', () => {
  const empty = { ...scopeOf('t1'), nodeId: '' };
  assert.throws(() => new AgentRuntime({ scope: empty }), /has no identity/);
});

test('two tenants on one host keep transcripts, tools, cache, queue and streams apart', async () => {
  const net = new FakeNet().withHistory().node('echo', 'echoes', {
    say: (args, call) => `${call.tenantId}: ${String(args.text)}`,
  });
  const gated = new GatedProvider();
  const agent = await startAgent({
    net,
    tenantId: 't1',
    tenants: ['t2'],
    providers: { t1: gated, t2: new ScriptedProvider() },
  });
  try {
    await agent.call('chat_no_wait', { msg: { content: 't1 first' } }, 'alice', 't1');
    await sleep(20);
    assert.equal(
      ((await agent.call('status', {}, 'alice', 't1')) as { state: string }).state,
      'generating',
    );

    // The second tenant is idle and can take a turn while the first one is still running.
    const idle = (await agent.call('status', {}, 'bob', 't2')) as {
      state: string;
      queued: unknown[];
    };
    assert.equal(idle.state, 'idle');
    assert.deepEqual(idle.queued, []);
    const t2lines = (await agent.call(
      'chat',
      { msg: { content: 't2 hello' } },
      'bob',
      't2',
    )) as Message[];
    assert.match(String(t2lines.at(-1)?.content), /^done:\nt2: FROM: bob, TIME: /);

    // One runtime per tenant, and no object inside them is shared.
    const t1 = agent.runtimeOf('t1');
    const t2 = agent.runtimeOf('t2');
    assert.notEqual(t1, t2);
    assert.notEqual(t1.cache, t2.cache);
    assert.notEqual(t1.hub, t2.hub);
    assert.notEqual(t1.env, t2.env);
    const id = await t1.cache.add('the secret of t1');
    assert.equal(await t2.cache.read(id), null);

    // Each transcript holds only its own lines.
    const t1history = (await agent.call('history', {}, 'alice', 't1')) as { messages: Message[] };
    const t2history = (await agent.call('history', {}, 'bob', 't2')) as { messages: Message[] };
    assert.ok(t1history.messages.every((line) => !String(line.content).includes('t2 hello')));
    assert.ok(t2history.messages.every((line) => !String(line.content).includes('t1 first')));
    assert.ok(t2history.messages.some((line) => String(line.content).includes('t2 hello')));

    // History and publication carry the tenant that wrote them.
    assert.ok(net.unit('conversation', 't1') !== undefined);
    assert.ok(net.unit('conversation', 't2') !== undefined);
    assert.ok(net.events.some((event) => event.tenantId === 't1'));
    assert.ok(net.events.some((event) => event.tenantId === 't2'));

    // The tool call of the t2 turn went out under t2, never under the first tenant.
    const toolCalls = agent.session.calls.filter((call) => call.to === 'echo');
    assert.ok(toolCalls.length > 0);
    assert.ok(toolCalls.every((call) => call.tenantId === 't2'));

    // Release the first tenant's turn; it finishes in its own transcript.
    gated.release();
    await sleep(80);
    const finished = (await agent.call('history', {}, 'alice', 't1')) as { messages: Message[] };
    assert.equal(finished.messages.at(-1)?.content, 't1 answer');
  } finally {
    gated.release();
    await agent.stop();
  }
});

/** One Node instance reused across two tenants: each handler follows the context it is handed. */
test('a reused AgentNode answers each invocation through that invocation tenant runtime', async () => {
  const host = hostContexts();
  class TenantNode extends AgentNode {
    constructor(ctx: NodeContext) {
      super(ctx, {
        provider: new ProseProvider(ctx.tenantId === 't1' ? 'answer one' : 'answer two'),
      });
    }
  }

  const node = new TenantNode(host.context('t1', 'alice'));
  try {
    const first = (await node.handlers.chat({ msg: { content: 'one' } })) as Message[];
    assert.equal(first.at(-1)?.content, 'answer one');
    const t1runtime = node.runtime;

    // The second tenant's runtime, as its own first call would have made it.
    const t2ctx = host.context('t2', 'bob');
    const t2runtime = runtimeFor(t2ctx, { provider: new ProseProvider('answer two') });

    // A stateful host hands the same instance a newer context instead of a new node.
    (node as unknown as { ctx: NodeContext }).ctx = t2ctx;
    const second = (await node.handlers.chat({ msg: { content: 'two' } })) as Message[];
    assert.equal(second.at(-1)?.content, 'answer two');
    assert.equal(node.runtime, t2runtime, 'the second tenant got its own runtime');

    const t1lines = t1runtime.model?.messages.absoluteSlice(0, 999) ?? [];
    const t2lines = node.runtime.model?.messages.absoluteSlice(0, 999) ?? [];
    assert.ok(t1lines.every((line) => !String(line.content).includes('two')));
    assert.ok(t2lines.every((line) => !String(line.content).includes('one')));
  } finally {
    await host.closeAll();
  }
});
