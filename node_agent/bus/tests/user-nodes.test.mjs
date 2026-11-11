// The bus keeps one table from a user to the nodes that belong to them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus, privateNodeToken } from '../dist/index.js';

const TOKEN = 'test-token';
/** The runtime supervisor's credential: the only connection allowed to change a user table. */
const CONTROL = 'control-token';
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

const MANIFEST = (name) => ({
  packageId: name,
  name,
  caps: { ping: { type: 'object', properties: {} } },
  desc: `${name} desc`,
  version: '1.0.0',
  publisher: 'tester',
  icon: '<svg/>',
});

const nodesOf = (bus, user) => [...(bus.users.get(user)?.nodes ?? [])].sort();

function open(url) {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => ok(ws), { once: true });
    ws.addEventListener('error', () => bad(new Error('websocket failed')), { once: true });
  });
}

function next(ws) {
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error('no frame')), 2_000);
    ws.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        ok(JSON.parse(event.data));
      },
      { once: true },
    );
  });
}

async function register(t, bus, name) {
  const ws = await open(`${bus.url}?token=${encodeURIComponent(TOKEN)}`);
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      id: `reg-${name}`,
      type: 'register',
      from: 'ignored',
      to: name,
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload: { manifest: MANIFEST(name) },
    }),
  );
  const answer = await next(ws);
  assert.equal(answer.payload.ok, true);
  return ws;
}

async function ask(ws, type, payload) {
  const id = `${type}-${Math.random()}`;
  ws.send(
    JSON.stringify({
      id,
      type,
      from: 'webui',
      to: 'bus',
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload,
    }),
  );
  return await next(ws);
}

/** The runtime supervisor's own connection: the control token, and no node of its own. */
async function control(t, bus) {
  const ws = await open(`${bus.url}?token=${encodeURIComponent(CONTROL)}`);
  t.after(() => ws.close());
  return ws;
}

async function askControl(ws, type, payload) {
  const id = `${type}-${Math.random()}`;
  ws.send(
    JSON.stringify({
      id,
      type,
      from: 'runtime-control',
      to: 'bus',
      tenantId: '*',
      deadline: Date.now() + 5_000,
      payload,
    }),
  );
  return await next(ws);
}

test('a user table follows register, unregister and disconnect', async (t) => {
  const bus = await new Bus(TOKEN, CONTROL).listen(0);
  t.after(() => bus.close());

  const webui = await register(t, bus, 'webui');
  await register(t, bus, 'provider');
  assert.equal(bus.users.size, 0, 'register creates no user space');
  assert.deepEqual(nodesOf(bus, ALICE), []);
  const alice = bus.user(ALICE, true);
  alice.connect('webui');
  alice.connect('provider');
  assert.deepEqual(nodesOf(bus, ALICE), ['provider', 'webui']);

  webui.send(
    JSON.stringify({
      id: 'unreg-webui',
      type: 'unregister',
      from: 'webui',
      to: 'bus',
      tenantId: 'ghost',
      payload: { name: 'webui' },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(nodesOf(bus, ALICE), ['provider']);
  assert.equal(bus.users.has('ghost'), false, 'unregister creates no user space');

  webui.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(nodesOf(bus, ALICE), ['provider'], 'a closed registration stays gone');
});

test('the control connection creates a user and connects a shared node to it', async (t) => {
  const bus = await new Bus(TOKEN, CONTROL).listen(0);
  t.after(() => bus.close());
  await register(t, bus, 'webui');
  const ctl = await control(t, bus);

  assert.deepEqual(nodesOf(bus, ALICE), [], 'registration does not connect a user');

  const created = await askControl(ctl, 'create_user', { user: ALICE });
  assert.equal(created.payload.ok, true);
  assert.deepEqual(created.payload.value.nodes, []);

  const connected = await askControl(ctl, 'connect', { user: ALICE, node: 'webui' });
  assert.equal(connected.payload.ok, true);
  assert.deepEqual(nodesOf(bus, ALICE), ['webui']);

  const bob = await askControl(ctl, 'create_user', { user: BOB });
  assert.equal(bob.payload.ok, true);
  assert.deepEqual(bob.payload.value.nodes, []);

  const both = await askControl(ctl, 'connect', { user: BOB, node: 'webui' });
  assert.equal(both.payload.ok, true);
  assert.deepEqual(nodesOf(bus, BOB), ['webui']);
  assert.deepEqual(nodesOf(bus, ALICE), ['webui'], 'the node is shared, not moved');

  const disconnected = await askControl(ctl, 'disconnect', { user: BOB, node: 'webui' });
  assert.equal(disconnected.payload.ok, true);
  assert.deepEqual(nodesOf(bus, BOB), []);
  assert.equal(bus.envelopeNodes.has('webui'), true, 'disconnect leaves the node registered');

  const destroyed = await askControl(ctl, 'destroy_user', { user: BOB });
  assert.equal(destroyed.payload.ok, true);
  assert.equal(bus.users.has(BOB), false);
  assert.deepEqual(nodesOf(bus, ALICE), ['webui']);
});

test('a shared node cannot change a user table', async (t) => {
  const bus = await new Bus(TOKEN, CONTROL).listen(0);
  t.after(() => bus.close());
  const ws = await register(t, bus, 'webui');
  const ctl = await control(t, bus);
  await askControl(ctl, 'create_user', { user: ALICE });

  const refused = [
    ['create_user', { user: BOB }],
    ['connect', { user: ALICE, node: 'webui' }],
    ['disconnect', { user: ALICE, node: 'webui' }],
    ['destroy_user', { user: ALICE }],
  ];
  for (const [type, payload] of refused) {
    const answer = await ask(ws, type, payload);
    assert.equal(answer.payload.ok, false, `${type} from a shared node is refused`);
    assert.match(answer.payload.error, /control connection/);
  }

  assert.equal(bus.users.has(BOB), false, 'the refused create_user made no user');
  assert.deepEqual(nodesOf(bus, ALICE), [], 'the refused connect changed no table');
  assert.equal(bus.users.has(ALICE), true, 'the refused destroy_user removed nobody');
});

test('a display-name user id is refused by the bus', async (t) => {
  const bus = await new Bus(TOKEN, CONTROL).listen(0);
  t.after(() => bus.close());
  const ctl = await control(t, bus);

  const answer = await askControl(ctl, 'create_user', { user: 'alice' });
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /opaque user token/);
  assert.equal(bus.users.has('alice'), false);
});

async function registerPrivate(t, bus, owner, name) {
  const token = privateNodeToken(TOKEN, owner);
  const ws = await open(`${bus.url}?token=${encodeURIComponent(token)}`);
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      id: `private-${owner}-${name}`,
      type: 'register',
      from: 'ignored',
      to: name,
      tenantId: '*',
      deadline: Date.now() + 5_000,
      payload: { manifest: { ...MANIFEST(name), desc: `${owner}:${name}` } },
    }),
  );
  const answer = await next(ws);
  assert.equal(answer.payload.ok, true);
  assert.equal(answer.tenantId, owner);
  return ws;
}

async function attemptPrivate(t, bus, owner, name) {
  const token = privateNodeToken(TOKEN, owner);
  const ws = await open(`${bus.url}?token=${encodeURIComponent(token)}`);
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      id: `attempt-private-${owner}-${name}`,
      type: 'register',
      from: 'ignored',
      to: name,
      tenantId: '*',
      deadline: Date.now() + 5_000,
      payload: { manifest: { ...MANIFEST(name), desc: `${owner}:${name}` } },
    }),
  );
  return await next(ws);
}

async function attemptShared(t, bus, name) {
  const ws = await open(`${bus.url}?token=${encodeURIComponent(TOKEN)}`);
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      id: `attempt-shared-${name}`,
      type: 'register',
      from: 'ignored',
      to: name,
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload: { manifest: MANIFEST(name) },
    }),
  );
  return await next(ws);
}

async function askFor(ws, tenantId, type, payload, to = 'bus') {
  const id = `${type}-${tenantId}-${Math.random()}`;
  ws.send(
    JSON.stringify({
      id,
      type,
      from: 'forged',
      to,
      tenantId,
      deadline: Date.now() + 5_000,
      payload,
    }),
  );
  return await next(ws);
}

test('different users may register the same private name without seeing each other', async (t) => {
  const bus = await new Bus(TOKEN, CONTROL).listen(0);
  t.after(() => bus.close());
  const ctl = await control(t, bus);
  const ctlNode = await register(t, bus, 'control');
  await askControl(ctl, 'create_user', { user: ALICE });
  await askControl(ctl, 'create_user', { user: BOB });
  await askControl(ctl, 'connect', { user: ALICE, node: 'control' });
  await askControl(ctl, 'connect', { user: BOB, node: 'control' });

  const aliceNode = await registerPrivate(t, bus, ALICE, 'external');
  await registerPrivate(t, bus, BOB, 'external');

  const aliceList = await askFor(ctlNode, ALICE, 'list_nodes', {});
  const bobList = await askFor(ctlNode, BOB, 'list_nodes', {});
  assert.equal(
    aliceList.payload.value.find((node) => node.name === 'external').desc,
    `${ALICE}:external`,
  );
  assert.equal(aliceList.payload.value.find((node) => node.name === 'external').scope, 'private');
  assert.equal(aliceList.payload.value.find((node) => node.name === 'control').scope, 'shared');
  assert.equal(
    bobList.payload.value.find((node) => node.name === 'external').desc,
    `${BOB}:external`,
  );
  assert.equal(bobList.payload.value.find((node) => node.name === 'external').scope, 'private');
  assert.equal(bus.privateNodes.get(ALICE)?.get('external')?.tenantId, ALICE);
  assert.equal(bus.privateNodes.get(BOB)?.get('external')?.tenantId, BOB);

  const forged = await askFor(aliceNode, BOB, 'list_nodes', {});
  assert.equal(forged.tenantId, ALICE, 'the connection, not its frame, selects the tenant');
  assert.equal(
    forged.payload.value.find((node) => node.name === 'external').desc,
    `${ALICE}:external`,
  );

  const forbidden = await askFor(aliceNode, BOB, 'connect', { user: BOB, node: 'control' });
  assert.equal(forbidden.payload.ok, false);
  assert.match(forbidden.payload.error, /control connection/);
});

test('a private name cannot collide with a shared name', async (t) => {
  const bus = await new Bus(TOKEN, CONTROL).listen(0);
  t.after(() => bus.close());
  await register(t, bus, 'tool');

  const answer = await attemptPrivate(t, bus, ALICE, 'tool');
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /already taken by a shared node/);
  assert.equal(bus.privateNodes.get(ALICE)?.has('tool'), false);
});

test('a shared name cannot collide with a private name', async (t) => {
  const bus = await new Bus(TOKEN, CONTROL).listen(0);
  t.after(() => bus.close());
  await registerPrivate(t, bus, ALICE, 'external');

  const answer = await attemptShared(t, bus, 'external');
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /already taken by a private node/);
  assert.equal(bus.envelopeNodes.has('external'), false);
});
