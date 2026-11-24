// A search must never be able to hold the process. The engine is RE2 now (linear, so the pattern
// that used to pin a core answers at once) and the thread the match runs in is the second line of
// defence behind it: a search that still runs long is killed at its budget.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoryScope } from './memory-scope.ts';
import { Cache } from '../src/cache.ts';

const memoryHistory = memoryScope;

test('a catastrophic pattern is answered at once, not left to run', async () => {
  const cache = new Cache(2, memoryHistory());
  const id = await cache.add('a'.repeat(200_000));
  const started = Date.now();
  // A backtracking engine never finishes this; RE2 is linear in the text.
  assert.deepEqual(await cache.search(id, '(a+)+b', 10, 5_000), []);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `finished in ${elapsed}ms`);
});

test('a search that runs past its budget is stopped by killing the thread', async () => {
  const cache = new Cache(2, memoryHistory());
  const id = await cache.add('a'.repeat(200_000));
  const started = Date.now();
  await assert.rejects(
    cache.search(id, 'a', 10, 1),
    /took longer than .*use a simpler pattern/,
    'the budget is what answers, not the regex',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, 'the thread is killed, not waited on');
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
