import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { LOCAL_PROVIDER_ID, localConfigPath, providerMode } from '../src/mode.ts';

// The id a provider process registers under is the whole of local mode on this side: the same
// package, the same capacities, a second address on the same bus.

test('a plain start registers under the package id', () => {
  assert.deepEqual(providerMode([], {}), { local: false, id: 'provider' });
  assert.deepEqual(providerMode(['--url', 'ws://127.0.0.1:8788'], {}), {
    local: false,
    id: 'provider',
  });
});

test('--local registers as local-provider', () => {
  assert.deepEqual(providerMode(['--local'], {}), { local: true, id: LOCAL_PROVIDER_ID });
  assert.deepEqual(providerMode(['--local', '--url', 'ws://x'], {}), {
    local: true,
    id: 'local-provider',
  });
});

test('NODE_AGENT_LOCAL=1 asks for the same thing without the flag', () => {
  assert.deepEqual(providerMode([], { NODE_AGENT_LOCAL: '1' }), {
    local: true,
    id: LOCAL_PROVIDER_ID,
  });
  assert.deepEqual(providerMode([], { NODE_AGENT_LOCAL: '0' }), { local: false, id: 'provider' });
});

test('local mode keeps its rows under the node-agent home', () => {
  assert.equal(localConfigPath('provider', {}, '/tmp/home'), null);
  assert.equal(
    localConfigPath(LOCAL_PROVIDER_ID, {}, '/tmp/home'),
    join('/tmp/home', 'local-provider.json'),
  );
  assert.equal(
    localConfigPath(
      LOCAL_PROVIDER_ID,
      { NODE_AGENT_PROVIDER_CONFIG: '/tmp/rows.json' },
      '/tmp/home',
    ),
    '/tmp/rows.json',
  );
});
