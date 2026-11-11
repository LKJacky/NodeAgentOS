import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Bus } from '../../../bus/src/bus.ts';
import {
  HistoryNode,
  SqliteHistoryStore,
  defaultHistoryPath,
  nodeAgentHome,
} from '../src/index.ts';
import { Caller, Fixture, fixedModel, startAgent, startHistory, userOf } from './support.ts';

/** The line a stored message carries: a message from another node is prefixed with who sent it and
 *  when, so the test compares the words and the role, not the envelope. */
function lastLine(entry: unknown): { role: unknown; content: unknown } {
  const message = entry as { role?: unknown; content?: unknown };
  const content = typeof message.content === 'string' ? message.content : '';
  const at = content.lastIndexOf('\n\n');
  return { role: message.role, content: at < 0 ? content : content.slice(at + 2) };
}

const turn = [
  { role: 'user' as const, content: 'hello' },
  { role: 'assistant' as const, content: 'hi' },
];
/** A database as one of the older schemas left it, for the migration tests to open. */
function legacyDatabase(path: string, sql: string, rows: { sql: string; values: unknown[] }[]) {
  const database = new DatabaseSync(path);
  database.exec(sql);
  for (const row of rows) database.prepare(row.sql).run(...(row.values as never[]));
  database.close();
}

test('NODE_AGENT_HOME contains the default history database', () => {
  const previousHome = process.env.NODE_AGENT_HOME;
  try {
    delete process.env.NODE_AGENT_HOME;
    assert.equal(nodeAgentHome(), join(homedir(), '.node_agent'));
    assert.equal(defaultHistoryPath(), join(homedir(), '.node_agent', 'history', 'sqlite'));

    process.env.NODE_AGENT_HOME = '/tmp/node-agent-home';
    assert.equal(nodeAgentHome(), '/tmp/node-agent-home');
    assert.equal(defaultHistoryPath(), '/tmp/node-agent-home/history/sqlite');
  } finally {
    if (previousHome === undefined) delete process.env.NODE_AGENT_HOME;
    else process.env.NODE_AGENT_HOME = previousHome;
  }
});

test('holds any JSON per unit and still has it after reopening SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-history-'));
  const path = join(directory, 'history.sqlite');
  const first = new SqliteHistoryStore(path);
  const saved = first.save('alice', 'search', 'settings', { engines: ['deepseek'], limit: 5 });
  assert.equal(saved.revision, 1);
  first.save('alice', 'agent', 'conversation', { messages: 0, usage: { total_tokens: 1 } });
  first.close();

  const second = new SqliteHistoryStore(path);
  assert.deepEqual(second.load('alice', 'search', 'settings')?.meta, {
    engines: ['deepseek'],
    limit: 5,
  });
  assert.deepEqual(second.load('alice', 'agent', 'conversation')?.meta, {
    messages: 0,
    usage: { total_tokens: 1 },
  });
  second.close();
  rmSync(directory, { recursive: true });
});

test('isolates units by user and node, and rejects stale writers', () => {
  const store = new SqliteHistoryStore(':memory:');
  store.save('alice', 'search', 'settings', { limit: 1 });
  store.save('alice', 'agent', 'settings', { limit: 2 });
  store.save('bob', 'search', 'settings', { limit: 3 });

  assert.equal(store.save('alice', 'search', 'settings', { limit: 4 }, 1).revision, 2);
  assert.throws(
    () => store.save('alice', 'search', 'settings', { limit: 5 }, 1),
    /changed concurrently/,
  );
  assert.throws(() => store.save('alice', 'search', 'gone', { limit: 5 }, 1), /does not exist/);
  assert.deepEqual(
    store.list('alice', 'search').map((unit) => unit.unitId),
    ['settings'],
  );
  assert.deepEqual(store.load('alice', 'agent', 'settings')?.meta, { limit: 2 });
  assert.deepEqual(store.load('bob', 'search', 'settings')?.meta, { limit: 3 });

  store.delete('alice', 'search', 'settings', 2);
  assert.equal(store.load('alice', 'search', 'settings'), null);
  store.close();
});

test('a unit named by its revision is an update; without one it is written again', () => {
  const store = new SqliteHistoryStore(':memory:');
  const first = store.save('alice', 'agent', 'conversation.0', turn[0]);
  assert.equal(first.revision, 1);

  // Writing the same name again is the point: a turn that failed half way writes its messages
  // again rather than colliding, and the bytes it lands are the same.
  const again = store.save('alice', 'agent', 'conversation.0', turn[0]);
  assert.equal(again.revision, 2);
  assert.deepEqual(store.load('alice', 'agent', 'conversation.0')?.meta, turn[0]);

  assert.equal(store.save('alice', 'agent', 'conversation.0', turn[1], 2).revision, 3);
  assert.throws(
    () => store.save('alice', 'agent', 'conversation.0', turn[1], 2),
    /changed concurrently/,
  );
  assert.deepEqual(store.load('alice', 'agent', 'conversation.0')?.meta, turn[1]);
  store.close();
});

test('migrates schema 1 conversation rows into a count and a unit per message', () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-history-v1-'));
  const path = join(directory, 'history.sqlite');
  legacyDatabase(
    path,
    `CREATE TABLE histories (user_id TEXT PRIMARY KEY, usage_json TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE messages (
       user_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload_json TEXT NOT NULL,
       created_at TEXT NOT NULL, PRIMARY KEY (user_id, sequence)
     );
     PRAGMA user_version = 1;`,
    [
      {
        sql: 'INSERT INTO histories VALUES (?, ?, ?)',
        values: ['alice', JSON.stringify({ total_tokens: 3 }), '2026-01-01T00:00:00.000Z'],
      },
      ...turn.map((message, sequence) => ({
        sql: 'INSERT INTO messages VALUES (?, ?, ?, ?)',
        values: ['alice', sequence, JSON.stringify(message), '2026-01-01T00:00:00.000Z'],
      })),
    ],
  );

  const store = new SqliteHistoryStore(path);
  assert.deepEqual(store.load('alice', 'agent', 'conversation')?.meta, {
    usage: { total_tokens: 3 },
    messages: 2,
  });
  assert.deepEqual(store.load('alice', 'agent', 'conversation.1')?.meta, turn[1]);
  store.close();
  rmSync(directory, { recursive: true });
});

test('migrates a schema 2 blob by splitting its messages out, leaving other units alone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-history-v2-'));
  const path = join(directory, 'history.sqlite');
  legacyDatabase(
    path,
    `CREATE TABLE units (
       user_id TEXT NOT NULL, node_name TEXT NOT NULL, unit_id TEXT NOT NULL,
       revision INTEGER NOT NULL, data_json TEXT NOT NULL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       PRIMARY KEY (user_id, node_name, unit_id)
     ) STRICT;
     PRAGMA user_version = 2;`,
    [
      {
        sql: 'INSERT INTO units VALUES (?, ?, ?, ?, ?, ?, ?)',
        values: [
          'alice',
          'agent',
          'conversation',
          5,
          JSON.stringify({ messages: turn, usage: { total_tokens: 3 } }),
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
        ],
      },
      {
        sql: 'INSERT INTO units VALUES (?, ?, ?, ?, ?, ?, ?)',
        values: [
          'alice',
          'search',
          'settings',
          2,
          JSON.stringify({ engines: ['deepseek'] }),
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      },
    ],
  );

  const store = new SqliteHistoryStore(path);
  const conversation = store.load('alice', 'agent', 'conversation');
  assert.equal(conversation?.revision, 5);
  assert.deepEqual(conversation?.meta, { usage: { total_tokens: 3 }, messages: 2 });
  assert.deepEqual(store.load('alice', 'agent', 'conversation.0')?.meta, turn[0]);
  // A unit that never held a list of messages keeps its value exactly as it was.
  assert.deepEqual(store.load('alice', 'search', 'settings')?.meta, { engines: ['deepseek'] });
  store.close();
  rmSync(directory, { recursive: true });
});

test('migrates schema 3 item rows into a unit per message', () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-history-v3-'));
  const path = join(directory, 'history.sqlite');
  legacyDatabase(
    path,
    `CREATE TABLE units (
       user_id TEXT NOT NULL, node_name TEXT NOT NULL, unit_id TEXT NOT NULL,
       revision INTEGER NOT NULL, meta_json TEXT NOT NULL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       PRIMARY KEY (user_id, node_name, unit_id)
     ) STRICT;
     CREATE TABLE items (
       user_id TEXT NOT NULL, node_name TEXT NOT NULL, unit_id TEXT NOT NULL,
       seq INTEGER NOT NULL, item_json TEXT NOT NULL,
       PRIMARY KEY (user_id, node_name, unit_id, seq)
     ) STRICT;
     PRAGMA user_version = 3;`,
    [
      {
        sql: 'INSERT INTO units VALUES (?, ?, ?, ?, ?, ?, ?)',
        values: [
          'alice',
          'agent',
          'conversation',
          9,
          JSON.stringify({ usage: { total_tokens: 3 } }),
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
        ],
      },
      ...turn.map((message, seq) => ({
        sql: 'INSERT INTO items VALUES (?, ?, ?, ?, ?)',
        values: ['alice', 'agent', 'conversation', seq, JSON.stringify(message)],
      })),
      {
        sql: 'INSERT INTO units VALUES (?, ?, ?, ?, ?, ?, ?)',
        values: [
          'alice',
          'search',
          'settings',
          1,
          JSON.stringify({ engines: ['deepseek'] }),
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      },
    ],
  );

  const store = new SqliteHistoryStore(path);
  assert.deepEqual(store.load('alice', 'agent', 'conversation')?.meta, {
    usage: { total_tokens: 3 },
    messages: 2,
  });
  assert.deepEqual(store.load('alice', 'agent', 'conversation.1')?.meta, turn[1]);
  assert.deepEqual(store.load('alice', 'search', 'settings')?.meta, { engines: ['deepseek'] });
  store.close();
  rmSync(directory, { recursive: true });
});

test('TypeScript agent keeps one unit per message, writing only the turn it ran', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-history-agent-'));
  const path = join(directory, 'history.sqlite');
  // What each save carried, so the test can show a turn never sends the whole transcript again.
  const carried: { unitId: string; meta: unknown }[] = [];
  const user = userOf(path);

  const first = await Fixture.open(user);
  await startHistory(first, carried);
  const firstAgent = await startAgent(first, fixedModel('durable'));
  const firstCaller = await Caller.join(first);
  try {
    assert.equal(firstAgent.manifest.name, 'agent');
    for (const line of ['remember this', 'and this']) {
      const answer = await firstCaller.call('agent.chat', { msg: { role: 'user', content: line } });
      assert.equal(answer.ok, true, answer.ok ? '' : answer.error);
    }

    // One unit per message, each carrying one message — never a list, and never twice.
    assert.deepEqual(
      carried.filter((call) => call.unitId !== 'conversation').map((call) => call.unitId),
      ['conversation.0', 'conversation.1', 'conversation.2', 'conversation.3'],
    );
    // One message per unit, in the order the turn ran. A line that came from another node carries
    // that node's name and the moment it arrived, so the assertion is on the line itself.
    assert.deepEqual(
      carried.filter((call) => call.unitId !== 'conversation').map((call) => lastLine(call.meta)),
      [
        { role: 'user', content: 'remember this' },
        { role: 'assistant', content: 'durable' },
        { role: 'user', content: 'and this' },
        { role: 'assistant', content: 'durable' },
      ],
    );
    // The count is written when the conversation starts and again beside every line, so the number a
    // reader sees is always the number of units next to it.
    const counts = carried
      .filter((call) => call.unitId === 'conversation')
      .map((call) => (call.meta as { messages: number }).messages);
    assert.deepEqual(counts, [0, 1, 2, 3, 4]);
    assert.equal(counts.at(-1), carried.filter((call) => call.unitId !== 'conversation').length);
  } finally {
    await firstCaller.close();
    await first.close();
  }

  // A second stack over the same file: the transcript is read back, so the agent starts where the
  // last turn left it instead of forgetting the conversation.
  const second = await Fixture.open(user);
  await startHistory(second);
  await startAgent(second, fixedModel('unused'));
  const secondCaller = await Caller.join(second);
  try {
    const transcript = await secondCaller.call('agent.history', {});
    assert.equal(transcript.ok, true, transcript.ok ? '' : transcript.error);
    const window = transcript.value as { messages: unknown[] };
    assert.deepEqual(
      window.messages.map((entry) => lastLine(entry)),
      [
        { role: 'user', content: 'remember this' },
        { role: 'assistant', content: 'durable' },
        { role: 'user', content: 'and this' },
        { role: 'assistant', content: 'durable' },
      ],
    );
  } finally {
    await secondCaller.close();
    await second.close();
  }
  rmSync(directory, { recursive: true });
});

test('node derives namespace from caller and validates what it is given', () => {
  const node = new HistoryNode({} as never, ':memory:');
  // Opened on `:memory:`, so the store answers at once — the interface allows a promise, this
  // backend does not use one.
  const store = node.store as SqliteHistoryStore;
  const created = node.handle('save', { unitId: 'settings', meta: { limit: 1 } }, 'search') as {
    unit: { revision: number };
  };
  assert.equal(created.unit.revision, 1);
  assert.deepEqual(
    (node.handle('list', {}, 'search') as { units: { unitId: string }[] }).units.map(
      (unit) => unit.unitId,
    ),
    ['settings'],
  );
  assert.deepEqual(node.handle('load', { unitId: 'settings' }, 'other'), { unit: null });
  assert.deepEqual(node.handle('load', { unitId: 'settings' }, 'search'), {
    unit: {
      revision: 1,
      meta: { limit: 1 },
      createdAt: store.load('default', 'search', 'settings')?.createdAt,
      updatedAt: store.load('default', 'search', 'settings')?.updatedAt,
    },
  });
  // `expectedRevision: 0` is the create-only form: it makes a unit that does not exist yet, and
  // refuses one that does (a writer that meant to create it must not overwrite it).
  assert.deepEqual(
    node.handle('save', { unitId: 'fresh', meta: { limit: 1 }, expectedRevision: 0 }, 'search'),
    {
      unit: {
        revision: 1,
        meta: { limit: 1 },
        createdAt: store.load('default', 'search', 'fresh')?.createdAt,
        updatedAt: store.load('default', 'search', 'fresh')?.updatedAt,
      },
    },
  );
  assert.throws(
    () =>
      node.handle(
        'save',
        { unitId: 'settings', meta: { limit: 2 }, expectedRevision: 0 },
        'search',
      ),
    /changed concurrently/,
  );
  assert.throws(
    () => node.handle('save', { unitId: 'fresh', meta: {}, expectedRevision: -1 }, 'search'),
    /positive safe integer/,
  );
  assert.throws(
    () => node.handle('save', { unitId: 'settings', expectedRevision: 1 }, 'search'),
    /meta must be JSON serializable/,
  );
  assert.deepEqual(
    node.handle('save', { unitId: 'settings', meta: { limit: 2 }, expectedRevision: 1 }, 'search'),
    {
      unit: {
        revision: 2,
        meta: { limit: 2 },
        createdAt: store.load('default', 'search', 'settings')?.createdAt,
        updatedAt: store.load('default', 'search', 'settings')?.updatedAt,
      },
    },
  );
  // The store is one per backend and outlives the instance the host built, so nothing here closes it:
  // the next test in this process reads the same backend.
});

test('one history node serves each bus tenant separately', () => {
  const alice = new HistoryNode({ tenantId: 'alice', from: 'agent' } as never, ':memory:');
  const bob = new HistoryNode({ tenantId: 'bob', from: 'agent' } as never, ':memory:');
  alice.handle('save', { unitId: 'settings', meta: { limit: 1 } }, 'agent');
  bob.handle('save', { unitId: 'settings', meta: { limit: 2 } }, 'agent');
  const aliceUnit = alice.handle('load', { unitId: 'settings' }, 'agent') as {
    unit: { meta: { limit: number } };
  };
  const bobUnit = bob.handle('load', { unitId: 'settings' }, 'agent') as {
    unit: { meta: { limit: number } };
  };
  assert.equal(aliceUnit.unit.meta.limit, 1);
  assert.equal(bobUnit.unit.meta.limit, 2);
});

test('private callers are refused before history touches a unit', async () => {
  const node = new HistoryNode(
    {
      tenantId: 'alice',
      from: 'private-agent',
      listNodes: async () => [
        { name: 'private-agent', scope: 'private' },
        { name: 'shared-agent', scope: 'shared' },
      ],
    } as never,
    ':memory:',
  );

  await assert.rejects(
    async () =>
      await node.handle('save', { unitId: 'settings', meta: { limit: 1 } }, 'private-agent'),
    /history does not serve the private node/,
  );

  const saved = await node.handle(
    'save',
    { unitId: 'settings', meta: { limit: 2 } },
    'shared-agent',
  );
  assert.ok((saved as { unit: unknown }).unit);
});
