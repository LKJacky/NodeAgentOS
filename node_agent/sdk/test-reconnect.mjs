import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LegacyBusSession } from './dist/index.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, test) => {
  for (let i = 0; i < 200; i += 1) {
    if (test()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A socket the test can open, answer on, and drop, without a bus. It speaks the legacy NDJSON wire
 *  just enough for the session's handshake, subscribe and call paths. */
class FakeSocket extends EventTarget {
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
      this.readyState = 1; // WebSocket.OPEN
      this.dispatchEvent(new Event('open'));
    }, 0);
  }

  send(text) {
    const frame = JSON.parse(String(text).trim());
    this.sent.push(frame);
    if (frame.op === 'subscribe') this.#answer(frame.id, { ok: true });
    else if (frame.op === undefined) this.#answer(frame.id, { ok: true });
    else if (frame.op === 'call') this.#answer(frame.id, { ok: true, value: { reconnected: true } });
  }

  close() {
    this.#drop();
  }

  drop() {
    this.#drop();
  }

  #answer(id, value) {
    const event = Object.assign(new Event('message'), {
      data: JSON.stringify({ id, ...value }),
    });
    setTimeout(() => this.dispatchEvent(event), 0);
  }

  #drop() {
    if (this.dropped) return;
    this.dropped = true;
    this.readyState = 3; // WebSocket.CLOSED
    this.dispatchEvent(new Event('close'));
  }
}

const manifest = {
  name: 'sdk-reconnect-test',
  caps: { ping: { type: 'object' } },
  desc: 'reconnect test node',
  version: '0.1.0',
  publisher: 'node-agent',
  icon: '<svg></svg>',
};

const session = new LegacyBusSession({
  WebSocket: FakeSocket,
  autoReconnect: true,
  reconnectDelayMs: 5,
  reconnectMaxDelayMs: 20,
  registerTimeoutMs: 200,
});
await session.connect('ws://fake/bus', 'secret');
await session.register(manifest);
await session.subscribe('news');
assert.equal(FakeSocket.instances.length, 1);
assert.equal(FakeSocket.instances[0].sent.filter((frame) => frame.op === 'subscribe').length, 1);

// The first connection goes away: the session must dial again, register the same manifest, and ask
// for the topic again before a caller can use it.
FakeSocket.instances[0].drop();
await until('the reconnect', () => FakeSocket.instances.length === 2);
const second = FakeSocket.instances[1];
await until('the re-registration', () => second.sent.some((frame) => frame.op === undefined));
await until('the re-subscribe', () => second.sent.some((frame) => frame.op === 'subscribe'));

const result = await session.call({
  id: randomUUID(),
  type: 'call',
  to: 'echo',
  tenantId: 't1',
  deadline: Date.now() + 500,
  payload: { cap: 'ping', args: {} },
});
assert.deepEqual(result.payload, { ok: true, value: { reconnected: true } });

// close() is deliberate: the next close event must not schedule a third dial.
await session.close();
await wait(40);
assert.equal(FakeSocket.instances.length, 2);
console.log('legacy reconnect ok');
