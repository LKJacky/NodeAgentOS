// A search must never be able to hold the process: the match runs in a thread the budget can kill.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cache, type CacheHistory } from '../src/cache.ts';

function memoryHistory(): CacheHistory {
  const units = new Map<string, unknown>();
  return {
    async load(unitId) {
      return units.has(unitId) ? { meta: units.get(unitId), revision: 1 } : null;
    },
    async save(unitId, meta) {
      units.set(unitId, meta);
      return 1;
    },
    async remove(unitId) {
      units.delete(unitId);
    },
  } as CacheHistory;
}

test('a pattern that never returns is stopped by the budget', async () => {
  const cache = new Cache(2, memoryHistory());
  const id = await cache.add('a'.repeat(64));
  const started = Date.now();
  await assert.rejects(
    cache.search(id, '(a+)+b', 10, 300),
    /took longer than .*use a simpler pattern/,
    'the budget is what answers, not the regex',
  );
  assert.ok(Date.now() - started < 5_000, 'the thread is killed, not waited on');
});

test('a search that finishes still answers every match with its window', async () => {
  const cache = new Cache(2, memoryHistory());
  const id = await cache.add('needle in a haystack, needle again');
  const matches = await cache.search(id, 'needle', 6, 5_000);
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.entry, id);
  assert.equal(matches[0]?.position, 0);
  assert.match(String(matches[0]?.text), /^needle in a/);
});
