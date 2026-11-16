# node-agent-files

File management for the node-agent system: **one** set of files, shared by every node on the bus.

A path is a logical key, not a place on a disk. No directory has to exist, nothing is normalised and
no extension or MIME type is looked at - `notes/today.md`, `weird name .txt`, `../../x` and
`文件/说明.md` are four keys like any other. The only path refused is an empty one.

Any byte sequence can be stored: every body is held as base64, so a PNG, a gzip and a UTF-8 document
take the same road, and nothing anywhere sniffs or validates content.

## Capabilities

| capability | arguments | answer |
| --- | --- | --- |
| `list` | `path?`, `limit?` | `{ total, count, more, files: [{ path, bytes, revision, encoding, createdAt, updatedAt, createdBy, updatedBy }] }`, sorted by path, **no bodies** |
| `read` | `path`, `encoding?` | `{ path, content, encoding, bytes, revision, createdAt, updatedAt, createdBy, updatedBy }` |
| `write` | `path`, `content`, `encoding?`, `expectedRevision?` | `{ path, bytes, revision, encoding, createdAt, updatedAt, createdBy, updatedBy, created }` |
| `delete` | `path` | `{ path, deleted }` - `false` when there was nothing there |
| `rename` | `from`, `to` | `{ from, path, bytes, revision, encoding, createdAt, updatedAt, createdBy, updatedBy }` |
| `ui` | — | the page described below (HTML) |

### who may call

Every capability declares `"callers": ["*"]` - every node on the bus may list, read, write, rename
and delete, and may fetch the page. That is deliberate: a store only some nodes can see is not a
shared file system, and a node that had to be granted access before it could read a file would fail
at the worst moment. The manifest is the default, not a lock: a deployment that wants a narrower
shape grants per capability in the system node's permission table (the bus enforces it there), and
the manifest keeps saying what this node asks for.

The page is content and holds no data of its own; the bus marks a `ui` capability unexposed and
uneditable in the permission table, so it is never advertised to siblings - but fetching it is
harmless, and the data behind it goes through the five capabilities above, on the same terms.

### list: a prefix and a limit

`path` is a **prefix**, not a directory: exactly "which keys start with these bytes". Nothing is
resolved, completed or normalised on the way, so

- no `path` (or `path: ""`) is the whole directory
- `"notes/"` is the files under `notes/`
- `"notes"` is those plus `notes-old.md`, which is what a caller typing a name means

The answer is capped - 200 entries when no `limit` is named, 1000 at most - and never silently:
`total` is how many matched, `count` how many came back, and `more` is true when they differ.

```json
{ "path": "notes/", "limit": 50 }
```

### encoding

`base64` is the default **on both sides**, because it is the one spelling that cannot lose a byte:

```json
{ "path": "blob/logo.png", "content": "iVBORw0KGgo…" }
{ "path": "blob/logo.png" }
```

`utf8` is for text a person or a model is going to write and read:

```json
{ "path": "notes/today.md", "content": "# today\n", "encoding": "utf8" }
{ "path": "notes/today.md", "encoding": "utf8" }
```

`read` always answers with the `encoding` it used, so nothing has to be guessed. Reading a binary file
with `encoding: "utf8"` is lossy by design (invalid sequences become U+FFFD) - that is what `base64`
is for.

### the page

`ui` answers with a page a person can read the store through: the list (filtered by the same `path`
prefix, with bytes, revision, who wrote it last and when), and a viewer that opens one file. Text is
shown as text - the bytes are decoded as UTF-8 strictly, so a file that is not text is never drawn
as replacement characters - and anything else is shown as base64, with the whole file one
**Download** away. Files over 512 KB are not drawn at all: the page says how big the file is and
leaves it to the download.

Uploads go the other way: **Upload** (or dragging files anywhere onto the page) sends the bytes to
the folder the page is looking at - the filter box when it ends in `/`, otherwise the folder of the
open file, otherwise the root - keeping each file's name and its bytes exactly (read as base64, so a
PNG arrives as a PNG). A path that is already there asks before replacing it, a new one is written
create-only (`expectedRevision: 0`), and a file that moved on in the meantime is a conflict rather
than a silent loss. One call carries at most 5 MB of bytes, because the webui refuses a `/call`
body over 8 MiB and base64 is 4/3 of the bytes. The bus itself has no such ceiling: a node
calling `write` directly can send what the history unit can hold.

The page is content, not code: it asks `/call` for `files.list` and `files.read`, the same two
capabilities a model calls through the bus, so it can see nothing a caller could not. It sets no
innerHTML from file data, and every word it shows has both languages in `src/i18n/`.

### who wrote it

A path is shared by every node on the bus, so every entry says whose bytes it is: `createdBy` is the
node name that first wrote the file, `updatedBy` the one that wrote it last (the caller of the
`write`, or of the `rename` - a rename touches the entry). A rewrite keeps the first author and
moves the last one; a delete leaves nothing behind to attribute. The name is the bus name of the
calling node, the same `ctx.from` the host hands every capability.

### Concurrency

`write` without `expectedRevision` is unconditional: last one wins, which is what a caller that was
told to save a file wants. With it, the write happens only if the file is still where the caller saw
it:

```json
{ "path": "a.txt", "content": "…", "expectedRevision": 7 }
```

`expectedRevision: 0` means "this file must not exist yet". A file that moved on is refused as a
`conflict: a.txt has changed (expected revision 7, found 8)` - nothing is overwritten, and the caller
is told which revision to send to overwrite on purpose.

## Storage (history)

The store is the **history** node - nothing is kept in the process, so a restart (or a second
instance in another process) reads the same files. Two kinds of unit, filed under the calling node
name `files`, for the bus tenant:

| unit id | value |
| --- | --- |
| `files.index` | `{ version: 1, files: [ { path, bytes, revision, encoding, createdAt, updatedAt, createdBy, updatedBy } ] }` - the whole directory, which is what `list` reads |
| `files.file.<base64url(path)>` | `{ path, encoding, bytes, base64, updatedAt, createdBy, updatedBy }` - one file's bytes, and whose they are |

`<base64url(path)>` is the path's UTF-8 bytes in base64url without padding. Encoding is what lets a
key be any string at all - slashes, spaces, quotes, CJK, even `__proto__` - while the unit id stays
inside history's 255-character name rule; it is a pure function of the path, so it is never stored,
and two paths can never share a unit. That is also why a path may be at most 183 UTF-8 bytes.

Every write saves its body first and then the index, so a file the directory lists is a file whose
bytes are there. The index is a **single unit owned by the whole store**, so updating it is a
compare-and-set on that unit's history `revision` with a bounded retry (5 attempts): a writer that
lost the race re-reads the index and re-applies its own change, rather than overwriting someone
else's entry. `rename` writes the bytes to the new path's unit (create-only, revision 1 there - a
revision belongs to a unit, not to a name), deletes the old one (taking the new one back if the old
one would not go), and trades the two index entries.

Because the files live once, per tenant, under `files`, every node on the bus that calls
`files.read`/`files.write` touches the same file. There is no per-caller directory.

## Notes

- No local file system is read or written, ever.
- No UI page: this node is capabilities only.
- The index entry is what `list` shows; a body unit written by a write whose index update failed is
  invisible to `list` (and can be found again by reading the path, or removed by `delete`).
