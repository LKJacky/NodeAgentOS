// files: the node-agent system's file manager. Five capabilities over a shared, flat key space of
// **paths**: `list` says what is there, `read` and `write` move bytes in and out, `delete` throws one
// away, `rename` moves it to another key. `list` takes a `path` **prefix** and a `limit`: a caller
// after one folder's files asks for that folder, and never has to pull the whole store to filter it
// itself (and never gets more than `limit` entries without being told: `total`, `count` and `more`
// say when there are more).
//
// A sixth, `ui`, is the page a person reads those files through: the list with its prefix box, and a
// viewer that shows a file as text when its bytes decode as UTF-8 and as base64 when they do not,
// with the whole file one download away. It is content, not code - the page calls the same five
// capabilities through `/call` that a model calls through the bus, so it can see nothing a caller
// could not.
//
// Nothing here is a local file system. A path is a logical key - a name two nodes agree on - and the
// bytes behind it live in the **history** node, which is this node's only store: one unit per file
// plus one index unit (the unit ids are written down below). That is what makes a file shared by
// every node on the bus: the units are filed under this node's own name, once, per tenant, and the
// capability is the same capability for every caller - there is no per-caller directory, no "my
// files" and "your files", and the path alone decides what a call touches. A second `files`
// instance - after a restart, in another process - reads the same units and answers the same way.
//
// Paths are not normalised and not checked against anything: `a/b/c`, `weird name .txt`, `../../x`
// and `文件/说明.md` are four keys like any other, no directory has to exist, and no extension is
// looked at. The one path refused is an empty one, because a file has to have a name.
//
// Any byte sequence can be stored. A body is held as base64 inside its unit, so a PNG, a gzip and a
// UTF-8 document take exactly the same road, and there is no MIME sniffing, no size-by-extension
// guess and no content validation anywhere. `write` and `read` take `encoding`, which says how the
// `content` string is spelled:
//
//   base64  the bytes themselves, base64-encoded. The default, on both sides, because it is the one
//           encoding that cannot lose a byte - a binary file written and read back with no evidence
//           of the reader in between comes out identical.
//   utf8    a text document, as a human or a model writes it. Reading a binary file this way is
//           lossy on purpose: invalid sequences become U+FFFD, which is why `read` always says which
//           encoding it answered in.
//
// Concurrency: every write lands in its file's own unit, and the index is updated with the index
// unit's own history `revision` plus a bounded retry, so two writers bumping the index at once do not
// silently lose each other's entry. `write` may carry `expectedRevision` - the revision the caller
// believes the file is at (0: "it must not exist yet") - and a file that has moved on is refused as a
// conflict instead of overwritten. A write without it is unconditional and last-one-wins, which is
// what a caller that was simply told to save a file wants.
//
// Storage, in the history node, under the caller name `files`:
//
//   files.index                    { version: 1, files: [FileEntry, ...] }  the whole directory:
//                                  path, bytes, revision, encoding, createdAt, updatedAt,
//                                  createdBy, updatedBy. `list`
//                                  reads this and nothing else - it never touches a body.
//   files.file.<base64url(path)>   { path, encoding, bytes, base64, updatedAt,
//                                    createdBy, updatedBy }  one file's bytes, and whose they are.
//
// The unit id is the path's UTF-8 bytes in base64url (no padding) behind that prefix. Encoding is
// what lets a key be any string at all - slashes, spaces, quotes, CJK, an `__proto__` - while the
// unit id stays inside history's 255-character name rule; it is a pure function of the path, so it
// is never stored and two different paths can never share a unit. `rename` writes the body to a new
// unit (revision 1 there: the bytes are the same, the key is not) and deletes the old one; `delete`
// removes the body and the index entry. Both keep the index in step, so the index is the directory a
// reader sees.
import { readFileSync } from 'node:fs';
import {
  Node,
  loadResource,
  paintPage,
  type NodeContext,
  type NodeHandlers,
  type Resource,
  type ToolArgs,
} from '@node-agent/sdk';

/** One file as the directory knows it: what `list` returns and what every write answers with. There
 *  is no body here - a body is what `read` is for. */
export type FileEntry = {
  path: string;
  bytes: number;
  revision: number;
  encoding: Encoding;
  createdAt: string;
  updatedAt: string;
  /** The node that wrote these bytes first, and the one that wrote them last: a path is shared by
   *  every node on the bus, so "who changed this" is the first thing a reader wants to know. */
  createdBy: string;
  updatedBy: string;
};

/** How a `content` string is spelled. `base64` is the exact one; `utf8` is the readable one. */
export type Encoding = 'utf8' | 'base64';

/** The index unit's value: the directory, as a list sorted by path. A list rather than an object
 *  keyed by path, because a path is a key a caller chose and `{"__proto__": …}` is not a key an
 *  object can hold; a list has no such hole, and its order is the answer's order. */
export type FilesIndex = { version: 1; files: FileEntry[] };

/** One file's unit: the path it belongs to, how its bytes were spelled on the way in, and the bytes
 *  themselves as base64 - always base64, whatever the caller's `encoding` was, so one unit shape
 *  covers text and binary alike. */
export type FileUnit = {
  path: string;
  encoding: Encoding;
  bytes: number;
  base64: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
};

/** `read`'s answer: the entry, plus the content in the encoding the answer names. */
export type ReadResult = FileEntry & { content: string };

/** `write`'s answer: the entry the write left behind, and whether it created the file. */
export type WriteResult = FileEntry & { created: boolean };

/** `list`'s answer: the entries a `path` prefix selected, sorted by path and cut to `limit`, plus
 *  the count that was cut. `total` against `count` is how truncation is said out loud: when more
 *  files matched than fit, `more` is true rather than the rest being dropped in silence. */
export type ListResult = { total: number; count: number; more: boolean; files: FileEntry[] };

/** `delete`'s answer: nothing is an error here - a path that was not there is `deleted: false`. */
export type DeleteResult = { path: string; deleted: boolean };

/** `rename`'s answer: the entry at its new path, and the path it came from. */
export type RenameResult = FileEntry & { from: string };

/** The capability names in declaration order - the order the directory prints them in. `caps` in
 *  package.json and the test that pins the two together both read this one list. */
export const NAMES = ['list', 'read', 'write', 'delete', 'rename'] as const;

export type Capability = (typeof NAMES)[number];

/** This package's node id. The new SDK has no per-node id from the bus - the host names the
 *  endpoint - so the page is filled in with this constant. */
export const NODE_ID = 'files';

/** The page's capability name: a page is served like any other capability, one that answers HTML. */
export const PANEL = 'ui';

/** The page itself: the file list and the viewer, drawn for the browser. Content, not code. */
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

/** The page's words, in both languages: `src/i18n/*.json`, copied beside the compiled code by
 *  `npm run build` (scripts/copy-assets.mjs), which is the folder `node.i18n` names. */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

const ENCODINGS: readonly Encoding[] = ['utf8', 'base64'];

/** The default both ways. A caller who says nothing gets the encoding that cannot lose a byte - a
 *  binary file must survive a write and a read with no metadata, and text that goes through base64
 *  is merely inconvenient, not wrong. `encoding: "utf8"` is how a caller says "this is text". */
const DEFAULT_ENCODING: Encoding = 'base64';

const INDEX_UNIT = 'files.index';
const FILE_UNIT_PREFIX = 'files.file.';

/** How many entries `list` answers with when the caller names no `limit`, and the most it will
 *  answer with at all. A directory of a thousand files is a paging problem, not one answer: the
 *  rest stays one `path` prefix (or a smaller limit) away, and `total`/`more` say so. */
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

/** How many times an index update or a delete re-reads and tries again before it says it could not.
 *  Bounded on purpose: a caller gets an error instead of a call that waits forever on a store two
 *  other writers keep bumping. */
const MAX_ATTEMPTS = 5;

/** The longest path, in UTF-8 bytes. It is not a policy about names: it is the history node's own
 *  limit on a unit id (255 characters) pushed through the encoding below - base64 is 4 characters
 *  per 3 bytes, plus the 11-character prefix, so 183 bytes is the last path that fits. */
export const MAX_PATH_BYTES = 183;

/** A path as the caller sent it. It is a key, not a location: only an empty (or blank) name is
 *  refused, and nothing is trimmed, normalised or resolved - a leading space or a `..` is part of
 *  the name, the same way it would be inside a JSON object. */
export function filePathOf(value: unknown, field = 'path'): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (value.trim() === '') throw new Error(`${field} must not be empty`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_PATH_BYTES)
    throw new Error(
      `${field} is ${bytes} bytes of UTF-8; a path may be at most ${MAX_PATH_BYTES} ` +
        '(its history unit id has to fit in 255 characters)',
    );
  return value;
}

/** The `path` of a `list`: a prefix, not a directory. Nothing is resolved or completed - the question
 *  is exactly "which keys start with these bytes" - so `notes/` is the files under `notes/` and
 *  `notes` is those plus `notes.txt`, which is what a caller typing a name means. No `path` at all is
 *  the whole directory, and so is `''`: an empty prefix selects everything. */
export function prefixOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('path must be a string');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_PATH_BYTES)
    throw new Error(
      `path is ${bytes} bytes of UTF-8; a prefix may be at most ${MAX_PATH_BYTES}, ` +
        'the longest path there can be',
    );
  return value;
}

/** How many entries `list` may answer with: a whole number, at least one, capped so one call cannot
 *  turn into a directory of ten thousand entries. */
function limitOf(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('limit wants a whole number, one or more');
  return Math.min(value, MAX_LIST_LIMIT);
}

/** The unit one path lives in: the path's UTF-8 bytes in base64url, behind a fixed prefix. A pure
 *  function of the path, and injective - two paths, two units - which is what makes the index the
 *  only place a path has to be written down. */
export function unitIdOf(path: string): string {
  return FILE_UNIT_PREFIX + Buffer.from(path, 'utf8').toString('base64url');
}

/** Base64 in either alphabet, padded or not. Checked before decoding because `Buffer.from` skips
 *  what it does not understand, which would turn a typo into a silently short file.
 *
 *  A character walk rather than one regex over the whole string: a backtracking regexp on a 7 MB
 *  payload exhausts V8's stack (`Maximum call stack size exceeded` on a perfectly good file), and a
 *  file store that cannot take a large file is not a file store. This is O(n) with no recursion. */
function isBase64(text: string): boolean {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61 /* = */) end -= 1;
  if (text.length - end > 2) return false;
  if (end % 4 === 1) return false;
  for (let at = 0; at < end; at += 1) {
    const code = text.charCodeAt(at);
    const letter =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47 ||
      code === 45 ||
      code === 95;
    if (!letter) return false;
  }
  return true;
}

function encodingOf(value: unknown, field: string): Encoding {
  if (value === undefined) return DEFAULT_ENCODING;
  if (typeof value !== 'string' || !ENCODINGS.includes(value as Encoding))
    throw new Error(`${field} must be "utf8" or "base64"`);
  return value as Encoding;
}

function expectedOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(
      'expectedRevision wants a whole number, zero or more ' +
        '(0 means "this file must not exist yet")',
    );
  return value;
}

/** The bytes a `content` string stands for, in the encoding it was sent in. */
function bytesOf(content: string, encoding: Encoding): Buffer {
  if (encoding === 'utf8') return Buffer.from(content, 'utf8');
  const padded = content.replace(/-/g, '+').replace(/_/g, '/');
  if (!isBase64(padded))
    throw new Error(
      'content is not valid base64: send the bytes base64-encoded, or pass encoding:"utf8" for text',
    );
  return Buffer.from(padded, 'base64');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A history unit that was not at the revision a write named: someone else wrote first. The bus
 *  carries an error as its message, so the two ends agree on the words history itself uses. */
function isConflict(error: unknown): boolean {
  return /changed concurrently/.test(messageOf(error));
}

/** The unit is not there at all - the other way a revision-named write is refused. */
function isMissing(error: unknown): boolean {
  return /does not exist/.test(messageOf(error));
}

/** The words history answers with when there is no history node on this bus at all. */
function isNoHistory(error: unknown): boolean {
  return /no such node|no node provides|unknown node|not registered/i.test(messageOf(error));
}

/** One unit as history hands it back: the value and the revision it is at. */
type HistoryUnit = { revision: number; meta: unknown; createdAt: string; updatedAt: string };
type LoadedHistory = { unit: HistoryUnit | null };
type SavedHistory = { unit: HistoryUnit };

function sorted(files: readonly FileEntry[]): FileEntry[] {
  return [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** The name in a `createdBy`/`updatedBy` field: a string, or `''` for a unit written before the
 *  field existed (which is "somebody, unknown" - not a reason to refuse the whole store). */
function nameOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The first author a unit already carries, for a rewrite that must not rename him. */
function createdByIn(meta: unknown): string {
  if (typeof meta !== 'object' || meta === null) return '';
  return nameOf((meta as { createdBy?: unknown }).createdBy);
}

/** One entry out of a history value, checked field by field: what is read back is a store another
 *  process wrote, so a damaged unit is an error rather than a half-empty file list. */
function entryOf(value: unknown, where: string): FileEntry {
  if (typeof value !== 'object' || value === null) throw new Error(`invalid entry in ${where}`);
  const entry = value as Partial<FileEntry>;
  if (typeof entry.path !== 'string' || entry.path.trim() === '')
    throw new Error(`invalid entry in ${where}: path`);
  if (typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
    throw new Error(`invalid entry in ${where}: bytes`);
  if (
    typeof entry.revision !== 'number' ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 1
  )
    throw new Error(`invalid entry in ${where}: revision`);
  if (typeof entry.encoding !== 'string' || !ENCODINGS.includes(entry.encoding as Encoding))
    throw new Error(`invalid entry in ${where}: encoding`);
  if (typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string')
    throw new Error(`invalid entry in ${where}: timestamps`);
  return {
    path: entry.path,
    bytes: entry.bytes,
    revision: entry.revision,
    encoding: entry.encoding as Encoding,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    createdBy: nameOf(entry.createdBy),
    updatedBy: nameOf(entry.updatedBy),
  };
}

function indexOf(value: unknown): FilesIndex {
  if (typeof value !== 'object' || value === null) throw new Error('invalid files history index');
  const index = value as Partial<FilesIndex>;
  if (index.version !== 1 || !Array.isArray(index.files))
    throw new Error('invalid files history index');
  const files = index.files.map((entry) => entryOf(entry, 'files history index'));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error('invalid files history index: a path appears twice');
  return { version: 1, files: sorted(files) };
}

function fileUnitOf(value: unknown, where: string): FileUnit {
  if (typeof value !== 'object' || value === null) throw new Error(`invalid unit ${where}`);
  const unit = value as Partial<FileUnit>;
  if (typeof unit.path !== 'string' || unit.path.trim() === '')
    throw new Error(`invalid unit ${where}: path`);
  if (typeof unit.encoding !== 'string' || !ENCODINGS.includes(unit.encoding as Encoding))
    throw new Error(`invalid unit ${where}: encoding`);
  if (typeof unit.bytes !== 'number' || !Number.isSafeInteger(unit.bytes) || unit.bytes < 0)
    throw new Error(`invalid unit ${where}: bytes`);
  if (typeof unit.base64 !== 'string') throw new Error(`invalid unit ${where}: base64`);
  if (typeof unit.updatedAt !== 'string') throw new Error(`invalid unit ${where}: updatedAt`);
  return {
    path: unit.path,
    encoding: unit.encoding as Encoding,
    bytes: unit.bytes,
    base64: unit.base64,
    updatedAt: unit.updatedAt,
    createdBy: nameOf(unit.createdBy),
    updatedBy: nameOf(unit.updatedBy),
  };
}

/** The store behind the per-invocation Node wrapper: every call reads what it needs back from
 *  history, so an instance that lives for one call behaves like a node that lived for the process,
 *  and a restart is just another instance. Nothing is cached between calls: the units are the state. */
class FilesService {
  private ctx: NodeContext | null = null;

  /** The host builds a context per call; the work of one call runs under it. */
  activate(ctx: NodeContext): void {
    this.ctx = ctx;
  }

  async handle(cap: string, args: ToolArgs): Promise<unknown> {
    if (cap === 'list') return await this.list(args);
    if (cap === 'read') return await this.read(args);
    if (cap === 'write') return await this.write(args);
    if (cap === 'delete') return await this.delete(args);
    if (cap === 'rename') return await this.rename(args);
    throw new Error(`files only provides ${NAMES.join('/')} (got "${cap}")`);
  }

  /** The directory, or the part of it under one prefix: one entry per file, sorted by path, with no
   *  contents and never more than `limit` of them. A caller looking for one folder's files asks for
   *  that folder instead of pulling the whole store and filtering it itself. */
  async list(args: ToolArgs): Promise<ListResult> {
    const prefix = prefixOf(args.path);
    const limit = limitOf(args.limit);
    const index = await this.readIndex();
    const matching =
      prefix === '' ? index.files : index.files.filter((file) => file.path.startsWith(prefix));
    const files = matching.slice(0, limit);
    return {
      total: matching.length,
      count: files.length,
      more: matching.length > files.length,
      files,
    };
  }

  /** One file's bytes, in the encoding the answer names. */
  async read(args: ToolArgs): Promise<ReadResult> {
    const path = filePathOf(args.path);
    const encoding = encodingOf(args.encoding, 'encoding');
    const unit = await this.loadFile(path);
    const bytes = Buffer.from(unit.meta.base64, 'base64');
    if (bytes.length !== unit.meta.bytes)
      throw new Error(
        `files history unit ${JSON.stringify(unitIdOf(path))} is damaged: ` +
          `${bytes.length} bytes of body, ${unit.meta.bytes} recorded`,
      );
    return {
      path,
      bytes: bytes.length,
      revision: unit.revision,
      encoding,
      createdAt: unit.createdAt,
      updatedAt: unit.updatedAt,
      createdBy: unit.meta.createdBy,
      updatedBy: unit.meta.updatedBy,
      content: encoding === 'utf8' ? bytes.toString('utf8') : bytes.toString('base64'),
    };
  }

  /** Write or overwrite one file: the body first, then the index, so a file the directory lists is
   *  a file whose bytes are there. */
  async write(args: ToolArgs): Promise<WriteResult> {
    const path = filePathOf(args.path);
    const encoding = encodingOf(args.encoding, 'encoding');
    if (typeof args.content !== 'string')
      throw new Error('content must be a string (base64 of the bytes when encoding is "base64")');
    const bytes = bytesOf(args.content, encoding);
    const expected = expectedOf(args.expectedRevision);
    const unitId = unitIdOf(path);

    const caller = this.caller();
    const current = await this.loadUnit(unitId);
    const found = current?.revision ?? 0;
    // A rewrite keeps the first author and moves the last one: the bytes may be somebody else's.
    const createdBy = createdByIn(current?.meta) || caller;
    if (expected !== undefined && expected !== found)
      throw new Error(conflictText(path, expected, found));

    const meta: FileUnit = {
      path,
      encoding,
      bytes: bytes.length,
      base64: bytes.toString('base64'),
      updatedAt: new Date().toISOString(),
      createdBy,
      updatedBy: caller,
    };
    let saved: HistoryUnit;
    try {
      saved = await this.saveUnit(unitId, meta, expected);
    } catch (error) {
      // The pre-check above is this call's own read; history's own `expectedRevision` is the one that
      // is atomic, so a writer that landed in between is still caught - here.
      if (isConflict(error) || isMissing(error)) {
        const moved = await this.loadUnit(unitId);
        throw new Error(conflictText(path, expected ?? 0, moved?.revision ?? 0));
      }
      throw this.historyError('save', error);
    }

    const entry: FileEntry = {
      path,
      bytes: bytes.length,
      revision: saved.revision,
      encoding,
      createdAt: current?.createdAt ?? saved.createdAt,
      updatedAt: saved.updatedAt,
      createdBy,
      updatedBy: caller,
    };
    await this.updateIndex((files) => [...files.filter((file) => file.path !== path), entry]);
    return { ...entry, created: found === 0 };
  }

  /** Delete one file: the body, then the index entry. A path that was not there is not an error -
   *  a caller cleaning up should not have to read first to be allowed to. */
  async delete(args: ToolArgs): Promise<DeleteResult> {
    const path = filePathOf(args.path);
    const deleted = await this.dropUnit(unitIdOf(path));
    await this.updateIndex((files) => files.filter((file) => file.path !== path));
    return { path, deleted };
  }

  /** Rename one file: its bytes go to a unit of the new path, the old unit is deleted, and the index
   *  trades one entry for the other. The bytes are kept as they were; the revision is not - a unit
   *  that never existed starts at 1, and a revision belongs to a unit, not to a name. */
  async rename(args: ToolArgs): Promise<RenameResult> {
    const from = filePathOf(args.from, 'from');
    const to = filePathOf(args.to, 'to');
    const source = await this.loadFile(from);
    if (from === to) return { from, ...entryAt(to, source) };

    const target = await this.loadUnit(unitIdOf(to));
    if (target !== null)
      throw new Error(
        `conflict: a file already exists at ${JSON.stringify(to)} (revision ${target.revision}); ` +
          'rename to a free path, or delete that one first',
      );

    const caller = this.caller();
    const meta: FileUnit = {
      path: to,
      encoding: source.meta.encoding,
      bytes: source.meta.bytes,
      base64: source.meta.base64,
      updatedAt: new Date().toISOString(),
      createdBy: source.meta.createdBy || caller,
      updatedBy: caller,
    };
    let saved: HistoryUnit;
    try {
      // Create-only: a rename must not eat a file that appeared at the new path meanwhile.
      saved = await this.saveUnit(unitIdOf(to), meta, 0);
    } catch (error) {
      if (isConflict(error) || isMissing(error))
        throw new Error(
          `conflict: a file appeared at ${JSON.stringify(to)} while the rename was running; ` +
            'rename again, or pick another path',
        );
      throw this.historyError('save', error);
    }

    try {
      await this.deleteUnit(unitIdOf(from), source.revision);
    } catch (error) {
      // Half a rename is worse than none: if the old unit would not go, take the new one back.
      await this.dropUnit(unitIdOf(to)).catch(() => false);
      throw new Error(
        `files could not rename ${JSON.stringify(from)} to ${JSON.stringify(to)}: ${messageOf(error)}`,
      );
    }

    const entry: FileEntry = {
      path: to,
      bytes: source.meta.bytes,
      revision: saved.revision,
      encoding: source.meta.encoding,
      createdAt: source.createdAt,
      updatedAt: saved.updatedAt,
      createdBy: meta.createdBy,
      updatedBy: caller,
    };
    await this.updateIndex((files) => [
      ...files.filter((file) => file.path !== from && file.path !== to),
      entry,
    ]);
    return { from, ...entry };
  }

  /** The directory as history holds it. No index unit yet is an empty directory, not an error: the
   *  first write lays it down. */
  private async readIndex(): Promise<FilesIndex> {
    const loaded = await this.loadUnit(INDEX_UNIT);
    return loaded === null ? { version: 1, files: [] } : indexOf(loaded.meta);
  }

  /** Change the directory and save it against the revision it was read at, so a change made by
   *  another writer between the read and the save is not silently dropped: a lost race re-reads the
   *  index, applies this change to what is there now, and tries again - a bounded number of times.
   *  Only then does it give up, and it says so instead of pretending the entry was written. */
  private async updateIndex(change: (files: FileEntry[]) => FileEntry[]): Promise<FilesIndex> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const loaded = await this.loadUnit(INDEX_UNIT);
      const base =
        loaded === null ? { version: 1 as const, files: [] as FileEntry[] } : indexOf(loaded.meta);
      const next: FilesIndex = {
        version: 1,
        files: sorted(change(base.files.map((file) => ({ ...file })))),
      };
      try {
        await this.saveUnit(INDEX_UNIT, next, loaded === null ? 0 : loaded.revision);
        return next;
      } catch (error) {
        if (!isConflict(error) && !isMissing(error)) throw this.historyError('save', error);
        lastError = error;
      }
    }
    throw new Error(
      `files could not update its index after ${MAX_ATTEMPTS} attempts: ${messageOf(lastError)}`,
    );
  }

  /** One file's unit, or an error naming the path. The unit is checked against the path that was
   *  asked for: an index and a body that disagree are a store to report, not to serve. */
  private async loadFile(path: string): Promise<HistoryUnit & { meta: FileUnit }> {
    const unitId = unitIdOf(path);
    const loaded = await this.loadUnit(unitId);
    if (loaded === null) throw new Error(`no file at ${JSON.stringify(path)}`);
    const meta = fileUnitOf(loaded.meta, unitId);
    if (meta.path !== path)
      throw new Error(
        `files history unit ${JSON.stringify(unitId)} holds ${JSON.stringify(meta.path)}, ` +
          `not ${JSON.stringify(path)}`,
      );
    return { ...loaded, meta };
  }

  /** Remove one file's unit and answer whether there was one. A unit that moved under the delete is
   *  read again and retried, because "delete this file" does not care which revision it was on - the
   *  revision only has to be right for the one atomic delete that does the work. */
  private async dropUnit(unitId: string): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const unit = await this.loadUnit(unitId);
      if (unit === null) return false;
      try {
        await this.deleteUnit(unitId, unit.revision);
        return true;
      } catch (error) {
        if (isMissing(error)) return true;
        if (!isConflict(error)) throw this.historyError('delete', error);
      }
    }
    throw new Error(`files could not delete unit ${JSON.stringify(unitId)}: it kept changing`);
  }

  /** Who wrote: the node that called this capability, handed to him by the host. A path is shared
   *  by every node on the bus, so this is the only record of whose write a body is. */
  private caller(): string {
    return nameOf(this.context().from);
  }

  private context(): NodeContext {
    if (this.ctx === null) throw new Error('files was not given a context');
    return this.ctx;
  }

  private async loadUnit(unitId: string): Promise<HistoryUnit | null> {
    try {
      const loaded = await this.context().call<LoadedHistory>('history', 'load', { unitId });
      return loaded.unit;
    } catch (error) {
      throw this.historyError('load', error);
    }
  }

  /** Raw on purpose: the caller decides what a conflict means (a retry for the index, a refusal for
   *  a body). Everything else is wrapped where it is thrown. */
  private async saveUnit(
    unitId: string,
    meta: unknown,
    expectedRevision?: number,
  ): Promise<HistoryUnit> {
    const saved = await this.context().call<SavedHistory>('history', 'save', {
      unitId,
      meta,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    return saved.unit;
  }

  /** Raw for the same reason as `saveUnit`: the revision it was refused for is the caller's to fix. */
  private async deleteUnit(unitId: string, expectedRevision: number): Promise<void> {
    await this.context().call('history', 'delete', { unitId, expectedRevision });
  }

  /** What a caller reads instead of a bus error: which operation failed, and - when the reason is
   *  that there is no history node at all - the one sentence that says why nothing can be stored. */
  private historyError(operation: string, error: unknown): Error {
    const detail = messageOf(error);
    if (isNoHistory(error))
      return new Error(
        `files keeps every file in the history node, and this bus has none ` +
          `(${operation} failed: ${detail})`,
      );
    return new Error(`files could not ${operation} a unit in history: ${detail}`);
  }
}

/** The words for a write that named a revision the file is not at. Zero is a revision like any
 *  other here: a file that does not exist yet is at 0, which is how `expectedRevision: 0` says
 *  "create it, do not replace anything". */
function conflictText(path: string, expected: number, found: number): string {
  if (found === 0)
    return (
      `conflict: there is no file at ${JSON.stringify(path)} ` +
      `(expected revision ${expected}); send expectedRevision 0 only for a file that must not exist yet`
    );
  if (expected === 0)
    return (
      `conflict: a file already exists at ${JSON.stringify(path)} (revision ${found}); ` +
      `send expectedRevision ${found} to replace it, or delete it first`
    );
  return (
    `conflict: ${JSON.stringify(path)} has changed (expected revision ${expected}, found ${found}); ` +
    `read it again, or send expectedRevision ${found} to overwrite`
  );
}

function entryAt(path: string, unit: HistoryUnit & { meta: FileUnit }): FileEntry {
  return {
    path,
    bytes: unit.meta.bytes,
    revision: unit.revision,
    encoding: unit.meta.encoding,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
    createdBy: unit.meta.createdBy,
    updatedBy: unit.meta.updatedBy,
  };
}

/** A per-invocation Node: the host makes one instance per call, hands it the context and disposes it
 *  afterwards. Every capability reads the units back through history first, so an instance that
 *  lives for one call is the whole node - there is nothing in this class to keep. */
export class FilesNode extends Node {
  readonly handlers: NodeHandlers;

  constructor(ctx: NodeContext) {
    super(ctx);
    const service = new FilesService();
    this.handlers = Object.fromEntries(
      [...NAMES, PANEL].map((cap) => [
        cap,
        async (args: ToolArgs) => {
          // The page is content, not a read of the store: it is handed out without touching history,
          // and its words arrive in the language the caller asked for.
          if (cap === PANEL)
            return paintPage(PAGE, RESOURCE, args).replace('__NODE__', () =>
              JSON.stringify(NODE_ID).slice(1, -1),
            );
          service.activate(this.ctx);
          return await service.handle(cap, args);
        },
      ]),
    ) as NodeHandlers;
  }
}

export default FilesNode;
