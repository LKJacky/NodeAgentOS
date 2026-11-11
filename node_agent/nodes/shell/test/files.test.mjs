import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EFFECTS } from '../dist/index.js';
import { shell, withEnv } from './support.mjs';

/** A throwaway workspace plus a node pointed at it. The workspace sits inside a parent of its own
 *  so that `..` in a test has somewhere harmless to land. */
async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), 'shell-'));
  const root = join(parent, 'ws');
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const node = shell(t, root);
  return { root, node };
}

test('the manifest, the handlers and the effects table name the same abilities', async (t) => {
  const { node } = await setup(t);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  // The manifest is package.json now, and the host refuses a cap it does not list, so the three places
  // an ability can be named -- manifest, handler map, effect table -- have to agree, page included.
  assert.deepEqual(Object.keys(pkg.node.caps), [...Object.keys(EFFECTS), 'ui']);
  assert.deepEqual(Object.keys(node.handlers), Object.keys(pkg.node.caps));
  assert.deepEqual(EFFECTS, {
    read: 'read',
    write: 'write',
    edit: 'write',
    list: 'read',
    glob: 'read',
    grep: 'read',
    'files-tree': 'read',
    'files-read': 'read',
    'files-write': 'write',
    publish: 'write',
    exec: 'exec',
    'run-node': 'exec',
    'list-local-running-nodes': 'read',
    'kill-node': 'exec',
    'write-stdin': 'exec',
    sessions: 'exec',
    'kill-session': 'exec',
    permissions: 'read',
    'set-permissions': 'write',
    'custom-commands': 'write',
    'run-custom': 'exec',
  });
});

test('write then read round-trips plain text and creates parent directories', async (t) => {
  const { node } = await setup(t);
  const content = 'line one\nline two\n';
  assert.equal(await node.handle('write', { path: 'notes/a.txt', content }), 'wrote notes/a.txt (18 bytes, 3 lines)');
  assert.equal(await node.handle('read', { path: 'notes/a.txt' }), content);
});

test('read slices by line and says what it left out', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', { path: 'lines.txt', content: '1\n2\n3\n4\n' });
  assert.equal(await node.handle('read', { path: 'lines.txt', offset: 2, limit: 2 }), '2\n3\n… (5 lines in all; this stops at line 3)');
});

test('read cuts an oversized file with a marker', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', { path: 'big.txt', content: 'x'.repeat(300 * 1024) });
  const body = await node.handle('read', { path: 'big.txt' });
  assert.match(body, /only the first 262144/);
  assert.ok(body.length < 300 * 1024);
});

test('edit requires a unique snippet unless replaceAll is set', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', { path: 'e.txt', content: 'alpha beta alpha' });

  await assert.rejects(node.handle('edit', { path: 'e.txt', old: 'alpha', new: 'gamma' }), /appears 2 times/);
  assert.equal(
    await node.handle('edit', { path: 'e.txt', old: 'alpha', new: 'gamma', replaceAll: true }),
    'edited e.txt (2 replacements)',
  );
  assert.equal(await node.handle('read', { path: 'e.txt' }), 'gamma beta gamma');
  await assert.rejects(node.handle('edit', { path: 'e.txt', old: 'nope', new: 'x' }), /no such text/);
});

test('list, glob and grep see the files that were written', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', { path: 'a/one.ts', content: 'export const one = 1;\n' });
  await node.handle('write', { path: 'a/two.md', content: '# two\n' });

  const list = await node.handle('list', { path: 'a' });
  assert.match(list, /^f one\.ts/m);
  assert.match(list, /^f two\.md/m);

  const glob = await node.handle('glob', { pattern: '**/*.ts' });
  assert.match(glob, /a\/one\.ts/);
  assert.doesNotMatch(glob, /two\.md/);

  const grep = await node.handle('grep', { pattern: 'const one' });
  assert.match(grep, /a\/one\.ts:1: export const one = 1;/);
  assert.equal(await node.handle('grep', { pattern: 'nothing here' }), '(no matches)');
});

// The three tests below used to assert the opposite (an absolute path, `..` and a symlink out were
// all "allowed" / "followed"). They are the tests doc/shell-safety.md 8.2 means by "the only ones
// that should be overturned": they pinned the absence of a boundary, and layer 1 puts one in.
test('absolute and parent paths outside the starting workspace are supported', async (t) => {
  const { root, node } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await node.handle('write', { path: join(outside, 'note.txt'), content: 'out there' });
  await node.handle('write', { path: '../sibling.txt', content: 'next door' });
  assert.equal(await node.handle('read', { path: join(outside, 'note.txt') }), 'out there');
  assert.equal(await node.handle('read', { path: '../sibling.txt' }), 'next door');
  assert.equal(await readFile(join(root, '..', 'sibling.txt'), 'utf8'), 'next door');
});

test('a symlink outside the starting workspace is followed', async (t) => {
  const { root, node } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'note.txt'), 'visible');
  await symlink(outside, join(root, 'link'));
  assert.equal(await node.handle('read', { path: 'link/note.txt' }), 'visible');
  await node.handle('write', { path: 'link/new.txt', content: 'x' });
  assert.equal(await readFile(join(outside, 'new.txt'), 'utf8'), 'x');
});

test('a deny-listed name can be read but not written', async (t) => {
  const { root, node } = await setup(t);
  await writeFile(join(root, '.env'), 'SECRET=1');

  assert.equal(await node.handle('read', { path: '.env' }), 'SECRET=1');
  await assert.rejects(node.handle('write', { path: '.env', content: 'SECRET=2' }), /deny list/);
  await assert.rejects(node.handle('edit', { path: '.env', old: 'SECRET=1', new: 'SECRET=2' }), /deny list/);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'SECRET=1');
});

test('exec runs in the workspace and reports exit code and stdio', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', { path: 'marker.txt', content: 'x' });

  const output = await node.handle('exec', { command: 'ls' });
  assert.match(output, /^exit 0/);
  assert.match(output, /marker\.txt/);

  const failed = await node.handle('exec', { command: 'exit 7' });
  assert.match(failed, /^exit 7/);
});

test('run-node starts a local node with the bus URL and token in its environment', async (t) => {
  const { root, node } = await setup(t);
  withEnv(t, { NODE_AGENT_BUS_URL: 'ws://127.0.0.1:8788', NODE_AGENT_TOKEN: 'run-node-token' });
  await writeFile(
    join(root, 'env.mjs'),
    [
      'console.log(process.env.NODE_AGENT_BUS_URL);',
      'console.log(process.env.NODE_AGENT_TOKEN);',
      'console.log(process.env.NODE_AGENT_NODE_NAME);',
    ].join('\n'),
  );

  const output = await node.handle('run-node', { path: 'env.mjs' });
  assert.match(output, /^exit 0/);
  assert.match(output, /ws:\/\/127\.0\.0\.1:8788/);
  assert.match(output, /run-node-token/);
  assert.match(output, /env/); // no name given: the entry file name is the default
});

test('list-local-running-nodes lists a run-node process and kill-node removes it', async (t) => {
  const { root, node } = await setup(t);
  withEnv(t, { NODE_AGENT_BUS_URL: 'ws://127.0.0.1:8788', NODE_AGENT_TOKEN: 'run-nodes-token' });
  await writeFile(join(root, 'long.mjs'), "console.log('up'); setTimeout(() => {}, 30_000);\n");

  const started = await node.handle('run-node', {
    path: 'long.mjs',
    name: 'long-node',
    yield_ms: 200,
  });
  const session = /session (s\d+)/.exec(started)?.[1];
  assert.ok(session, started);

  const listed = JSON.parse(await node.handle('list-local-running-nodes', {}));
  assert.equal(listed.nodes.length, 1);
  assert.equal(listed.nodes[0].session, session);
  assert.equal(listed.nodes[0].name, 'long-node');
  assert.match(listed.nodes[0].path, /long\.mjs$/);
  assert.equal(listed.nodes[0].running, true);

  const killed = await node.handle('kill-node', { name: 'long-node' });
  assert.match(killed, /killed node long-node/);
  const after = JSON.parse(await node.handle('list-local-running-nodes', {}));
  assert.deepEqual(after.nodes, []);
});

test('the page has a Nodes tab that reads list-local-running-nodes', async () => {
  const page = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8');
  assert.match(page, /data-tab="nodes"/);
  assert.match(page, /list-local-running-nodes/);
  assert.match(page, /nodes-list/);
});

test('kill-node refuses a name it did not start', async (t) => {
  const { node } = await setup(t);
  await assert.rejects(
    node.handle('kill-node', { name: 'not-running' }),
    /no node started by run-node matches name not-running/,
  );
});
