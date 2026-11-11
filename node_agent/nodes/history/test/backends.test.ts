// Which backend a node picks, whose units it touches, and that a node on a URL behaves like a node on
// a file: the same capabilities, the same answers, the same wording when the server refuses. What the
// store itself promises is in the same file below; what a token means is the last test here, and the
// server the client talks to is the double in server-double.ts (the deployment's own server is a
// separate product, so the wire between the two is what this file pins down).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeManifestOfPackage } from '@node-agent/sdk';
import {
  HistoryNode,
  HttpHistoryStore,
  SqliteHistoryStore,
  defaultHistoryPath,
  defaultHistoryTarget,
  defaultHistoryUser,
  type PersistentUnit,
} from '../src/index.ts';
import { HistoryServer } from './server-double.ts';
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

test('NODE_AGENT_HISTORY_URL selects the network backend, and a blank one does not', async () => {
  await withEnv({ NODE_AGENT_HISTORY_URL: undefined }, async () => {
    assert.equal(defaultHistoryTarget(), defaultHistoryPath());
    const local = new HistoryNode({} as never);
    assert.ok(local.store instanceof SqliteHistoryStore);
  });

  await withEnv({ NODE_AGENT_HISTORY_URL: 'http://127.0.0.1:8791' }, async () => {
    assert.equal(defaultHistoryTarget(), 'http://127.0.0.1:8791');
    const remote = new HistoryNode({} as never);
    assert.ok(remote.store instanceof HttpHistoryStore);
    assert.equal((remote.store as HttpHistoryStore).url, 'http://127.0.0.1:8791');
  });

  // Blank counts as unset, so a compose file can leave the variable empty and still start locally.
  await withEnv({ NODE_AGENT_HISTORY_URL: '   ' }, async () => {
    assert.equal(defaultHistoryTarget(), defaultHistoryPath());
  });
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
  // A ws:// URL would otherwise become a file called `ws:/…`, and the first save would fail there.
  assert.throws(
    () => new HistoryNode({} as never, 'ws://127.0.0.1:8788'),
    /http\(s\) URL or a SQLite file path/,
  );
  assert.throws(() => new HistoryNode({} as never, ''), /http\(s\) URL or a file path/);
});

test("a node on a URL keeps its units on that server, under the token's user", async () => {
  const server = new HistoryServer({ store: new SqliteHistoryStore(':memory:') });
  const url = await server.listen(0);

  await withEnv({ NODE_AGENT_TOKEN: 'alice', NODE_AGENT_HISTORY_USER: 'alice' }, async () => {
    const node = new HistoryNode({} as never, url);
    const saved = (await node.handle(
      'save',
      { unitId: 'settings', meta: { limit: 7 } },
      'search',
    )) as { unit: PersistentUnit };
    assert.equal(saved.unit.revision, 1);

    // It is the *server* that holds it: the same read through the server's own store agrees, under
    // the user the token names.
    assert.deepEqual(await server.store.load('alice', 'search', 'settings'), saved.unit);
    assert.deepEqual(await server.store.load('bob', 'search', 'settings'), null);
    assert.deepEqual(await node.handle('load', { unitId: 'settings' }, 'search'), {
      unit: saved.unit,
    });
  });

  // Another token is another user, not a refusal: it has an empty history of its own, and sees
  // nothing of alice's.
  await withEnv({ NODE_AGENT_TOKEN: 'bob' }, async () => {
    const node = new HistoryNode({} as never, url);
    assert.deepEqual(await node.handle('load', { unitId: 'settings' }, 'search'), { unit: null });
  });

  await server.close();
});

test("two users on one server cannot reach each other's units", async () => {
  const server = new HistoryServer({ store: new SqliteHistoryStore(':memory:') });
  const url = await server.listen(0);

  /** One process as one person: its token, its fixed user, its own node on the bus. */
  async function as(token: string, user: string) {
    return await withEnv(
      { NODE_AGENT_TOKEN: token, NODE_AGENT_HISTORY_USER: user },
      async () => new HistoryNode({} as never, url),
    );
  }

  const alice = await as('alice', 'alice');
  const bob = await as('bob', 'bob');
  try {
    await alice.handle('save', { unitId: 'conversation.0', meta: 'alice said' }, 'agent');
    await bob.handle('save', { unitId: 'conversation.0', meta: 'bob said' }, 'agent');

    assert.deepEqual(await alice.handle('load', { unitId: 'conversation.0' }, 'agent'), {
      unit: (await server.store.load('alice', 'agent', 'conversation.0')) as PersistentUnit,
    });
    assert.equal(
      (
        (await bob.handle('load', { unitId: 'conversation.0' }, 'agent')) as {
          unit: PersistentUnit;
        }
      ).unit.meta,
      'bob said',
    );
    assert.equal(
      (
        (await alice.handle('load', { unitId: 'conversation.0' }, 'agent')) as {
          unit: PersistentUnit;
        }
      ).unit.meta,
      'alice said',
    );
    // Neither sees the other in a listing.
    assert.deepEqual(
      ((await alice.handle('list', {}, 'agent')) as { units: unknown[] }).units.length,
      1,
    );
  } finally {
    await server.close();
  }
});

test('a node on a URL answers over the bus exactly like one on a file', async () => {
  const server = new HistoryServer({ store: new SqliteHistoryStore(':memory:') });
  const url = await server.listen(0);
  const fixture = await Fixture.open();

  await withEnv({ NODE_AGENT_TOKEN: 'alice', NODE_AGENT_HISTORY_USER: 'alice' }, async () => {
    // The node on a URL, hosted the way the runtime hosts one; the caller the bus reports is
    // "probe", and that is the name the unit is filed under.
    const history = await fixture.host(
      nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url))),
      HistoryNode,
    );
    const probe = await Caller.join(fixture, 'probe');
    assert.equal(history.manifest.name, 'history');

    const saved = await probe.call('history.save', { unitId: 'conversation.0', meta: turn });
    assert.equal(saved.ok, true);
    const unit = (saved.value as { unit: PersistentUnit }).unit;
    assert.equal(unit.revision, 1);

    assert.deepEqual((await probe.call('history.load', { unitId: 'conversation.0' })).value, {
      unit,
    });
    assert.deepEqual((await probe.call('history.list', {})).value, {
      units: [
        {
          unitId: 'conversation.0',
          revision: unit.revision,
          createdAt: unit.createdAt,
          updatedAt: unit.updatedAt,
        },
      ],
    });
    // A stale write is still a conflict once it has crossed the wire and come back.
    const stale = await probe.call('history.save', {
      unitId: 'conversation.0',
      meta: turn,
      expectedRevision: 7,
    });
    assert.equal(stale.ok, false);
    assert.match(String(stale.error), /changed concurrently/);

    // 0 means create only over the wire too: the first write creates, the second is a conflict.
    const created = await probe.call('history.save', {
      unitId: 'fresh',
      meta: turn,
      expectedRevision: 0,
    });
    assert.equal(created.ok, true, 'expectedRevision 0 creates a missing unit');
    const again = await probe.call('history.save', {
      unitId: 'fresh',
      meta: turn,
      expectedRevision: 0,
    });
    assert.equal(again.ok, false);
    assert.match(String(again.error), /changed concurrently/);

    await probe.close();
  });

  await fixture.close();
  await server.close();
});

test('each HTTP tenant presents its own bearer token', async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization') ?? '');
    return new Response(JSON.stringify({ units: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const alice = new HistoryNode(
      { tenantId: 'alice', from: 'agent' } as never,
      'http://history.test',
    );
    const bob = new HistoryNode({ tenantId: 'bob', from: 'agent' } as never, 'http://history.test');
    // One request each, answered before the assertion reads what the transport was handed.
    await alice.handle('list', {}, 'agent');
    await bob.handle('list', {}, 'agent');
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(seen, ['Bearer alice', 'Bearer bob']);
});
