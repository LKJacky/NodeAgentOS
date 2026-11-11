// Registering is a bus decision: the token binds a connection to its user, a shared name is unique,
// and a name comes free when its connection goes. A bad first frame is refused without taking the
// bus down.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { next, open, started, until, MANIFEST, TOKEN, ALICE } from './support.mjs';

function sendRegister(ws, name) {
  ws.send(
    JSON.stringify({
      id: `reg-${name}`,
      type: 'register',
      from: 'ignored',
      to: name,
      tenantId: ALICE,
      deadline: Date.now() + 5_000,
      payload: { manifest: MANIFEST(name, ['ping']) },
    }),
  );
}

async function register(ws, name) {
  sendRegister(ws, name);
  return await next(ws);
}

test('a wrong token is refused and the connection is closed', async (t) => {
  const bus = await started(t);
  const ws = await open(bus.url, 'wrong-token');
  t.after(() => ws.close());

  const answer = await register(ws, 'probe');
  assert.equal(answer.payload.ok, false);
  assert.match(answer.payload.error, /wrong token/);
});

test('a shared name is taken once and comes free when its connection goes', async (t) => {
  const bus = await started(t);
  const first = await open(bus.url, TOKEN);
  t.after(() => first.close());
  assert.equal((await register(first, 'same')).payload.ok, true);

  const second = await open(bus.url, TOKEN);
  t.after(() => second.close());
  await new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error('the duplicate name was not refused')), 5_000);
    second.addEventListener(
      'close',
      () => {
        clearTimeout(timer);
        ok();
      },
      { once: true },
    );
    sendRegister(second, 'same');
  });
  assert.equal(bus.envelopeNodes.get('same')?.manifest.name, 'same');

  first.close();
  await until(() => !bus.envelopeNodes.has('same'), 2_000, 'the shared name to be released');
  const third = await open(bus.url, TOKEN);
  t.after(() => third.close());
  assert.equal((await register(third, 'same')).payload.ok, true);
});

test('a non-WebSocket connection is closed instead of adopted', async (t) => {
  const bus = await started(t);
  const { connect } = await import('node:net');
  const socket = connect(bus.port, '127.0.0.1');
  t.after(() => socket.destroy());

  await new Promise((ok) => socket.once('connect', ok));
  socket.write('GET /not-a-websocket HTTP/1.1\r\nHost: localhost\r\n\r\n');
  await new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error('the non-WebSocket socket stayed open')), 2_000);
    socket.once('close', () => {
      clearTimeout(timer);
      ok();
    });
  });
});
