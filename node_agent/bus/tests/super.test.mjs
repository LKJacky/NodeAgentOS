// The super role: one trusted connection can call without system authorization and may choose the
// forwarded `from`. It is a bus role, not a manifest property.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../dist/index.js';
import {
  ALICE,
  CONTROL,
  MANIFEST,
  TOKEN,
  ask,
  next,
  open,
  resultFor,
} from './support.mjs';

const SUPER = 'super-token';

async function started(t) {
  const bus = await new Bus(TOKEN, CONTROL, { permissions: { enforce: true } }, SUPER).listen(0);
  t.after(() => bus.close());
  return bus;
}

async function join(t, bus, name, caps, token = TOKEN) {
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
  assert.equal(answer.payload.ok, true, answer.payload.error);
  return ws;
}

function callFrame(id, to, cap, tenantId = ALICE, from = 'ignored') {
  return JSON.stringify({
    id,
    type: 'call',
    from,
    to,
    tenantId,
    deadline: Date.now() + 5_000,
    payload: { cap, args: {} },
  });
}

async function answer(ws, value) {
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
        payload: { ok: true, value: { ...value, seenFrom: frame.from } },
      }),
    );
  });
}

function allowAuthorize(ws) {
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type !== 'call' || frame.payload?.cap !== 'authorize') return;
    ws.send(
      JSON.stringify({
        id: `verdict-${frame.id}`,
        type: 'result',
        from: frame.to,
        to: frame.from,
        replyTo: frame.id,
        tenantId: frame.tenantId,
        payload: { ok: true, value: { allow: true } },
      }),
    );
  });
}

test('an ordinary call is refused when no system authorizes it', async (t) => {
  const bus = await started(t);
  const control = await join(t, bus, 'control', [], CONTROL);
  const target = await join(t, bus, 'history', ['save']);
  answer(target, { saved: true });
  await ask(control, 'connect', { user: ALICE, node: 'history' });
  const caller = await join(t, bus, 'caller', []);

  const id = 'ordinary';
  caller.send(callFrame(id, 'history', 'save'));
  const result = await resultFor(caller, id);
  assert.equal(result.payload.ok, false);
  assert.match(result.payload.error, /permission denied/);
});

test('a super call skips authorization and forwards its chosen from', async (t) => {
  const bus = await started(t);
  const control = await join(t, bus, 'control', [], CONTROL);
  const target = await join(t, bus, 'history', ['save']);
  answer(target, { saved: true });
  await ask(control, 'connect', { user: ALICE, node: 'history' });
  const superNode = await join(t, bus, 'runtime-super', [], SUPER);

  const id = 'super';
  superNode.send(callFrame(id, 'history', 'save', ALICE, 'notes'));
  const result = await resultFor(superNode, id);
  assert.equal(result.payload.ok, true, result.payload.error);
  assert.deepEqual(result.payload.value, { saved: true, seenFrom: 'notes' });
});

test('an ordinary call cannot choose from', async (t) => {
  const bus = await started(t);
  const control = await join(t, bus, 'control', [], CONTROL);
  const system = await join(t, bus, 'system', ['authorize']);
  allowAuthorize(system);
  const target = await join(t, bus, 'history', ['save']);
  answer(target, { saved: true });
  await ask(control, 'connect', { user: ALICE, node: 'history' });
  const caller = await join(t, bus, 'caller', []);

  const id = 'forged';
  caller.send(callFrame(id, 'history', 'save', ALICE, 'notes'));
  const result = await resultFor(caller, id);
  assert.equal(result.payload.ok, true, result.payload.error);
  assert.deepEqual(result.payload.value, { saved: true, seenFrom: 'caller' });
});
