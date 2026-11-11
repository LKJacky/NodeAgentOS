// The host's binding scope: the bus a bound object keeps after the invocation that made it has been
// answered. These are the tests that would fail if the runtime ever captured an invocation ctx.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatReply, Message, Provider, StreamEvent } from '../src/types.ts';
import { FakeNet, startAgent } from './harness.ts';
import { ScriptedProvider } from './scripted_model.ts';

/** A provider that answers only when the test opens its gate, so a turn spans invocations. */
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
    yield { type: 'content', text: '' };
    yield { type: 'end', previous_response_id: null };
  }
}

test('a bound object keeps calling and publishing after its invocation returned', async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const net = new FakeNet().node('echo', 'echoes', {
    say: async (args, call) => {
      await gate;
      return `${call.tenantId}: ${String(args.text)}`;
    },
  });
  const agent = await startAgent({ net, provider: new ScriptedProvider(), tenantId: 't1' });
  try {
    // The call that starts the turn is answered while the tool it asks for is still blocked.
    await agent.call('chat_no_wait', { msg: { content: 'go' } }, 'alice');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const calls = agent.session.calls.filter((call) => call.to === 'echo');
    assert.ok(calls.length > 0, 'the turn called a sibling after its invocation was answered');
    assert.ok(calls.every((call) => call.tenantId === 't1'));

    open();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The transcript was published through the same scope, after that call had returned.
    assert.ok(net.events.length > 0);
    assert.ok(net.events.every((event) => event.tenantId === 't1'));
  } finally {
    open();
    await agent.stop();
  }
});

test('two tenants hold different scopes over the same host', async () => {
  const agent = await startAgent({
    net: new FakeNet().withHistory(),
    tenantId: 't1',
    tenants: ['t2'],
    providers: { t1: new ScriptedProvider(), t2: new ScriptedProvider() },
  });
  try {
    await agent.call('status', {}, 'bob', 't2');
    const first = agent.runtimeOf('t1').scope;
    const second = agent.runtimeOf('t2').scope;
    assert.notEqual(first, second, 'one scope per tenant, never shared');
    assert.equal(first.tenantId, 't1');
    assert.equal(second.tenantId, 't2');
    assert.equal(first.nodeId, 'agent');
  } finally {
    await agent.stop();
  }
});

test('a poisoned invocation context leaves the bound object working', async () => {
  const net = new FakeNet().node('echo', 'echoes', { say: (args) => `echo ${String(args.text)}` });
  const agent = await startAgent({ net, provider: new ScriptedProvider(), tenantId: 't1' });
  try {
    // The context the first invocation saw, now unusable: a bound object that had kept it would
    // fail on its next call or publish.
    const ctx = agent.contextOf('t1');
    const stale = (): never => {
      throw new Error('stale invocation context');
    };
    Object.assign(ctx, { call: stale, publish: stale, bind: stale, signal: AbortSignal.abort() });

    const answer = (await agent.call('chat', { msg: { content: 'still here' } })) as Message[];
    assert.equal(answer.at(-1)?.role, 'assistant');
    assert.ok(agent.session.calls.some((call) => call.to === 'echo'));
    assert.ok(net.events.length > 0);
  } finally {
    await agent.stop();
  }
});

test('nothing on the runtime is an invocation context', async () => {
  const agent = await startAgent({
    net: new FakeNet(),
    provider: new ScriptedProvider(),
    tenantId: 't1',
  });
  try {
    const runtime = agent.runtime;
    assert.ok(!('ctx' in runtime), 'no ctx field');
    assert.ok(!('signal' in runtime), 'no signal field');
    assert.ok(!('tenantId' in runtime), 'identity lives on the scope');
    assert.ok(!('nodeId' in runtime), 'identity lives on the scope');
    assert.equal(runtime.identity.topic, 'agent');
  } finally {
    await agent.stop();
  }
});
