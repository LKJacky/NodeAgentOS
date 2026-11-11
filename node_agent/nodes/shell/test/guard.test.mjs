// The guard on the file abilities (doc/shell-safety.md, layer 1): one root, checked after a
// resolve *and* after a realpath, plus a short deny list for writes that is compared case-folded.
// `exec` is deliberately not in here — a command reaches anywhere anyway, and the test at the end
// says so out loud so nobody mistakes this file for a sandbox.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shellRoot } from '../dist/index.js';
import { shell } from './support.mjs';

/** A throwaway root, a directory beside it, and a node pointed at the root — the sibling is what
 *  `..` and an absolute path can name without touching anything real. */
async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), 'guard-'));
  const root = join(parent, 'ws');
  const outside = join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  t.after(() => rm(parent, { recursive: true, force: true }));

  return { parent, root, outside, node: shell(t, root) };
}

test('file abilities accept paths outside the starting workspace', async (t) => {
  const { outside, node } = await setup(t);
  const file = join(outside, 'note.txt');
  await writeFile(file, 'alpha');
  assert.equal(await node.handle('read', { path: file }), 'alpha');
  await node.handle('write', { path: file, content: 'beta' });
  await node.handle('edit', { path: file, old: 'beta', new: 'gamma' });
  assert.match(await node.handle('list', { path: outside }), /note\.txt/);
  assert.match(await node.handle('glob', { pattern: '**/*.txt', path: outside }), /note\.txt/);
  assert.match(await node.handle('grep', { pattern: 'gamma', path: outside }), /note\.txt/);
  assert.equal(JSON.parse(await node.handle('files-read', { path: file })).text, 'gamma');
  assert.equal(JSON.parse(await node.handle('files-write', { path: file, content: 'delta' })).ok, true);
});

test('symlinks outside the starting workspace are followed', async (t) => {
  const { root, outside, node } = await setup(t);
  await writeFile(join(outside, 'note.txt'), 'outside');
  await symlink(outside, join(root, 'dir-link'));
  assert.equal(await node.handle('read', { path: 'dir-link/note.txt' }), 'outside');
  await node.handle('write', { path: 'dir-link/new.txt', content: 'x' });
  assert.equal(await readFile(join(outside, 'new.txt'), 'utf8'), 'x');
});

test('the deny list stops a write by name, and says nothing about the file', async (t) => {
  const { root, node } = await setup(t);

  const denied = [
    '.git/config',
    'repo/.git/hooks/pre-commit',
    'homes/agent-1f3a/history.db',
    'k.pem',
    'certs/server.key',
    'a/secrets.yaml',
    'secrets.json',
    '.env',
    '.env.local',
  ];
  for (const path of denied)
    await assert.rejects(node.handle('write', { path, content: 'x' }), /on this node's deny list/, path);

  // `edit` writes too, so it is refused before the file is even read.
  await writeFile(join(root, 'k.pem'), 'PRIVATE-BYTES');
  await assert.rejects(node.handle('edit', { path: 'k.pem', old: 'PRIVATE', new: 'x' }), /deny list/);
  assert.equal(await readFile(join(root, 'k.pem'), 'utf8'), 'PRIVATE-BYTES');

  // A refusal names the place and the rule — never the content, and never a reason to try harder.
  await assert.rejects(
    node.handle('write', { path: 'k.pem', content: 'PRIVATE-BYTES' }),
    (error) => {
      assert.match(error.message, /^refusing to write k\.pem: \*\.pem is on this node's deny list/);
      assert.match(error.message, /NODE_AGENT_SHELL_DENY_WRITE/);
      assert.doesNotMatch(error.message, /PRIVATE-BYTES/);
      return true;
    },
  );

  // Reading is not denied: a read-only node that can read everything is what layer 1 promises.
  assert.equal(await node.handle('read', { path: 'k.pem' }), 'PRIVATE-BYTES');
});

test('the deny list is a name match, not a substring match', async (t) => {
  const { node } = await setup(t);

  // The neighbours of the denied names are ordinary files. A list that also caught these would be
  // a list nobody could work under, and the first thing anyone would do is switch it off.
  const allowed = [
    'src/git.txt',
    'notes/pem.md',
    'notes/homes.md',
    'keys/readme.md',
    'docs/secret.md',
    '.gitignore',
    'env.example',
  ];
  for (const path of allowed) {
    await node.handle('write', { path, content: 'fine' });
    assert.equal(await node.handle('read', { path }), 'fine', path);
  }
});

test('the page save meets the same deny list, and answers instead of throwing', async (t) => {
  const { root, node } = await setup(t);

  // `files-write` is the page's writer: the same list as `write`/`edit`, but a refusal is an answer
  // the page can print, not an exception — and it refuses before anything is written.
  for (const path of ['.git/config', 'x.pem', 'homes/a/history.db', '.env']) {
    const reply = JSON.parse(await node.handle('files-write', { path, content: 'x' }));
    assert.equal(reply.ok, false, path);
    assert.equal(reply.kind, 'denied', path);
    assert.match(reply.message, /on this node's deny list/, path);
    assert.match(reply.message, /NODE_AGENT_SHELL_DENY_WRITE/, path);
  }
  await assert.rejects(readFile(join(root, '.git', 'config')), 'a refused save wrote nothing');

  // The neighbours of the denied names are ordinary saves; so is a file inside the root.
  const fine = JSON.parse(await node.handle('files-write', { path: '.gitignore', content: 'node_modules\n' }));
  assert.equal(fine.ok, true);
  assert.equal(await node.handle('read', { path: '.gitignore' }), 'node_modules\n');
});

test('a denied name is denied in every spelling, so a case is not a way around it', async (t) => {
  const { node } = await setup(t);

  // On a case-insensitive disk (APFS by default) `a.pem` and `A.PEM` are one file. If the list
  // compared bytes, the same key would be writable in one spelling and refused in the other — the
  // classic way round a deny list.
  for (const path of ['a.pem', 'A.pem', 'A.PEM', 'a.Pem'])
    await assert.rejects(node.handle('write', { path, content: 'x' }), /deny list/, path);
  for (const path of ['.env', '.ENV', '.Env.Local'])
    await assert.rejects(node.handle('write', { path, content: 'x' }), /deny list/, path);
  for (const path of ['secrets.json', 'SECRETS.JSON', 'Secrets.yaml'])
    await assert.rejects(node.handle('write', { path, content: 'x' }), /deny list/, path);
  for (const path of ['.git/config', '.GIT/config', '.Git/config'])
    await assert.rejects(node.handle('write', { path, content: 'x' }), /deny list/, path);

  // NFKC too: the full-width spelling of `.env` is the same name to any reader.
  await assert.rejects(node.handle('write', { path: '\uFF0E\uFF45\uFF4E\uFF56', content: 'x' }), /deny list/);

  // Folding belongs to the deny list alone: an ordinary name keeps its case, and `A.txt` and
  // `a.txt` are two files on this filesystem and one on APFS — both spellings are allowed anyway.
  assert.match(await node.handle('write', { path: 'A.txt', content: 'one' }), /^wrote A\.txt/);
  assert.match(await node.handle('write', { path: 'a.txt', content: 'two' }), /^wrote a\.txt/);
});

test('ordinary work inside the root is untouched', async (t) => {
  const { root, node } = await setup(t);

  assert.equal(node.root, root);
  assert.equal(shellRoot(root), root);

  assert.equal(await node.handle('write', { path: 'notes/a.txt', content: 'alpha\n' }), 'wrote notes/a.txt (6 bytes, 2 lines)');
  assert.equal(await node.handle('edit', { path: 'notes/a.txt', old: 'alpha', new: 'beta' }), 'edited notes/a.txt (1 replacement)');
  assert.equal(await node.handle('read', { path: 'notes/a.txt' }), 'beta\n');
  assert.match(await node.handle('list', { path: 'notes' }), /^f a\.txt/m);
  assert.match(await node.handle('glob', { pattern: '**/*.txt' }), /notes\/a\.txt/);
  assert.match(await node.handle('grep', { pattern: 'beta' }), /notes\/a\.txt:1: beta/);

  // The browser's two abilities keep working inside the root — they were the first ones guarded,
  // and the unified check must not have narrowed them.
  const tree = JSON.parse(await node.handle('files-tree', { path: '.' }));
  assert.equal(tree.path, '.');
  assert.deepEqual(tree.entries.map((entry) => entry.name), ['notes']);

  const preview = JSON.parse(await node.handle('files-read', { path: 'notes/a.txt' }));
  assert.equal(preview.ok, true);
  assert.equal(preview.kind, 'text');
  assert.equal(preview.text, 'beta\n');
});

test('NODE_AGENT_SHELL_ROOT moves the root, and a bad one is a startup failure', async (t) => {
  const { root, outside } = await setup(t);
  const before = process.env.NODE_AGENT_SHELL_ROOT;

  try {
    process.env.NODE_AGENT_SHELL_ROOT = outside;
    const moved = shell(t, root);
    assert.equal(moved.root, outside);
    await moved.handle('write', { path: 'there.txt', content: 'ok' });
    await moved.handle('write', { path: join(root, 'here.txt'), content: 'x' });
    assert.equal(await readFile(join(root, 'here.txt'), 'utf8'), 'x');

    process.env.NODE_AGENT_SHELL_ROOT = join(outside, 'typo');
    assert.throws(() => shell(t, root), /NODE_AGENT_SHELL_ROOT is not a directory/);
  } finally {
    if (before === undefined) delete process.env.NODE_AGENT_SHELL_ROOT;
    else process.env.NODE_AGENT_SHELL_ROOT = before;
  }
});

test('exec keeps its old reach, on purpose', async (t) => {
  const { outside, node } = await setup(t);

  // Layer 1 constrains the file abilities, not the shell. A command with a `cwd` outside the root
  // still runs there, and this test exists so nobody reads the guard above as a sandbox.
  const output = await node.handle('exec', { command: 'pwd', cwd: outside });
  assert.match(output, /^exit 0/);
  assert.match(output, /outside/);
});
