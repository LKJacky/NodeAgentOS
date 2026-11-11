// During a cold runtime start the system node can be asked to authorize before history has joined.
// Authorization must still answer from defaults, and a later start must retry loading the overrides.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemScheduler, type SchedulerBus } from '../src/scheduler.ts';
import type { OutboundCallEnvelope, ResultEnvelope } from '@node-agent/sdk';

function result(call: OutboundCallEnvelope, payload: ResultEnvelope['payload']): ResultEnvelope {
  return {
    id: 'result',
    type: 'result',
    from: 'history',
    to: 'system',
    replyTo: call.id,
    tenantId: call.tenantId,
    payload,
  };
}

test('authorization works before history is available, then loads overrides on retry', async () => {
  let historyReady = false;
  const bus = {
    async call(call: OutboundCallEnvelope): Promise<ResultEnvelope> {
      if (!historyReady)
        return result(call, { ok: false, error: 'no such node for user: history' });
      if (call.payload.cap === 'load') return result(call, { ok: true, value: { unit: null } });
      return result(call, { ok: true, value: { unit: { meta: {}, revision: 1 } } });
    },
  } as unknown as SchedulerBus;

  const scheduler = new SystemScheduler(bus, 'cold-start');
  const args = {
    caller: 'agent',
    target: 'shell',
    cap: 'exec',
    defaultCallers: ['*'],
  };

  assert.deepEqual(await scheduler.authorize(args), { allow: true });
  assert.equal(await scheduler.language(), 'en');

  historyReady = true;
  await scheduler.start();
  assert.deepEqual(await scheduler.authorize(args), { allow: true });
});
