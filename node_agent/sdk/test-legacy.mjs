// The adapter for the bus that predates envelopes: `LegacyBusSession`. Its wire is the older one, so
// the bus it is tested against is the older one too (test-legacy-bus.mjs); the real bus speaks
// envelopes, and is covered by the other suites here and by bus/tests.
//
// What this pins down is that a node hosted over the adapter still works as a node: it registers,
// answers a call, appears in the directory, and receives the events it subscribed to.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LegacyBusSession, Node, NodeHost } from './dist/index.js';
import { LegacyBus } from './test-legacy-bus.mjs';

class Echo extends Node {
  handlers = { ping: () => ({ pong: true }) };
}

const manifest = (name, caps) => ({
  packageId: `test-${name}`,
  name,
  caps,
  desc: `${name} test node`,
  version: '0.1.0',
  publisher: 'node-agent',
  icon: '<svg></svg>',
});

const bus = new LegacyBus('secret');
const server = new NodeHost({
  definition: { manifest: manifest('echo', { ping: { type: 'object' } }), Node: Echo },
  bus: new LegacyBusSession({ WebSocket: bus.WebSocket, tenantId: 't1', registerTimeoutMs: 2000 }),
});
await server.start(bus.url, 'secret');

const client = new LegacyBusSession({
  WebSocket: bus.WebSocket,
  tenantId: 't1',
  registerTimeoutMs: 2000,
});
await client.connect(bus.url, 'secret');
await client.register(manifest('caller', {}));

const result = await client.call({
  id: randomUUID(),
  type: 'call',
  to: 'echo',
  tenantId: 't1',
  deadline: Date.now() + 2000,
  payload: { cap: 'ping', args: {} },
});
assert.deepEqual(result.payload, { ok: true, value: { pong: true } });

// A zero-capability node is not part of the legacy directory: the old wire lists tools, not names.
const nodes = await client.listNodes();
assert.deepEqual(nodes.map((node) => node.name), ['echo']);
const caps = await client.listCapabilities('echo');
assert.deepEqual(caps.map((cap) => cap.cap), ['ping']);

let event = null;
client.onEvent((value) => {
  event = value;
});
await client.subscribe('smoke');
client.publish({
  id: randomUUID(),
  type: 'event',
  to: '*',
  tenantId: 't1',
  payload: { topic: 'smoke', value: 42 },
});
for (let i = 0; i < 20 && event === null; i += 1)
  await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(event?.payload, { node: 'caller', topic: 'smoke', value: 42 });

await client.close();
await server.stop();
bus.close();
console.log('legacy session ok');
