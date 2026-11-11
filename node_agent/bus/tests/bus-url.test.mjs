// Address helpers belong to the bus, not to a node client. A dial URL keeps its scheme, path and
// query; the bus never turns a wss:// address into a plain dial or an http(s) address into one at all.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { busAddress, busFromEnv, socketUrl } from '../dist/index.js';

test('busAddress keeps ws and wss addresses whole, path and query included', () => {
  assert.equal(busAddress('ws://127.0.0.1:8788/bus?x=1'), 'ws://127.0.0.1:8788/bus?x=1');
  assert.equal(busAddress('wss://bus.example/bus?tenant=t1'), 'wss://bus.example/bus?tenant=t1');
  assert.equal(busAddress('  ws://127.0.0.1:1  '), 'ws://127.0.0.1:1');
});

test('busAddress refuses schemes and addresses a WebSocket would refuse', () => {
  for (const bad of ['http://127.0.0.1:8788', 'https://bus.example', '127.0.0.1:8788', 'ws://']) {
    assert.equal(busAddress(bad), null, bad);
  }
});

test('socketUrl brackets a bare IPv6 host', () => {
  assert.equal(socketUrl('::1', 8788), 'ws://[::1]:8788');
  assert.equal(socketUrl('[::1]', 8788), 'ws://[::1]:8788');
  assert.equal(socketUrl('127.0.0.1', 8788), 'ws://127.0.0.1:8788');
});

test('busFromEnv takes the one URL variable and has a loopback fallback', () => {
  assert.equal(
    busFromEnv({ NODE_AGENT_BUS_URL: 'wss://bus.example/bus?tenant=t1' }),
    'wss://bus.example/bus?tenant=t1',
  );
  assert.equal(busFromEnv({}), 'ws://127.0.0.1:8788');
  assert.equal(busFromEnv({ NODE_AGENT_BUS_URL: 'not-a-url' }), 'ws://127.0.0.1:8788');
});
