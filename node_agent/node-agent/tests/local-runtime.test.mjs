import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeError, RuntimeServer } from '@node-agent/runtime';
import { LocalRuntime } from '../dist/local.js';

test('user and node names are refused before a process starts', async () => {
  const runtime = new LocalRuntime({ home: join(tmpdir(), 'never-used') });
  await assert.rejects(runtime.stopNode('Web UI'), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'invalid_node');
    return true;
  });
  await assert.rejects(runtime.disconnect('alice', 'Web UI'), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'invalid_node');
    return true;
  });
});

test('connect starts a bus and a shared node; disconnect keeps the node', async () => {
  const home = await mkdtemp(join(tmpdir(), 'node-agent-runtime-'));
  const runtime = new LocalRuntime({ home });
  let bus;
  try {
    bus = await runtime.launchBus();
    assert.equal(bus.state, 'running');
    assert.match(bus.url, /^ws:\/\/127\.0\.0\.1:\d+$/);

    const node = await runtime.connect('alice', 'webui', {
      env: { NODE_AGENT_WEBUI_PORT: '0' },
    });
    assert.equal(node.name, 'webui');
    assert.equal(node.state, 'running');
    assert.equal(node.pid, process.pid, 'default isolation is a worker in this process');
    await runtime.disconnect('alice', 'webui');
    assert.equal(node.state, 'running', 'disconnect leaves the shared node up');
    assert.equal(bus.state, 'running', 'disconnect leaves the user bus up');
    await runtime.stopBus();
    assert.equal(bus.state, 'stopped');
  } finally {
    await runtime.stopAll();
    await rm(home, { recursive: true, force: true });
  }
});


test('a generated bus token survives a restart, so a user keeps one history partition', async () => {
  const home = await mkdtemp(join(tmpdir(), 'node-agent-runtime-token-'));
  const first = new LocalRuntime({ home });
  let token;
  let user;
  try {
    const bus = await first.launchBus();
    token = bus.token;
    user = first.busUser('default');
  } finally {
    await first.stopAll();
  }

  const second = new LocalRuntime({ home });
  try {
    const bus = await second.launchBus();
    assert.equal(bus.token, token, 'the generated token was not reused');
    assert.equal(second.busUser('default'), user, 'the user identity moved with the token');
  } finally {
    await second.stopAll();
    await rm(home, { recursive: true, force: true });
  }
});


test('rotating NODE_AGENT_TOKEN keeps every user in the same history partition', async () => {
  const home = await mkdtemp(join(tmpdir(), 'node-agent-runtime-salt-'));
  const first = new LocalRuntime({ home, token: 'first-bus-token' });
  let user;
  try {
    const bus = await first.launchBus();
    assert.equal(bus.token, 'first-bus-token');
    user = first.busUser('default');
  } finally {
    await first.stopAll();
  }

  const second = new LocalRuntime({ home, token: 'second-bus-token' });
  try {
    const bus = await second.launchBus();
    assert.equal(bus.token, 'second-bus-token');
    assert.equal(second.busUser('default'), user, 'the history partition moved with the token');
  } finally {
    await second.stopAll();
    await rm(home, { recursive: true, force: true });
  }
});


test('concurrent users share one launch instead of racing the same node name', async () => {
  const home = await mkdtemp(join(tmpdir(), 'node-agent-runtime-race-'));
  const runtime = new LocalRuntime({ home });
  try {
    const [alice, bob] = await Promise.all([
      runtime.connect('alice', 'webui', { env: { NODE_AGENT_WEBUI_PORT: '0' } }),
      runtime.connect('bob', 'webui', { env: { NODE_AGENT_WEBUI_PORT: '0' } }),
    ]);
    assert.equal(alice.pid, bob.pid);
    assert.equal(alice.name, 'webui');
    assert.equal(bob.name, 'webui');
  } finally {
    await runtime.stopAll();
    await rm(home, { recursive: true, force: true });
  }
});


test('runtime API authenticates and forwards connect/disconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'node-agent-runtime-api-'));
  const runtime = new LocalRuntime({ home });
  const server = new RuntimeServer({ runtime, token: 'service-token' });
  try {
    const address = await server.start();
    const health = await fetch(`${address.url}/healthz`);
    assert.equal(health.status, 200);

    const denied = await fetch(`${address.url}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'alice', node: 'webui' }),
    });
    assert.equal(denied.status, 401);

    const connected = await fetch(`${address.url}/connect`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        user: 'alice',
        node: 'webui',
        options: { env: { NODE_AGENT_WEBUI_PORT: '0' } },
      }),
    });
    assert.equal(connected.status, 200);
    assert.equal((await connected.json()).name, 'webui');

    const disconnected = await fetch(`${address.url}/disconnect`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ user: 'alice', node: 'webui' }),
    });
    assert.equal(disconnected.status, 200);

    const stopped = await fetch(`${address.url}/agents/stop`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ user: 'alice' }),
    });
    assert.equal(stopped.status, 200);

    const created = await fetch(`${address.url}/create_user`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ user: 'bob' }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.user, 'bob');

    const destroyed = await fetch(`${address.url}/destroy_user`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ user: 'bob' }),
    });
    assert.equal(destroyed.status, 200);
  } finally {
    await server.stop();
    await runtime.stopAll();
    await rm(home, { recursive: true, force: true });
  }
});


test('createUser makes a home and destroyUser removes it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'node-agent-runtime-user-'));
  const runtime = new LocalRuntime({ home });
  try {
    const user = await runtime.createUser('bob');
    assert.equal(user.state, 'ready');
    assert.ok(existsSync(user.home));
    await runtime.destroyUser('bob');
    assert.equal(existsSync(user.home), false);
  } finally {
    await runtime.stopAll();
    await rm(home, { recursive: true, force: true });
  }
});
