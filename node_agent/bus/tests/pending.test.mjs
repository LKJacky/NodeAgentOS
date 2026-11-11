// A forwarded call belongs to the bus until it is answered. If either endpoint disappears, or the
// caller stops waiting, the pending entry must be settled and removed rather than kept forever.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, call, callFrame, joinShared, started, until, ALICE, CONTROL } from './support.mjs';

test('a call settles when its callee leaves before answering', async (t) => {
  const bus = await started(t);
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  const callee = await joinShared(t, bus, 'callee', ['slow']);
  await ask(control, 'connect', { user: ALICE, node: 'callee' });

  const pending = call(control, 'callee', 'slow');
  await until(() => bus.pendingCount === 1, 1_000, 'the call to be out');
  callee.close();

  const answer = await pending;
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /left before answering/);
  assert.equal(bus.pendingCount, 0, 'the table does not keep a call that was answered');
});

test('the caller leaving drops its pending call instead of keeping it forever', async (t) => {
  const bus = await started(t);
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  const callee = await joinShared(t, bus, 'callee', ['slow']);
  await ask(control, 'connect', { user: ALICE, node: 'callee' });

  control.send(
    callFrame({ id: 'caller-gone', to: 'callee', cap: 'slow', deadline: Date.now() + 60_000 }),
  );
  await until(() => bus.pendingCount === 1, 1_000, 'the call to be out');
  control.close();
  await until(() => bus.pendingCount === 0, 1_000, 'the caller call to be dropped');
});

test('an answered call leaves nothing pending', async (t) => {
  const bus = await started(t);
  const control = await joinShared(t, bus, 'control', [], CONTROL);
  const echo = await joinShared(t, bus, 'echo', ['say']);
  echo.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type !== 'call') return;
    echo.send(
      JSON.stringify({
        id: `result-${frame.id}`,
        type: 'result',
        from: frame.to,
        to: frame.from,
        replyTo: frame.id,
        tenantId: frame.tenantId,
        payload: { ok: true, value: 'said' },
      }),
    );
  });
  await ask(control, 'connect', { user: ALICE, node: 'echo' });

  const answer = await call(control, 'echo', 'say');
  assert.equal(answer.payload.ok, true);
  assert.equal(answer.payload.value, 'said');
  assert.equal(bus.pendingCount, 0);
});
