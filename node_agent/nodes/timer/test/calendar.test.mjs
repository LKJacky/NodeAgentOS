// Calendar behavior at the timer capability boundary. The system scheduler receives absolute
// instants; freezing Date lets these cases exercise DST without waiting for a real clock change.
import assert from 'node:assert/strict';
import test from 'node:test';
import TimerNode from '../dist/system.js';

function fixture(t, now, timezone = 'America/New_York') {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const scheduled = [];
  const node = new TimerNode({
    from: 'webui',
    async call(target, cap, args) {
      if (target === 'system' && cap === 'timers') return [];
      if (target === 'system' && cap === 'add_timer') {
        scheduled.push(args);
        return;
      }
      if (target === 'webui' && cap === 'chat_no_wait') return 'queued';
      assert.fail(`unexpected call: ${target}.${cap}`);
    },
    publish() {},
  });
  return { node, scheduled };
}

for (const [season, before, after] of [
  ['spring', '2026-03-07T12:00:00-05:00', '2026-03-08T09:00:00-04:00'],
  ['autumn', '2026-10-31T12:00:00-04:00', '2026-11-01T09:00:00-05:00'],
]) {
  test(`a passed clock time stays at 09:00 tomorrow across ${season} DST`, async (t) => {
    const { node, scheduled } = fixture(t, before);
    await node.handlers.set({ at: '09:00', message: 'morning reminder' });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].at, new Date(after).toISOString());
  });
}

for (const [rule, before, after] of [
  ['daily', '2026-03-07T09:00:00-05:00', '2026-03-08T09:00:00-04:00'],
  ['daily', '2026-10-31T09:00:00-04:00', '2026-11-01T09:00:00-05:00'],
  ['weekly', '2026-03-06T09:00:00-05:00', '2026-03-13T09:00:00-04:00'],
  ['weekly', '2026-10-30T09:00:00-04:00', '2026-11-06T09:00:00-05:00'],
  ['weekdays', '2026-03-06T09:00:00-05:00', '2026-03-09T09:00:00-04:00'],
  ['weekdays', '2026-10-30T09:00:00-04:00', '2026-11-02T09:00:00-05:00'],
]) {
  test(`${rule} preserves local clock time after ${before}`, async (t) => {
    const { node, scheduled } = fixture(t, before);
    const result = await node.handlers.wake({
      id: 1, target: 'webui', message: 'morning reminder', mode: 'alarm',
      repeat: rule, firesAt: Date.parse(before),
    });
    assert.deepEqual(result, { woke: true, error: '' });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].at, new Date(after).toISOString());
  });
}

test('a weekday alarm set on the weekend advances to Monday at the same clock time', async (t) => {
  const { node, scheduled } = fixture(t, '2026-03-07T08:00:00-05:00');
  await node.handlers.set({ at: '09:00', repeat: 'weekdays', message: 'work reminder' });
  assert.equal(scheduled[0].at, '2026-03-09T13:00:00.000Z');
});

test('an overdue daily alarm skips missed days and keeps the local clock time', async (t) => {
  const { node, scheduled } = fixture(t, '2026-03-10T12:00:00-04:00');
  await node.handlers.wake({
    id: 1, target: 'webui', message: 'morning reminder', mode: 'alarm',
    repeat: 'daily', firesAt: Date.parse('2026-03-07T09:00:00-05:00'),
  });
  assert.equal(scheduled[0].at, '2026-03-11T13:00:00.000Z');
});

for (const before of ['2026-03-07T09:00:00-05:00', '2026-10-31T09:00:00-04:00']) {
  test(`countdowns retain elapsed-time semantics across DST after ${before}`, async (t) => {
    const { node, scheduled } = fixture(t, before);
    await node.handlers.set({ after_seconds: 86400, message: 'elapsed reminder' });
    await node.handlers.wake({
      id: 1, target: 'webui', message: 'elapsed reminder', mode: 'countdown',
      repeat: 'every:86400', firesAt: Date.parse(before),
    });
    assert.equal(scheduled.length, 2);
    for (const timer of scheduled) {
      assert.equal(Date.parse(timer.at) - Date.parse(before), 86400000);
    }
  });
}

test('daily alarms still advance one calendar day in a zone without DST', async (t) => {
  const { node, scheduled } = fixture(t, '2026-03-07T09:00:00+08:00', 'Asia/Shanghai');
  await node.handlers.wake({
    id: 1, target: 'webui', message: 'morning reminder', mode: 'alarm',
    repeat: 'daily', firesAt: Date.parse('2026-03-07T09:00:00+08:00'),
  });
  assert.equal(scheduled[0].at, '2026-03-08T01:00:00.000Z');
});
