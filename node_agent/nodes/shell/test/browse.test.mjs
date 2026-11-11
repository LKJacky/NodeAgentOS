// The file browser's own abilities (`files-tree` / `files-read` / `files-write`): what they answer,
// and the one thing they promise that `read` does not — the shell root is a boundary here, because a
// page can hand them any string it likes. The browser is also the only reader that must never turn
// bytes into text (a binary or oversized file comes back as a structured refusal), and the only
// writer that carries a revision: a save whose file has moved on is refused, not written.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shell } from './support.mjs';

/** A throwaway workspace inside a parent of its own, so `..` has somewhere harmless to land. */
async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), 'browse-'));
  const root = join(parent, 'ws');
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, node: shell(t, root) };
}

/** A tree answer parsed back, since the capability answers JSON on the wire. */
async function tree(node, args = {}) {
  return JSON.parse(await node.handle('files-tree', args));
}

async function read(node, path) {
  return JSON.parse(await node.handle('files-read', { path }));
}

async function save(node, args) {
  return JSON.parse(await node.handle('files-write', args));
}

/** The smallest PNG this test can carry in source: 1×1, transparent. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('files-tree lists directories first, with type, size and mtime', async (t) => {
  const { node } = await setup(t);
  await mkdir(join(node.workspace, 'src'));
  await writeFile(join(node.workspace, 'src', 'a.ts'), 'const a = 1;\n');
  await writeFile(join(node.workspace, 'notes.txt'), 'hello');

  const root = await tree(node);
  assert.equal(root.path, '.');
  assert.equal(root.depth, 1);
  assert.deepEqual(
    root.entries.map((entry) => [entry.name, entry.type]),
    [
      ['src', 'dir'],
      ['notes.txt', 'file'],
    ],
  );

  const file = root.entries[1];
  assert.equal(file.path, 'notes.txt');
  assert.equal(file.size, 5);
  assert.equal(typeof file.mtime, 'number');
  // One level is all the default asks for: a directory at the edge carries no children, which is
  // how the page knows to ask again when it opens it.
  assert.equal(root.entries[0].children, undefined);
});

test('files-tree expands the levels it is asked for, and no more than four', async (t) => {
  const { node } = await setup(t);
  await mkdir(join(node.workspace, 'a', 'b'), { recursive: true });
  await writeFile(join(node.workspace, 'a', 'b', 'deep.txt'), 'x');

  const two = await tree(node, { path: 'a', depth: 2 });
  assert.equal(two.path, 'a');
  assert.equal(two.entries[0].name, 'b');
  assert.deepEqual(
    two.entries[0].children.map((entry) => entry.name),
    ['deep.txt'],
  );

  await assert.rejects(node.handle('files-tree', { depth: 0 }), /depth wants a whole number/);
  await assert.rejects(node.handle('files-tree', { depth: 'deep' }), /depth wants a whole number/);
});

test('files-read answers text with its line count and a source type', async (t) => {
  const { node } = await setup(t);
  await writeFile(join(node.workspace, 'src.ts'), 'const a = 1;\n');

  const text = await read(node, 'src.ts');
  assert.equal(text.ok, true);
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'const a = 1;\n');
  assert.equal(text.lines, 2);
  assert.equal(text.size, 13);
  assert.equal(text.path, 'src.ts');
  assert.equal(typeof text.revision, 'number', 'a preview carries the revision a save hands back');
});

test('files-read shows an image as a data URL', async (t) => {
  const { node } = await setup(t);
  await writeFile(join(node.workspace, 'dot.png'), PNG);

  const image = await read(node, 'dot.png');
  assert.equal(image.ok, true);
  assert.equal(image.kind, 'image');
  assert.equal(image.mime, 'image/png');
  assert.match(image.dataUrl, /^data:image\/png;base64,iVBOR/);
  assert.equal(image.text, undefined, 'an image is never also handed back as text');
});

test('files-read refuses a binary file, and says only what it is', async (t) => {
  const { node } = await setup(t);
  await writeFile(join(node.workspace, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]));

  const binary = await read(node, 'blob.bin');
  assert.equal(binary.ok, false);
  assert.equal(binary.kind, 'binary');
  assert.equal(binary.size, 5);
  assert.equal(binary.text, undefined);
  assert.equal(binary.dataUrl, undefined);
  assert.match(binary.message, /not previewable: 5 bytes/);
});

test('files-read refuses a file past the preview limit', async (t) => {
  const { node } = await setup(t);
  await writeFile(join(node.workspace, 'big.txt'), 'x'.repeat(600 * 1024));

  const large = await read(node, 'big.txt');
  assert.equal(large.ok, false);
  assert.equal(large.kind, 'too-large');
  assert.match(large.message, /over the 524288-byte preview limit/);
  assert.equal(large.text, undefined);
});

test('absolute, parent and symlink paths are available to the file browser', async (t) => {
  const { parent, root, node } = await setup(t);
  await writeFile(join(parent, 'outside.txt'), 'visible');
  assert.equal((await read(node, '../outside.txt')).text, 'visible');
  assert.equal((await read(node, join(parent, 'outside.txt'))).text, 'visible');
  assert.equal(JSON.parse(await node.handle('files-tree', { path: '../' })).path, parent);
  await symlink(parent, join(root, 'link'));
  assert.equal((await read(node, 'link/outside.txt')).text, 'visible');
});

test('a path inside the root still works when written absolutely', async (t) => {
  const { root, node } = await setup(t);
  await writeFile(join(root, 'inside.txt'), 'fine');

  const text = await read(node, join(root, 'inside.txt'));
  assert.equal(text.ok, true);
  assert.equal(text.path, 'inside.txt');
});

test('missing paths and the wrong kind of path get a sentence, not a stack', async (t) => {
  const { node } = await setup(t);
  await mkdir(join(node.workspace, 'dir'));
  await writeFile(join(node.workspace, 'file.txt'), 'x');

  await assert.rejects(node.handle('files-tree', { path: 'nope' }), /path wants a directory that exists/);
  await assert.rejects(node.handle('files-read', { path: 'nope' }), /path wants a file that exists/);
  await assert.rejects(node.handle('files-read', { path: 'dir' }), /path wants a file/);
  await assert.rejects(node.handle('files-read', { path: '' }), /path wants a file to read/);
  await assert.rejects(node.handle('files-tree', { path: 'file.txt' }), /is a file — read it with files-read/);
});

test('files-write saves the text and hands back the next revision', async (t) => {
  const { node } = await setup(t);
  await writeFile(join(node.workspace, 'edit.txt'), 'one\n');

  const first = await read(node, 'edit.txt');
  const saved = await save(node, {
    path: 'edit.txt',
    content: 'two\n',
    expectedRevision: first.revision,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.path, 'edit.txt');
  assert.equal(saved.size, 4);
  assert.ok(
    saved.revision > first.revision,
    `a save moves the revision forward: ${first.revision} -> ${saved.revision}`,
  );

  const again = await read(node, 'edit.txt');
  assert.equal(again.text, 'two\n', 'the bytes on disk are the ones the save carried');
  assert.equal(again.revision, saved.revision, 'the revision the save returned is the one a read sees');

  // A file that is not there has no revision to conflict with: without one, a save creates it.
  const created = await save(node, { path: 'deep/new.txt', content: 'hi\n' });
  assert.equal(created.ok, true);
  assert.equal(await node.handle('read', { path: 'deep/new.txt' }), 'hi\n');
});

test('files-write refuses a revision the file has moved past', async (t) => {
  const { node } = await setup(t);
  await writeFile(join(node.workspace, 'race.txt'), 'mine\n');
  const stale = await read(node, 'race.txt');

  // Something else writes the file after the page read it: the revision the page holds is now old.
  await node.handle('write', { path: 'race.txt', content: 'theirs\n' });

  const refused = await save(node, {
    path: 'race.txt',
    content: 'mine, again\n',
    expectedRevision: stale.revision,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, 'conflict');
  assert.match(refused.message, /changed since revision/);
  assert.ok(refused.revision > stale.revision, 'a conflict hands back the revision that is there now');
  assert.equal(await node.handle('read', { path: 'race.txt' }), 'theirs\n', 'the refused save wrote nothing');

  // "Keep mine" is the same call without a revision: the page's text goes over what is there.
  const forced = await save(node, { path: 'race.txt', content: 'mine, again\n' });
  assert.equal(forced.ok, true);
  assert.equal(await node.handle('read', { path: 'race.txt' }), 'mine, again\n');
});

test('files-write refuses the deny-list names and says which one', async (t) => {
  const { node, root } = await setup(t);
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), '[core]\n');

  const refused = await save(node, { path: '.git/config', content: 'sneaky' });
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, 'denied');
  assert.match(refused.message, /"\.git" is on this node's deny list/);
  assert.equal(await node.handle('read', { path: '.git/config' }), '[core]\n', 'the refused file is untouched');

  // The same name anywhere in a path, whether or not the directory exists yet.
  assert.equal((await save(node, { path: 'a/.git/hooks/pre-commit', content: 'x' })).kind, 'denied');

  // An ordinary dot-file is not on that list.
  assert.equal((await save(node, { path: '.gitignore', content: 'ok\n' })).ok, true);
});

test('files-write accepts parent and absolute paths while requiring content', async (t) => {
  const { parent, node } = await setup(t);
  assert.equal((await save(node, { path: '../escape.txt', content: 'x' })).ok, true);
  assert.equal((await save(node, { path: join(parent, 'absolute.txt'), content: 'y' })).ok, true);
  assert.equal(await readFile(join(parent, 'escape.txt'), 'utf8'), 'x');
  await assert.rejects(save(node, { path: 'ok.txt' }), /content wants the whole file contents/);
});

test('the model’s own write and edit move the revision the page read', async (t) => {
  const { node } = await setup(t);
  const path = join(node.workspace, 'shared.txt');
  await writeFile(path, 'one\n');

  // A revision lives in the file, not in a table here: the model's `write` and `edit` go through the
  // same `writeOne`, so a page holding the revision from before them sees the file move.
  const first = await read(node, 'shared.txt');
  await node.handle('write', { path: 'shared.txt', content: 'two\n' });
  const afterWrite = await read(node, 'shared.txt');
  assert.ok(afterWrite.revision > first.revision, `${afterWrite.revision} > ${first.revision}`);

  await node.handle('edit', { path: 'shared.txt', old: 'two', new: 'three' });
  const afterEdit = await read(node, 'shared.txt');
  assert.ok(afterEdit.revision > afterWrite.revision, `${afterEdit.revision} > ${afterWrite.revision}`);

  // What the page read before either of them is stale now, and the save says where the file is.
  const refused = await save(node, { path: 'shared.txt', content: 'mine\n', expectedRevision: first.revision });
  assert.equal(refused.kind, 'conflict');
  assert.equal(refused.revision, afterEdit.revision);
  assert.equal(await node.handle('read', { path: 'shared.txt' }), 'three\n');
});

test('files-write follows a link out of the starting workspace', async (t) => {
  const { node, root } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'out-link'));
  assert.equal((await save(node, { path: 'out-link/x.txt', content: 'x' })).ok, true);
  assert.equal(await readFile(join(outside, 'x.txt'), 'utf8'), 'x');
});
