import assert from 'node:assert/strict';
import { Node, NodeHost } from './dist/index.js';

let nextNode = 0;
const disposed = [];
const calls = [];
const published = [];
const events = [];
let eventHandler = null;
let inbound = null;
let sent = [];

class EchoNode extends Node {
  id = ++nextNode;

  handlers = {
    echo: async (args) => {
      const saved = await this.ctx.call('history', 'save', { text: args.text });
      this.ctx.publish('echo.done', { id: this.id });
      return { id: this.id, tenant: this.ctx.tenantId, saved };
    },
    fail: () => {
      throw new Error('boom');
    },
    slow: () => new Promise(() => {}),
    dotted: () => this.ctx.call('shell', 'files.read', {}),
    home: async () => ({ root: this.ctx.nodeAgentHome, home: this.ctx.home }),
    caps: async () => ({
      exposed: typeof this.ctx.listCapabilities,
      caps: await this.ctx.listCapabilities('agent'),
    }),
  };

  dispose() {
    disposed.push(this.id);
  }

  onEvent(topic, value, from) {
    events.push({ topic, value, from, tenant: this.ctx.tenantId, caller: this.ctx.from });
    this.ctx.publish('echo.event', { topic });
  }
}

const bus = {
  async connect(url, token) {
    assert.equal(url, 'ws://bus');
    assert.equal(token, 'token');
  },
  async close() {},
  async register(manifest) { calls.push(['register', manifest.name]); },
  async unregister(name) { calls.push(['unregister', name]); },
  onCall(handler) { inbound = handler; },
  onEvent(handler) { eventHandler = handler; },
  async subscribe(topic) { calls.push(['subscribe', topic]); },
  async listNodes() { return []; },
  async listCapabilities(node) {
    calls.push(['listCapabilities', node]);
    return [{ cap: 'status', parameters: { type: 'object' } }];
  },
  async reply(call, outcome) {
    sent.push({ from: 'echo', to: call.from, replyTo: call.id, payload: outcome });
  },
  async call(call) {
    assert.equal('from' in call, false);
    calls.push(['call', call.to, call.payload]);
    return {
      id: 'result-1',
      type: 'result',
      from: 'history',
      to: 'echo',
      replyTo: call.id,
      tenantId: call.tenantId,
      payload: { ok: true, value: { saved: 1 } },
    };
  },
  publish(event) {
    assert.equal('from' in event, false);
    published.push(event);
  },
};

const manifest = {
  packageId: 'pkg_test',
  name: 'echo',
  caps: {
    echo: { type: 'object' },
    fail: { type: 'object' },
    slow: { type: 'object' },
    dotted: { type: 'object' },
    caps: { type: 'object' },
    home: { type: 'object' },
  },
  desc: 'echo test node',
  version: '1.0.0',
  publisher: 'node-agent',
  icon: '<svg></svg>',
};

const host = new NodeHost({
  definition: { manifest, Node: EchoNode },
  bus,
});
await host.start('ws://bus', 'token');
assert.deepEqual(calls, [['register', 'echo']]);

process.env.NODE_AGENT_HOME = '/tmp/node-agent-sdk-home-test';

const ctx = {
  tenantId: 'tenant-a',
  deadline: Date.now() + 10_000,
  args: {},
};

const call = {
  id: 'call-1',
  type: 'call',
  from: 'agent',
  to: 'echo',
  tenantId: ctx.tenantId,
  deadline: ctx.deadline,
  payload: { cap: 'echo', args: { text: 'hi' } },
};

const result = await host.invoke(call);
assert.equal(result.ok, true);
assert.equal(result.value.saved.saved, 1);
assert.equal(result.value.tenant, 'tenant-a');
assert.deepEqual(disposed, [1]);
assert.deepEqual(calls.find((c) => c[0] === 'call'), [
  'call',
  'history',
  { cap: 'save', args: { text: 'hi' } },
]);
assert.equal(published.length, 1);

const failed = await host.invoke({ ...call, payload: { cap: 'fail', args: {} } });
assert.equal(failed.ok, false);
assert.equal(failed.error, 'boom');
assert.deepEqual(disposed, [1, 2]);

const unknown = await host.invoke({ ...call, payload: { cap: 'nope', args: {} } });
assert.equal(unknown.ok, false);
assert.match(unknown.error, /unknown capability/);

const dotted = await host.invoke({ ...call, payload: { cap: 'dotted', args: {} } });
assert.equal(dotted.ok, true);
assert.deepEqual(calls.at(-1), ['call', 'shell', { cap: 'files.read', args: {} }]);

// NodeContext exposes the bus directory's capability list when the session can answer it.
const caps = await host.invoke({ ...call, payload: { cap: 'caps', args: {} } });
assert.equal(caps.ok, true);
assert.equal(caps.value.exposed, 'function');
assert.deepEqual(caps.value.caps, [{ cap: 'status', parameters: { type: 'object' } }]);
assert.deepEqual(calls.at(-1), ['listCapabilities', 'agent']);

const timedOut = await host.invoke({
  ...call,
  deadline: Date.now() + 20,
  payload: { cap: 'slow', args: {} },
});
assert.equal(timedOut.ok, false);
assert.equal(timedOut.error, 'deadline exceeded');

// The bus delivers an inbound call and the host sends the result back.
await inbound(call);
assert.equal(sent.length, 1);
assert.equal(sent[0].payload.ok, true);


// An event gets a fresh Node and context, unlike a call that may have outlived its deadline.
await eventHandler({
  id: 'event-1',
  type: 'event',
  from: 'agent',
  to: '*',
  tenantId: 'tenant-a',
  payload: { topic: 'agent', value: { role: 'assistant' } },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(events, [
  { topic: 'agent', value: { role: 'assistant' }, from: 'agent', tenant: 'tenant-a', caller: 'agent' },
]);
assert.equal(published.at(-1)?.payload?.topic, 'echo.event');

const homeCall = {
  ...call,
  id: 'call-home',
  payload: { cap: 'home', args: {} },
};
assert.deepEqual((await host.invoke(homeCall)).value, {
  root: '/tmp/node-agent-sdk-home-test',
  home: '/tmp/node-agent-sdk-home-test/echo',
});

const pending = host.invoke({
  ...call,
  deadline: Date.now() + 10_000,
  payload: { cap: 'slow', args: {} },
});
await new Promise((resolve) => setTimeout(resolve, 0));
await host.stop();

const stopped = await pending;
assert.equal(stopped.ok, false);
assert.equal(stopped.error, 'host stopped');
assert.deepEqual(calls.at(-1), ['unregister', 'echo']);

console.log('host smoke ok');
