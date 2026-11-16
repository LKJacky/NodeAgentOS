import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { nodeManifestOfPackage } from '@node-agent/sdk';
import {
  MAX_PATH_BYTES,
  NAMES,
  PANEL,
  FilesNode,
  unitIdOf,
  type DeleteResult,
  type FilesIndex,
  type ListResult,
  type ReadResult,
  type RenameResult,
  type WriteResult,
} from '../src/index.ts';
import { FakeHistory, call, fakeContext, handlersOf, refusal } from './support.ts';

/** Every byte value once: valid UTF-8 in places, invalid sequences in others, NULs and a lone 0xFF.
 *  A file store that quietly treated a body as text would fail this one. */
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_unused, value) => value));

const bytesOf = (base64: string): number[] => [...Buffer.from(base64, 'base64')];

test('an empty store lists nothing', async () => {
  const history = new FakeHistory();
  assert.deepEqual(await call<ListResult>(history, 'list'), {
    total: 0,
    count: 0,
    more: false,
    files: [],
  });
});

test('a text file is written and read back as text, and read says which encoding it used', async () => {
  const history = new FakeHistory();
  const wrote = await call<WriteResult>(history, 'write', {
    path: 'notes/hello.txt',
    content: 'héllo\nworld',
    encoding: 'utf8',
  });
  assert.equal(wrote.created, true);
  assert.equal(wrote.revision, 1);
  assert.equal(wrote.bytes, Buffer.byteLength('héllo\nworld', 'utf8'));
  assert.equal(wrote.encoding, 'utf8');
  assert.equal(typeof wrote.createdAt, 'string');
  assert.equal(typeof wrote.updatedAt, 'string');

  const read = await call<ReadResult>(history, 'read', {
    path: 'notes/hello.txt',
    encoding: 'utf8',
  });
  assert.equal(read.content, 'héllo\nworld');
  assert.equal(read.encoding, 'utf8');
  assert.equal(read.revision, 1);
  assert.equal(read.bytes, wrote.bytes);

  // No `encoding` in the call is base64 on both sides: the one spelling that cannot lose a byte.
  const plain = await call<ReadResult>(history, 'read', { path: 'notes/hello.txt' });
  assert.equal(plain.encoding, 'base64');
  assert.equal(plain.content, Buffer.from('héllo\nworld', 'utf8').toString('base64'));
});

test('arbitrary bytes survive a write and a read unchanged, with no encoding named at all', async () => {
  const history = new FakeHistory();
  const content = ALL_BYTES.toString('base64');
  const wrote = await call<WriteResult>(history, 'write', { path: 'blob/every-byte.bin', content });
  assert.equal(wrote.bytes, 256);
  assert.equal(wrote.encoding, 'base64');

  const read = await call<ReadResult>(history, 'read', { path: 'blob/every-byte.bin' });
  assert.equal(read.encoding, 'base64');
  assert.equal(read.content, content);
  assert.deepEqual(bytesOf(read.content), [...ALL_BYTES]);

  // The unit itself holds base64, whatever the caller said: one shape for text and binary alike.
  const unit = history.units.get(unitIdOf('blob/every-byte.bin'));
  assert.equal((unit?.meta as { base64: string }).base64, content);
});

test('a large file goes in and comes out whole (no recursion on the base64 check)', async () => {
  const history = new FakeHistory();
  // 1 MiB of every byte value: the size at which a backtracking regexp over the base64 would have
  // thrown 'Maximum call stack size exceeded' instead of storing the file.
  const bytes = Buffer.alloc(1024 * 1024);
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = at % 256;
  const content = bytes.toString('base64');

  const wrote = await call<WriteResult>(history, 'write', { path: 'big.bin', content });
  assert.equal(wrote.bytes, bytes.length);

  const read = await call<ReadResult>(history, 'read', { path: 'big.bin' });
  assert.equal(read.content.length, content.length);
  assert.ok(Buffer.from(read.content, 'base64').equals(bytes), 'every byte came back');

  // The same walk still refuses what is not base64, at any size.
  assert.match(
    await refusal(call(history, 'write', { path: 'bad.bin', content: 'A'.repeat(100_000) + '!' })),
    /content is not valid base64/,
  );
});

test('an empty file is a file: zero bytes, one entry', async () => {
  const history = new FakeHistory();
  const wrote = await call<WriteResult>(history, 'write', { path: 'empty.txt', content: '' });
  assert.equal(wrote.bytes, 0);
  const read = await call<ReadResult>(history, 'read', { path: 'empty.txt' });
  assert.equal(read.content, '');
  assert.deepEqual(
    (await call<ListResult>(history, 'list')).files.map((file) => [file.path, file.bytes]),
    [['empty.txt', 0]],
  );
});

test('list carries the metadata and never a body', async () => {
  const history = new FakeHistory();
  await call<WriteResult>(history, 'write', { path: 'b.txt', content: 'second', encoding: 'utf8' });
  await call<WriteResult>(history, 'write', { path: 'a.txt', content: 'first', encoding: 'utf8' });

  const listed = await call<ListResult>(history, 'list');
  assert.equal(listed.count, 2);
  assert.deepEqual(
    listed.files.map((file) => file.path),
    ['a.txt', 'b.txt'],
  );
  for (const file of listed.files) {
    assert.deepEqual(Object.keys(file).sort(), [
      'bytes',
      'createdAt',
      'createdBy',
      'encoding',
      'path',
      'revision',
      'updatedAt',
      'updatedBy',
    ]);
    assert.equal('content' in file, false, 'a body belongs to read');
    assert.equal(typeof file.bytes, 'number');
    assert.equal(typeof file.revision, 'number');
    assert.ok(file.updatedAt >= file.createdAt);
  }
});

test('list answers one prefix at a time, and says when it cut the answer', async () => {
  const history = new FakeHistory();
  for (const path of ['notes/a.md', 'notes/b.md', 'notes/x/c.md', 'notes-old.md', 'todo/t.txt'])
    await call<WriteResult>(history, 'write', { path, content: path, encoding: 'utf8' });

  const everything = await call<ListResult>(history, 'list');
  assert.equal(everything.total, 5);
  assert.equal(everything.count, 5);
  assert.equal(everything.more, false);

  // A prefix, not a directory: `notes/` is what is under it, `notes` also catches `notes-old.md`, and
  // nothing is resolved, completed or normalised on the way.
  assert.deepEqual(
    (await call<ListResult>(history, 'list', { path: 'notes/' })).files.map((file) => file.path),
    ['notes/a.md', 'notes/b.md', 'notes/x/c.md'],
  );
  assert.deepEqual(
    (await call<ListResult>(history, 'list', { path: 'notes' })).files.map((file) => file.path),
    ['notes-old.md', 'notes/a.md', 'notes/b.md', 'notes/x/c.md'],
  );
  assert.deepEqual(
    (await call<ListResult>(history, 'list', { path: 'notes/x/' })).files.map((file) => file.path),
    ['notes/x/c.md'],
  );
  assert.deepEqual(await call<ListResult>(history, 'list', { path: 'nothing/' }), {
    total: 0,
    count: 0,
    more: false,
    files: [],
  });
  // `''` is the whole directory, like saying nothing.
  assert.equal((await call<ListResult>(history, 'list', { path: '' })).total, 5);

  // The cap is said out loud instead of silently dropping the rest.
  const cut = await call<ListResult>(history, 'list', { path: 'notes', limit: 2 });
  assert.equal(cut.total, 4);
  assert.equal(cut.count, 2);
  assert.equal(cut.more, true);
  assert.deepEqual(
    cut.files.map((file) => file.path),
    ['notes-old.md', 'notes/a.md'],
  );

  assert.match(await refusal(call(history, 'list', { path: 7 })), /path must be a string/);
  assert.match(await refusal(call(history, 'list', { limit: 0 })), /limit wants a whole number/);
  assert.match(await refusal(call(history, 'list', { limit: 1.5 })), /limit wants a whole number/);
});

test('every entry says who wrote the bytes first, and who wrote them last', async () => {
  const history = new FakeHistory();
  const created = await call<WriteResult>(
    history,
    'write',
    { path: 'who.txt', content: 'one', encoding: 'utf8' },
    'notes',
  );
  assert.equal(created.createdBy, 'notes');
  assert.equal(created.updatedBy, 'notes');

  // A rewrite keeps the first author and moves the last one: the bytes are somebody else's now.
  const edited = await call<WriteResult>(
    history,
    'write',
    { path: 'who.txt', content: 'two', encoding: 'utf8', expectedRevision: 1 },
    'todo',
  );
  assert.equal(edited.createdBy, 'notes');
  assert.equal(edited.updatedBy, 'todo');

  const read = await call<ReadResult>(
    history,
    'read',
    { path: 'who.txt', encoding: 'utf8' },
    'agent',
  );
  assert.equal(read.createdBy, 'notes');
  assert.equal(read.updatedBy, 'todo');

  const listed = (await call<ListResult>(history, 'list')).files[0];
  assert.equal(listed?.createdBy, 'notes');
  assert.equal(listed?.updatedBy, 'todo');

  // Renaming touches the entry, so the renamer is who wrote it last - the author is still the author.
  const renamed = await call<RenameResult>(
    history,
    'rename',
    { from: 'who.txt', to: 'whom.txt' },
    'timer',
  );
  assert.equal(renamed.createdBy, 'notes');
  assert.equal(renamed.updatedBy, 'timer');
  assert.equal(
    (history.units.get(unitIdOf('whom.txt'))?.meta as { createdBy: string }).createdBy,
    'notes',
    'the first author travels with the bytes',
  );

  // A unit written before these fields existed reads as "somebody, unknown", not as a broken store.
  history.units.set(unitIdOf('old.txt'), {
    revision: 1,
    meta: {
      path: 'old.txt',
      encoding: 'utf8',
      bytes: 1,
      base64: 'eA==',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const old = await call<ReadResult>(history, 'read', { path: 'old.txt', encoding: 'utf8' });
  assert.equal(old.content, 'x');
  assert.equal(old.createdBy, '');
  assert.equal(old.updatedBy, '');
});

test('a write that named a stale revision is refused, and nothing is lost in the attempt', async () => {
  const history = new FakeHistory();
  const first = await call<WriteResult>(history, 'write', {
    path: 'a.txt',
    content: 'one',
    encoding: 'utf8',
  });
  assert.equal(first.revision, 1);

  const second = await call<WriteResult>(history, 'write', {
    path: 'a.txt',
    content: 'two',
    encoding: 'utf8',
    expectedRevision: 1,
  });
  assert.equal(second.revision, 2);
  assert.equal(second.created, false);

  assert.match(
    await refusal(
      call(history, 'write', {
        path: 'a.txt',
        content: 'three',
        encoding: 'utf8',
        expectedRevision: 1,
      }),
    ),
    /conflict: "a\.txt" has changed \(expected revision 1, found 2\); read it again, or send expectedRevision 2 to overwrite/,
  );
  assert.equal(
    (await call<ReadResult>(history, 'read', { path: 'a.txt', encoding: 'utf8' })).content,
    'two',
  );
  assert.equal((await call<ListResult>(history, 'list')).files[0]?.revision, 2);

  // 0 is "this file must not exist yet": create-only, in both directions.
  assert.match(
    await refusal(
      call(history, 'write', {
        path: 'a.txt',
        content: 'x',
        encoding: 'utf8',
        expectedRevision: 0,
      }),
    ),
    /conflict: a file already exists at "a\.txt" \(revision 2\)/,
  );
  const created = await call<WriteResult>(history, 'write', {
    path: 'fresh.txt',
    content: 'new',
    encoding: 'utf8',
    expectedRevision: 0,
  });
  assert.equal(created.created, true);
  assert.equal(created.revision, 1);

  assert.match(
    await refusal(
      call(history, 'write', {
        path: 'ghost.txt',
        content: 'x',
        encoding: 'utf8',
        expectedRevision: 1,
      }),
    ),
    /conflict: there is no file at "ghost\.txt" \(expected revision 1\)/,
  );
  assert.equal(history.units.has(unitIdOf('ghost.txt')), false);
});

test('a write without expectedRevision is an unconditional overwrite', async () => {
  const history = new FakeHistory();
  await call<WriteResult>(history, 'write', { path: 'a.txt', content: 'one', encoding: 'utf8' });
  const overwritten = await call<WriteResult>(history, 'write', {
    path: 'a.txt',
    content: 'two',
    encoding: 'utf8',
  });
  assert.equal(overwritten.revision, 2);
  assert.equal(
    (await call<ListResult>(history, 'list')).count,
    1,
    'the index was updated, not appended to',
  );
});

test('rename moves the bytes, trades one index entry for the other, and keeps a taken path', async () => {
  const history = new FakeHistory();
  await call<WriteResult>(history, 'write', {
    path: 'a/x.txt',
    content: 'payload',
    encoding: 'utf8',
  });
  await call<WriteResult>(history, 'write', { path: 'c.txt', content: 'taken', encoding: 'utf8' });

  const renamed = await call<RenameResult>(history, 'rename', { from: 'a/x.txt', to: 'b/y.txt' });
  assert.equal(renamed.from, 'a/x.txt');
  assert.equal(renamed.path, 'b/y.txt');
  assert.equal(renamed.bytes, 7);
  assert.equal(renamed.revision, 1, 'a new key is a new unit, at its first revision');

  assert.deepEqual(
    (await call<ListResult>(history, 'list')).files.map((file) => file.path),
    ['b/y.txt', 'c.txt'],
  );
  assert.equal(
    (await call<ReadResult>(history, 'read', { path: 'b/y.txt', encoding: 'utf8' })).content,
    'payload',
  );
  assert.match(await refusal(call(history, 'read', { path: 'a/x.txt' })), /no file at "a\/x\.txt"/);

  // The store itself moved: the old unit is gone, the new one holds the same bytes.
  assert.equal(history.units.has(unitIdOf('a/x.txt')), false);
  assert.equal(
    (history.units.get(unitIdOf('b/y.txt'))?.meta as { base64: string }).base64,
    Buffer.from('payload', 'utf8').toString('base64'),
  );

  // A rename onto a path that exists is refused, and the file being renamed stays where it was.
  assert.match(
    await refusal(call(history, 'rename', { from: 'b/y.txt', to: 'c.txt' })),
    /conflict: a file already exists at "c\.txt" \(revision 1\)/,
  );
  assert.equal(
    (await call<ReadResult>(history, 'read', { path: 'b/y.txt', encoding: 'utf8' })).content,
    'payload',
  );
  assert.equal(
    (await call<ReadResult>(history, 'read', { path: 'c.txt', encoding: 'utf8' })).content,
    'taken',
  );

  // Renaming to the name it already has changes nothing and is not an error.
  const same = await call<RenameResult>(history, 'rename', { from: 'c.txt', to: 'c.txt' });
  assert.equal(same.revision, 1);
  assert.equal((await call<ListResult>(history, 'list')).count, 2);
});

test('delete removes the bytes and the index entry, and says whether there was anything', async () => {
  const history = new FakeHistory();
  await call<WriteResult>(history, 'write', { path: 'gone.txt', content: 'bye', encoding: 'utf8' });

  const deleted = await call<DeleteResult>(history, 'delete', { path: 'gone.txt' });
  assert.deepEqual(deleted, { path: 'gone.txt', deleted: true });
  assert.equal(history.units.has(unitIdOf('gone.txt')), false);
  assert.deepEqual(await call<ListResult>(history, 'list'), {
    total: 0,
    count: 0,
    more: false,
    files: [],
  });
  assert.match(
    await refusal(call(history, 'read', { path: 'gone.txt' })),
    /no file at "gone\.txt"/,
  );

  assert.deepEqual(await call<DeleteResult>(history, 'delete', { path: 'gone.txt' }), {
    path: 'gone.txt',
    deleted: false,
  });
});

test('a new instance reads what the one before it wrote: the history units are the state', async () => {
  const history = new FakeHistory();
  await call<WriteResult>(history, 'write', {
    path: 'keep/me.txt',
    content: 'durable',
    encoding: 'utf8',
  });
  await call<WriteResult>(history, 'write', {
    path: 'keep/binary.bin',
    content: ALL_BYTES.toString('base64'),
  });

  // A restart is a second instance with a second context against the same store - which is what the
  // host builds anyway, one per invocation, so nothing may live in the instance.
  const restarted = handlersOf(history, 'some-other-node');
  const listed = (await restarted.list!({})) as ListResult;
  assert.deepEqual(
    listed.files.map((file) => file.path),
    ['keep/binary.bin', 'keep/me.txt'],
  );
  const read = (await restarted.read!({ path: 'keep/me.txt', encoding: 'utf8' })) as ReadResult;
  assert.equal(read.content, 'durable');
  const binary = (await restarted.read!({ path: 'keep/binary.bin' })) as ReadResult;
  assert.deepEqual(bytesOf(binary.content), [...ALL_BYTES]);

  // Under the names the node documents, and nothing else.
  assert.deepEqual([...history.units.keys()].sort(), [
    unitIdOf('keep/binary.bin'),
    unitIdOf('keep/me.txt'),
    'files.index',
  ]);
  assert.equal(
    unitIdOf('keep/me.txt'),
    `files.file.${Buffer.from('keep/me.txt', 'utf8').toString('base64url')}`,
  );
});

test('every node names the same file: a path is global, not per caller', async () => {
  const history = new FakeHistory();
  await call<WriteResult>(
    history,
    'write',
    { path: 'shared/report.md', content: '# hi', encoding: 'utf8' },
    'agent',
  );

  for (const from of ['agent', 'notes', 'todo', 'another-agent']) {
    const read = await call<ReadResult>(
      history,
      'read',
      { path: 'shared/report.md', encoding: 'utf8' },
      from,
    );
    assert.equal(read.content, '# hi', `${from} reads the same file`);
  }
  const wrote = await call<WriteResult>(
    history,
    'write',
    { path: 'shared/report.md', content: '# hi!', encoding: 'utf8' },
    'todo',
  );
  assert.equal(wrote.revision, 2);
  assert.equal(
    (
      await call<ReadResult>(
        history,
        'read',
        { path: 'shared/report.md', encoding: 'utf8' },
        'agent',
      )
    ).content,
    '# hi!',
  );
});

test('two writers of the index do not lose each other: the retry re-reads and re-applies', async () => {
  const history = new FakeHistory();
  let armed = true;
  history.beforeSave = async (unitId) => {
    if (!armed || unitId !== 'files.index') return;
    armed = false;
    // A second writer lands its own entry in the gap between this call's read and its save.
    await call<WriteResult>(history, 'write', {
      path: 'other.txt',
      content: 'from the other writer',
      encoding: 'utf8',
    });
  };

  await call<WriteResult>(history, 'write', {
    path: 'mine.txt',
    content: 'from this writer',
    encoding: 'utf8',
  });

  const listed = await call<ListResult>(history, 'list');
  assert.deepEqual(
    listed.files.map((file) => file.path),
    ['mine.txt', 'other.txt'],
  );
  assert.equal(
    (await call<ReadResult>(history, 'read', { path: 'other.txt', encoding: 'utf8' })).content,
    'from the other writer',
  );
  assert.ok(history.saves > 3, 'the index write was attempted more than once');
});

test('a path is a logical key: slashes, spaces, dots, CJK, anything but empty', async () => {
  const history = new FakeHistory();
  const paths = [
    'a/b/c/d.txt',
    ' spaced name .txt ',
    '../../etc/passwd',
    '文件/说明.md',
    'emoji 🎉.bin',
    '__proto__',
    'C:\\windows\\system32',
    'a'.repeat(MAX_PATH_BYTES),
  ];
  for (const path of paths)
    await call<WriteResult>(history, 'write', { path, content: path, encoding: 'utf8' });

  for (const path of paths) {
    const read = await call<ReadResult>(history, 'read', { path, encoding: 'utf8' });
    assert.equal(read.content, path, `${JSON.stringify(path)} round-trips and is not rewritten`);
  }
  assert.equal(
    (await call<ListResult>(history, 'list')).count,
    paths.length,
    'no path collided with another',
  );

  assert.match(
    await refusal(call(history, 'write', { path: '', content: 'x' })),
    /path must not be empty/,
  );
  assert.match(
    await refusal(call(history, 'write', { path: '   ', content: 'x' })),
    /path must not be empty/,
  );
  assert.match(await refusal(call(history, 'read', {})), /path must be a string/);
  assert.match(await refusal(call(history, 'delete', { path: 7 })), /path must be a string/);
});

test('what cannot be stored is refused with a sentence, before anything is written', async () => {
  const history = new FakeHistory();
  const saves = history.saves;

  assert.match(
    await refusal(call(history, 'write', { path: 'a.txt', content: 'x', encoding: 'utf16' })),
    /encoding must be "utf8" or "base64"/,
  );
  assert.match(
    await refusal(call(history, 'write', { path: 'a.txt', content: '!!!not base64!!!' })),
    /content is not valid base64/,
  );
  assert.match(
    await refusal(call(history, 'write', { path: 'a.txt', content: 7 })),
    /content must be a string/,
  );
  assert.match(
    await refusal(
      call(history, 'write', {
        path: 'a.txt',
        content: 'x',
        encoding: 'utf8',
        expectedRevision: 1.5,
      }),
    ),
    /expectedRevision wants a whole number/,
  );
  assert.match(
    await refusal(
      call(history, 'write', {
        path: 'a'.repeat(MAX_PATH_BYTES + 1),
        content: 'x',
        encoding: 'utf8',
      }),
    ),
    new RegExp(`a path may be at most ${MAX_PATH_BYTES}`),
  );
  assert.match(await refusal(call(history, 'rename', { from: 'a.txt' })), /to must be a string/);
  assert.match(await refusal(call(history, 'rename', { to: 'a.txt' })), /from must be a string/);
  assert.match(
    await refusal(call(history, 'rename', { from: 'nope.txt', to: 'b.txt' })),
    /no file at "nope\.txt"/,
  );

  assert.equal(history.saves, saves, 'a refused call wrote nothing at all');
  assert.equal(history.units.size, 0);
});

test('a bus with no history node says so, instead of failing somewhere deep', async () => {
  const history = new FakeHistory({ registered: false });
  const message = await refusal(call(history, 'list'));
  assert.match(message, /files keeps every file in the history node, and this bus has none/);
  assert.match(message, /no such node for user: history/);
});

test('files declares one schema per capability', () => {
  const history = new FakeHistory();
  assert.deepEqual(Object.keys(handlersOf(history)), [...NAMES, PANEL]);

  const manifest = nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(manifest.name, 'files');
  assert.deepEqual(Object.keys(manifest.caps).sort(), [...NAMES, PANEL].sort());
  for (const name of NAMES)
    assert.ok(
      (manifest.caps[name] as { description?: string } | undefined)?.description,
      `${name} has no description`,
    );

  // Every capability says who may call it, and the answer is everyone: one shared store is the point,
  // so no node has to be granted access before it can read a file. `*` is the bus's wildcard.
  for (const cap of [...NAMES, PANEL])
    assert.deepEqual(
      (manifest.caps[cap] as { callers?: string[] }).callers,
      ['*'],
      `${cap} is open to every node on the bus`,
    );

  // The schemas the model reads are the shipped ones, not a test's idea of them.
  const write = manifest.caps.write as { properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(write.properties.encoding?.enum, ['utf8', 'base64']);
  assert.ok(write.properties.expectedRevision, 'write can name a revision');
});

test('the page is handed out without touching the store, painted in the language asked for', async () => {
  const history = new FakeHistory();
  const handlers = handlersOf(history);

  const english = String(await handlers.ui!({}));
  assert.match(english, /^<!doctype html>/i);
  assert.match(english, /<html lang="en">/);
  assert.match(english, /<title data-text-key="title">Files · node_agent<\/title>/);
  assert.match(english, /placeholder="Filter by path prefix, e.g. notes\/"/);
  // The node's own name is filled in, and the markers stay so a later change of language is redrawn
  // by the SDK's browser half without a reload.
  assert.match(english, /const INJECTED = ['"]files['"];/);
  assert.match(english, /data-text-key="button\.download"/);
  assert.doesNotMatch(english, /__NODE__/);

  const chinese = String(await handlers.ui!({ language: 'zh-CN' }));
  assert.match(chinese, /<html lang="zh-CN">/);
  assert.match(chinese, /<h1 data-text-key="title">文件 · node_agent<\/h1>/);
  assert.match(chinese, />下载</);

  // A page is content: it was answered with nothing written and nothing read.
  assert.equal(history.saves, 0);
  assert.equal(history.units.size, 0);
});

test('the page reads files through the same capabilities a caller does, and draws text safely', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');

  // The two calls a viewer makes, and the filter the list takes.
  assert.match(html, /call\(`\$\{NODE\}\.list`, \{ path: prefix, limit: PAGE_SIZE \}\)/);
  assert.match(html, /call\(`\$\{NODE\}\.read`, \{ path \}\)/);

  // No markup built out of file data: a path is text, and only textContent puts it on the page.
  assert.doesNotMatch(html, /innerHTML/);
  assert.doesNotMatch(html, /insertAdjacentHTML|outerHTML|document\.write/);

  // A text file is decoded as UTF-8 and a binary one is shown as bytes, never as replacement
  // characters pretending to be text.
  assert.match(html, /new TextDecoder\('utf-8', \{ fatal: true \}\)/);
  assert.match(html, /viewer\.binary/);
  // Both directions of a look are offered: the bytes as base64, and the whole file as a download.
  assert.match(html, /button\.base64/);
  assert.match(html, /URL\.createObjectURL\(new Blob\(\[raw\]/);
});

test('the page uploads bytes with the same write capability, and never silently replaces a file', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');

  // A picked or dropped file is read as bytes and sent as base64: no text decoding on the way in,
  // so a PNG arrives as the same PNG.
  assert.match(html, /<input[\s\S]*?id="pick"[\s\S]*?type="file"[\s\S]*?multiple/);
  assert.match(html, /await file\.arrayBuffer\(\)/);
  assert.match(html, /content: base64Of\(bytes\)/);
  assert.match(html, /encoding: 'base64'/);
  assert.match(html, /dataTransfer\?\.files/);
  assert.doesNotMatch(html, /accept=/, 'any bytes are allowed, so there is no type filter');

  // Create-only for a path nobody saw, and the revision on screen for one that is there: an upload
  // cannot land on top of a file that moved on.
  assert.match(html, /expectedRevision: known \? known\.revision : 0/);
  assert.match(html, /confirm\(t\('upload\.overwrite'/);

  // The webui refuses a /call body over 8 MiB, so the page stops the upload before it starts.
  assert.match(html, /const MAX_UPLOAD = 5 \* 1024 \* 1024;/);
  assert.match(html, /upload\.tooLarge/);
});

test('the index is a list of entries, and a damaged one is an error rather than an empty store', async () => {
  const history = new FakeHistory();
  await call<WriteResult>(history, 'write', { path: 'a.txt', content: 'x', encoding: 'utf8' });
  const index = history.units.get('files.index')!.meta as FilesIndex;
  assert.equal(index.version, 1);
  assert.deepEqual(
    index.files.map((file) => file.path),
    ['a.txt'],
  );

  // Something else wrote the index: half an entry is a store to report, not an empty directory.
  history.units.set('files.index', {
    revision: 2,
    meta: { version: 1, files: [{ path: 'a.txt' }] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.match(await refusal(call(history, 'list')), /invalid entry in files history index/);
});

test('the node is built from a context alone, as the host builds it', () => {
  const node = new FilesNode(fakeContext(new FakeHistory()));
  assert.deepEqual(Object.keys(node.handlers), [...NAMES, PANEL]);
});
