// The cache of trimmed lines: one history unit per entry, a counter of its own, a bounded size, and
// the two tools the model reads it back with.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache, type CacheHistory } from '../src/cache.ts';
import { ScriptedProvider } from './scripted_model.ts';
import { FakeNet, startAgent } from './harness.ts';

function memoryHistory(): CacheHistory & {
  units: Map<string, { meta: unknown; revision: number }>;
} {
  const units = new Map<string, { meta: unknown; revision: number }>();
  let revision = 0;
  return {
    units,
    async load(unitId) {
      const unit = units.get(unitId);
      return unit === undefined ? null : { meta: unit.meta, revision: unit.revision };
    },
    async save(unitId, meta, expectedRevision) {
      const current = units.get(unitId);
      if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) {
        throw new Error('revision conflict');
      }
      revision += 1;
      units.set(unitId, { meta, revision });
      return revision;
    },
    async remove(unitId) {
      units.delete(unitId);
    },
  };
}

test('an entry is written, read in slices, searched, and numbered across restarts', async () => {
  const history = memoryHistory();
  const cache = new Cache(3, history);
  const text = 'alpha beta gamma delta';
  const id = await cache.add(text);
  assert.equal(id, 1);
  assert.equal(await cache.read(id), text);
  assert.equal(await cache.read(id, 6, 4), 'beta');
  assert.deepEqual(await cache.ids(), [1]);
  const matches = await cache.search(id, 'beta', 2);
  assert.deepEqual(matches, [{ entry: 1, position: 6, text: 'a beta g' }]);
  await assert.rejects(() => cache.search(id, '(', 2), /not a valid regular expression/);

  // A second process continues the numbering rather than reusing it.
  const restarted = new Cache(3, history);
  await restarted.restore();
  assert.equal(await restarted.add('next'), 2);
});

test('the oldest entry leaves when one past the size arrives', async () => {
  const cache = new Cache(2, memoryHistory());
  await cache.add('one');
  await cache.add('two');
  const third = await cache.add('three');
  assert.equal(third, 3);
  assert.equal(await cache.read(1), null);
  assert.equal(await cache.read(3), 'three');
  assert.deepEqual(await cache.ids(), [2, 3]);
});

test('a cache with no history node still answers, and holds nothing', async () => {
  const cache = new Cache(5, null);
  assert.equal(cache.enabled, false);
  assert.equal(await cache.add('text'), 1);
  assert.equal(await cache.read(1), null);
  assert.deepEqual(await cache.ids(), []);
});

test('a trimmed line keeps its whole text in the cache and says where', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({
    net,
    provider: new ScriptedProvider(),
    runtime: { maxInputPerTurn: 40 },
  });
  try {
    const runtime = agent.runtime;
    await runtime.ready();
    const long = 'x'.repeat(200);
    const kept = await runtime.shrink(long, 40);
    assert.match(
      kept,
      /<warning>Inputted Context is too long over the maximum allowed length of 40/,
    );
    const at = /cache entry (\d+)/.exec(kept);
    assert.ok(at !== null, 'the warning names the entry');
    assert.equal(await runtime.cache.read(Number(at[1])), long, 'nothing was thrown away');
  } finally {
    await agent.stop();
  }
});

test('the read_cache and search_cache tools answer the model', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, provider: new ScriptedProvider() });
  try {
    const runtime = agent.runtime;
    await runtime.ready();
    const id = await runtime.cache.add('needle in a haystack');
    const read = await runtime.env?.execute({
      id: 'call_1',
      type: 'function',
      function: {
        name: 'read_cache',
        arguments: JSON.stringify({ entry: id, start: 0, length: 6 }),
      },
    });
    assert.equal(read, 'needle');
    const searched = await runtime.env?.execute({
      id: 'call_2',
      type: 'function',
      function: { name: 'search_cache', arguments: JSON.stringify({ entry: id, pattern: 'hay' }) },
    });
    assert.deepEqual(JSON.parse(String(searched)), [
      { entry: id, position: 12, text: 'needle in a haystack' },
    ]);
    const none = await runtime.env?.execute({
      id: 'call_3',
      type: 'function',
      function: { name: 'read_cache', arguments: JSON.stringify({ entry: 99 }) },
    });
    assert.match(String(none), /no cache entry 99/);
  } finally {
    await agent.stop();
  }
});
