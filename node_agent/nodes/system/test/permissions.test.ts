import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutboundCallEnvelope, ResultEnvelope, ToolArgs } from '@node-agent/sdk';
import { SystemScheduler } from '../src/scheduler.ts';

interface Unit {
  meta: unknown;
  revision: number;
}

class FakeHistoryBus {
  readonly units = new Map<string, Unit>();

  async call(call: OutboundCallEnvelope): Promise<ResultEnvelope> {
    const args = call.payload.args as ToolArgs;
    const unitId = String(args.unitId);
    if (call.payload.cap === 'load') {
      return this.reply({ unit: this.units.get(unitId) ?? null });
    }
    if (call.payload.cap === 'save') {
      const previous = this.units.get(unitId);
      const revision = (previous?.revision ?? 0) + 1;
      const meta = args.meta;
      this.units.set(unitId, { meta, revision });
      return this.reply({ unit: { meta, revision } });
    }
    return this.reply({});
  }

  private reply(value: unknown): ResultEnvelope {
    return {
      id: 'reply',
      type: 'result',
      from: 'history',
      to: 'system',
      replyTo: 'call',
      tenantId: 'tenant',
      payload: { ok: true, value },
    };
  }
}

const tenant = 'a'.repeat(64);

async function scheduler(bus: FakeHistoryBus): Promise<SystemScheduler> {
  const s = new SystemScheduler(bus, tenant);
  await s.start();
  return s;
}

test('default callers and stored overrides decide authorize', async () => {
  const bus = new FakeHistoryBus();
  const s = await scheduler(bus);
  const allowed = await s.authorize({
    caller: 'agent',
    target: 'shell',
    cap: 'exec',
    defaultCallers: ['agent'],
  });
  assert.equal(allowed.allow, true);
  const denied = await s.authorize({
    caller: 'store',
    target: 'shell',
    cap: 'exec',
    defaultCallers: ['agent'],
  });
  assert.equal(denied.allow, false);

  await s.setPermission('shell', 'exec', ['store']);
  assert.equal(
    (
      await s.authorize({
        caller: 'store',
        target: 'shell',
        cap: 'exec',
        defaultCallers: ['agent'],
      })
    ).allow,
    true,
  );
  assert.equal(
    (
      await s.authorize({
        caller: 'agent',
        target: 'shell',
        cap: 'exec',
        defaultCallers: ['agent'],
      })
    ).allow,
    false,
  );
});

test('an override survives a scheduler restart and can be cleared', async () => {
  const bus = new FakeHistoryBus();
  const first = await scheduler(bus);
  await first.setPermission('provider', 'chat_stream', ['agent']);

  const second = await scheduler(bus);
  const view = await second.permission('provider', 'chat_stream', ['*']);
  assert.deepEqual(view.callers, ['agent']);
  assert.equal(view.source, 'override');
  assert.equal(
    (
      await second.authorize({
        caller: 'agent',
        target: 'provider',
        cap: 'chat_stream',
        defaultCallers: ['*'],
      })
    ).allow,
    true,
  );

  await second.clearPermission('provider', 'chat_stream');
  const cleared = await second.permission('provider', 'chat_stream', ['*']);
  assert.deepEqual(cleared.callers, ['*']);
  assert.equal(cleared.source, 'default');
});

test('an unspecified list allows everyone, but an explicitly empty list allows nobody', async () => {
  const s = await scheduler(new FakeHistoryBus());
  const unspecified = await s.authorize({
    caller: 'agent',
    target: 'shell',
    cap: 'exec',
  });
  assert.equal(unspecified.allow, true);

  const empty = await s.authorize({
    caller: 'agent',
    target: 'shell',
    cap: 'exec',
    defaultCallers: [],
  });
  assert.equal(empty.allow, false);

  const emptyView = await s.permission('shell', 'exec', []);
  assert.deepEqual(emptyView.callers, []);
  assert.deepEqual(emptyView.defaultCallers, []);
  assert.equal(emptyView.source, 'default');
});

test('a node always reaches its own capabilities', async () => {
  const s = await scheduler(new FakeHistoryBus());
  const self = await s.authorize({
    caller: 'shell',
    target: 'shell',
    cap: 'exec',
    defaultCallers: [],
  });
  assert.equal(self.allow, true);

  await s.setPermission('shell', 'exec', []);
  const withEmptyOverride = await s.authorize({
    caller: 'shell',
    target: 'shell',
    cap: 'exec',
    defaultCallers: [],
  });
  assert.equal(withEmptyOverride.allow, true);
});

test('expose false allows only the owner and its webui page', async () => {
  const s = await scheduler(new FakeHistoryBus());
  const base = {
    target: 'shell',
    cap: 'exec',
    defaultCallers: ['*'],
    expose: false,
  } as const;
  assert.equal((await s.authorize({ ...base, caller: 'shell' })).allow, true);
  assert.equal((await s.authorize({ ...base, caller: 'webui' })).allow, true);
  const denied = await s.authorize({ ...base, caller: 'agent' });
  assert.equal(denied.allow, false);
  assert.match(String(denied.reason), /not exposed/);
});

test('permission rows carry editable and exposed flags', async () => {
  const s = await scheduler(new FakeHistoryBus());
  const row = await s.permission('shell', 'exec', ['agent'], false, false);
  assert.equal(row.editable, false);
  assert.equal(row.exposed, false);
});

test('webui is always allowed without being listed in callers', async () => {
  const s = await scheduler(new FakeHistoryBus());
  const allowed = await s.authorize({
    caller: 'webui',
    target: 'shell',
    cap: 'exec',
    defaultCallers: [],
  });
  assert.equal(allowed.allow, true);
});

test('the service control plane may reach an unexposed cap', async () => {
  const s = await scheduler(new FakeHistoryBus());
  const base = {
    target: 'userpage',
    cap: 'configure',
    tenant: '0'.repeat(64),
    defaultCallers: [],
    expose: false,
  };
  const control = await s.authorize({ ...base, caller: 'runtime-control' });
  assert.equal(control.allow, true);
  const business = await s.authorize({ ...base, caller: 'agent', tenant: 'alice' });
  assert.equal(business.allow, false);
});

test('parallel permission edits are persisted as one serial sequence', async () => {
  const s = await scheduler(new FakeHistoryBus());
  await Promise.all([
    s.setPermission('shell', 'exec', ['agent']),
    s.setPermission('shell', 'write', ['agent']),
  ]);
  const rules = await s.overrides();
  assert.deepEqual(
    rules.map((rule) => [rule.target, rule.cap, rule.callers]),
    [
      ['shell', 'exec', ['agent']],
      ['shell', 'write', ['agent']],
    ],
  );
});

test('private targets default to allow and ignore old overrides', async () => {
  const s = await scheduler(new FakeHistoryBus());
  await s.setPermission('private-node', 'wake', []);

  assert.equal(
    (
      await s.authorize({
        caller: 'agent',
        target: 'private-node',
        cap: 'wake',
        defaultCallers: [],
        private: true,
      })
    ).allow,
    true,
  );
  assert.equal(
    (
      await s.authorize({
        caller: 'agent',
        target: 'private-node',
        cap: 'wake',
        expose: false,
        private: true,
      })
    ).allow,
    false,
  );
  assert.equal(
    (
      await s.authorize({
        caller: 'webui',
        target: 'private-node',
        cap: 'wake',
        expose: false,
        private: true,
      })
    ).allow,
    true,
  );

  const view = await s.permission('private-node', 'wake', ['*'], false, true, true);
  assert.deepEqual(view.callers, ['*']);
  assert.equal(view.source, 'default');
  assert.equal(view.editable, false);
});
