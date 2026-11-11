// ctx.bind / ctx.unbind: the one thing the host keeps for a node, and the only thing it holds for it.
//
// The host never looks inside what a node binds - it cannot, it is an opaque reference - so every
// case here proves the same four things from the outside: which object came back, how many times the
// factory ran, what was called on it (nothing), and what survived a host stop.
import assert from 'node:assert/strict';
import { Node, NodeHost, requireBindings } from './dist/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One Node class for every case; what it counts lives in the test, not in the node. */
let serial = 0;
const instances = [];
const disposed = [];
let factories = 0;
let disposedObjects = 0;

class KeepNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.id = ++serial;
    instances.push(this.id);
  }

  handlers = {
    // Binds a counter under a key and bumps it: two calls that see 1 and 2 are two calls on one object.
    touch: async (args) => {
      const counter = this.ctx.bind(args.key, () => {
        factories += 1;
        return { key: args.key, tenant: this.ctx.tenantId, hits: 0 };
      });
      counter.hits += 1;
      return {
        hits: counter.hits,
        key: counter.key,
        tenant: counter.tenant,
        ref: counter,
        instance: this.id,
      };
    },
    // Binds after an await, so several invocations reach the factory region at once.
    race: async () => {
      await sleep(1);
      const counter = this.ctx.bind('race', () => {
        factories += 1;
        return { hits: 0 };
      });
      counter.hits += 1;
      return { hits: counter.hits, instance: this.id };
    },
    boom: async () => {
      this.ctx.bind('boom', () => {
        factories += 1;
        throw new Error('factory failed');
      });
      return 'unreachable';
    },
    drop: async (args) => this.ctx.unbind(args.key),
    // What a node that keeps something actually writes: one helper call, then the surface.
    surface: async () => {
      const { bind, unbind } = requireBindings(this.ctx);
      const object = bind('counter', () => ({ ok: true }));
      return { bound: object.ok, dropped: unbind('counter'), again: unbind('counter') };
    },
    // Binds an object that would have to be disposed, then forgets it: the host must not call it.
    noop: async () => {
      this.ctx.bind('noop', () => {
        factories += 1;
        return {
          dispose: () => {
            disposedObjects += 1;
          },
        };
      });
      const existed = this.ctx.unbind('noop');
      const again = this.ctx.unbind('noop');
      return { existed, again, disposed: disposedObjects };
    },
    // The factory unbinds its own key while it is still running: the outer bind must not cache it.
    reenter: async () => {
      let unbound = null;
      const object = this.ctx.bind('reenter', () => {
        factories += 1;
        unbound = this.ctx.unbind('reenter');
        return { made: factories };
      });
      return { made: object.made, unbound, ref: object };
    },
  };

  dispose() {
    disposed.push(this.id);
  }
}

const manifest = (bindings) => ({
  packageId: 'pkg_keep',
  name: 'keep',
  caps: Object.fromEntries(
    ['touch', 'race', 'boom', 'drop', 'noop', 'reenter', 'surface'].map((cap) => [cap, { type: 'object' }]),
  ),
  desc: 'bind test node',
  version: '1.0.0',
  publisher: 'node-agent',
  icon: '<svg></svg>',
  ...(bindings === undefined ? {} : { bindings }),
});

const DECLARED = ['counter', 'other', 'race', 'boom', 'noop', 'reenter'];

function bus() {
  return {
    async connect() {},
    async close() {},
    async register() {},
    async unregister() {},
    onCall() {},
    async listNodes() {
      return [];
    },
    async reply() {},
    async call() {
      throw new Error('no bus in this test');
    },
    publish() {},
  };
}

/** A host over one manifest; `null` asks for a node that declared no bindings at all. */
async function openHost(bindings = DECLARED) {
  const declared = bindings === null ? undefined : bindings;
  const host = new NodeHost({
    definition: { manifest: manifest(declared), Node: KeepNode },
    bus: bus(),
  });
  await host.start('ws://bus', 'token');
  return host;
}

/** One fresh Node per invocation, invoked the way the bus invokes it. */
async function call(host, cap, args = {}, tenantId = 'tenant-a') {
  const outcome = await host.invoke({
    id: `${cap}-${Math.random()}`,
    type: 'call',
    from: 'agent',
    to: 'keep',
    tenantId,
    deadline: Date.now() + 10_000,
    payload: { cap, args },
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}

{
  // Same tenant, same key: one object, made once, and the same one on every later invocation.
  factories = 0;
  const host = await openHost();

  const first = await call(host, 'touch', { key: 'counter' });
  const second = await call(host, 'touch', { key: 'counter' });
  const third = await call(host, 'touch', { key: 'counter' });
  assert.equal(first.hits, 1);
  assert.equal(second.hits, 2);
  assert.equal(third.hits, 3);
  assert.equal(factories, 1);
  assert.equal(first.ref, third.ref);
  assert.equal(third.tenant, 'tenant-a');

  // …and never the instance it was bound from: every invocation still gets a new Node.
  assert.notEqual(first.instance, second.instance);
  assert.ok(disposed.includes(first.instance));

  // Different key, same tenant: a different object, its own factory run.
  const other = await call(host, 'touch', { key: 'other' });
  assert.equal(other.hits, 1);
  assert.equal(other.key, 'other');
  assert.equal(factories, 2);
  assert.equal((await call(host, 'touch', { key: 'counter' })).hits, 4);

  // Different tenant, same key: a different object.
  const foreign = await call(host, 'touch', { key: 'counter' }, 'tenant-b');
  assert.equal(foreign.hits, 1);
  assert.equal(foreign.tenant, 'tenant-b');
  assert.equal(factories, 3);
  assert.notEqual(foreign.ref, first.ref);
  assert.equal((await call(host, 'touch', { key: 'counter' })).hits, 5);
  assert.equal((await call(host, 'touch', { key: 'counter' }, 'tenant-b')).hits, 2);

  // unbind: the object is gone, and the next bind makes a new one.
  assert.equal(await call(host, 'drop', { key: 'counter' }), true);
  assert.equal(await call(host, 'drop', { key: 'counter' }), false, 'there was nothing left to drop');
  const remade = await call(host, 'touch', { key: 'counter' });
  assert.equal(remade.hits, 1);
  assert.notEqual(remade.ref, first.ref);
  assert.equal(factories, 4);

  // …and only for the tenant that asked: tenant-b kept its own.
  assert.equal((await call(host, 'touch', { key: 'counter' }, 'tenant-b')).hits, 3);
  assert.equal(await call(host, 'drop', { key: 'counter' }, 'tenant-b'), true);
  assert.equal((await call(host, 'touch', { key: 'counter' })).hits, 2, 'tenant-a was not touched');

  // A factory that throws caches nothing: the failure reaches the caller, the next bind retries.
  await assert.rejects(() => call(host, 'boom'), /factory failed/);
  const before = factories;
  await assert.rejects(() => call(host, 'boom'), /factory failed/);
  assert.equal(factories, before + 1);

  await host.stop();
}

{
  // The host drops the reference and calls nothing on it: disposing is the node's own business.
  factories = 0;
  disposedObjects = 0;
  const host = await openHost();
  const result = await call(host, 'noop');
  assert.equal(result.existed, true);
  assert.equal(result.again, false);
  assert.equal(result.disposed, 0, 'unbind must not call dispose on what it drops');
  assert.equal(factories, 1);

  // requireBindings hands a host context its surface, without the handler testing the members.
  const surface = await call(host, 'surface');
  assert.deepEqual(surface, { bound: true, dropped: true, again: false });

  await host.stop();
}

{
  // A factory that unbinds its own key: the unbind wins, and the object it made is not cached.
  factories = 0;
  const host = await openHost();
  const first = await call(host, 'reenter');
  const second = await call(host, 'reenter');
  assert.equal(first.made, 1);
  assert.equal(second.made, 2, 'the first object was never put back into the table');
  assert.notEqual(first.ref, second.ref);
  assert.equal(first.unbound, false, 'nothing was cached yet when the factory unbound');
  assert.equal(factories, 2);
  await host.stop();
}

{
  // Declared or not: a key nobody declared is refused, by bind and by unbind alike.
  const host = await openHost();
  await assert.rejects(
    () => call(host, 'touch', { key: 'secret' }),
    /does not declare a binding named secret/,
  );
  await assert.rejects(() => call(host, 'drop', { key: 'secret' }), /binding named secret/);
  await assert.rejects(() => call(host, 'touch', { key: 'Not A Key' }), /wants a binding name/);

  const undeclared = await openHost(null);
  await assert.rejects(() => call(undeclared, 'touch', { key: 'counter' }), /declares no bindings/);
  await assert.rejects(() => call(undeclared, 'drop', { key: 'counter' }), /declares no bindings/);
  await undeclared.stop();

  await host.stop();
}

{
  // Several invocations binding one key at once: one factory run, one object, every caller served.
  factories = 0;
  const host = await openHost();

  const results = await Promise.all(Array.from({ length: 8 }, () => call(host, 'race')));
  assert.equal(factories, 1);
  assert.deepEqual(
    results.map((result) => result.hits).sort((left, right) => left - right),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(new Set(results.map((result) => result.instance)).size, 8);

  await host.stop();
}

{
  // host.stop drops the reference: nothing survives into the next host.
  factories = 0;
  const host = await openHost();
  const before = await call(host, 'touch', { key: 'counter' });
  assert.equal(before.hits, 1);

  await host.stop();
  const late = await host.invoke({
    id: 'late',
    type: 'call',
    from: 'agent',
    to: 'keep',
    tenantId: 'tenant-a',
    deadline: Date.now() + 1_000,
    payload: { cap: 'touch', args: { key: 'counter' } },
  });
  assert.equal(late.ok, false);
  assert.match(late.error, /host is (not started|stopped)/);

  // A new host is a new table: the same key is a new object, not the one the stopped host kept.
  const next = await openHost();
  const after = await call(next, 'touch', { key: 'counter' });
  assert.equal(after.hits, 1);
  assert.notEqual(after.ref, before.ref);
  assert.equal(factories, 2);
  await next.stop();
}


{
  // The factory gets a scope, not the invocation's context: identity plus the host's bus, still
  // usable after the call that made the object has been answered (and its deadline has passed).
  const calls = [];
  const published = [];
  const scopedBus = {
    ...bus(),
    async call(envelope) {
      calls.push(envelope);
      return {
        id: envelope.id,
        type: 'result',
        from: envelope.to,
        to: envelope.to,
        tenantId: envelope.tenantId,
        payload: { ok: true, value: 'ok' },
      };
    },
    publish(event) {
      published.push(event);
    },
  };

  class ScopeNode extends Node {
    handlers = {
      bindScope: async () => {
        const kept = this.ctx.bind('surface', (scope) => ({ scope }));
        // After this handler returns (the invocation is over, its deadline is already gone) the
        // object still has to reach the bus - through the scope, the only bus it kept.
        setTimeout(() => {
          void kept.scope.call('echo', 'say', { text: 'late' });
          kept.scope.publish('topic', { late: true });
        }, 0);
        return { tenant: kept.scope.tenantId, nodeId: kept.scope.nodeId };
      },
    };
  }

  const scopeManifest = {
    ...manifest(['surface']),
    name: 'scope',
    packageId: 'scope',
    caps: { bindScope: { type: 'object' } },
  };
  const host = new NodeHost({
    definition: { manifest: scopeManifest, Node: ScopeNode },
    bus: scopedBus,
  });
  await host.start('ws://bus', 'token');

  const outcome = await host.invoke({
    id: 'scope-1',
    type: 'call',
    from: 'agent',
    to: 'scope',
    tenantId: 't-scope',
    // Already expired: a context-based bus would refuse, the scope must not.
    deadline: Date.now() - 1,
    payload: { cap: 'bindScope', args: {} },
  });
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
  assert.deepEqual(outcome.value, { tenant: 't-scope', nodeId: 'scope' });

  await sleep(20);
  assert.equal(calls.length, 1, 'the bound object called the bus after the invocation ended');
  assert.equal(calls[0].tenantId, 't-scope');
  assert.equal(published.length, 1, 'the bound object published after the invocation ended');
  assert.equal(published[0].tenantId, 't-scope');
  await host.stop();
}

console.log('bind smoke ok');
