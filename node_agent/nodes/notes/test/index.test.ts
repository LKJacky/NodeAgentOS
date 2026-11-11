import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeManifestOfPackage } from '@node-agent/sdk';
import {
  forgetLocalNotes,
  NotesNode,
  NAMES,
  type Memo,
  type Result,
  type Summary,
} from '../src/index.ts';
import {
  Caller,
  Fixture,
  joinNotes,
  startHistory,
  storeFor,
  testContext,
  type TestHistory,
} from './support.ts';

/** The notes node, a history node and a caller on one bus, all in one user's directory. */
async function withNotes<T>(
  database: string,
  run: (caller: Caller, history: TestHistory) => Promise<T>,
): Promise<T> {
  const fixture = await Fixture.open();
  const history = await startHistory(fixture, database);
  const notes = await joinNotes(fixture);
  const caller = await Caller.join(fixture);
  try {
    return await run(caller, history);
  } finally {
    await caller.close();
    await notes.stop();
    forgetLocalNotes(fixture.user);
    await history.close();
    await fixture.close();
  }
}

test('notes content survives a restart through history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-notes-'));
  const database = join(directory, 'history.sqlite');
  try {
    await withNotes(database, async (caller, history) => {
      const added = await caller.call('notes.add', { title: 'durable', text: 'saved body' });
      assert.equal(added.ok, true);

      const indexAfterAdd = history.store.load('default', 'notes', 'memos');
      const memoAfterAdd = history.store.load('default', 'notes', 'memos.1');
      assert.deepEqual(indexAfterAdd?.meta, { ids: [1], nextId: 2 });
      assert.equal(indexAfterAdd?.revision, 2);
      assert.equal(memoAfterAdd?.revision, 1);

      const updated = await caller.call('notes.update', { id: 1, text: 'updated body' });
      assert.equal(updated.ok, true);
      assert.equal(history.store.load('default', 'notes', 'memos')?.revision, 2);
      assert.equal(history.store.load('default', 'notes', 'memos.1')?.revision, 2);
    });

    await withNotes(database, async (caller, history) => {
      const listed = await caller.call('notes.list', {});
      assert.equal(listed.ok, true);
      const durable = (listed.value as Summary[]).find((memo) => memo.title === 'durable');
      assert.ok(durable);
      // `list` hands out summaries; the body is a `get` away, and this is that get.
      assert.equal((await caller.call('notes.get', { id: durable.id })).value.text, 'updated body');

      assert.equal((await caller.call('notes.delete', { id: 1 })).ok, true);
      assert.equal(history.store.load('default', 'notes', 'memos.1'), null);
      assert.deepEqual(history.store.load('default', 'notes', 'memos')?.meta, {
        ids: [],
        nextId: 2,
      });
    });

    await withNotes(database, async (caller) => {
      const listed = await caller.call('notes.list', {});
      assert.equal(listed.ok, true);
      assert.equal(
        (listed.value as Memo[]).some((memo) => memo.id === 1),
        false,
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('notes migrates a whole-list snapshot to incremental units', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-notes-legacy-'));
  const database = join(directory, 'history.sqlite');
  // Written before tags and incremental units existed: one whole-list snapshot, no tag field.
  storeFor(database).save('default', 'notes', 'memos', {
    memos: [{ id: 7, title: 'legacy', text: 'old snapshot', at: '2026-01-01T00:00:00.000Z' }],
    nextId: 8,
  });

  try {
    await withNotes(database, async (caller, currentHistory) => {
      const listed = await caller.call('notes.list', {});
      assert.equal((listed.value as Summary[])[0]?.title, 'legacy');
      // Written before any of this existed, so it reads as "no tag" instead of failing the store.
      assert.equal((listed.value as Summary[])[0]?.tag, '');
      assert.deepEqual(currentHistory.store.load('default', 'notes', 'memos')?.meta, {
        ids: [7],
        nextId: 8,
      });
      assert.equal(currentHistory.store.load('default', 'notes', 'memos.7')?.revision, 1);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('notes remains usable without history', async () => {
  const fixture = await Fixture.open();
  const notes = await joinNotes(fixture);
  const caller = await Caller.join(fixture);
  try {
    assert.equal((await caller.call('notes.add', { title: 'local' })).ok, true);
    const listed = await caller.call('notes.list', {});
    assert.equal(listed.ok, true);
    assert.ok((listed.value as Summary[]).some((memo) => memo.title === 'local'));
  } finally {
    await caller.close();
    await notes.stop();
    forgetLocalNotes(fixture.user);
    await fixture.close();
  }
});

/** The id of the document with this title, found instead of assumed: the seeds take ids 1 and 2. */
async function idOf(caller: Caller, title: string): Promise<number> {
  const listed = await caller.call('notes.list', {});
  assert.equal(listed.ok, true);
  const found = (listed.value as Summary[]).find((memo) => memo.title === title);
  assert.ok(found, `no document titled ${title}`);

  return found.id;
}

/** A node, its store and a caller — the short form the read/edit tests below need. */
async function withCaller<T>(run: (caller: Caller) => Promise<T>): Promise<T> {
  const fixture = await Fixture.open();
  const notes = await joinNotes(fixture);
  const caller = await Caller.join(fixture);
  try {
    return await run(caller);
  } finally {
    await caller.close();
    await notes.stop();
    forgetLocalNotes(fixture.user);
    await fixture.close();
  }
}

test('a document says which revision it is at, and a write can insist on one', async () => {
  await withCaller(async (caller) => {
    await caller.call('notes.add', { title: 'versioned', text: 'first' });
    const id = await idOf(caller, 'versioned');

    const first = await caller.call('notes.get', { id });
    assert.equal((first.value as Memo & { revision: number }).revision, 1);

    // A write that names the revision it read goes through, and answers with the new one.
    const written = await caller.call('notes.update', {
      id,
      text: 'second',
      expectedRevision: 1,
    });
    assert.equal(written.value, `updated id=${id} rev=2: versioned`);

    // The same revision again is a conflict: nothing is written, and the answer says which revision
    // it found — the number a caller sends to overwrite on purpose.
    const stale = await caller.call('notes.update', {
      id,
      text: 'third',
      expectedRevision: 1,
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /^conflict: memo id=/);
    assert.match(stale.error, /expected revision 1, found 2/);
    assert.match(stale.error, /expectedRevision=2 to overwrite/);
    assert.equal((await caller.call('notes.read', { id })).value, 'second');

    // Overwriting on purpose is the same write with the revision the conflict named.
    const overwritten = await caller.call('notes.update', {
      id,
      text: 'third',
      expectedRevision: 2,
    });
    assert.equal(overwritten.value, `updated id=${id} rev=3: versioned`);

    // A write that names no revision stays unconditional: a model that was told to change a
    // document is not made to read it twice first.
    assert.equal((await caller.call('notes.update', { id, text: 'fourth' })).ok, true);
    assert.equal((await caller.call('notes.get', { id })).value.text, 'fourth');

    // The revision is not a string the wire may talk us into: it is a whole number, zero or more.
    const silly = await caller.call('notes.update', { id, text: 'x', expectedRevision: '2' });
    assert.equal(silly.ok, false);
    assert.equal(silly.error, 'expectedRevision wants a whole number, zero or more');
    assert.equal(
      (await caller.call('notes.update', { id, text: 'x', expectedRevision: -1 })).error,
      'expectedRevision wants a whole number, zero or more',
    );

    // A document that is not there is not a conflict — there is nothing to have moved on.
    const missing = await caller.call('notes.update', { id: 999, text: 'x', expectedRevision: 1 });
    assert.equal(missing.error, 'no memo with id=999');
  });
});

test('notes reads a document in line chunks, with the marker shell.read leaves', async () => {
  await withCaller(async (caller) => {
    assert.equal(
      (await caller.call('notes.add', { title: 'lines', text: 'one\ntwo\nthree\nfour' })).ok,
      true,
    );
    const id = await idOf(caller, 'lines');

    const middle = await caller.call('notes.read', { id, offset: 2, limit: 2 });
    assert.equal(middle.value, 'two\nthree\n… (4 lines in all; this stops at line 3)');
    const head = await caller.call('notes.read', { id, limit: 2 });
    assert.equal(head.value, 'one\ntwo\n… (4 lines in all; this stops at line 2)');
    // The last chunk is the rest, so there is nothing left to say about lines.
    assert.equal((await caller.call('notes.read', { id, offset: 3 })).value, 'three\nfour');
    // No offset and no limit is the whole document, in one answer.
    assert.equal((await caller.call('notes.read', { id })).value, 'one\ntwo\nthree\nfour');
    assert.equal((await caller.call('notes.read', { id: 999 })).ok, false);
  });
});

test('notes edits a snippet, and refuses the two edits shell refuses', async () => {
  await withCaller(async (caller) => {
    await caller.call('notes.add', { title: 'edit me', text: 'alpha\nbeta\nalpha' });
    const id = await idOf(caller, 'edit me');

    const edited = await caller.call('notes.edit', { id, old: 'beta', new: 'BETA' });
    assert.equal(edited.value, `edited id=${id} rev=2 (1 replacement): edit me`);

    const nothing = await caller.call('notes.edit', { id, old: 'gamma', new: 'x' });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.error, `there is no such text in the document id=${id}`);

    const twice = await caller.call('notes.edit', { id, old: 'alpha', new: 'ALPHA' });
    assert.equal(twice.ok, false);
    assert.equal(
      twice.error,
      `old appears 2 times in the document id=${id}: give more context, or pass replaceAll:true`,
    );

    const both = await caller.call('notes.edit', {
      id,
      old: 'alpha',
      new: 'ALPHA',
      replaceAll: true,
    });
    assert.equal(both.value, `edited id=${id} rev=3 (2 replacements): edit me`);
    assert.equal((await caller.call('notes.read', { id })).value, 'ALPHA\nBETA\nALPHA');

    // No `new` at all deletes the snippet, which is what a document needs and a file rarely does.
    const removed = await caller.call('notes.edit', { id, old: 'BETA\n' });
    assert.equal(removed.value, `edited id=${id} rev=4 (1 replacement): edit me`);
    assert.equal((await caller.call('notes.read', { id })).value, 'ALPHA\nALPHA');

    const empty = await caller.call('notes.edit', { id, old: '', new: 'x' });
    assert.equal(empty.error, 'edit needs the old text to replace (old cannot be empty)');
  });
});

test('notes appends one line at the end of a document', async () => {
  await withCaller(async (caller) => {
    await caller.call('notes.add', { title: 'log', text: 'first' });
    const id = await idOf(caller, 'log');

    const appended = await caller.call('notes.append', { id, text: 'second' });
    assert.equal(appended.value, `appended to id=${id} rev=2 (+6 bytes): log`);
    // The newline is added for the caller: an append never glues two entries into one line.
    assert.equal((await caller.call('notes.read', { id })).value, 'first\nsecond');
    await caller.call('notes.append', { id, text: 'third' });
    assert.equal((await caller.call('notes.read', { id })).value, 'first\nsecond\nthird');

    // An empty document gets the line with no leading blank line.
    await caller.call('notes.add', { title: 'blank' });
    const blank = await idOf(caller, 'blank');
    await caller.call('notes.append', { id: blank, text: 'only' });
    assert.equal((await caller.call('notes.read', { id: blank })).value, 'only');

    // An empty append is refused, but whitespace is text: `edit` and `append` never trim what the
    // caller sent, so a line made of spaces is a line.
    const nothing = await caller.call('notes.append', { id, text: '' });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.error, 'append wants the text to add');
    assert.equal((await caller.call('notes.append', { id, text: '   ' })).ok, true);
  });
});

test("notes lists summaries — no body — in the size bound's own unit", async () => {
  await withCaller(async (caller) => {
    // Five characters, thirteen bytes, two lines: a summary that counted characters would say 5.
    await caller.call('notes.add', { title: '中文', text: '你好\n世界' });
    const id = await idOf(caller, '中文');

    const listed = await caller.call('notes.list', {});
    assert.equal(listed.ok, true);
    const summary = (listed.value as Summary[]).find((memo) => memo.id === id);
    assert.ok(summary);
    assert.deepEqual(Object.keys(summary).sort(), [
      'at',
      'bytes',
      'id',
      'lines',
      'revision',
      'tag',
      'title',
    ]);
    assert.equal('text' in summary, false);
    // A summary says which revision the document is at: one write so far, the add.
    assert.equal(summary.revision, 1);
    assert.equal(summary.bytes, 13);
    assert.equal(summary.lines, 2);
    assert.equal(summary.tag, '');
    assert.equal(typeof summary.at, 'string');

    // The number a summary reports is the number the bound is in: 256K of bytes fits, one byte more
    // does not.
    assert.equal(
      (await caller.call('notes.add', { title: 'fat', text: 'z'.repeat(256 * 1024) })).ok,
      true,
    );
    const fat = (await caller.call('notes.list', {})).value as Summary[];
    assert.equal(fat.find((memo) => memo.title === 'fat')?.bytes, 256 * 1024);
    assert.equal(
      (await caller.call('notes.add', { title: 'fatter', text: 'z'.repeat(256 * 1024 + 1) })).ok,
      false,
    );

    // An empty body has no lines. (`add` trims the body on the way in — that has been the title
    // and body contract — so a trailing newline is the trim's business, not `lines`'s.)
    await caller.call('notes.add', { title: 'empty' });
    await caller.call('notes.add', { title: 'two lines', text: 'one\ntwo' });
    const all = (await caller.call('notes.list', {})).value as Summary[];
    assert.equal(all.find((memo) => memo.title === 'empty')?.lines, 0);
    assert.equal(all.find((memo) => memo.title === 'two lines')?.lines, 2);
    assert.deepEqual(
      all.map((memo) => memo.title),
      ['two lines', 'empty', 'fat', '中文'],
    );

    // An unknown tag is an empty answer, not an error; no tag at all is still every document.
    assert.equal(((await caller.call('notes.list', { tag: 'nope' })).value as Summary[]).length, 0);
  });
});

test('notes searches for places, and a place can be read back', async () => {
  await withCaller(async (caller) => {
    await caller.call('notes.add', {
      title: 'places',
      text: 'first line\nThe Needle Is Here and needle again\nthird line',
    });
    const id = await idOf(caller, 'places');

    const found = (await caller.call('notes.search', { query: 'needle' })).value as Result;
    assert.equal(found.docs, 1);
    assert.equal(found.totalDocs, 1);
    assert.equal(found.more, false);
    const hit = found.hits[0];
    assert.equal(hit.id, id);
    assert.equal(hit.matchCount, 2);
    assert.equal(hit.matches.length, 2);
    assert.equal('text' in hit, false);
    assert.equal(hit.bytes, 57);
    assert.equal(hit.lines, 3);

    // Case-insensitive search, the document's own text back — `match` keeps the capital N.
    assert.equal(hit.matches[0].match, 'Needle');
    assert.equal(hit.matches[1].match, 'needle');
    assert.equal(hit.matches[0].line, 2);
    assert.equal(hit.matches[0].col, 5);
    assert.equal(hit.matches[1].line, 2);
    assert.equal(hit.matches[1].col, 24);
    assert.equal(hit.matches[0].before, 'The ');
    assert.equal(hit.matches[0].after, ' Is Here and needle again');
    assert.equal(hit.matches[1].before, 'The Needle Is Here and ');
    assert.equal(hit.matches[1].after, ' again');

    // `line` is the number `read` takes as `offset`: ask for that line and the hit is on it, at the
    // column the answer gave.
    for (const match of hit.matches) {
      const line = String(
        (await caller.call('notes.read', { id, offset: match.line, limit: 1 })).value,
      );
      assert.ok(line.includes(match.match), `line ${match.line} holds ${match.match}`);
      assert.equal(line.slice(match.col - 1, match.col - 1 + match.match.length), match.match);
    }

    // Title and tag are not searched; a miss is an empty answer, not an error.
    assert.equal(
      ((await caller.call('notes.search', { query: 'places' })).value as Result).totalDocs,
      0,
    );
    await caller.call('notes.add', { title: 'tagged', text: 'nothing here', tag: 'query' });
    assert.equal(
      ((await caller.call('notes.search', { query: 'query' })).value as Result).totalDocs,
      0,
    );
  });
});

test('notes says how much it cut off: three places a document, twenty documents', async () => {
  await withCaller(async (caller) => {
    await caller.call('notes.add', { title: 'many', text: 'hit hit hit hit hit' });
    const id = await idOf(caller, 'many');

    const one = (await caller.call('notes.search', { query: 'hit' })).value as Result;
    assert.equal(one.hits[0].matchCount, 5);
    assert.equal(one.hits[0].matches.length, 3);
    assert.equal(one.hits[0].id, id);

    // Twenty-five documents with a hit: the twenty newest come back, and `more` says the rest is
    // there instead of it disappearing.
    for (let i = 0; i < 25; i += 1)
      await caller.call('notes.add', { title: `doc ${i}`, text: 'needle' });
    const many = (await caller.call('notes.search', { query: 'needle' })).value as Result;
    assert.equal(many.docs, 20);
    assert.equal(many.totalDocs, 25);
    assert.equal(many.more, true);
    assert.deepEqual(
      many.hits.map((entry) => entry.title),
      Array.from({ length: 20 }, (_, index) => `doc ${24 - index}`),
    );

    // An empty query is not a search: every document in scope is a summary, with no matches.
    const everything = (await caller.call('notes.search', { query: '' })).value as Result;
    assert.equal(everything.docs, 26);
    assert.equal(everything.more, false);
    for (const entry of everything.hits) {
      assert.deepEqual(entry.matches, []);
      assert.equal(entry.matchCount, 0);
      assert.equal('text' in entry, false);
    }

    // Context is cut at forty characters, and it never wraps a line: the space next to the match
    // is kept (it is what separates the words), the cut edge is not padded.
    await caller.call('notes.add', {
      title: 'long',
      text: `${'a'.repeat(60)} needle ${'b'.repeat(60)}\nafter`,
    });
    const long = (await caller.call('notes.search', { query: 'needle' })).value as Result;
    const context = long.hits[0].matches[0];
    assert.equal(context.before, `${'a'.repeat(39)} `);
    assert.equal(context.after, ` ${'b'.repeat(39)}`);
    assert.equal(context.line, 1);
    assert.equal(context.col, 62);
  });
});

test('notes tags are labels: exact match, one per document, counted from the documents', async () => {
  await withCaller(async (caller) => {
    await caller.call('notes.add', { title: 'in work', text: 'w', tag: 'work' });
    await caller.call('notes.add', { title: 'deeper label', text: 'd', tag: 'work/2026' });
    await caller.call('notes.add', { title: 'untagged', text: 'u' });
    await caller.call('notes.add', { title: 'doubled', text: 's', tag: '  work   spaces  ' });

    // A tag is a label, not a path: `work` finds `work`, not `work/2026`.
    assert.equal(((await caller.call('notes.list', { tag: 'work' })).value as Summary[]).length, 1);
    assert.equal(
      ((await caller.call('notes.list', { tag: 'work/2026' })).value as Summary[]).length,
      1,
    );
    assert.equal(((await caller.call('notes.list', { tag: 'wor' })).value as Summary[]).length, 0);
    // Trimmed outside, inner runs of whitespace collapsed: one label, however it was typed.
    assert.equal(
      ((await caller.call('notes.list', { tag: 'work spaces' })).value as Summary[]).length,
      1,
    );
    assert.equal(
      ((await caller.call('notes.list', { tag: 'work  spaces' })).value as Summary[]).length,
      1,
    );
    const doubled = await idOf(caller, 'doubled');
    assert.equal((await caller.call('notes.get', { id: doubled })).value.tag, 'work spaces');

    // One tag per document, counted from the documents — nothing is stored for a tag, and the
    // store starts with no documents at all.
    assert.deepEqual((await caller.call('notes.tags', {})).value, [
      { tag: '', count: 1 },
      { tag: 'work', count: 1 },
      { tag: 'work spaces', count: 1 },
      { tag: 'work/2026', count: 1 },
    ]);

    // Refiling is a partial update, and `..` is an ordinary character in a label.
    assert.equal(
      (await caller.call('notes.update', { id: doubled, tag: '..' })).value,
      `updated id=${doubled} rev=2: doubled`,
    );
    assert.equal(((await caller.call('notes.list', { tag: '..' })).value as Summary[]).length, 1);
    assert.equal(
      ((await caller.call('notes.list', { tag: 'work spaces' })).value as Summary[]).length,
      0,
    );

    const tooLong = await caller.call('notes.update', { id: doubled, tag: 'x'.repeat(65) });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.error, 'tag cannot be longer than 64 characters');

    // A search scopes by tag the way list does — exactly.
    assert.equal(
      ((await caller.call('notes.search', { query: 'd', tag: 'work/2026' })).value as Result)
        .totalDocs,
      1,
    );
    assert.equal(
      ((await caller.call('notes.search', { query: 'd', tag: 'work' })).value as Result).totalDocs,
      0,
    );

    // Deleting the last document of a tag is how that tag goes away.
    await caller.call('notes.delete', { id: await idOf(caller, 'in work') });
    assert.deepEqual((await caller.call('notes.tags', {})).value, [
      { tag: '', count: 1 },
      { tag: '..', count: 1 },
      { tag: 'work/2026', count: 1 },
    ]);
    assert.equal(((await caller.call('notes.list', { tag: 'work' })).value as Summary[]).length, 0);
  });
});

test('notes refuses a document over its size bound and leaves the old text alone', async () => {
  await withCaller(async (caller) => {
    const tooBig = await caller.call('notes.add', {
      title: 'big',
      text: 'x'.repeat(256 * 1024 + 1),
    });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.error, 'the document is 262145 bytes, over the 262144 limit');

    const near = 'x'.repeat(256 * 1024 - 5);
    assert.equal((await caller.call('notes.add', { title: 'grow', text: near })).ok, true);
    const id = await idOf(caller, 'grow');

    const grown = await caller.call('notes.append', { id, text: 'y'.repeat(10) });
    assert.equal(grown.ok, false);
    assert.match(String(grown.error), /over the 262144 limit/);
    // The refused write left the document as it was: the bound is checked before anything is saved.
    assert.equal((await caller.call('notes.read', { id })).value.length, near.length);
  });
});

test('notes keeps a document, its tag and its edits across a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-notes-tags-'));
  const database = join(directory, 'history.sqlite');
  try {
    await withNotes(database, async (caller, history) => {
      await caller.call('notes.add', { title: 'kept', text: 'one\ntwo', tag: 'work' });
      const id = await idOf(caller, 'kept');
      await caller.call('notes.edit', { id, old: 'two', new: 'TWO' });

      // One unit carries the whole document, tag included; the small index carries only ids and
      // the allocator, which is what makes a refiling one save instead of a rewrite of the store.
      const unit = history.store.load('default', 'notes', `memos.${id}`)?.meta as Memo;
      assert.equal(unit.title, 'kept');
      assert.equal(unit.text, 'one\nTWO');
      assert.equal(unit.tag, 'work');
      assert.equal(typeof unit.at, 'string');
      assert.deepEqual(history.store.load('default', 'notes', 'memos')?.meta, {
        ids: [id],
        nextId: id + 1,
      });
    });

    await withNotes(database, async (caller) => {
      const id = await idOf(caller, 'kept');
      assert.equal((await caller.call('notes.read', { id })).value, 'one\nTWO');
      assert.equal((await caller.call('notes.get', { id })).value.tag, 'work');
      assert.deepEqual((await caller.call('notes.tags', {})).value, [{ tag: 'work', count: 1 }]);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('notes declares one schema per capability, and the page carries the tag filter', async () => {
  const notes = new NotesNode(testContext());

  // The capability list is declared once in the source; the schemas the model reads are the package
  // node block, so this pins the two together instead of letting them drift apart.
  const manifest = nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url)));
  assert.deepEqual(Object.keys(notes.handlers), [...NAMES, 'ui']);
  for (const name of [...NAMES, 'ui'])
    assert.ok(
      (manifest.caps[name] as { description?: string } | undefined)?.description,
      `${name} has no description`,
    );

  assert.match(String(await notes.handlers.ui!({})), /tagFilter/);
});

test('the library column is the scroller, and the head is not wrapped around it', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');

  // The panel is a flex column: the head is `flex: none`, and the list is the child that takes what
  // is left and scrolls. A wrapper edit once swallowed the head's closing tag, which made the list
  // its child: the list then grew to its content (7756px with 68 memos) and the panel — which is
  // `overflow: hidden` — clipped every card below the fold. Only a browser saw it, so the shape is
  // pinned: the head closes before the list starts.
  assert.match(html, /\.list\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/s);
  assert.match(html, /\.list\s*\{[^}]*overflow-y:\s*auto/s);
  const head = html.slice(
    html.indexOf('<div class="library-head">'),
    html.indexOf('<div class="list"'),
  );
  assert.ok(head.length > 0, 'the library head and the list are both in the page');
  assert.equal(
    (head.match(/<div\b/g) ?? []).length,
    (head.match(/<\/div>/g) ?? []).length,
    'the head has to close before the list: one unclosed div makes the list its child',
  );
});

// `index.ts` reads `./ui.html` next to its own file, so a running node serves dist/ui.html while this
// suite reads src/: a build that has not been re-run hands the browser the old page.
test('the served copy is the page in src', (t) => {
  const built = new URL('../dist/ui.html', import.meta.url);
  if (!existsSync(built)) return t.skip('dist/ is only there after `npm run build`');
  assert.equal(
    readFileSync(built, 'utf8'),
    readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8'),
    'run `npm run build`: the page in dist/ is copied from src/, not compiled',
  );
});
