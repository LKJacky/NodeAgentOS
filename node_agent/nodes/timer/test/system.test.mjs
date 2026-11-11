// The timer node as the store hosts it, against the real thing behind it: a bus, a history node, the
// system node with its long-lived scheduler, and this package's own dist/system.js in a NodeHost.
// The old tests drove a timer service that lived in this process; the queue lives in `system` now, so
// the only honest test is one that goes out over the bus and comes back as a wake.
//
// The node that sets a timer is the page's node: `timer.set` names no other caller, because a timer is
// something the person in front of the browser asks for, and webui is the node that speaks for them.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, NodeHost, WebSocketBusSession, nodeManifestOfPackage } from '@node-agent/sdk';
import { Bus } from '../../../bus/src/index.ts';
import { HistoryNode } from '../../history/src/index.ts';
import { SystemNode, setSystemScheduler } from '../../system/src/index.ts';
import { SystemScheduler } from '../../system/src/scheduler.ts';
import TimerNode from '../dist/system.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HISTORY_ROOT = fileURLToPath(new URL('../../history', import.meta.url));
const SYSTEM_ROOT = fileURLToPath(new URL('../../system', import.meta.url));
const token = 'timer-system-test-token';
const controlToken = 'timer-system-test-control-token';

/** What the page's node was handed: the wake the scheduler delivered, exactly as it arrived. */
const handed = [];

/** The history node as this test hosts it: the four capabilities the scheduler calls. */
const historyManifest = {
  packageId: 'test-history',
  name: 'history',
  desc: 'history for the timer tests',
  version: '0.0.0',
  publisher: 'test',
  icon: '',
  caps: Object.fromEntries(
    ['load', 'save', 'delete', 'list'].map((cap) => [cap, { type: 'object', properties: {} }]),
  ),
};

/** The `relative` loop the tests wait on: a promise is awaited, a predicate is polled. */
async function waitFor(check, what, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The page's node: it takes the wake the scheduler delivers (`chat_no_wait`) and relays one call per
 *  `relay`, which is how a test asks the timer node a question over the real bus. */
class PageNode extends Node {
  handlers = {
    relay: async (args) =>
      await this.ctx.call(String(args.node), String(args.cap), args.args ?? {}),
    chat_no_wait: async (args) => {
      handed.push(args);
      return 'queued';
    },
  };
}

/** The page a test talks through, hosted the way the runtime hosts any node. */
class Page {
  #host = null;
  #user;

  constructor(user) {
    this.#user = user;
  }

  get handed() {
    return handed;
  }

  async join(fixture) {
    this.#host = new NodeHost({
      definition: {
        manifest: {
          packageId: 'test-webui',
          name: 'webui',
          desc: 'the page that sets a timer',
          version: '0.0.0',
          publisher: 'test',
          icon: '<svg/>',
          caps: {
            relay: { type: 'object', properties: {} },
            chat_no_wait: { type: 'object', properties: {} },
          },
        },
        Node: PageNode,
      },
      bus: new WebSocketBusSession(),
    });
    await this.#host.start(fixture.bus.url, token);
    await fixture.admit('webui');
    return this;
  }

  /** `timer.set` reaches the timer node's `set`, and the answer is the bus's own outcome. */
  async call(capability, args = {}) {
    const split = capability.lastIndexOf('.');
    return await this.#host.invoke({
      id: randomUUID(),
      type: 'call',
      from: 'webui',
      to: 'webui',
      tenantId: this.#user,
      deadline: Date.now() + 10_000,
      payload: {
        cap: 'relay',
        args: { node: capability.slice(0, split), cap: capability.slice(split + 1), args },
      },
    });
  }

  async close() {
    await this.#host?.stop();
  }
}

let users = 0;

/** One bus, a history node, the system node over its scheduler, the timer node over this package's
 *  built entry, and the page's node. Everything is closed again however the run ends. */
async function withTimer(run) {
  const dir = mkdtempSync(join(tmpdir(), 'timer-system-test-'));
  users += 1;
  const user = `timer-system-test-${users}-${randomUUID()}`;
  const previousHome = process.env.NODE_AGENT_HOME;
  process.env.NODE_AGENT_HOME = dir;
  const bus = await new Bus(token, controlToken).listen();
  const control = new WebSocketBusSession();
  const fixture = {
    bus,
    admit: (name) => control.connectNode(user, name),
  };
  let scheduler = null;
  let systemHost = null;
  let timerHost = null;
  let historyHost = null;
  let page = null;
  try {
    await control.connect(bus.url, controlToken);

    historyHost = new NodeHost({
      definition: { manifest: historyManifest, Node: HistoryNode },
      bus: new WebSocketBusSession(),
    });
    await historyHost.start(bus.url, token);
    await fixture.admit('history');

    page = await new Page(user).join(fixture);

    // One session for both halves of the system node: the host registers it, and the scheduler keeps
    // using it after the call that created it is gone (serve.ts does the same).
    const systemSession = new WebSocketBusSession();
    scheduler = new SystemScheduler(systemSession, user);
    systemHost = new NodeHost({
      definition: { manifest: nodeManifestOfPackage(SYSTEM_ROOT), Node: SystemNode },
      bus: systemSession,
    });
    setSystemScheduler(scheduler);
    await systemHost.start(bus.url, token);
    await fixture.admit('system');
    await scheduler.start();

    timerHost = new NodeHost({
      definition: { manifest: nodeManifestOfPackage(ROOT), Node: TimerNode },
      bus: new WebSocketBusSession(),
    });
    await timerHost.start(bus.url, token);
    await fixture.admit('timer');

    return await run({ bus, caller: page, tenantId: user });
  } finally {
    setSystemScheduler(null);
    scheduler?.stop();
    try {
      await timerHost?.stop();
    } catch {}
    try {
      await systemHost?.stop();
    } catch {}
    await page?.close();
    await historyHost?.stop();
    await control.close();
    bus.close();
    if (previousHome === undefined) delete process.env.NODE_AGENT_HOME;
    else process.env.NODE_AGENT_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the package is the system-backed node: it ships dist/system.js and the wake capability', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = nodeManifestOfPackage(ROOT);

  assert.equal(pkg.node.entry, 'dist/system.js');
  assert.equal(pkg.exports['.'].default, './dist/system.js');
  assert.equal(pkg.exports['.'].types, './dist/system.d.ts');
  assert.deepEqual(Object.keys(manifest.caps).sort(), ['cancel', 'list', 'set', 'ui', 'wake']);
});

test('a countdown is set, listed, fired at the target through chat_no_wait, then gone', async () => {
  await withTimer(async ({ caller }) => {
    // 1. the page sets a 0.1s countdown back on itself
    const set = await caller.call('timer.set', {
      after_seconds: 0.1,
      node: 'webui',
      message: 'integration ping',
    });
    assert.equal(set.ok, true, `timer.set failed: ${set.error}`);
    assert.match(set.value, /^set timer id=1: countdown wakes webui/);

    // 2. timer.list shows it, read straight away so the fire cannot have come round yet
    const listed = await caller.call('timer.list', {});
    assert.equal(listed.ok, true, `timer.list failed: ${listed.error}`);
    assert.equal(listed.value.length, 1);
    const [row] = listed.value;
    assert.equal(row.id, 1);
    assert.equal(row.target, 'webui');
    assert.equal(row.message, 'integration ping');
    assert.equal(row.mode, 'countdown');
    assert.equal(row.kind, 'delay');
    assert.equal(row.repeat, 'once');

    // 3. the system scheduler calls back into timer.wake, which hands the page its sentence
    await waitFor(() => caller.handed.length > 0, 'the chat_no_wait wake');
    assert.equal(caller.handed.length, 1);
    const wake = caller.handed[0];
    assert.equal(wake.priority, 'queue');
    assert.equal(wake.msg.role, 'system');
    assert.match(wake.msg.content, /^\[timer 1 \d\d:\d\d \S+\] integration ping$/);

    // 4. the queue is empty on both sides: the timer's view and the scheduler's own
    await waitFor(async () => {
      const answer = await caller.call('timer.list', {});
      assert.equal(answer.ok, true, `timer.list after the fire failed: ${answer.error}`);
      return answer.value.length === 0;
    }, 'timer.list to come back empty');
    const systemTimers = await caller.call('system.timers', {});
    assert.equal(systemTimers.ok, true);
    assert.deepEqual(systemTimers.value, []);
  });
});
