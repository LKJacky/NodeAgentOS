// notes: a document store living on the bus. Every memo is one document, and the capabilities are
// the operations a shell gives a text file: read it in chunks, replace a snippet inside it, append a
// line, search it for a place, keep it under a tag. Its documents are stored through the history node when one
// is available, and remain usable as process-local state when it is not.
//
// Eleven capabilities, all about those documents:
//
//   read {id, offset?, limit?}      the document's text, in line chunks (the marker shell.read
//                                   leaves when it stops early is the marker this one leaves)
//   list {tag?}                     one summary per document (no body), newest first
//   get {id}                        one document's entry, body included — the way to the text
//   search {query, tag?}            where a substring appears: line, column and the text around it
//   tags                            every tag in use, with how many documents carry it
//   add {title, text?, tag?}        a new document
//   update {id, title?, text?, tag?, expectedRevision?}
//                                   rewrite the fields that were sent
//   edit {id, old, new?, replaceAll?}     literal snippet replacement inside the text
//   append {id, text}               add a line at the end of the text
//   delete {id}                     throw the document away
//
// list and search hand back **summaries and places, never bodies**: a body is what `get` is for,
// and what `read` chunks. That is deliberate — a summary costs a few dozen bytes, so a model can
// look at the whole store and then ask for the one document it wants, while a search answer says
// *where* each hit is (line and column, the same line number `read` takes as `offset`) instead of
// shipping the text again.
//
// Nothing outside knows how it is stored, and the node does not know who is asking — the model may
// be writing your shopping list through run_on_node, the notes page may be doing it through /call.
//
// Every write also publishes the new list of summaries on the topic "notes" (its own id). The
// capabilities answer whoever called; the event reaches whoever is listening, which is how the page learns about a
// write it did not make itself. Both paths run through the same methods below, so there is no way
// to change the list without the page hearing about it — model, curl and page all end up here.
// The topic is the node's name, so a listener that still subscribes to the old `memory` topic has
// to follow the rename: the bus keys an event by (publishing node, topic), and there is no way to
// publish under a name this node no longer has without registering a second node at `memory`.
//
// Every document also carries a **revision**: the count of writes to it, which is the history unit's
// own revision when there is one. `get` and every summary say which revision the document is at, a
// write answers with the revision it left behind, and `update` can be told which revision it expects
// — `expectedRevision`. A document that is not at that revision is a **conflict**, answered as an
// error rather than written: two writers (a page left open in two tabs, a model and a page) then
// find out about each other instead of the second silently eating the first one's words. Writes
// without `expectedRevision` stay unconditional, which is what a model doing what it was told wants.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  Node,
  loadResource,
  paintPage,
  type NodeContext,
  type NodeHandlers,
  type Resource,
  type ToolArgs,
} from '@node-agent/sdk';

/** One document. `id` is its address and is assigned once and never reused; `tag` is the label it
 *  is filed under ('' means no tag, and nothing else — a tag is a label, not a folder); `text` is the
 *  contents, the one field `read`, `edit` and `append` work on; `at` is when it was last written. */
export type Memo = { id: number; title: string; text: string; tag: string; at: string };

/** A document without its body: what `list` and `search` hand back. `bytes` is the body's UTF-8
 *  length — the same unit as the size bound below — and `lines` how many lines a read walks.
 *  `revision` is how many times the document has been written: a page keeps it beside the copy it
 *  is showing, and the event announcing every write carries it too, so "has this document moved
 *  on since I read it" is a number the reader can compare instead of a guess. */
export type Summary = {
  id: number;
  title: string;
  tag: string;
  bytes: number;
  lines: number;
  at: string;
  revision: number;
};

/** One document as `get` hands it out: the entry itself and the revision it is at. A writer that
 *  sends that revision back as `expectedRevision` is saying "only if nothing moved since I read
 *  it" — which is the difference between a conflict being reported and a change being overwritten. */
export type Entry = Memo & { revision: number };

/** One place a query appears: 1-based `line` (the same number `read` takes as `offset`) and 1-based
 *  character `col`, with the document's own text around it — `match` is the original, not the
 *  case-folded copy that was searched. */
export type Match = { line: number; col: number; before: string; match: string; after: string };

/** One document a query appears in: its summary, how many matches it holds, and the first few. */
export type Hit = Summary & { matchCount: number; matches: Match[] };

/** The answer to `search`. `totalDocs` against `docs` is how truncation is said out loud: when more
 *  documents matched than fit, `more` is true rather than the rest being dropped in silence. */
export type Result = { docs: number; totalDocs: number; more: boolean; hits: Hit[] };

/** One tag in use, and how many documents carry it. */
export type TagCount = { tag: string; count: number };

/** Bytes of one document this node will hold. Documents are written by a model, so the bound is
 *  checked on the way in: that is what makes `read` safe on the way out, without it a made-up
 *  "limit" would be the only thing between the model and a megabyte of its own text. */
const MAX_DOC_BYTES = 256 * 1024;

/** How much of a search answer there is: at most this many places per document, and at most this
 *  many documents. Both limits are visible in the answer (`matchCount`, `totalDocs`/`more`). */
const MATCHES_PER_DOC = 3;
const DOCS_PER_SEARCH = 20;

/** Characters of the line kept on each side of a match. */
const CONTEXT = 40;

/** The capability names in declaration order — the order the directory prints them in. `caps`, the
 *  error a mistyped capability gets, and the test that pins `caps` against `schemas` all read this
 *  one list, so the two can never drift apart. */
export const NAMES = [
  'list',
  'get',
  'read',
  'search',
  'tags',
  'add',
  'update',
  'edit',
  'append',
  'delete',
];

type NotesIndex = { ids: number[]; nextId: number };
type LegacyNotesState = { memos: Memo[]; nextId: number };
type HistoryUnit = { revision: number; meta: unknown };
type LoadedHistory = { unit: HistoryUnit | null };
type SavedHistory = { unit: HistoryUnit };
const HISTORY_UNIT = 'memos';
const memoUnit = (id: number): string => `${HISTORY_UNIT}.${id}`;

/** This package's node id. There is no per-node id from the bus any more -- the host names the
 *  endpoint -- so the page is filled in and the change event published under this constant. */
const NODE_ID = 'notes';

/** The page's capability name: `ui`, the row the old `PANEL` constant named. */
const PANEL = 'ui';

/** The page's Markdown renderer, carried inside the page the node hands out: markdown-it's browser
 *  build is text, and embedding it is what lets a note be drawn as Markdown with no network, no CDN
 *  and no second route. The page keeps raw HTML disabled, so a note stays the text the reader typed
 *  rather than markup the page would execute. */
const MARKDOWN_IT = readFileSync(
  createRequire(import.meta.url).resolve('markdown-it/dist/markdown-it.min.js'),
  'utf8',
);

/** The node's own page: the memo list and its editor, drawn for the browser. Content, not code. */
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8').replace(
  '/*__MARKDOWN_IT__*/',
  () => MARKDOWN_IT,
);

/** The page's words, in both languages: `src/i18n/*.json`, copied beside the compiled code by
 *  `npm run build` (scripts/copy-assets.mjs), which is the folder `node.i18n` names. */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

/** The tab's glyph is `src/icon.svg` now: the manifest points at the file and copy-assets puts it
 *  beside the build, so the icon travels as an asset instead of a string read into the source. */

/** Memos the store starts with. Empty on purpose: what a reader sees here is the stack's setup, not
 *  this module's opinion — notes files what it is given and invents nothing. A seed added here is a
 *  document every new stack starts with. */
const SEEDS: { title: string; text: string }[] = [];

/** The wire carries JSON, not TypeScript: every argument is checked before it is used. */
function text(value: unknown, what: string, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new Error(`${what} wants a string`);

  return value.trim();
}

/** `id` has to be a whole number — a model that sends "3" gets told, instead of a wrong memo. */
function id(args: ToolArgs): number {
  const value = args.id;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('id wants an integer');

  return value;
}

/** An optional whole number: `offset`/`limit`, where anything else means "not given" rather than
 *  a bad argument — a chunk request with a nonsense limit should still read the document. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** A string used exactly as it arrived. `edit` and `append` work on text, and a snippet that begins
 *  or ends with a space or a newline is still that snippet: replacing three lines with four has to
 *  keep the newline it was handed, which is also why shell.edit does not trim its `old`. Titles and
 *  whole bodies keep going through `text`, which does trim — that has been their contract. */
function raw(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} wants a string`);

  return value;
}

/** A tag: a label, not a path. `''` means no tag, outer whitespace goes, and runs of whitespace
 *  inside a tag collapse to one space — a tag is shown on one line of a dropdown. `/` and `..` are
 *  ordinary characters here: nothing walks a tag, and `list {tag}` matches it exactly. */
function tag(args: ToolArgs, what = 'tag'): string {
  const value = text(args.tag, what, false).replace(/\s+/g, ' ');
  if (value.length > 64) throw new Error(`${what} cannot be longer than 64 characters`);

  return value;
}

/** UTF-8 bytes of a body — the unit the size bound is in, so `bytes` in a summary and the 256K
 *  limit a write is checked against are the same number. */
function sizeOf(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}

/** How many lines a read walks. An empty document has none (not one empty line), and a body ending
 *  in a newline has one more: the same arithmetic `chunk` uses, so `lines` and `read` agree. */
function linesOf(body: string): number {
  return body === '' ? 0 : body.split('\n').length;
}

/** One hit's place in a document: 1-based line and character column, with the document's own text
 *  around it. `line` is the number `read` takes as `offset`, so a hit can be read back:
 *  `read {id, offset: line, limit: 5}` starts at the line the hit is on. The search was
 *  case-insensitive, but `match` is the document's text, not the case-folded copy. */
function place(body: string, at: number, length: number): Match {
  const start = body.lastIndexOf('\n', at - 1) + 1;
  const end = body.indexOf('\n', at);
  const lineEnd = end === -1 ? body.length : end;

  return {
    line: body.slice(0, at).split('\n').length,
    col: at - start + 1,
    before: squeeze(body.slice(Math.max(start, at - CONTEXT), at), 'start'),
    match: body.slice(at, at + length),
    after: squeeze(body.slice(at + length, Math.min(lineEnd, at + length + CONTEXT)), 'end'),
  };
}

/** Context on one line: runs of whitespace become one space, and the edge that CONTEXT cut loses
 *  the space it was cut in, while the edge that touches the match keeps it (`The ` + match). */
function squeeze(part: string, cut: 'start' | 'end'): string {
  const one = part.replace(/\s+/g, ' ');

  return cut === 'start' ? one.replace(/^ /, '') : one.replace(/ $/, '');
}

/** Lines `offset` … `offset + limit` of a document, cut with the same marker shell.read leaves, so
 *  a chunk of a document reads exactly like a chunk of a file and a model's habit carries over. */
function chunk(body: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return body;

  const lines = body.split('\n');
  const start = Math.max((offset ?? 1) - 1, 0);
  const end = limit === undefined ? lines.length : start + limit;
  const part = lines.slice(start, end).join('\n');
  if (end < lines.length)
    return `${part}\n… (${lines.length} lines in all; this stops at line ${end})`;

  return part;
}

/** The one size this node enforces, on every path that writes text: a document has to fit in a
 *  read. Without it the chunked `read` above would be the only thing between a model and a
 *  document it cannot afford to look at. */
function checked(body: string): string {
  const bytes = sizeOf(body);
  if (bytes > MAX_DOC_BYTES)
    throw new Error(`the document is ${bytes} bytes, over the ${MAX_DOC_BYTES} limit`);

  return body;
}

/** The tag a document was stored with. Missing (or not a string) is "no tag": every document
 *  written before tags existed has none, and an old field must not throw a store away. */
function tagOf(value: unknown): string {
  const stored = (value as Partial<Memo>).tag;
  return typeof stored === 'string' ? stored : '';
}

/** notes: keeps the documents and answers questions about them. */
/** The documents this process holds on a bus with no history node. The old node kept them on an
 *  instance that lived as long as the process; the SDK builds one instance per call, so the fallback
 *  has to live here -- keyed per tenant, so two tenants on one process never read each other's memos.
 *  With a history node this map is never touched: history is the store. */
type LocalNotes = { memos: Memo[]; nextId: number; revisions: Map<number, number> };
const LOCALS = new Map<string, LocalNotes>();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stateful store behind the per-invocation Node wrapper. Every invocation reads its own copy
 *  back -- from history, or from the process-local fallback above -- and keeps nothing between calls
 *  except that fallback. */
class NotesService {
  memos: Memo[] = [];
  nextId = 1;
  private readonly memoRevisions = new Map<number, number>();
  private historyInitialized = false;
  private ctx: NodeContext | null = null;
  /** Resolves when the store has been read back, so a capability that arrives while the read is in
   *  flight waits for it instead of answering from an empty store. */
  private restored: Promise<void> | null = null;
  private tenantId = 'default';

  constructor() {
    for (const seed of SEEDS) this.addLocal(seed as ToolArgs);
  }

  /** The host builds a context per call; the store keeps the one its work runs under and reads its
   *  documents back once for that call. */
  async activate(ctx: NodeContext): Promise<void> {
    this.ctx = ctx;
    this.tenantId = ctx.tenantId;
    this.restored ??= this.restore();
    await this.restored;
  }

  /** Read the store back: through history when that node answers, from the process-local fallback
   *  when it does not. A history with no `memos` unit yet is an empty store, and the first write lays
   *  the units down (bootstrap); a history that is there and fails a load is an error, because a
   *  store that quietly started empty would look like data loss.
   *
   *  The unit is still called `memos` — renaming the node does not have to rename the data — but the
   *  history node files units under the caller's node name, and the data written before the rename
   *  sits under `memory`. This node cannot read another name's units (that is what keeps one node's
   *  transcript out of another node's reach), so the old store is copied once, by the history node's
   *  own store, with `scripts/migrate-memos-from-memory.mjs` — see docs/deployment.md. */
  private async restore(): Promise<void> {
    if (!(await this.hasHistory())) {
      const local = LOCALS.get(this.tenantId);
      if (local !== undefined) {
        this.memos = local.memos.map((memo) => ({ ...memo }));
        this.nextId = local.nextId;
        this.memoRevisions.clear();
        for (const [memoId, revision] of local.revisions) this.memoRevisions.set(memoId, revision);
      }
      return;
    }

    const loaded = await this.loadUnit(HISTORY_UNIT);
    if (loaded === null) await this.bootstrapHistory();
    else if (this.isLegacyState(loaded.meta)) {
      this.restoreLegacy(loaded.meta);
      await this.bootstrapHistory();
    } else {
      this.restoreIndex(loaded.meta);
      await this.loadMemos();
      this.historyInitialized = true;
    }
  }

  /** Keep the no-history fallback in step with what this call changed. */
  private saveLocal(): void {
    LOCALS.set(this.tenantId, {
      memos: this.memos.map((memo) => ({ ...memo })),
      nextId: this.nextId,
      revisions: new Map(this.memoRevisions),
    });
  }

  /** Reads return document data -- summaries for `list`, places for `search`, an entry for `get`,
   *  text for `read`; writes return confirmation text. */
  handle(
    cap: string,
    args: ToolArgs,
  ): Summary[] | Result | Entry | TagCount[] | string | Promise<string> {
    if (cap === 'list') return this.list(args);
    if (cap === 'get') return this.get(args);
    if (cap === 'read') return this.read(args);
    if (cap === 'search') return this.search(args);
    if (cap === 'tags') return this.tags();
    if (cap === 'add') return this.add(args);
    if (cap === 'update') return this.update(args);
    if (cap === 'edit') return this.edit(args);
    if (cap === 'append') return this.append(args);
    if (cap === 'delete') return this.remove(args);
    throw new Error(`notes only provides ${NAMES.join('/')}/ui (got "${cap}")`);
  }

  /** Newest first — the order the page shows. The documents themselves: what the event carries is
   *  their summaries, and what `list` hands out is the same without the bodies. */
  all(): Memo[] {
    return [...this.memos].sort((a, b) => b.id - a.id);
  }

  /** One document as the list and the search show it: no body, but its size in bytes, its lines and
   *  the revision it is at. */
  summary(memo: Memo): Summary {
    return {
      id: memo.id,
      title: memo.title,
      tag: memo.tag,
      bytes: sizeOf(memo.text),
      lines: linesOf(memo.text),
      at: memo.at,
      revision: this.revisionOf(memo.id),
    };
  }

  /** The documents, newest first, as summaries — one per document, body excluded on purpose (that
   *  is what `get` is for). `tag` keeps the ones filed under exactly that label; it is a label, so
   *  `work` does not reach `work/reports` the way a folder argument used to. */
  list(args: ToolArgs): Summary[] {
    if (args.tag === undefined) return this.all().map((memo) => this.summary(memo));

    const scope = tag(args);
    return this.all()
      .filter((memo) => memo.tag === scope)
      .map((memo) => this.summary(memo));
  }

  /** The entry, body included, with the revision it is at: what a writer keeps to send back as
   *  `expectedRevision`, and what tells a page whether the copy it holds is still the current one. */
  get(args: ToolArgs): Entry {
    const memo = this.find(id(args));
    return { ...memo, revision: this.revisionOf(memo.id) };
  }

  /** The text of one document, in line chunks — the file half of `get`, which is the entry half. */
  read(args: ToolArgs): string {
    return chunk(this.find(id(args)).text, count(args.offset), count(args.limit));
  }

  async add(args: ToolArgs): Promise<string> {
    const memo = this.addLocal(args);
    await this.changed('add', memo);
    return `added id=${memo.id} rev=${this.revisionOf(memo.id)}: ${memo.title}`;
  }

  private addLocal(args: ToolArgs): Memo {
    const title = text(args.title, 'title');
    if (title === '') throw new Error('notes.add wants a title');

    const memo: Memo = {
      id: this.nextId,
      title,
      text: checked(text(args.text, 'text', false)),
      tag: tag(args),
      at: new Date().toISOString(),
    };
    this.nextId += 1;
    this.memos.push(memo);
    return memo;
  }

  /** Only the fields that were sent are touched, so a partial update is a normal update. With
   *  `expectedRevision` it is also a conditional one: a document that moved on since that revision
   *  is a conflict, and the answer says which revision it is at now — the caller reloads, or sends
   *  that number to overwrite on purpose. */
  async update(args: ToolArgs): Promise<string> {
    const memo = this.find(id(args));
    this.expect(args, memo.id);

    if (args.title !== undefined) {
      const title = text(args.title, 'title');
      if (title === '') throw new Error('update title cannot be empty');
      memo.title = title;
    }
    if (args.text !== undefined) memo.text = checked(text(args.text, 'text'));
    if (args.tag !== undefined) memo.tag = tag(args);

    memo.at = new Date().toISOString();
    await this.changed('update', memo);
    return `updated id=${memo.id} rev=${this.revisionOf(memo.id)}: ${memo.title}`;
  }

  /** edit: literal snippet replacement inside the text — shell.edit's rules, so the two complaints a
   *  model learned there (no such text / not unique) are the complaints it gets here. */
  async edit(args: ToolArgs): Promise<string> {
    const memo = this.find(id(args));
    const old = raw(args.old, 'old');
    if (old === '') throw new Error('edit needs the old text to replace (old cannot be empty)');

    const replacement = args.new === undefined ? '' : raw(args.new, 'new');
    const hits = memo.text.split(old).length - 1;
    if (hits === 0) throw new Error(`there is no such text in the document id=${memo.id}`);
    if (hits > 1 && args.replaceAll !== true)
      throw new Error(
        `old appears ${hits} times in the document id=${memo.id}: give more context, or pass replaceAll:true`,
      );

    const index = memo.text.indexOf(old);
    memo.text = checked(
      args.replaceAll === true
        ? memo.text.split(old).join(replacement)
        : memo.text.slice(0, index) + replacement + memo.text.slice(index + old.length),
    );
    memo.at = new Date().toISOString();
    await this.changed('update', memo);
    return `edited id=${memo.id} rev=${this.revisionOf(memo.id)} (${hits} replacement${hits === 1 ? '' : 's'}): ${memo.title}`;
  }

  /** append: one more line at the end — `>>` for a document. A body that does not end in a newline
   *  gets one first, so appending twice can never glue two entries into the same line. */
  async append(args: ToolArgs): Promise<string> {
    const memo = this.find(id(args));
    const line = raw(args.text, 'text');
    if (line === '') throw new Error('append wants the text to add');

    const separator = memo.text === '' || memo.text.endsWith('\n') ? '' : '\n';
    memo.text = checked(`${memo.text}${separator}${line}`);
    memo.at = new Date().toISOString();
    await this.changed('update', memo);
    return `appended to id=${memo.id} rev=${this.revisionOf(memo.id)} (+${Buffer.byteLength(line)} bytes): ${memo.title}`;
  }

  async remove(args: ToolArgs): Promise<string> {
    const memo = this.find(id(args));
    this.memos = this.memos.filter((m) => m !== memo);
    await this.changed('delete', memo);
    return `deleted id=${memo.id}: ${memo.title}`;
  }

  /** The one place a write becomes durable and public, and where the document's revision moves: in
   *  history mode the unit's own revision (the store counts the writes for us), without history this
   *  process's count of the same thing. Either way every write raises it by one, so a reader holding
   *  revision N can tell whether anything has happened to the document since. */
  private async changed(kind: 'add' | 'update' | 'delete', memo: Memo): Promise<void> {
    if (!(await this.hasHistory())) {
      if (kind === 'delete') this.memoRevisions.delete(memo.id);
      else this.memoRevisions.set(memo.id, this.revisionOf(memo.id) + 1);
      // No history node: the fallback is the store, so the change has to land in it before the
      // caller is told the write went through.
      this.saveLocal();
    } else if (!this.historyInitialized) await this.bootstrapHistory();
    else if (kind === 'delete') {
      const revision = this.memoRevisions.get(memo.id);
      if (revision !== undefined) {
        try {
          await this.ctx!.call('history', 'delete', {
            unitId: memoUnit(memo.id),
            expectedRevision: revision,
          });
          this.memoRevisions.delete(memo.id);
        } catch {
          // A delete history would not take is not fatal, exactly as before: the index written
          // below still drops the document, so nobody reads a memo whose unit is gone.
        }
      }
      await this.saveIndex();
    } else {
      await this.saveMemo(memo);
      if (kind === 'add') await this.saveIndex();
    }
    this.announce();
  }

  /** The revision a document is at, and the number every reader compares against. Unknown is 0:
   *  a document this node has not loaded a revision for cannot be the one a caller is expecting. */
  private revisionOf(memoId: number): number {
    return this.memoRevisions.get(memoId) ?? 0;
  }

  /** "Only if the document is still at this revision." Nothing sent means an unconditional write —
   *  what a model that was simply told to change a document wants — and a number that does not match
   *  is a conflict: the caller is told which revision it found, and nothing is written. Zero is a
   *  revision like any other: a document this process holds but has never written is at 0. */
  private expect(args: ToolArgs, memoId: number): void {
    if (args.expectedRevision === undefined) return;
    const expected = args.expectedRevision;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)
      throw new Error('expectedRevision wants a whole number, zero or more');

    const found = this.revisionOf(memoId);
    if (found !== expected)
      throw new Error(
        `conflict: memo id=${memoId} has changed (expected revision ${expected}, found ${found}); ` +
          `reload it, or send expectedRevision=${found} to overwrite`,
      );
  }

  /** The new context does not expose the directory, so a harmless load is the probe: a missing
   *  history node makes the call fail and notes serves from the process-local fallback. A history
   *  that is there and fails a read is data that must not be replaced by an empty store. The bus says
   *  `no such node for user: history` when nothing is registered under that name, and `no node
   *  provides the capability` when a node is there without `load`. */
  private async hasHistory(): Promise<boolean> {
    try {
      await this.ctx!.call('history', 'load', { unitId: '__notes_probe__' });
      return true;
    } catch (error) {
      return !/no node provides|no such node|unknown node|not registered/.test(message(error));
    }
  }

  /** Write each document once, then keep only ids and the allocator in the root unit. Later edits
   *  save one document unit; only add/delete also update the small root index. A document's tag
   *  travels inside the document, never in the index: that is what makes a refiling one save. */
  private async bootstrapHistory(): Promise<void> {
    this.memoRevisions.clear();
    for (const memo of this.memos) await this.saveMemo(memo);
    await this.saveIndex();
    this.historyInitialized = true;
  }

  private async saveMemo(memo: Memo): Promise<void> {
    this.memoRevisions.set(memo.id, await this.saveUnit(memoUnit(memo.id), memo));
  }

  private async saveIndex(): Promise<void> {
    const index: NotesIndex = { ids: this.memos.map((memo) => memo.id), nextId: this.nextId };
    await this.saveUnit(HISTORY_UNIT, index);
  }

  /** Write one unit and answer with the revision it is now at. A store that will not take the write
   *  is an error, not a silence: a document the page believes was saved would otherwise be one a
   *  restart loses. */
  private async saveUnit(unitId: string, meta: unknown): Promise<number> {
    try {
      const saved = await this.ctx!.call<SavedHistory>('history', 'save', { unitId, meta });
      return saved.unit.revision;
    } catch (error) {
      throw new Error(`notes could not save ${unitId}: ${message(error)}`);
    }
  }

  private async loadUnit(unitId: string): Promise<HistoryUnit | null> {
    try {
      const loaded = await this.ctx!.call<LoadedHistory>('history', 'load', { unitId });
      return loaded.unit;
    } catch (error) {
      throw new Error(`notes could not load history: ${message(error)}`);
    }
  }

  private async loadMemos(): Promise<void> {
    const memos: Memo[] = [];
    for (const id of this.memos.map((memo) => memo.id)) {
      const loaded = await this.loadUnit(memoUnit(id));
      if (loaded === null) throw new Error(`notes history is missing memo id=${id}`);
      const memo = this.validMemo(loaded.meta);
      if (memo.id !== id) throw new Error(`notes history memo id mismatch for id=${id}`);
      memos.push(memo);
      this.memoRevisions.set(id, loaded.revision);
    }
    this.memos = memos;
  }

  private restoreIndex(value: unknown): void {
    if (typeof value !== 'object' || value === null) throw new Error('invalid notes history index');
    const index = value as Partial<NotesIndex>;
    if (
      !Array.isArray(index.ids) ||
      index.ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(index.ids).size !== index.ids.length ||
      !Number.isSafeInteger(index.nextId) ||
      index.nextId! < 1 ||
      index.ids.some((id) => id >= index.nextId!)
    ) {
      throw new Error('invalid notes history index');
    }
    this.memos = index.ids.map((id) => ({ id, title: '', text: '', tag: '', at: '' }));
    this.nextId = index.nextId!;
  }

  private isLegacyState(value: unknown): value is LegacyNotesState {
    return (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as LegacyNotesState).memos)
    );
  }

  private restoreLegacy(state: LegacyNotesState): void {
    if (!Number.isSafeInteger(state.nextId) || state.nextId < 1) {
      throw new Error('invalid legacy notes history');
    }
    const memos = state.memos.map((memo) => this.validMemo(memo));
    if (memos.some((memo) => memo.id >= state.nextId)) {
      throw new Error('invalid next id in legacy notes history');
    }
    this.memos = memos;
    this.nextId = state.nextId;
  }

  private validMemo(value: unknown): Memo {
    if (
      typeof value !== 'object' ||
      value === null ||
      !Number.isSafeInteger((value as Memo).id) ||
      (value as Memo).id < 1 ||
      typeof (value as Memo).title !== 'string' ||
      typeof (value as Memo).text !== 'string' ||
      typeof (value as Memo).at !== 'string' ||
      (tagOf(value) !== '' && typeof (value as Memo).tag !== 'string')
    ) {
      throw new Error('invalid memo in notes history');
    }
    return { ...(value as Memo), tag: tagOf(value) };
  }

  /** Tell the bus the list changed, under this node's own id as the topic. The event carries the
   *  summaries — the page treats it as a doorbell and asks again, and a body belongs to `get`,
   *  not to every open listener. The topic is the node's name, so the old `memory` topic is not
   *  kept: the bus keys an event by (publishing node, topic), and publishing under a name this node
   *  no longer has would need a second registration at `memory` — a node that answers where it is
   *  not served. A subscriber left on `memory` has to follow the rename to `notes`. */
  announce(): void {
    this.ctx!.publish(
      NODE_ID,
      this.all().map((memo) => this.summary(memo)),
    );
  }

  /** Where a query appears: one entry per document that has it, with the places. `tag` narrows it
   *  the way `list` does (exactly that label), and title and text are searched — not the tag.
   *
   *  An empty query is "everything" — which is what the search box sends while it is empty — and
   *  every document in scope comes back as its own summary with no matches: there is nothing to
   *  truncate. The search itself is case-insensitive; what comes back is the document's own text. */
  search(args: ToolArgs): Result {
    const scope = args.tag === undefined ? null : tag(args);
    const scoped = this.all().filter((memo) => scope === null || memo.tag === scope);
    const query = text(args.query, 'query', false).toLowerCase();

    if (query === '') {
      const hits: Hit[] = scoped.map((memo) => ({
        ...this.summary(memo),
        matchCount: 0,
        matches: [],
      }));
      return { docs: hits.length, totalDocs: hits.length, more: false, hits };
    }

    const found = scoped.map((memo) => this.hits(memo, query)).filter((hit) => hit.matchCount > 0);
    const hits = found.slice(0, DOCS_PER_SEARCH);

    return { docs: hits.length, totalDocs: found.length, more: found.length > hits.length, hits };
  }

  /** Every place one query appears in one document, of which MATCHES_PER_DOC are kept — the total
   *  in `matchCount`, so a cut-off answer still says how many there were. */
  private hits(memo: Memo, query: string): Hit {
    const haystack = memo.text.toLowerCase();
    const matches: Match[] = [];
    let count = 0;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(query, from);
      if (at === -1) break;
      count += 1;
      if (matches.length < MATCHES_PER_DOC) matches.push(place(memo.text, at, query.length));
      from = at + query.length;
    }

    return { ...this.summary(memo), matchCount: count, matches };
  }

  /** Every tag in use, alphabetical, with how many documents carry it. Nothing is stored for a tag:
   *  it exists because a document has it, and `''` (no tag) is always there. The counts are exact —
   *  one document has one tag, and a tag is a label, not a path, so nothing counts into anything. */
  tags(): TagCount[] {
    const counts = new Map<string, number>();
    for (const memo of this.all()) counts.set(memo.tag, (counts.get(memo.tag) ?? 0) + 1);

    return [...counts]
      .map(([tag, count]) => ({ tag, count }))
      .sort((left, right) => left.tag.localeCompare(right.tag));
  }

  find(want: number): Memo {
    const memo = this.memos.find((m) => m.id === want);
    if (memo === undefined) throw new Error(`no memo with id=${want}`);

    return memo;
  }
}

/** Drop one tenant's process-local store. A bus with a history node never uses that store, and a
 *  test that wants a clean one starts a tenant of its own and drops it the same way. */
export function forgetLocalNotes(tenant: string): void {
  LOCALS.delete(tenant);
}

/** A per-invocation Node: the host makes one instance per call, hands it the context and disposes it
 *  afterwards. Every capability reads the store back through the service first, so an instance that
 *  lives for one call behaves like the node that used to live for the process. */
export class NotesNode extends Node {
  readonly handlers: NodeHandlers;

  constructor(ctx: NodeContext) {
    super(ctx);
    const service = new NotesService();
    this.handlers = Object.fromEntries(
      [...NAMES, PANEL].map((cap) => [
        cap,
        async (args: ToolArgs) => {
          // The page is content, not a read of the store: it is handed out without touching history.
          // Its words are painted in the language the shell asked for, and the resource travels in
          // the page so the browser half can redraw it when the reader changes language.
          if (cap === PANEL)
            return paintPage(PAGE, RESOURCE, args).replace('__NODE__', () =>
              JSON.stringify(NODE_ID).slice(1, -1),
            );
          await service.activate(this.ctx);
          return await service.handle(cap, args);
        },
      ]),
    ) as NodeHandlers;
  }
}

export default NotesNode;
