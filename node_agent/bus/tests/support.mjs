// Shared fixtures for the bus tests: a started bus, one envelope socket, and the small
// management/call frames the tests write by hand. The bus package has no client any more, so
// these helpers speak the wire directly instead of pulling in the SDK.
import assert from 'node:assert/strict';
import { Bus } from '../dist/index.js';

export const TOKEN = 'test-token';
export const CONTROL = 'control-token';
export const ALICE = 'a'.repeat(64);

/** A manifest naming exactly the capabilities a test needs. */
export const MANIFEST = (name, caps) => ({
  packageId: name,
  name,
  caps: Object.fromEntries(caps.map((cap) => [cap, { type: 'object', properties: {} }])),
  desc: `${name} desc`,
  version: '1.0.0',
  publisher: 'tester',
  icon: '<svg/>',
});

export function wait(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}

export async function started(t, limits) {
  const bus = await new Bus(TOKEN, CONTROL, limits).listen(0);
  t.after(() => bus.close());
  return bus;
}

export function open(url, token = TOKEN) {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    ws.addEventListener('open', () => ok(ws), { once: true });
    ws.addEventListener('error', () => bad(new Error('websocket failed')), { once: true });
  });
}

/** The next frame this socket receives; the failure names the frame nobody sent. */
export function next(ws) {
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

/** Every frame this socket receives from now on, in order. */
export function record(ws) {
  const frames = [];
  ws.addEventListener('message', (event) => frames.push(JSON.parse(event.data)));
  return frames;
}

export async function until(predicate, ms = 2_000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${ms}ms`);
    await wait(10);
  }
}

/** Register a shared node and answer its registration. */
export async function joinShared(t, bus, name, caps, token = TOKEN) {
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
export async function ask(ws, type, payload, tenantId = ALICE) {
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

export function callFrame({ id, to, cap, deadline, tenantId = ALICE }) {
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

/** Send a call and wait for its matching result, ignoring unrelated node events. */
export function resultFor(ws, id) {
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no result for ${id}`)), 5_000);
    const listener = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type !== 'result' || frame.replyTo !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', listener);
      ok(frame);
    };
    ws.addEventListener('message', listener);
  });
}

export async function call(ws, to, cap, options = {}) {
  const id = options.id ?? `call-${Math.random()}`;
  const deadline = options.deadline ?? Date.now() + 5_000;
  ws.send(callFrame({ id, to, cap, deadline }));
  return await resultFor(ws, id);
}

/** Answer every call this node receives with the same value: the well-behaved target. */
export function answerCalls(ws, value) {
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
