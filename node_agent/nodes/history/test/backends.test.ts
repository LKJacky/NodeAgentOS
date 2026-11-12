// Which backend a node picks and whose units it touches. The HTTP history client is the cloud
// deployment's own package; this local node keeps one SQLite file and refuses a network target.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeManifestOfPackage } from '@node-agent/sdk';
import {
  HistoryNode,
  SqliteHistoryStore,
  defaultHistoryPath,
  defaultHistoryTarget,
  defaultHistoryUser,
  type PersistentUnit,
} from '../src/index.ts';
import { Caller, Fixture } from './support.ts';

const turn = { role: 'assistant' as const, content: 'hi' };

/** Set environment variables for one test, and put them back as they were. */
async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a local history node refuses a network URL', () => {
  assert.throws(
    () => new HistoryNode({} as never, 'http://127.0.0.1:8791'),
    /network history client lives in the cloud deployment/,
  );
});

test('NODE_AGENT_HISTORY_USER fixes the user, and the default is unchanged', async () => {
  await withEnv({ NODE_AGENT_HISTORY_USER: undefined }, async () => {
    assert.equal(defaultHistoryUser(), 'default');
    const node = new HistoryNode({} as never, ':memory:');
    assert.equal(node.userId, 'default');
  });

  await withEnv({ NODE_AGENT_HISTORY_USER: 'alice' }, async () => {
    assert.equal(defaultHistoryUser(), 'alice');
    const node = new HistoryNode({} as never, ':memory:');
    assert.equal(node.userId, 'alice');
  });
});

test('a calling node cannot choose the user, even by sending one', () => {
  const node = new HistoryNode({} as never, ':memory:', 'alice');
  // An older caller still passes `userId`, and it is ignored rather than obeyed.
  node.handle('save', { userId: 'bob', unitId: 'settings', meta: { limit: 1 } }, 'search');
  assert.equal(node.store.load('bob', 'search', 'settings'), null);
  assert.deepEqual(node.store.load('alice', 'search', 'settings')?.meta, { limit: 1 });
  // The calling node still comes from the bus and cannot be named either.
  assert.deepEqual(node.handle('list', {}, 'other'), { units: [] });
  // And no schema offers a field that could look like it changed the user: the manifest is the
  // schema every caller sees.
  const caps = (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      node: { caps: Record<string, { properties?: Record<string, unknown> }> };
    }
  ).node.caps;
  assert.ok(!('userId' in (caps.load?.properties ?? {})));
  assert.deepEqual(Object.keys(caps.list?.properties ?? {}), []);
});

test('a target that is neither an http(s) URL nor a file path is refused', () => {
  assert.throws(
    () => new HistoryNode({} as never, 'ws://127.0.0.1:8788'),
    /network history client lives in the cloud deployment/,
  );
  assert.throws(() => new HistoryNode({} as never, ''), /SQLite file path/);
});
