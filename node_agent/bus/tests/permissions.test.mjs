// cap-level permissions, on the bus side.
//
// A capability's JSON Schema may carry `callers`, and a node that handles other people's words
// should not be callable by everyone. The bus is where that is enforced, because the bus is the
// only party that knows the authenticated sender of a call: before it forwards one it asks the
// system node, and the answer decides. Three properties matter more than the policy itself:
//
//   * a call is never forwarded before the verdict — a denial reaches nobody;
//   * a system node that does not answer fails closed, and the wait it cost leaves nothing behind;
//   * the system's own calls are not authorized, or the check would ask the system to answer while
//     it is waiting for itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTHORIZE_CAP,
  Bus,
  SYSTEM_NODE,
  capCallers,
  capExposed,
  privateNodeToken,
} from '../dist/index.js';

const TOKEN = 'test-token';
const CONTROL = 'control-token';
const ALICE = 'a'.repeat(64);

/** A manifest whose caps are the JSON Schemas the test needs, `callers` included. */
const MANIFEST = (name, caps) => ({
  packageId: name,
  name,
  caps: Object.fromEntries(
    Object.entries(caps).map(([cap, schema]) => [
      cap,
      { type: 'object', properties: {}, ...schema },
    ]),
  ),
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

/** Every frame this socket receives from now on, in order — for the calls a test must *not* see. */
function record(ws) {
  const frames = [];
  ws.addEventListener('message', (event) => frames.push(JSON.parse(event.data)));
  return frames;
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

/** A management frame: it belongs to the bus, and the user it names is the one it acts on. */
/** Register a node in the caller's private table, the way a user-owned node joins. */
async function joinPrivate(t, bus, name, caps) {
  const ws = await open(bus.url, privateNodeToken(TOKEN, ALICE));
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      id: `private-${name}`,
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
  return ws;
}

async function ask(ws, type, payload) {
  ws.send(
    JSON.stringify({
      id: `${type}-${Math.random()}`,
      type,
      from: 'ignored',
      to: 'bus',
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload,
    }),
  );
  return await next(ws);
}

async function call(ws, to, cap, options = {}) {
  const id = options.id ?? `call-${Math.random()}`;
  ws.send(
    JSON.stringify({
      id,
      type: 'call',
      from: 'ignored',
      to,
      tenantId: ALICE,
      deadline: options.deadline ?? Date.now() + 5_000,
      payload: { cap, args: {} },
    }),
  );
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

/**
 * Be the system node: answer each authorize request with what `decide` makes of its arguments, and
 * hand back the requests so a test can see what the bus asked. `null` answers with an error, the
 * way a policy store that is down would.
 */
function serveAuthorize(ws, decide) {
  const asked = [];
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type !== 'call' || frame.payload?.cap !== AUTHORIZE_CAP) return;
    asked.push(frame);
    const verdict = decide(frame.payload.args);
    ws.send(
      JSON.stringify({
        id: `verdict-${frame.id}`,
        type: 'result',
        from: frame.to,
        to: frame.from,
        replyTo: frame.id,
        tenantId: frame.tenantId,
        payload:
          verdict === null
            ? { ok: false, error: 'the policy store is down' }
            : { ok: true, value: verdict },
      }),
    );
  });
  return asked;
}

/** `callers` as the system node would read it: empty or `*` is everyone, else the names alone. */
function listed(args) {
  const who = args.defaultCallers;
  return who.length === 0 || who.includes('*') || who.includes(args.caller);
}

/** A bus with a system, a callee and a caller already joined and wired to ALICE. */
async function joined(t, options = {}) {
  const { limits, caps = { ping: {} }, decide = () => ({ allow: true }) } = options;
  const bus = await started(t, limits);
  const system = await joinShared(t, bus, SYSTEM_NODE, { [AUTHORIZE_CAP]: {} });
  const asked = serveAuthorize(system, decide);
  const callee = await joinShared(t, bus, 'callee', caps);
  answerCalls(callee, 'pong');
  const caller = await joinShared(t, bus, 'caller', {});
  const agent = await joinShared(t, bus, 'agent', {});
  const notes = await joinShared(t, bus, 'notes', {});
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await ask(control, 'connect', { user: ALICE, node: 'callee' });
  return { bus, system, asked, callee, caller, agent, notes, control };
}

test('an allowed call is forwarded only after the system node says yes', async (t) => {
  const { bus, asked, caller } = await joined(t);

  const answer = await call(caller, 'callee', 'ping');
  assert.equal(answer.payload.ok, true, answer.payload.error);
  assert.equal(answer.payload.value, 'pong');

  assert.equal(asked.length, 1, 'one forwarded call, one question');
  const question = asked[0];
  assert.equal(question.type, 'call');
  assert.equal(question.from, 'bus', 'the bus asks, not the caller');
  assert.equal(question.to, SYSTEM_NODE);
  assert.equal(question.tenantId, ALICE);
  assert.deepEqual(question.payload.args, {
    caller: 'caller',
    target: 'callee',
    cap: 'ping',
    tenant: ALICE,
    defaultCallers: ['*'],
    expose: true,
  });
  assert.equal(bus.pendingCount, 0, 'an answered call leaves nothing pending');
  assert.equal(bus.authPendingCount, 0, 'an answered check leaves nothing behind');
});

test('a denied call never reaches its target', async (t) => {
  const { bus, callee, caller } = await joined(t, {
    decide: () => ({ allow: false, reason: 'only the agent may call callee.ping' }),
  });
  const frames = record(callee);

  const answer = await call(caller, 'callee', 'ping');
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /permission denied: only the agent may call callee\.ping/);

  await wait(100);
  assert.deepEqual(
    frames.filter((frame) => frame.type === 'call'),
    [],
    'a refused call is not forwarded',
  );
  assert.equal(bus.pendingCount, 0);
  assert.equal(bus.authPendingCount, 0);
});

test('a cap keeps its own callers, and a cap without one falls back to the bus default', async (t) => {
  const { asked, agent, notes } = await joined(t, {
    limits: { permissions: { defaultCallers: ['agent'] } },
    caps: { guarded: { callers: ['agent', 'timer'] }, starred: { callers: ['*'] }, open: {} },
    decide: (args) => ({ allow: listed(args), reason: `${args.caller} is not on the list` }),
  });

  // The cap's own list is what decides: `agent` is on it, `notes` is not.
  assert.equal((await call(agent, 'callee', 'guarded')).payload.ok, true);
  const refused = await call(notes, 'callee', 'guarded');
  assert.equal(refused.payload.ok, false);
  assert.match(refused.payload.error, /permission denied: notes is not on the list/);

  // `*` is every node, whatever the bus default says.
  assert.equal((await call(notes, 'callee', 'starred')).payload.ok, true);

  // A cap that names no callers is held to the bus's default, which here names `agent` alone.
  assert.equal((await call(agent, 'callee', 'open')).payload.ok, true);
  assert.equal((await call(notes, 'callee', 'open')).payload.ok, false);

  assert.deepEqual(
    asked.map((frame) => [
      frame.payload.args.cap,
      frame.payload.args.caller,
      frame.payload.args.defaultCallers,
    ]),
    [
      ['guarded', 'agent', ['agent', 'timer']],
      ['guarded', 'notes', ['agent', 'timer']],
      ['starred', 'notes', ['*']],
      ['open', 'agent', ['agent']],
      ['open', 'notes', ['agent']],
    ],
  );
});

test('a system that does not answer fails the call closed and leaves nothing behind', async (t) => {
  const bus = await started(t, { permissions: { authMs: 80 } });
  await joinShared(t, bus, SYSTEM_NODE, { [AUTHORIZE_CAP]: {} }); // names the cap and never answers it
  const callee = await joinShared(t, bus, 'callee', { ping: {} });
  answerCalls(callee, 'pong');
  const caller = await joinShared(t, bus, 'caller', {});
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await ask(control, 'connect', { user: ALICE, node: 'callee' });
  const frames = record(callee);

  const answer = await call(caller, 'callee', 'ping');
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /permission denied: the system did not answer authorize/);

  await wait(120);
  assert.deepEqual(
    frames.filter((frame) => frame.type === 'call'),
    [],
    'the call was never forwarded',
  );
  assert.equal(bus.pendingCount, 0, 'the call is not left in the pending table');
  assert.equal(bus.authPendingCount, 0, 'and neither is the check that timed out');
});

test('destroying a user settles the permission checks it still has waiting', async (t) => {
  const bus = await started(t, { permissions: { authMs: 5_000 } });
  await joinShared(t, bus, SYSTEM_NODE, { [AUTHORIZE_CAP]: {} }); // never answers
  const callee = await joinShared(t, bus, 'callee', { ping: {} });
  answerCalls(callee, 'pong');
  const caller = await joinShared(t, bus, 'caller', {});
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await ask(control, 'create_user', { user: ALICE });
  await ask(control, 'connect', { user: ALICE, node: 'callee' });

  caller.send(
    JSON.stringify({
      id: 'destroy-pending',
      type: 'call',
      from: 'ignored',
      to: 'callee',
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload: { cap: 'ping', args: {} },
    }),
  );
  await wait(30);
  assert.equal(bus.authPendingCount, 1, 'the check is waiting on system');
  bus.user(ALICE)?.destroy('user destroyed');
  assert.equal(
    bus.authPendingCount,
    0,
    'destroy settles the check instead of leaving it to its timer',
  );
});

test('the system node calling is not authorized: no question, no recursion', async (t) => {
  const { asked, system } = await joined(t);

  const answer = await call(system, 'callee', 'ping');
  assert.equal(answer.payload.ok, true, answer.payload.error);
  assert.equal(answer.payload.value, 'pong');
  assert.deepEqual(asked, [], 'the system does not authorize its own call');
});

test('an error from the system is a refusal, not a pass', async (t) => {
  const { caller } = await joined(t, { decide: () => null });

  const answer = await call(caller, 'callee', 'ping');
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /permission denied: the policy store is down/);
});

test('without a system node the bus keeps its old answer, unless told to enforce', async (t) => {
  const bus = await started(t);
  const callee = await joinShared(t, bus, 'callee', { ping: {} });
  answerCalls(callee, 'pong');
  const caller = await joinShared(t, bus, 'caller', {});
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await ask(control, 'connect', { user: ALICE, node: 'callee' });

  const answer = await call(caller, 'callee', 'ping');
  assert.equal(answer.payload.ok, true, 'a bus with no system node has no policy to consult');

  const strict = await started(t, { permissions: { enforce: true } });
  const held = await joinShared(t, strict, 'callee', { ping: {} });
  answerCalls(held, 'pong');
  const asking = await joinShared(t, strict, 'caller', {});
  const ops = await joinShared(t, strict, 'control', [], CONTROL);
  await ask(ops, 'connect', { user: ALICE, node: 'callee' });

  const refused = await call(asking, 'callee', 'ping');
  assert.equal(refused.payload.ok, false);
  assert.match(refused.payload.error, /no system node to authorize the call/);
});

test('cap callers are read off the schema as names, and only as names', () => {
  assert.deepEqual(capCallers({ callers: ['agent', 'timer'] }), ['agent', 'timer']);
  assert.deepEqual(capCallers({ callers: ['agent', 7, '', ' '] }), ['agent']);
  assert.equal(capCallers({ type: 'object' }), undefined);
  assert.equal(capCallers(undefined), undefined);
});

test('the bus forwards expose:false from the capability schema', async (t) => {
  const { asked, caller } = await joined(t, {
    caps: { hidden: { expose: false } },
    decide: () => ({ allow: true }),
  });
  assert.equal((await call(caller, 'callee', 'hidden')).payload.ok, true);
  assert.equal(asked[0].payload.args.expose, false);
});

async function listCaps(ws, node) {
  ws.send(
    JSON.stringify({
      id: `list-${Math.random()}`,
      type: 'list_capabilities',
      from: 'ignored',
      to: 'bus',
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload: { node },
    }),
  );
  return await next(ws);
}

test('an empty caller list reserved from the editor is not exposed', async (t) => {
  // The shape is the policy: no sibling caller (callers: []) and no permission row to grant one
  // (allow_edit_permission: false) is a cap that is the node's own and its page's. The bus reads it
  // as expose: false without the manifest repeating the word.
  assert.equal(capExposed({ callers: [], allow_edit_permission: false }), false);
  assert.equal(capExposed({ callers: [], allow_edit_permission: true }), true, 'still a row');
  assert.equal(capExposed({ callers: ['agent'], allow_edit_permission: false }), true);
  assert.equal(capExposed({ expose: false, callers: ['agent'] }), false);
  assert.equal(capExposed({}), true);
  assert.equal(capExposed(undefined), true);

  const bus = await started(t, { permissions: { enforce: true } });
  const system = await joinShared(t, bus, SYSTEM_NODE, { [AUTHORIZE_CAP]: {} });
  serveAuthorize(system, (args) =>
    args.caller === 'webui' || args.expose !== false
      ? { allow: true }
      : { allow: false, reason: `${args.target}.${args.cap} is not exposed` },
  );
  const callee = await joinShared(t, bus, 'callee', {
    open: {},
    internal: { callers: [], allow_edit_permission: false },
    fixed: { callers: [], allow_edit_permission: true },
  });
  answerCalls(callee, 'pong');
  const caller = await joinShared(t, bus, 'caller', {});
  const webui = await joinShared(t, bus, 'webui', {});
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await ask(control, 'connect', { user: ALICE, node: 'callee' });
  await ask(control, 'connect', { user: ALICE, node: 'caller' });
  await ask(control, 'connect', { user: ALICE, node: 'webui' });

  const listed = await listCaps(caller, 'callee');
  assert.deepEqual(
    listed.payload.value.map((cap) => cap.cap),
    ['open', 'fixed'],
    'the internal cap is not in the directory; a fixed-but-visible one still is',
  );

  const refused = await call(caller, 'callee', 'internal');
  assert.equal(refused.payload.ok, false);
  assert.match(refused.payload.error, /not exposed/);

  // The page's own path still works: webui is the shell's front end.
  assert.equal((await call(webui, 'callee', 'internal')).payload.value, 'pong');
});

test('labels ride along with the directory, and the names stay canonical', async (t) => {
  const bus = await started(t);
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  const system = await joinShared(t, bus, SYSTEM_NODE, { [AUTHORIZE_CAP]: {} });
  serveAuthorize(system, () => ({ allow: true }));

  // A node that publishes display names beside its manifest: the identifiers it labels do not move.
  const ws = await open(bus.url);
  t.after(() => ws.close());
  const manifest = MANIFEST('labeled', { ping: {}, add: {} });
  manifest.labels = {
    node: { en: 'Labeled', 'zh-CN': '标签' },
    caps: { add: { en: 'Add one', 'zh-CN': '加一个' } },
    args: { add: { n: { en: 'Count', 'zh-CN': '数量' } } },
  };
  ws.send(
    JSON.stringify({
      id: 'reg-labeled',
      type: 'register',
      from: 'ignored',
      to: 'labeled',
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload: { manifest },
    }),
  );
  assert.equal((await next(ws)).payload.ok, true);

  const reader = await joinShared(t, bus, 'reader', {});
  await ask(control, 'connect', { user: ALICE, node: 'labeled' });
  await ask(control, 'connect', { user: ALICE, node: 'reader' });

  const nodes = await ask(reader, 'list_nodes', {});
  const row = nodes.payload.value.find((one) => one.name === 'labeled');
  assert.equal(row.name, 'labeled', 'the directory key is still the canonical name');
  assert.deepEqual(row.labels.node, { en: 'Labeled', 'zh-CN': '标签' });

  const caps = await ask(reader, 'list_capabilities', { node: 'labeled' });
  const add = caps.payload.value.find((one) => one.cap === 'add');
  assert.equal(add.cap, 'add', 'the cap a caller sends is still the canonical one');
  assert.deepEqual(add.labels, { en: 'Add one', 'zh-CN': '加一个' });
  assert.deepEqual(add.argLabels, { n: { en: 'Count', 'zh-CN': '数量' } });
  // A label is presentation only: the schema handed to a tool stays exactly what it was.
  assert.equal('labels' in add.parameters, false);
  assert.equal('argLabels' in add.parameters, false);
  assert.equal(JSON.stringify(add.parameters).includes('Add one'), false);
  // A cap with no labels carries none, rather than an empty map.
  const ping = caps.payload.value.find((one) => one.cap === 'ping');
  assert.equal(ping.labels, undefined);
  assert.equal(ping.argLabels, undefined);
});

test('list_capabilities hides expose:false from every node, including the owner', async (t) => {
  const { callee, caller } = await joined(t, {
    caps: { shown: {}, hidden: { expose: false } },
  });
  const sibling = await listCaps(caller, 'callee');
  assert.equal(sibling.payload.ok, true);
  assert.deepEqual(
    sibling.payload.value.map((cap) => cap.cap),
    ['shown'],
  );

  // The owner does not need list_capabilities to know its own hidden caps; it calls them directly.
  const owner = await listCaps(callee, 'callee');
  assert.deepEqual(
    owner.payload.value.map((cap) => cap.cap),
    ['shown'],
  );
});

test('registration normalises a legacy ui cap to webui-only', async (t) => {
  const bus = await started(t);
  const ws = await open(bus.url);
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      id: 'reg-legacy-ui',
      type: 'register',
      from: 'ignored',
      to: 'legacy-ui',
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload: { manifest: MANIFEST('legacy-ui', { ui: {} }) },
    }),
  );
  const answer = await next(ws);
  assert.equal(answer.payload.ok, true, answer.payload.error);
  const manifest = bus.envelopeNodes.get('legacy-ui').manifest;
  assert.equal(manifest.caps.ui.expose, false);
  assert.equal(manifest.caps.ui.allow_edit_permission, false);
});

test('a cap without callers defaults to everyone when the bus has no whitelist', async (t) => {
  const { asked, notes } = await joined(t, { caps: { open: {} } });
  assert.equal((await call(notes, 'callee', 'open')).payload.ok, true);
  assert.deepEqual(asked[0].payload.args.defaultCallers, ['*']);
});

test('system still decides a private target, but its default is allow-all', async (t) => {
  const bus = await started(t, { permissions: { enforce: true } });
  const system = await joinShared(t, bus, SYSTEM_NODE, { [AUTHORIZE_CAP]: {} });
  const asked = serveAuthorize(system, (args) =>
    args.caller === 'webui' || args.expose !== false
      ? { allow: true }
      : { allow: false, reason: `${args.target}.${args.cap} is not exposed` },
  );
  const caller = await joinShared(t, bus, 'caller', {});
  const webui = await joinShared(t, bus, 'webui', {});
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  await ask(control, 'connect', { user: ALICE, node: 'caller' });
  await ask(control, 'connect', { user: ALICE, node: 'webui' });

  const open = await joinPrivate(t, bus, 'private-open', { ping: { callers: [] } });
  answerCalls(open, 'pong');
  const hidden = await joinPrivate(t, bus, 'private-hidden', { ping: { expose: false } });
  answerCalls(hidden, 'secret');

  // The system is still the decision point. `private` makes it use the default allow-all row,
  // ignoring the private manifest's explicit `callers: []`.
  assert.equal((await call(caller, 'private-open', 'ping')).payload.value, 'pong');
  assert.equal(asked[0].payload.args.private, true);

  const refused = await call(caller, 'private-hidden', 'ping');
  assert.equal(refused.payload.ok, false);
  assert.match(refused.payload.error, /not exposed/);

  // webui may still reach a hidden private cap; that is the page's own path.
  assert.equal((await call(webui, 'private-hidden', 'ping')).payload.value, 'secret');
});

test('list_nodes labels private and shared nodes', async (t) => {
  const bus = await started(t);
  await joinShared(t, bus, 'shared-node', {});
  await joinShared(t, bus, 'control', [], CONTROL);
  const user = bus.user(ALICE, true);
  user.connect('shared-node');
  user.connect('control');
  await joinPrivate(t, bus, 'private-node', {});

  const entries = user.entries();
  assert.equal(entries.find((node) => node.name === 'shared-node')?.scope, 'shared');
  assert.equal(entries.find((node) => node.name === 'private-node')?.scope, 'private');
});
