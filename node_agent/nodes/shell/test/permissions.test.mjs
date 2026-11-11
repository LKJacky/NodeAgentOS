// The shell's capability switches: what the page saves, what a caller meets when it asks anyway, and
// what a restart reads back. The switches are this node's own state, not a history unit, so they live
// in a file per tenant under `NODE_AGENT_HOME` (`settings.ts`) and these tests point that home at a
// temp directory. No bus is involved at all: the contexts below refuse to `call` one, so a shell that
// reached for history would fail these tests loudly.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';
import { EFFECTS, permissionsFile, tenantKey } from '../dist/index.js';
import {
  ShellNode,
  closeShellService,
  context,
  nodeAgentHome,
  tenant,
  withEnv,
} from './support.mjs';

/** A workspace, a node-agent home of its own, and one tenant whose shell can be made again. */
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'shell-perm-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home = await nodeAgentHome(t);
  const id = tenant();
  t.after(() => closeShellService(id));

  /** A shell on that tenant: the second call to this is a restart. */
  const make = (from = 'test-caller') => new ShellNode(context(id, { from }), { workspace: root });

  return {
    root,
    home,
    id,
    file: permissionsFile(id),
    make,
    node: make('webui'),
    caller: make('test-caller'),
  };
}

/** The switches as the page reads them. */
async function view(node, args = {}) {
  return JSON.parse(String(await node.handle('permissions', args)));
}

/** The switches after a save, as the save answers. */
async function save(node, args) {
  return JSON.parse(String(await node.handle('set-permissions', args)));
}

/** What this tenant's file says, as the save left it. */
async function saved(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

test('the switches list every capability but the page, all on until somebody says otherwise', async (t) => {
  const { file, node } = await setup(t);
  const seen = await view(node);

  // The page is not a row: a switch that could hide the switches is not a switch. Everything else the
  // node answers to is one, and `ui` is the only name missing.
  assert.deepEqual(
    seen.caps.map((row) => row.cap),
    Object.keys(EFFECTS).filter((cap) => cap !== 'set-permissions'),
  );
  assert.ok(!seen.caps.some((row) => row.cap === 'ui'));
  for (const cap of ['exec', 'read', 'write', 'run-custom']) {
    assert.ok(
      seen.caps.some((row) => row.cap === cap),
      `${cap} is not in the list`,
    );
  }

  assert.deepEqual(seen.denied, []);
  // A shell nobody has configured: no file, no warning, everything allowed.
  assert.equal(seen.warning, null);
  assert.equal(existsSync(file), false, 'nothing was written by merely reading');
  assert.ok(seen.switches.exec === true);
  assert.equal(seen.node, 'shell');

  // The page's management path is marked so the page can explain that webui bypasses its switch.
  assert.deepEqual(
    seen.caps.filter((row) => row.forceWebui).map((row) => row.cap),
    ['permissions', 'custom-commands'],
  );
});

test('webui bypasses management switches while other callers still obey them', async (t) => {
  const { node, caller } = await setup(t);
  const management = ['permissions', 'custom-commands'];
  for (const cap of management) {
    const answer = await save(node, { caps: { [cap]: false } });
    assert.equal(answer.persisted, true);
    assert.equal((await view(node)).switches[cap], false);
    await assert.rejects(caller.handle(cap, {}), {
      message: `shell.${cap} is disabled by the user for node "test-caller"`,
    });
  }
  // `ui` and `set-permissions` are page-only: no switch exists, and only webui may call them.
  await assert.rejects(caller.handle('ui', {}), { message: 'shell.ui is reserved for webui' });
  await assert.rejects(caller.handle('set-permissions', { caps: {} }), {
    message: 'shell.set-permissions is reserved for webui',
  });
  await assert.rejects(node.handle('set-permissions', { caps: { 'set-permissions': false } }), {
    message: 'shell.set-permissions is reserved for webui and is not a user switch',
  });
});

test('a capability that is off refuses its caller by name, before it runs', async (t) => {
  const { root, file, node, caller } = await setup(t);
  await node.handle('write', { path: 'kept.txt', content: 'still here\n' });

  const answer = await save(node, { caps: { exec: false } });
  assert.equal(answer.persisted, true);
  assert.deepEqual(answer.denied, ['exec']);

  // The refusal is this call's error, and it names the capability and the caller.
  await assert.rejects(caller.handle('exec', { command: 'touch made' }), {
    message: 'shell.exec is disabled by the user for node "test-caller"',
  });
  // Refused *before* it ran: nothing was started, so nothing was made.
  await assert.rejects(readFile(join(root, 'made')));

  // One switch is one capability: the rest still answer.
  assert.equal(await caller.handle('read', { path: 'kept.txt' }), 'still here\n');

  // And the switch is in this tenant's own file, in the shape she can hand to a bus-wide check later.
  assert.deepEqual(await saved(file), { version: 1, rules: [{ cap: 'exec', callers: [] }] });
});

test('the page stays reachable when its own management switches are off', async (t) => {
  const { node, caller } = await setup(t);
  const off = { permissions: false, 'custom-commands': false };
  const answer = await save(node, { caps: off });
  assert.equal(answer.persisted, true);
  assert.deepEqual(answer.denied, Object.keys(off));

  // webui can still read and save the switches; an ordinary caller cannot use the management caps.
  assert.equal((await view(node)).switches.permissions, false);
  const after = await save(node, {});
  assert.equal(after.persisted, true);
  await assert.rejects(caller.handle('set-permissions', { caps: { exec: false } }), {
    message: 'shell.set-permissions is reserved for webui',
  });
});

// The page's ``off`` switches are the rules the bus will read: a look at the row and at what refused.
test('every capability can be switched off, and each one refuses on its own', async (t) => {
  const { node, caller } = await setup(t);
  await node.handle('write', { path: 'kept.txt', content: 'x\n' });

  const switches = Object.keys(EFFECTS).filter((cap) => cap !== 'set-permissions');
  const off = Object.fromEntries(switches.map((cap) => [cap, false]));
  const answer = await save(node, { caps: off });
  assert.equal(answer.persisted, true);
  assert.deepEqual(answer.denied, Object.keys(off));
  for (const cap of answer.denied)
    assert.equal(
      answer.caps.find((row) => row.cap === cap).enabled,
      false,
      `${cap} was not switched off`,
    );

  // webui can still read the switches back while every ordinary caller is refused.
  const seen = await view(node);
  for (const cap of switches) assert.equal(seen.switches[cap], false);

  // Every refused capability says so, by name, without running.
  await assert.rejects(caller.handle('read', { path: 'kept.txt' }), {
    message: 'shell.read is disabled by the user for node "test-caller"',
  });
  await assert.rejects(caller.handle('exec', { command: 'true' }), {
    message: 'shell.exec is disabled by the user for node "test-caller"',
  });
});

test("the switches are filed in this tenant's own file, and a restart reads them back", async (t) => {
  const { file, id, make, node } = await setup(t);
  await save(node, { caps: { exec: false } });

  // The file is the shape `system.permissions` files: a rule list of callers, empty meaning nobody.
  assert.deepEqual(await saved(file), { version: 1, rules: [{ cap: 'exec', callers: [] }] });

  // A restart: the tenant's service is gone, so the next shell reads the file for the first time.
  closeShellService(id);
  const again = make('webui');
  assert.equal((await view(again)).switches.exec, false);
  await assert.rejects(again.handle('exec', { command: 'true' }), {
    message: /shell\.exec is disabled by the user for node/,
  });

  // ... and switching it back on leaves no rule behind: an unconfigured capability, not `['*']`.
  await save(again, { caps: { exec: true } });
  assert.deepEqual(await saved(file), { version: 1, rules: [] });
  assert.match(await again.handle('exec', { command: 'echo back' }), /back/);
});

test('a rule may name the callers it allows, and the switch shows what it would overwrite', async (t) => {
  const { file, make, node, caller } = await setup(t);
  await node.handle('write', { path: 'kept.txt', content: 'for one caller\n' });
  await save(node, { callers: { read: ['agent'] } });

  assert.deepEqual(await saved(file), { version: 1, rules: [{ cap: 'read', callers: ['agent'] }] });
  const row = (await view(node)).caps.find((entry) => entry.cap === 'read');
  assert.deepEqual(row.callers, ['agent']);
  assert.equal(row.enabled, false, 'a switch that only names one caller reads as off');

  // The caller the rule names is let through; anybody else is not, and is told so.
  const agent = make('agent');
  assert.equal(await agent.handle('read', { path: 'kept.txt' }), 'for one caller\n');
  await assert.rejects(caller.handle('read', { path: 'kept.txt' }), {
    message: 'shell.read is disabled by the user for node "test-caller"',
  });

  // `null` drops the rule -- everyone again.
  await save(node, { callers: { read: null } });
  assert.deepEqual(await saved(file), { version: 1, rules: [] });
  assert.equal(await caller.handle('read', { path: 'kept.txt' }), 'for one caller\n');
});

test('a switch for a capability this node does not have is refused, not saved', async (t) => {
  const { file, node } = await setup(t);
  await assert.rejects(node.handle('set-permissions', { caps: { 'exec-all': false } }), {
    message: 'shell has no capability "exec-all": see shell.permissions for the list',
  });
  assert.equal(existsSync(file), false, 'a refused switch wrote nothing');
});

test('a permissions file that cannot be read fails open, and the page is told why', async (t) => {
  const { root, file, id } = await setup(t);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{ this is not json', 'utf8');

  // A restart, so the file is read for the first time with that content in it.
  closeShellService(id);
  const node = new ShellNode(context(id, { from: 'webui' }), { workspace: root });
  t.after(() => closeShellService(id));

  // Nothing is switched off, because nothing could be read -- and the page is told why, rather than the
  // model being handed an error about a settings file.
  const seen = await view(node);
  assert.match(seen.warning, /permissions\.json: .*(JSON|position)/);
  assert.deepEqual(seen.denied, []);
  assert.match(await node.handle('exec', { command: 'echo ok' }), /ok/);

  // A save overwrites the broken file, so the shell is not stuck with a warning it cannot clear.
  const answer = await save(node, { caps: { exec: false } });
  assert.equal(answer.persisted, true);
  assert.equal(answer.error, null);
  assert.deepEqual(await saved(file), { version: 1, rules: [{ cap: 'exec', callers: [] }] });
  assert.equal((await view(node)).warning, null);
});

test('a saved file of the wrong shape fails open too', async (t) => {
  const { root, file, id } = await setup(t);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, rules: 'everyone' }), 'utf8');

  closeShellService(id);
  const node = new ShellNode(context(id, { from: 'webui' }), { workspace: root });
  const seen = await view(node);
  assert.match(seen.warning, /no rules list/);
  assert.deepEqual(seen.denied, []);
});

test('a write that fails keeps the switch in force and says it is not saved', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shell-perm-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // A home that cannot be a directory: the file the shell would make has nowhere to go.
  const blocked = join(root, 'not-a-directory');
  await writeFile(blocked, 'x', 'utf8');
  withEnv(t, { NODE_AGENT_HOME: blocked });

  const id = tenant();
  t.after(() => closeShellService(id));
  const node = new ShellNode(context(id, { from: 'webui' }), { workspace: root });

  // The switch works here and now; only the promise about the next restart cannot be made.
  const answer = await save(node, { caps: { exec: false } });
  assert.equal(answer.persisted, false);
  assert.match(answer.error, /ENOTDIR|not a directory/);
  await assert.rejects(node.handle('exec', { command: 'true' }), {
    message: /shell\.exec is disabled by the user for node/,
  });
});

test('two tenants keep their switches in two files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shell-perm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await nodeAgentHome(t);

  const one = tenant();
  const other = tenant();
  t.after(() => {
    closeShellService(one);
    closeShellService(other);
  });

  const mine = new ShellNode(context(one, { from: 'webui' }), { workspace: root });
  const theirs = new ShellNode(context(other, { from: 'webui' }), { workspace: root });

  await save(mine, { caps: { exec: false } });

  // One tenant's file is not the other's, and the other was never written.
  assert.notEqual(permissionsFile(one), permissionsFile(other));
  assert.equal((await view(mine)).switches.exec, false);
  assert.equal((await view(theirs)).switches.exec, true);
  assert.equal(existsSync(permissionsFile(other)), false, "one tenant's save made another's file");
  assert.match(await theirs.handle('exec', { command: 'echo theirs' }), /theirs/);
});

test("a tenant's name becomes one safe path segment", async (t) => {
  const home = await nodeAgentHome(t);
  const dir = join(home, 'shell', 'tenants');

  for (const name of ['default', 'a b', '../..', 'a/b', 'x'.repeat(200), '', '.hidden']) {
    const file = permissionsFile(name);
    assert.ok(file.startsWith(dir + sep), `${JSON.stringify(name)} escapes the shell's directory`);

    // One segment, no traversal of its own: the whole path is the node's directory plus a key.
    const key = tenantKey(name);
    assert.match(key, /^[A-Za-z0-9._-]+$/);
    assert.ok(key !== '.' && key !== '..');
    assert.equal(file, join(dir, key, 'permissions.json'));
  }

  // Two names that slug alike are still two tenants.
  assert.notEqual(permissionsFile('a b'), permissionsFile('a-b'));
  // And the same tenant always lands on the same file: that is what a restart reads.
  assert.equal(permissionsFile('default'), permissionsFile('default'));
});

test('the manifest, the handlers and the effects table name the same abilities', async (t) => {
  // The host refuses a capability the manifest does not list, so the places an ability can be named --
  // manifest, handler map, effect table -- have to agree. `files.test.mjs` says the same thing; this
  // copy is here because the new capabilities are the ones most likely to drift.
  const { node } = await setup(t);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.deepEqual(Object.keys(pkg.node.caps), [...Object.keys(EFFECTS), 'ui']);
  assert.deepEqual(Object.keys(node.handlers), Object.keys(pkg.node.caps));
  for (const cap of Object.keys(EFFECTS))
    assert.equal(typeof pkg.node.caps[cap].description, 'string', `${cap} has no description`);
});
