// What the worker backend has to promise, which is more than the synchronous store does: the same
// answers, but the file is touched on threads of its own, so nothing on this one blocks — reads run
// beside each other, a read or a health probe does not wait for the writes queued ahead of it, a burst
// that cannot be served is refused instead of piling up, and a stop leaves nothing running.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_READER_COUNT,
  HistoryQueueFullError,
  MAX_READER_COUNT,
  RevisionConflictError,
  SqliteHistoryStore,
  UnitNotFoundError,
  WorkerHistoryStore,
  defaultReaderCount,
} from '../src/index.ts';

/** A store on a file of its own, and the directory it lives in, so a test can close it and open the
 *  same file again with something else. */
function storeOnFile(options: { readers?: number; queueLimit?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-history-worker-'));
  const path = join(directory, 'history.sqlite');
  const store = new WorkerHistoryStore({ path, ...options });
  return { directory, path, store };
}

/** One megabyte of JSON: big enough that writing it is real work for the writer thread. */
function payload(fill: string): { blob: string } {
  return { blob: fill.repeat(1024 * 1024) };
}

test('two readers by default, NODE_AGENT_HISTORY_READERS says otherwise, never more than four', () => {
  assert.equal(DEFAULT_READER_COUNT, 2);
  assert.equal(defaultReaderCount({}), 2);
  assert.equal(defaultReaderCount({ NODE_AGENT_HISTORY_READERS: '3' }), 3);
  // A typo costs a default, and a big number costs the ceiling — never a hundred threads on one file.
  assert.equal(defaultReaderCount({ NODE_AGENT_HISTORY_READERS: 'two' }), 2);
  assert.equal(defaultReaderCount({ NODE_AGENT_HISTORY_READERS: '0' }), 2);
  assert.equal(defaultReaderCount({ NODE_AGENT_HISTORY_READERS: '64' }), MAX_READER_COUNT);
});

test('refuses :memory:, where each worker would open a database of its own', () => {
  assert.throws(() => new WorkerHistoryStore({ path: ':memory:' }), /needs a file/);
});

test('keeps units the way the synchronous store does, in a file it opens again', async () => {
  const { directory, path, store } = storeOnFile();
  try {
    await store.ready();
    assert.equal(store.readerCount, 2);

    const first = await store.save('alice', 'search', 'settings', { limit: 5 });
    assert.equal(first.revision, 1);
    const second = await store.save('alice', 'search', 'settings', { limit: 6 }, 1);
    assert.equal(second.revision, 2);
    await store.save('alice', 'search', 'engines', ['deepseek']);
    await store.save('alice', 'agent', 'conversation', { messages: 0 });
    await store.save('bob', 'search', 'settings', { secret: true });

    assert.deepEqual(await store.load('alice', 'search', 'settings'), {
      revision: 2,
      meta: { limit: 6 },
      createdAt: second.createdAt,
      updatedAt: second.updatedAt,
    });
    assert.equal(await store.load('alice', 'search', 'missing'), null);

    assert.deepEqual(
      (await store.list('alice', 'search')).map((unit) => [unit.unitId, unit.revision]),
      [
        ['engines', 1],
        ['settings', 2],
      ],
    );

    const usage = await store.usage('alice');
    assert.deepEqual(
      usage.nodes.map((node) => [node.node, node.units]),
      [
        ['agent', 1],
        ['search', 2],
      ],
    );
    assert.equal(usage.units, 3);
    assert.equal((await store.usage('bob')).units, 1, 'one user never sees another user');

    // The refusals are the classes a caller catches, not strings that came back over a thread.
    await assert.rejects(store.save('alice', 'search', 'settings', {}, 1), RevisionConflictError);
    await assert.rejects(store.delete('alice', 'search', 'gone', 1), UnitNotFoundError);

    assert.equal(await store.reset('alice', 'search'), 2);
    assert.deepEqual(await store.list('alice', 'search'), []);
    await store.delete('alice', 'agent', 'conversation', 1);
    assert.equal((await store.usage('alice')).units, 0);
  } finally {
    await store.shutdown();
    rmSync(directory, { recursive: true });
  }
});

test('a save answers only once it is committed, so a read sees it and so does a new connection', async () => {
  const { directory, path, store } = storeOnFile();
  try {
    for (let round = 1; round <= 20; round += 1) {
      const saved = await store.save('alice', 'agent', 'conversation', { round });
      assert.equal(saved.revision, round);
      // Straight after the answer, from a reader thread on another connection: the same revision.
      assert.equal((await store.load('alice', 'agent', 'conversation'))?.revision, round);
    }
    // And from a connection this store knows nothing about: the commit is in the file, not waiting
    // for a flush that would happen after the answer.
    const other = new SqliteHistoryStore(path);
    try {
      assert.deepEqual(other.load('alice', 'agent', 'conversation')?.meta, { round: 20 });
    } finally {
      other.close();
    }

    await store.delete('alice', 'agent', 'conversation', 20);
    const gone = new SqliteHistoryStore(path);
    try {
      assert.equal(gone.load('alice', 'agent', 'conversation'), null);
    } finally {
      gone.close();
    }
  } finally {
    await store.shutdown();
    rmSync(directory, { recursive: true });
  }
});

test('reads run beside each other: many at once, all correct, across the readers', async () => {
  const { directory, store } = storeOnFile({ readers: 2 });
  try {
    await store.ready();
    await store.save('alice', 'search', 'settings', { limit: 5 });

    const reads = Array.from({ length: 100 }, () => store.load('alice', 'search', 'settings'));
    const lists = Array.from({ length: 100 }, () => store.list('alice', 'search'));
    const usage = Array.from({ length: 50 }, () => store.usage('alice'));
    const [units, summaries, totals] = await Promise.all([
      Promise.all(reads),
      Promise.all(lists),
      Promise.all(usage),
    ]);

    for (const unit of units) assert.deepEqual(unit?.meta, { limit: 5 });
    for (const summary of summaries) assert.equal(summary.length, 1);
    for (const total of totals) assert.equal(total.units, 1);
  } finally {
    await store.shutdown();
    rmSync(directory, { recursive: true });
  }
});

test('a read and a health probe answer while the writer is still busy', async () => {
  const { directory, store } = storeOnFile({ readers: 2, queueLimit: 128 });
  try {
    await store.ready();
    await store.save('alice', 'search', 'settings', { limit: 5 });

    // Eight megabytes of write, queued at the writer without being awaited: on one thread this would
    // be the whole event loop, and the read below would be behind all of it.
    let written = 0;
    const burst = Array.from({ length: 8 }, (_, index) =>
      store.save('alice', 'search', `big-${index}`, payload('x')).then(() => {
        written += 1;
      }),
    );

    await store.ping();
    const read = await store.load('alice', 'search', 'settings');
    assert.deepEqual(read?.meta, { limit: 5 }, 'the committed unit, not a half-written one');
    await store.list('alice', 'search');
    assert.ok(written < burst.length, `the writer was still busy (answered after ${written} writes)`);

    await Promise.all(burst);
    assert.equal((await store.list('alice', 'search')).length, 9);
  } finally {
    await store.shutdown();
    rmSync(directory, { recursive: true });
  }
});

test('a queue that is full refuses at once, with an error a server can turn into a 503', async () => {
  const { directory, store } = storeOnFile({ queueLimit: 2 });
  try {
    await store.ready();
    const burst = Array.from({ length: 40 }, (_, index) =>
      store.save('alice', 'search', `unit-${index}`, { index }),
    );
    const settled = await Promise.allSettled(burst);
    const refused = settled.filter(
      (one): one is PromiseRejectedResult => one.status === 'rejected',
    );
    assert.ok(refused.length > 0, 'a burst bigger than the ceiling is refused, not held');
    for (const one of refused) {
      assert.ok(one.reason instanceof HistoryQueueFullError, String(one.reason));
      assert.equal(one.reason.status, 503);
      assert.equal(one.reason.code, 'queue_full');
    }
    // Everything it did take, it took: the refusals cost nothing and left nothing half done.
    const kept = settled.length - refused.length;
    assert.equal((await store.list('alice', 'search')).length, kept);
  } finally {
    await store.shutdown();
    rmSync(directory, { recursive: true });
  }
});

test('close refuses new work, leaves nothing running, and leaves the file where it was', async () => {
  const { directory, path, store } = storeOnFile();
  try {
    await store.save('alice', 'search', 'settings', { limit: 5 });
    store.close();
    await assert.rejects(store.load('alice', 'search', 'settings'), /closed/);

    const started = Date.now();
    await store.shutdown();
    await store.shutdown();
    assert.ok(Date.now() - started < 2000, 'a stop is finished business, not a wait');
    store.close(); // still a no-op

    const reopened = new SqliteHistoryStore(path);
    try {
      assert.deepEqual(reopened.load('alice', 'search', 'settings')?.meta, { limit: 5 });
    } finally {
      reopened.close();
    }
  } finally {
    await store.shutdown();
    rmSync(directory, { recursive: true });
  }
});
