import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Unit, UnitConflictError } from './dist/index.js';

function localContext(home) {
  return {
    nodeId: 'local-tool',
    tenantId: 'tenant-a',
    from: 'agent',
    home,
    nodeAgentHome: home,
    listNodes: async () => [{ name: 'local-tool', scope: 'private' }],
    call: async () => {
      throw new Error('a private node must not call history');
    },
  };
}

function busContext(calls) {
  return {
    nodeId: 'cloud-tool',
    tenantId: 'tenant-b',
    from: 'agent',
    home: '/nonexistent',
    nodeAgentHome: '/nonexistent',
    listNodes: async () => [
      { name: 'cloud-tool', scope: 'shared' },
      { name: 'history', scope: 'shared' },
    ],
    call: async (node, cap, args) => {
      calls.push({ node, cap, args });
      if (cap === 'load') return { unit: null };
      if (cap === 'delete') return {};
      return {
        unit: {
          revision: 1,
          meta: args.meta,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      };
    },
  };
}

class Settings extends Unit {
  meta = { theme: 'light' };
}

class Broken extends Unit {
  meta = undefined;
}

const home = await mkdtemp(join(tmpdir(), 'node-agent-unit-'));
try {
  const local = new Settings(localContext(home), 'settings');
  await local.load();
  assert.deepEqual(local.meta, { theme: 'light' });
  assert.equal(local.revision, 0);

  local.meta = { theme: 'dark' };
  await local.save();
  assert.equal(local.revision, 1);

  const reloaded = new Settings(localContext(home), 'settings');
  await reloaded.load();
  assert.deepEqual(reloaded.meta, { theme: 'dark' });
  assert.equal(reloaded.revision, 1);

  reloaded.meta = { theme: 'light' };
  await reloaded.save();
  assert.equal(reloaded.revision, 2);
  await reloaded.delete();
  assert.equal(reloaded.revision, 0);
  await reloaded.load();
  assert.equal(reloaded.revision, 0);

  const writerA = new Settings(localContext(home), 'race');
  const writerB = new Settings(localContext(home), 'race');
  await writerA.load();
  await writerB.load();
  writerA.meta = { theme: 'a' };
  await writerA.save();
  writerB.meta = { theme: 'b' };
  await assert.rejects(writerB.save(), UnitConflictError);

  const calls = [];
  const bus = new Settings(busContext(calls), 'settings');
  await bus.load();
  bus.meta = { theme: 'blue' };
  await bus.save();
  assert.equal(bus.revision, 1);
  await bus.delete();
  assert.equal(bus.revision, 0);
  assert.deepEqual(calls.map(({ node, cap }) => [node, cap]), [
    ['history', 'load'],
    ['history', 'save'],
    ['history', 'delete'],
  ]);

  await assert.rejects(new Broken(localContext(home), 'bad').save(), /JSON serializable/);
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log('history unit smoke ok');
