import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SCRIPT = readFileSync(new URL('../src/events-shared-worker.js', import.meta.url), 'utf8');
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test('worker serializes union updates, reconnects one source and lets an expired port recover pending ACKs', async () => {
  let clock = 0,
    hold = false,
    release!: () => void;
  const requests: any[] = [],
    sources: any[] = [],
    timers: any[] = [];
  const sandbox: any = {
    self: { location: { href: 'http://localhost/webui/events-shared-worker.js?tenant=alice' } },
    crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789012' },
    Date: { now: () => clock },
    URL,
    URLSearchParams,
    AbortSignal,
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    setTimeout: (run: () => void, ms: number) => {
      timers.push({ run, ms });
      return timers.length;
    },
    setInterval: (run: () => void, ms: number) => {
      timers.push({ run, ms, interval: true });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      if (timers[id - 1]) timers[id - 1].cancelled = true;
    },
    EventSource: class {
      closed = false;
      constructor(url: string, options: any) {
        sources.push(this);
        assert.equal(options.withCredentials, true);
        assert.equal(new URL(url, 'http://localhost').searchParams.get('tenant'), 'alice');
      }
      close() {
        this.closed = true;
      }
    },
    fetch: async (url: string, options: any) => {
      assert.equal(options.credentials, 'same-origin');
      if (url.startsWith('/events/identity'))
        return { ok: true, json: async () => ({ tenant: 'alice' }) };
      requests.push(JSON.parse(options.body));
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { ok: true };
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(SCRIPT, context);
  function port() {
    const received: any[] = [];
    const result: any = {
      received,
      postMessage: (message: any) => received.push(message),
      start() {},
      close() {},
    };
    sandbox.self.onconnect({ ports: [result] });
    return result;
  }
  function update(port: any, id: number, feeds: string[]) {
    port.onmessage({ data: { type: 'update', id, feeds } });
  }
  const first = port(),
    second = port();
  await settle();
  assert.equal(sources.length, 1);
  sources[0].onopen();
  await settle();
  hold = true;
  update(first, 1, ['a:x']);
  await settle();
  update(second, 2, ['b:y']);
  assert.equal(
    first.received.some((m: any) => m.type === 'ack' && m.id === 1),
    false,
  );
  hold = false;
  release();
  await settle();
  assert.deepEqual(requests.at(-1).feeds, ['a:x', 'b:y', 'bus:nodes']);
  assert.ok(first.received.some((m: any) => m.type === 'ack' && m.id === 1 && m.ok));
  assert.ok(second.received.some((m: any) => m.type === 'ack' && m.id === 2 && m.ok));
  first.onmessage({ data: { type: 'close' } });
  await settle();
  assert.equal(sources[0].closed, false);
  assert.deepEqual(requests.at(-1).feeds, ['b:y', 'bus:nodes']);
  sources[0].onmessage({ data: JSON.stringify({ node: 'b', topic: 'y', value: 'second only' }) });
  assert.ok(
    second.received.some(
      (m: any) => m.type === 'message' && JSON.parse(m.data).value === 'second only',
    ),
  );
  assert.equal(
    first.received.some((m: any) => m.type === 'message'),
    false,
  );
  sources[0].onerror();
  assert.equal(sources[0].closed, true);
  const reconnect = timers.find((t) => t.ms === 1000 && !t.cancelled)!;
  reconnect.run();
  assert.equal(sources.length, 2);
  sources[1].onopen();
  await settle();
  assert.equal(sources.filter((s) => !s.closed).length, 1);
  assert.equal(second.received.filter((m: any) => m.type === 'open').length, 2);
  const suspended = port();
  await settle();
  hold = true;
  update(suspended, 10, ['c:z']);
  await settle();
  clock = 181000;
  second.onmessage({ data: { type: 'ping' } });
  timers.find((t) => t.interval).run();
  assert.ok(
    suspended.received.some((m: any) => m.type === 'ack' && m.id === 10 && !m.ok),
    'expired tab update is rejected, not left waiting forever',
  );
  hold = false;
  release();
  await settle();
  suspended.onmessage({ data: { type: 'ping' } });
  update(suspended, 11, ['c:z']);
  await settle();
  assert.ok(suspended.received.some((m: any) => m.type === 'ack' && m.id === 11 && m.ok));
  assert.deepEqual(requests.at(-1).feeds, ['b:y', 'bus:nodes', 'c:z']);
  assert.equal(sources.filter((s) => !s.closed).length, 1);
  second.onmessage({ data: { type: 'close' } });
  suspended.onmessage({ data: { type: 'close' } });
  assert.equal(sources.filter((s) => !s.closed).length, 0);
});
