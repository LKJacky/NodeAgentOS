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
/** The bus's service tenant: what the runtime launches every node worker under. */
const SERVICE_TENANT = '0'.repeat(64);

/** What the page's node was handed: the wake the scheduler delivered, exactly as it arrived. */
const handed = [];

/** What the agent node was handed: `chat_no_wait` as the timer sent it, `agent` included when a
 *  sub-agent was named and absent when the family's own agent was. */
const woken = [];

/** Everything the timer published (`set` / `cancel` / `fire`), which is where a wake says what it
 *  reached: a wake that reached nothing has no return value anyone sees. */
const fired = [];

/** The family the agent node runs, as `agent.agents` answers it: the node's own agent first, then the
 *  sub-agents it started. A test may add one (`create_agent`) or drop one (a destroyed sub-agent). */
const FAMILY = [
  { name: 'agent', parent: null },
  { name: 'writer', parent: 'agent' },
];
let familyRows = FAMILY.map((row) => ({ ...row }));

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
    /** Keep this node posted on the timer's topic, so a test reads what a wake reported the way a page
     *  does - from the event, not from a return value nobody sees. */
    watch: async () => {
      await this.ctx.subscribe?.('timer', 'timer');
      return 'watching';
    },
  };

  onEvent(topic, value) {
    if (topic === 'timer') fired.push(value);
  }
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
            watch: { type: 'object', properties: {} },
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

  /** Keep this page's node posted on the timer's topic, the way the page's own feed is. */
  async watch() {
    return await this.#host.invoke({
      id: randomUUID(),
      type: 'call',
      from: 'webui',
      to: 'webui',
      tenantId: this.#user,
      deadline: Date.now() + 10_000,
      payload: { cap: 'watch', args: {} },
    });
  }

  async close() {
    await this.#host?.stop();
  }
}

/** The agent node as this test hosts it: the family it runs (`agents`, the read the page's picker is
 *  drawn from and the one a wake is resolved against) and the single capability a timer reaches it by
 *  (`chat_no_wait`, which names a sub-agent with `agent` and the family's own agent with nothing). A
 *  name this node does not run is refused the way the real node refuses it. */
class AgentsNode extends Node {
  handlers = {
    agents: async () => ({
      agents: familyRows.map((row) => ({
        ...row,
        topic:
          row.parent === null ? 'agent' : `${row.parent === 'agent' ? 'agent' : row.parent}.${row.name}`,
        state: 'idle',
        children: 0,
      })),
    }),
    chat_no_wait: async (args) => {
      const name = typeof args.agent === 'string' ? args.agent : '';
      if (name !== '' && !familyRows.some((row) => row.name === name && row.parent !== null))
        throw new Error(
          `no agent named "${name}" here (agents: ${familyRows.map((row) => row.name).join(', ')})`,
        );
      // The tenant is the point: a timer is set in a tenant and must fire there, so the wake has to
      // arrive with the caller's tenant and not with whichever one this process joined under.
      woken.push({ ...args, tenantId: this.ctx.tenantId });
      return 'queued';
    },
  };
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
  // Every run starts on the same family and with nothing woken or published yet: several tests read
  // these, and a count left over from the run before would be read as a wake of this one.
  handed.length = 0;
  woken.length = 0;
  fired.length = 0;
  familyRows = FAMILY.map((row) => ({ ...row }));
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
  let agentHost = null;
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
    await page.watch();

    // The agent node: the family a wake is resolved against, and the node a timer on an agent is
    // woken through. Its manifest names no caller for either capability, exactly as the real one's
    // does not, so this is the permission path a timer runs on.
    agentHost = new NodeHost({
      definition: {
        manifest: {
          packageId: 'test-agent',
          name: 'agent',
          desc: 'the agents of this family',
          version: '0.0.0',
          publisher: 'test',
          icon: '<svg/>',
          caps: {
            agents: { type: 'object', properties: {}, expose: true },
            chat_no_wait: { type: 'object', properties: {}, expose: true },
          },
        },
        Node: AgentsNode,
      },
      bus: new WebSocketBusSession(),
    });
    await agentHost.start(bus.url, token);
    await fixture.admit('agent');

    // One session for both halves of the system node, and a scheduler that belongs to the SERVICE
    // tenant - what `system/src/serve.ts` used to install, and what a runtime's workers are launched
    // under (`NODE_AGENT_TENANT`). The page and its timers live in `user`, so no timer may be stored
    // or fired here: the node has to keep one queue per tenant of its own (see SystemNode).
    const systemSession = new WebSocketBusSession();
    scheduler = new SystemScheduler(systemSession, SERVICE_TENANT);
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

    return await run({ bus, caller: page, tenantId: user, admit: fixture.admit });
  } finally {
    setSystemScheduler(null);
    scheduler?.stop();
    try {
      await timerHost?.stop();
    } catch {}
    try {
      await agentHost?.stop();
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
  // A timer always names the agent it wakes: there is no caller default to fall back to.
  const set = manifest.caps.set;
  assert.deepEqual([...(set.required ?? [])].sort(), ['agent', 'message']);
});

test('a timer is set only when it names the agent it wakes', async () => {
  await withTimer(async ({ caller }) => {
    const set = await caller.call('timer.set', { after_seconds: 300, message: 'no target' });
    assert.equal(set.ok, false);
    assert.match(set.error, /needs "agent"/);

    const listed = await caller.call('timer.list', {});
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.value, [], 'nothing was scheduled');
  });
});

test('a countdown is set, listed, fired at the target through chat_no_wait, then gone', async () => {
  await withTimer(async ({ caller }) => {
    // 1. the page sets a 0.1s countdown back on itself
    const set = await caller.call('timer.set', {
      after_seconds: 0.1,
      agent: 'webui',
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

// The picker on both timer forms is drawn from `agent.agents`, and the node that asks for it is webui
// — the node every panel's `/call` speaks as. The agent node names no caller for that cap, so the bus
// holds it to its default policy and the system node answers the browser shell with allow: there is
// nothing for the timer package to declare, and no manifest of its to change.
test("a page's node may ask the agent node which agents it runs", async () => {
  await withTimer(async ({ caller }) => {
    const answer = await caller.call('agent.agents');
    assert.equal(answer.ok, true, `agent.agents was refused: ${answer.error}`);
    assert.deepEqual(
      answer.value.agents.map((row) => row.name),
      ['agent', 'writer'],
    );
  });
});

// A target is resolved the same way at both ends of a timer's life: `set` describes it, `wake` reaches
// it. A name the family runs is woken through the agent node - with `agent` for a sub-agent, without
// it for the family's own - and every other name is a node that answers `chat_no_wait` itself, which
// is what this node has always done and what an older timer set on another node still needs.
test("a timer on the family's own agent wakes it without naming an agent", async () => {
  await withTimer(async ({ caller, tenantId }) => {
    const set = await caller.call('timer.set', {
      after_seconds: 0.1,
      agent: 'agent',
      message: 'wake the family',
    });
    assert.equal(set.ok, true, `timer.set failed: ${set.error}`);
    assert.match(set.value, /^set timer id=1: countdown wakes agent /);
    assert.equal(set.value.includes('no agent named'), false, 'a known agent needs no note');

    await waitFor(() => woken.length > 0, 'the chat_no_wait wake');
    assert.equal(woken.length, 1);
    // The family's own agent is what the node is: no `agent` argument, exactly what it accepts today.
    assert.equal(woken[0].agent, undefined);
    assert.equal(woken[0].msg.role, 'system');
    // The regression this harness now pins: the system node's process-wide scheduler belongs to the
    // service tenant, and a wake that fired there would reach that tenant's agent instead of the one
    // whose page set the timer (and would publish its `fire` event where no page is listening).
    assert.equal(woken[0].tenantId, tenantId, 'the wake reached the tenant that set the timer');
    assert.match(woken[0].msg.content, /wake the family$/);
    assert.equal(caller.handed.length, 0, 'the page is not what an agent target wakes');
  });
});

test('a timer on a sub-agent names it in the wake', async () => {
  await withTimer(async ({ caller, tenantId }) => {
    const set = await caller.call('timer.set', {
      after_seconds: 0.1,
      agent: 'writer',
      priority: 'interpret',
      message: 'for the writer',
    });
    assert.equal(set.ok, true, `timer.set failed: ${set.error}`);
    assert.match(set.value, /^set timer id=1: countdown wakes writer /);

    await waitFor(() => woken.length > 0, 'the chat_no_wait wake');
    assert.equal(woken.length, 1);
    assert.equal(woken[0].agent, 'writer');
    assert.equal(woken[0].tenantId, tenantId);
    assert.equal(woken[0].priority, 'interpret');
    assert.match(woken[0].msg.content, /for the writer$/);
    assert.equal(caller.handed.length, 0);
  });
});

test('a timer on a node that is not an agent still calls that node itself', async () => {
  await withTimer(async ({ caller }) => {
    const set = await caller.call('timer.set', {
      after_seconds: 0.1,
      agent: 'webui',
      message: 'plain node',
    });
    assert.equal(set.ok, true, `timer.set failed: ${set.error}`);

    await waitFor(() => caller.handed.length > 0, 'the node wake');
    assert.equal(caller.handed[0].agent, undefined);
    assert.match(caller.handed[0].msg.content, /plain node$/);
    assert.equal(woken.length, 0, 'the agent node was not asked to wake anything');
  });
});

// A name that is neither an agent nor a node is not refused when the timer is set - it may be a
// sub-agent the model is about to create - so the wake is where it has to be told, and it says so on
// the event instead of reporting it as a successful wake.
test('a timer on a name that is neither an agent nor a node reports what it could not reach', async () => {
  await withTimer(async ({ caller }) => {
    const set = await caller.call('timer.set', {
      after_seconds: 0.1,
      agent: 'ghost',
      message: 'nobody home',
    });
    assert.equal(set.ok, true, `timer.set failed: ${set.error}`);
    assert.match(set.value, /no agent named "ghost" is running yet/);

    await waitFor(() => fired.some((event) => event.type === 'fire'), 'the fire event');
    const fire = fired.find((event) => event.type === 'fire');
    assert.equal(fire.woke, false);
    // No name is invented here: the call that failed is the bus's, and its answer names the target.
    assert.match(fire.error, /ghost/);
    assert.equal(woken.length, 0);
    assert.equal(caller.handed.length, 0);

    // Nothing is left pending: a wake that reached nothing does not repeat.
    const listed = await caller.call('timer.list', {});
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.value, []);
  });
});

// A sub-agent destroyed between the timer being set and the timer firing is the other half of the
// same question: the wake says which name reached nothing, not that everything was fine.
test('a timer on a sub-agent that is gone by the time it fires reports it', async () => {
  await withTimer(async ({ caller }) => {
    const set = await caller.call('timer.set', {
      after_seconds: 0.2,
      agent: 'writer',
      message: 'too late',
    });
    assert.equal(set.ok, true, `timer.set failed: ${set.error}`);
    // `destroy_agent writer`, as the family would see it on its next read.
    familyRows = familyRows.filter((row) => row.name !== 'writer');

    await waitFor(() => fired.some((event) => event.type === 'fire'), 'the fire event');
    const fire = fired.find((event) => event.type === 'fire');
    assert.equal(fire.woke, false);
    assert.match(fire.error, /writer/);
    assert.equal(woken.length, 0);
  });
});

// A repeat is re-armed by the wake itself, from the payload the system node kept: the target is part
// of that payload, so the next alarm has to name the same agent the first one did.
test('a repeating timer re-arms with the same target', async () => {
  await withTimer(async ({ caller }) => {
    const at = new Date(Date.now() + 200).toISOString();
    const set = await caller.call('timer.set', {
      mode: 'alarm',
      at,
      agent: 'writer',
      repeat: 'daily',
      message: 'daily for the writer',
    });
    assert.equal(set.ok, true, `timer.set failed: ${set.error}`);
    assert.match(set.value, /, daily$/);

    await waitFor(() => woken.length > 0, 'the first wake');
    assert.equal(woken[0].agent, 'writer');

    await waitFor(async () => {
      const answer = await caller.call('timer.list', {});
      assert.equal(answer.ok, true, `timer.list failed: ${answer.error}`);
      return answer.value.length === 1;
    }, 'the re-armed timer');
    const listed = await caller.call('timer.list', {});
    const [next] = listed.value;
    assert.equal(next.target, 'writer');
    assert.equal(next.repeat, 'daily');
    assert.equal(next.id, 1);
    assert.ok(Date.parse(next.next_at) > Date.now(), 'the next alarm is in the future');
  });
});
