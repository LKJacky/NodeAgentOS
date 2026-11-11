// The introduce page runs the stack's one setup now, not the runtime: a stack that is started and
// never visited stays uninitialized, with no marker and nothing filed in the notes.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { line, portOf, tenant } from './entry.mjs';
import { connectProbe } from './probe.mjs';

/** The setup markers this deployment's history holds. */
function markers(home) {
  const db = new DatabaseSync(join(home, 'history', 'sqlite'), { readOnly: true });
  try {
    const row = db.prepare("select count(*) as n from units where unit_id = 'setup'").get();
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

test('a started stack is not set up until its page asks for it', async (t) => {
  const entry = tenant(t, { NODE_AGENT_NODES: 'node-agent-notes,node-agent-introduce' });
  const port = portOf(await line(entry, 'bus: '));
  await line(entry, 'user: ');

  // The setup is the page's: nothing ran at startup, so nothing was written.
  assert.equal(markers(entry.home), 0, 'the startup wrote a setup marker');
  const probe = await connectProbe(port);
  t.after(() => probe.close());
  const notes = await probe.call('notes.list', { tag: 'instruction' });
  assert.equal(notes.ok, true, JSON.stringify(notes));
  assert.deepEqual(notes.value ?? [], [], 'the startup filed an instruction document');
});

// The gate belongs to the reader's browser: a sibling node cannot run the setup or even ask for the
// status. Only the shell (and the parent page it serves) may.
test('a node that is not the shell cannot run the setup', async (t) => {
  const entry = tenant(t, { NODE_AGENT_NODES: 'node-agent-introduce' });
  const port = portOf(await line(entry, 'bus: '));
  await line(entry, 'user: ');
  const probe = await connectProbe(port);
  t.after(() => probe.close());
  const refused = await probe.call('introduce.setup', {});
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(refused.error ?? '', /introduce\.setup/);
  const status = await probe.call('introduce.status', {});
  assert.equal(status.ok, false, JSON.stringify(status));
});
