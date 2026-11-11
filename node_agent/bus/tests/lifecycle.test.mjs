// The life of a call, and the life of a user space.
//
// A call the bus has handed to a target is the bus's to end: the caller may have stopped waiting, the
// target may never answer at all, and nothing on either side of the wire will notice. So every pending
// call carries a timer taken from its own frame's deadline, and the table it lives in has a ceiling.
//
// A user space is the other half of the same promise: once it is destroyed, the calls it held, the
// subscriptions it kept and the private nodes that belonged to it are gone — a later user space with
// the same id starts from nothing, or the destroy would only be a rename.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus, privateNodeToken } from '../dist/index.js';

const TOKEN = 'test-token';
const CONTROL = 'control-token';
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

/** A manifest naming exactly the capabilities a test needs. */
const MANIFEST = (name, caps) => ({
  packageId: name,
  name,
  caps: Object.fromEntries(caps.map((cap) => [cap, { type: 'object', properties: {} }])),
  desc: `${name} desc`,
  version: '1.0.0',
  publisher: 'tester',
  icon: '<svg/>',
});

async function started(t, limits) {
  const bus = await new Bus(TOKEN, CONTROL, limits).listen(0);
  t.after(() => bus.close());
  return bus;
}

function wait(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}

function open(url, token = TOKEN) {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    ws.addEventListener('open', () => ok(ws), { once: true });
    ws.addEventListener('error', () => bad(new Error('websocket failed')), { once: true });
  });
}

/** The next frame this socket receives; the failure names the frame nobody sent. */
function next(ws) {
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error('no frame')), 5_000);
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

/** Every frame this socket receives from now on, in order — for the frames a test must *not* get. */
function record(ws) {
  const frames = [];
  ws.addEventListener('message', (event) => frames.push(JSON.parse(event.data)));
  return frames;
}

async function until(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${ms}ms`);
    await wait(10);
  }
}

/** Register a shared node on this bus and answer the registration. */
async function joinShared(t, bus, name, caps, token = TOKEN) {
  const ws = await open(bus.url, token);
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      id: `reg-${name}`,
      type: 'register',
      from: 'ignored',
      to: name,
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload: { manifest: MANIFEST(name, caps) },
    }),
  );
  const answer = await next(ws);
  assert.equal(answer.payload.ok, true, `register ${name}: ${answer.payload.error}`);
  return ws;
}

/** Register a node that belongs to one user and no other; the token, not the frame, says which. */
async function joinPrivate(t, bus, owner, name, caps) {
  const ws = await open(bus.url, privateNodeToken(TOKEN, owner));
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      id: `reg-${owner}-${name}`,
      type: 'register',
      from: 'ignored',
      to: name,
      tenantId: '*',
      deadline: Date.now() + 5_000,
      payload: { manifest: MANIFEST(name, caps) },
    }),
  );
  const answer = await next(ws);
  assert.equal(answer.payload.ok, true, `register ${name}: ${answer.payload.error}`);
  assert.equal(answer.tenantId, owner);
  return ws;
}

/** A management frame: it belongs to the bus, and the user it names is the one it acts on. */
async function ask(ws, type, payload, tenantId = ALICE) {
  const id = `${type}-${Math.random()}`;
  ws.send(
    JSON.stringify({
      id,
      type,
      from: 'ignored',
      to: 'bus',
      tenantId,
      deadline: Date.now() + 5_000,
      payload,
    }),
  );
  return await next(ws);
}

function callFrame({ id, to, cap, deadline, tenantId = ALICE }) {
  return JSON.stringify({
    id,
    type: 'call',
    from: 'ignored',
    to,
    tenantId,
    deadline,
    payload: { cap, args: {} },
  });
}

async function call(ws, to, cap, options = {}) {
  const id = options.id ?? `call-${Math.random()}`;
  const deadline = options.deadline ?? Date.now() + 5_000;
  ws.send(callFrame({ id, to, cap, deadline }));
  return await next(ws);
}

/** Answer every call this node receives with the same value: the well-behaved target. */
function answerCalls(ws, value) {
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type !== 'call') return;
    ws.send(
      JSON.stringify({
        id: `result-${frame.id}`,
        type: 'result',
        from: frame.to,
        to: frame.from,
        replyTo: frame.id,
        tenantId: frame.tenantId,
        payload: { ok: true, value },
      }),
    );
  });
}

test('a call whose target never answers ends at its own deadline', async (t) => {
  const bus = await started(t);
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await joinShared(t, bus, 'stuck', ['slow']); // names a capability and never answers it
  await ask(control, 'connect', { user: ALICE, node: 'stuck' });

  const answer = await call(control, 'stuck', 'slow', { deadline: Date.now() + 150 });
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /deadline exceeded/);
  assert.equal(bus.pendingCount, 0, 'the table does not keep a call its own deadline ended');
});

test('a deadline the bus cannot honour is cut to the bus ceiling', async (t) => {
  const bus = await started(t, { callMs: 150 });
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await joinShared(t, bus, 'stuck', ['slow']);
  await ask(control, 'connect', { user: ALICE, node: 'stuck' });

  // A frame may name any moment it likes — including one no call will ever reach.
  const at = Date.now();
  const answer = await call(control, 'stuck', 'slow', { deadline: Date.now() + 3_600_000 });
  assert.match(answer.payload.error, /deadline exceeded/);
  assert.ok(Date.now() - at < 2_000, 'the wait was the bus ceiling, not the year the frame named');
  assert.equal(bus.pendingCount, 0);
});

test('an answered call leaves no timer to fire later', async (t) => {
  const bus = await started(t);
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  const echo = await joinShared(t, bus, 'echo', ['say']);
  answerCalls(echo, 'said');
  await ask(control, 'connect', { user: ALICE, node: 'echo' });

  const frames = record(control);
  control.send(
    callFrame({ id: 'answered-once', to: 'echo', cap: 'say', deadline: Date.now() + 100 }),
  );
  await until(() => frames.length === 1, 2_000, 'the answer');

  assert.equal(bus.pendingCount, 0);
  await wait(300); // three times the deadline: a timer left behind would have fired by now
  assert.equal(frames.length, 1, 'the caller hears one answer, not one answer and one timeout');
  assert.equal(frames[0].payload.ok, true);
});

test('the same call id twice is refused instead of replacing the first call', async (t) => {
  const bus = await started(t);
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await joinShared(t, bus, 'stuck', ['slow']);
  await ask(control, 'connect', { user: ALICE, node: 'stuck' });

  control.send(callFrame({ id: 'same', to: 'stuck', cap: 'slow', deadline: Date.now() + 60_000 }));
  await until(() => bus.pendingCount === 1, 1_000, 'the first call is out');

  const second = await call(control, 'stuck', 'slow', {
    id: 'same',
    deadline: Date.now() + 60_000,
  });
  assert.equal(second.payload.ok, false);
  assert.match(second.payload.error, /already in flight/);
  assert.equal(bus.pendingCount, 1, 'the first call is still the one in flight');
});

test('one user space cannot hold more calls than its quota', async (t) => {
  const bus = await started(t, { pendingPerUser: 2 });
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await joinShared(t, bus, 'stuck', ['slow']);
  await ask(control, 'connect', { user: ALICE, node: 'stuck' });

  for (const id of ['one', 'two'])
    control.send(callFrame({ id, to: 'stuck', cap: 'slow', deadline: Date.now() + 60_000 }));
  await until(() => bus.pendingCount === 2, 1_000, 'the quota is full');

  const refused = await call(control, 'stuck', 'slow', { deadline: Date.now() + 60_000 });
  assert.equal(refused.payload.ok, false);
  assert.match(refused.payload.error, /too many calls in flight/);
  assert.equal(bus.pendingCount, 2, 'a refused call takes no place in the table');
});

test('the bus refuses a user space past its quota', async (t) => {
  const bus = await started(t, { users: 1 });
  const control = await joinShared(t, bus, 'control', [], CONTROL);

  const first = await ask(control, 'create_user', { user: ALICE });
  assert.equal(first.payload.ok, true);
  const second = await ask(control, 'create_user', { user: BOB });
  assert.equal(second.payload.ok, false);
  assert.match(second.payload.error, /user spaces/);
  assert.equal(bus.users.size, 1);
});

test('destroy_user ends its calls, drops its private nodes and leaves nothing to inherit', async (t) => {
  const bus = await started(t);
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  const caller = await joinShared(t, bus, 'caller', []);
  const external = await joinPrivate(t, bus, ALICE, 'external', ['slow']); // never answers
  const gone = new Promise((ok) => external.addEventListener('close', () => ok(), { once: true }));

  await ask(control, 'connect', { user: ALICE, node: 'control' });
  await ask(control, 'connect', { user: ALICE, node: 'external' });
  const subscribed = await ask(control, 'subscribe', { node: 'external', topic: 'tick' });
  assert.equal(subscribed.payload.ok, true, subscribed.payload.error);
  const alice = bus.users.get(ALICE);
  assert.equal(alice.subscriptions.size, 1, 'the subscription is in the user space');

  // A call that is out when the user goes: its caller must hear the end of it, not wait forever.
  const answers = record(caller);
  caller.send(callFrame({ id: 'out', to: 'external', cap: 'slow', deadline: Date.now() + 60_000 }));
  await until(() => bus.pendingCount === 1, 1_000, 'the call is out');

  const destroyed = await ask(control, 'destroy_user', { user: ALICE });
  assert.equal(destroyed.payload.ok, true);
  assert.equal(destroyed.payload.value.removed, true);

  assert.equal(bus.users.has(ALICE), false, 'the space is gone');
  assert.equal(bus.privateNodes.has(ALICE), false, 'its private nodes are gone with it');
  assert.equal(bus.pendingCount, 0, 'nothing is left in flight');
  assert.equal(alice.pendingCount, 0);
  assert.equal(alice.subscriptions.size, 0, 'no subscription outlives its user');
  assert.equal(alice.nodes.size, 0, 'and no connected shared node either');

  await until(() => answers.length === 1, 1_000, 'the caller is told');
  assert.equal(answers[0].payload.ok, false);
  assert.match(answers[0].payload.error, /user was destroyed/);
  await gone; // the private node's connection was closed, not merely forgotten

  // The same id asked for again is a new space: the private node that belonged to the old one is not
  // in it, and the closed connection does not put it back.
  const recreated = await ask(control, 'create_user', { user: ALICE });
  assert.equal(recreated.payload.ok, true);
  assert.deepEqual((await ask(control, 'list_nodes', {}, ALICE)).payload.value, []);
  await wait(100);
  assert.equal(bus.privateNodes.has(ALICE), false, 'the old private node does not come back');
  assert.equal(bus.users.get(ALICE).nodes.size, 0);
});
