import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocketBusSession } from './dist/index.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, test) => {
  for (let i = 0; i < 200; i += 1) {
    if (test()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  sent = [];
  dropped = false;

  constructor(url) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    }, 0);
  }

  send(text) {
    const frame = JSON.parse(String(text));
    this.sent.push({ text: String(text), frame });
    if (frame.op === 'part') return;
    if (['register', 'subscribe', 'unsubscribe', 'call'].includes(frame.type)) {
      const value = frame.type === 'call' ? { reconnected: true } : undefined;
      this.answer(frame.id, { ok: true, value });
    }
  }

  answer(replyTo, payload) {
    this.receive({
      id: randomUUID(),
      type: 'result',
      to: 'test',
      replyTo,
      tenantId: '*',
      payload,
    });
  }

  receive(frame) {
    const event = Object.assign(new Event('message'), { data: JSON.stringify(frame) });
    setTimeout(() => this.dispatchEvent(event), 0);
  }

  close() {
    this.drop();
  }

  drop() {
    if (this.dropped) return;
    this.dropped = true;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

const manifest = {
  name: 'sdk-websocket-test',
  caps: { ping: { type: 'object' } },
  desc: 'native websocket test node',
  version: '0.1.0',
  publisher: 'node-agent',
  icon: '<svg></svg>',
};

const session = new WebSocketBusSession({
  WebSocket: FakeSocket,
  autoReconnect: true,
  reconnectDelayMs: 5,
  reconnectMaxDelayMs: 20,
  registerTimeoutMs: 200,
});
await session.connect('ws://fake/bus', 'secret');
await session.register(manifest);
await session.subscribe('news', 't1', 'sdk-websocket-test');
const first = FakeSocket.instances[0];
const registration = first.sent.find(({ frame }) => frame.type === 'register').frame;
assert.equal(registration.payload.chunks, true);

const received = [];
session.onEvent((event) => received.push(event.payload.value));
const incoming = JSON.stringify({
  id: randomUUID(),
  type: 'event',
  to: 'sdk-websocket-test',
  tenantId: 't1',
  payload: { topic: 'news', value: { chunked: true } },
});
const transfer = randomUUID();
const split = Math.floor(incoming.length / 2);
first.receive({ op: 'part', id: transfer, seq: 0, value: incoming.slice(0, split), last: false });
first.receive({ op: 'part', id: transfer, seq: 1, value: incoming.slice(split), last: true });
await until('chunked inbound event', () => received.length === 1);
assert.deepEqual(received[0], { chunked: true });

session.publish({
  id: randomUUID(),
  type: 'event',
  to: 'sink',
  tenantId: 't1',
  payload: { topic: 'large', value: 'x'.repeat((1 << 20) + 10_000) },
});
const outboundParts = first.sent.filter(({ frame }) => frame.op === 'part');
assert.ok(outboundParts.length > 1);
assert.ok(outboundParts.every(({ text }) => Buffer.byteLength(text, 'utf8') <= 1 << 20));

first.drop();
await until('reconnect', () => FakeSocket.instances.length === 2);
const second = FakeSocket.instances[1];
await until('re-registration', () => second.sent.some(({ frame }) => frame.type === 'register'));
await until('re-subscribe', () => second.sent.some(({ frame }) => frame.type === 'subscribe'));
const result = await session.call({
  id: randomUUID(),
  type: 'call',
  to: 'echo',
  tenantId: 't1',
  deadline: Date.now() + 500,
  payload: { cap: 'ping', args: {} },
});
assert.deepEqual(result.payload.value, { reconnected: true });

await session.close();
await wait(40);
assert.equal(FakeSocket.instances.length, 2);
console.log('websocket bus session ok');
