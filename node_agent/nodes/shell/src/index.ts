#!/usr/bin/env node
// shell: the node that actually touches the machine. It reads and writes files and runs commands
// — including long ones, which become sessions that keep running while the model does something
// else. Like every node here it also brings its own page for the browser front end (`ui.html`,
// served as `shell.ui`), and that page's browser has abilities of its own: it lists and reads
// (`files-tree` / `files-read`) and it saves what the page edited (`files-write`, carrying the
// revision it started from). Absolute and relative paths may reach anywhere the Shell process can access.
//
// **The file abilities share one starting directory, not a sandbox.** `read`, `write`, `edit`,
// `list`, `glob`, `grep` and the browser file abilities resolve relative paths from the workspace and
// accept absolute paths anywhere the Shell process can access. Writes are still refused for a short
// deny list (`.git`, `homes`, `*.pem`, `*.key`, `secrets*`, `.env*`), compared case-folded. The page's save is the one place a refusal comes back as an answer
// rather than a throw, because the page has a line to show it on: a stale `expectedRevision` comes
// back as `kind: 'conflict'` with the revision the file is at now, so a file somebody else touched
// is never written over by accident. `exec` keeps its old reach: a command can still go anywhere,
// which is why the boundary that matters is the container's (see `doc/node_agent/shell-safety.md`,
// layer ①).
//
// **This package is a node, not a process.** The host makes one `ShellNode` per call and throws it
// away afterwards, so nothing that has to outlive a call lives on it: the sessions `exec` leaves
// running, the nodes `run-node` started, and the two directories paths resolve against all live in
// the tenant's `ShellService`, made once for the process (`shellService`). `dispose()` is left alone
// for the same reason -- it runs after *every* call, so clearing sessions there would kill a command
// between two of them. And the capability names are the bus's own: a name is `[a-z][a-z0-9-]*`, so
// what used to be `files.tree` / `run_node` is `files-tree` / `run-node` -- same behaviour, under a
// name the manifest can carry.
import {
  existsSync,
  globSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Node,
  NodeHost,
  WebSocketBusSession,
  loadResource,
  nodeManifestOfPackage,
  paintPage,
  type NodeContext,
  type NodeHandlers,
  type Resource,
  type ToolArgs,
} from '@node-agent/sdk';
import { packLocalPackage } from '@node-agent/sdk';
import {
  CustomCommands,
  MAX_CUSTOM_ARGS,
  PermissionPolicy,
  argvName,
  environment,
  type CustomCommand,
} from './policy.js';
import {
  Sessions,
  TIMEOUT_CODE,
  type Poll,
  type SessionStatus,
  type StreamRead,
} from './sessions.js';
import { ShellSettings } from './settings.js';

export * from './sessions.js';
export * from './policy.js';
export { ShellSettings, COMMANDS_UNIT, permissionsFile, tenantKey } from './settings.js';

/** Characters of command output that reach the model in one read. Its context is not a log file. */
const MAX_OUTPUT = 4000;

/** How long `exec` waits before handing back a session handle instead of an exit code. */
const DEFAULT_YIELD_MS = 10_000;

/** `write-stdin`'s default wait: long enough to catch a flush, short enough to feel like a poll. */
const DEFAULT_POLL_MS = 1_000;

/** Ceiling for both, so one capability call can never sit on a turn longer than this. */
const MAX_YIELD_MS = 30_000;

/** Bytes of one file `read` hands back; longer files are cut with a marker. */
const MAX_READ_BYTES = 256 * 1024;

/** Bytes of one file `write` / `edit` will produce. */
const MAX_WRITE_BYTES = 1024 * 1024;

/** Entries `list` prints before it stops. */
const MAX_LIST = 500;

/** Matches `glob` / `grep` return before they stop. */
const MAX_MATCHES = 200;

/** Files `grep` walks before it stops. */
const MAX_FILES = 2000;

/** A file `grep` will not read: past this it is not a source file worth scanning. */
const MAX_GREP_BYTES = 1024 * 1024;

/** Entries one `files-tree` answer returns per directory, and in the whole answer. */
const MAX_TREE_ENTRIES = 1000;
const MAX_TREE_NODES = 4000;

/** How many levels `files-tree` will descend. The page asks one level at a time, so a deep tree is
 *  never one answer — this only bounds a caller that asks for all of it at once. */
const MAX_TREE_DEPTH = 4;

/** Bytes of one text file `files-read` hands to the page; past this it answers `too-large`. */
const MAX_PREVIEW_BYTES = 512 * 1024;

/** Bytes of one image `files-read` inlines as a data URL (base64 grows a third on the way out). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Image extensions the page can show as `<img>`, by the type a browser understands. */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** A source type for the page's header line; anything else is `text/plain`. */
const TEXT_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.py': 'text/x-python',
  '.sh': 'text/x-sh',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

/** What an ability does to the machine. Read here; the authorization pass (doc/plan.md 7) will
 *  lift it into the handshake manifest and enforce it on the bus. */
/** What an ability does to the machine. Read here; the authorization pass (doc/plan.md 7) will
 *  lift it into the handshake manifest and enforce it on the bus. */
export type Effect = 'read' | 'write' | 'exec';

/** Ability -> effect, for the authorization pass to read (enforced in doc/plan.md 7).
 *
 *  The argument schemas are not here any more: `package.json`'s `node.caps` is the manifest the bus
 *  registers and the one a caller (and the model's tool list) is built from, so the schemas have one
 *  home instead of two that can drift. What a capability *does* is still the node's own business. */
export const EFFECTS: Record<string, Effect> = {
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
};

/** Local names in declaration order; the directory prints them in this order. */
const NAMES = Object.keys(EFFECTS);

/** The node's own page. Not in `EFFECTS`: a page is drawn, it does not touch the machine. */
const PANEL = 'ui';

/** Page-only capabilities: no switch exists, and only webui may call them. */
const PAGE_ONLY = new Set<string>([PANEL, 'set-permissions']);

/** Capabilities the page must always be able to reach. Their switches still restrict every other
 *  caller; webui is the one caller the switches cannot lock out. */
const FORCE_WEBUI = new Set<string>(['permissions', 'custom-commands']);

/** The names that appear as switches: everything except the page-only capabilities. */
const SWITCHABLE = NAMES.filter((cap) => !PAGE_ONLY.has(cap));

/** The node's own page for the webui. Content, not code — so it lives in its own file. */
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

/** The page's words, in every language it speaks: `src/i18n/*.json`, copied beside the compiled JS by
 *  the build (`node.i18n` in package.json names that same folder). */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

/** The tab's glyph: this node's own drawing, next to the page it belongs to. Content, not code —
 *  the shell renders the `<svg>` it is handed and knows no node's name. */
const ICON = readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');

/** A string argument off the wire; the wire carries no types, so anything else is empty. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** One argv word for /bin/sh. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\''`)}'`;

/** A positive integer argument off the wire, or undefined. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Where relative paths start from and where a command runs when no `cwd` is given:
 *  `NODE_AGENT_WORKSPACE` when set, else the process's current directory. */
export function workspaceRoot(): string {
  return resolve(process.env.NODE_AGENT_WORKSPACE ?? process.cwd());
}

/** One caller path, as an absolute path, with no root check — `exec`'s `cwd` is the one caller left
 *  that goes where it says: a command can reach anywhere anyway, so a check there would only be
 *  decoration. `~` is not expanded (that is the shell's job, and `exec` already has it). */
function fullPath(root: string, input: string): string {
  return resolve(root, input);
}

/** How a path is shown back to a model: relative while it stays under `root`, absolute once it
 *  does not — `../..` in a message tells nobody anything. */
function displayPath(root: string, target: string): string {
  const rel = relative(root, target);
  if (rel === '') return '.';
  return rel.startsWith('..') ? target : rel;
}

/** True when `target` is `root` or lies under it. `relative` rather than a string prefix, because a
 *  sibling whose name starts with the root's (`/ws2` beside `/ws`) is not inside it. */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The one root the file abilities are confined to: `NODE_AGENT_SHELL_ROOT` when set, else the
 *  workspace. A configured root that is not a directory is a startup failure, not a guess — a typo
 *  there would confine everything to a place that does not exist. `exec` is not confined by it. */
export function shellRoot(workspace = workspaceRoot()): string {
  const configured = (process.env.NODE_AGENT_SHELL_ROOT ?? '').trim();
  if (configured === '') return resolve(workspace);

  const root = resolve(configured);
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true)
    throw new Error(
      `NODE_AGENT_SHELL_ROOT is not a directory: ${root} (relative paths start there; absolute paths are refused)`,
    );

  return root;
}

/** Names no file ability may write, as segment globs — a whole segment, never a substring, so
 *  `src/git.txt` and `notes/pem.md` stay ordinary files. One list for every writer: the model's
 *  `write` / `edit` throw on it, and the page's `files-write` answers with it. Built in;
 *  `NODE_AGENT_SHELL_DENY_WRITE` can only add to the list (a list a variable can shorten is not a
 *  list). */
const DENIED_WRITE = ['.git', 'homes', '*.pem', '*.key', '**/secrets*', '.env*'];

/** The deny list in force: the built-in names plus whatever the environment adds, comma-separated. */
function denyWritePatterns(): string[] {
  const extra = (process.env.NODE_AGENT_SHELL_DENY_WRITE ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');

  return [...DENIED_WRITE, ...extra];
}

/** A path segment as the deny list compares it: NFKC, then lower case. APFS is case-insensitive by
 *  default and macOS hands names back decomposed, so `.GIT` and `.git` are one directory there.
 *  Folding both sides is what stops a name from being refused in one spelling and allowed in the
 *  other. Only the deny list is folded — the root check stays exact, because folding it would
 *  invent a containment a case-sensitive filesystem does not have. */
function fold(segment: string): string {
  return segment.normalize('NFKC').toLowerCase();
}

/** One segment glob against one segment: `*` is any run of characters, `?` one character, a leading
 *  `**\u200b/` a prefix that may be empty, everything else is literal. Two pointers, no regex — so a
 *  name cannot smuggle a metacharacter into the list by being written in it. */
function segmentMatches(pattern: string, segment: string): boolean {
  const glob = pattern.startsWith('**/') ? pattern.slice(3) : pattern;
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;

  while (s < segment.length) {
    if (p < glob.length && (glob[p] === '?' || glob[p] === segment[s])) {
      p += 1;
      s += 1;
    } else if (p < glob.length && glob[p] === '*') {
      star = p;
      mark = s;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else {
      return false;
    }
  }

  while (p < glob.length && glob[p] === '*') p += 1;
  return p === glob.length;
}

/** The deny pattern a write lands on, or null: every segment of `rel`, folded, matched as a name. */
function deniedBy(rel: string, patterns: string[]): string | null {
  const segments = rel
    .split(sep)
    .filter((segment) => segment !== '' && segment !== '.')
    .map(fold);

  for (const pattern of patterns)
    if (segments.some((segment) => segmentMatches(fold(pattern), segment))) return pattern;

  return null;
}

/** `realpath`, or — for a path that is not there yet — the real path of its nearest existing
 *  ancestor with the missing segments put back. A new file under a symlinked directory is exactly
 *  how a write escapes a root, so the ancestor has to be resolved, not skipped. */
async function realOrAncestor(target: string): Promise<string> {
  const rest: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return target; // the filesystem root is missing: nothing to resolve
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Resolve a caller path against the workspace. Absolute paths and relative paths that leave the
 * workspace are allowed: this node is the user's machine-side filesystem boundary. Writes still go
 * through the deny list, and the operating system remains the final permission boundary. */
async function resolveInsideRoot(
  root: string,
  input: string,
  access: 'read' | 'write' = 'read',
): Promise<string> {
  const target = resolve(root, input);
  if (access === 'write') {
    const named = await deniedWrite(root, target);
    if (named !== null)
      throw new Error(
        `refusing to write ${displayPath(root, target)}: ${named} is on this node's deny list (NODE_AGENT_SHELL_DENY_WRITE)`,
      );
  }
  return target;
}

/** The deny-list pattern a write would meet on `target`, or null — the same fold-and-match the gate
 *  above applies, asked on its own because `files-write` answers with it where a model's `write`
 *  throws. The ancestors are resolved first, so a segment reached through a symlinked directory is
 *  still compared by its own name. */
async function deniedWrite(root: string, target: string): Promise<string | null> {
  let real = resolve(root);
  try {
    real = await realpath(root);
  } catch {
    // The root itself is gone; the names relative to it are all there is to go on.
  }

  return deniedBy(relative(real, await realOrAncestor(target)), denyWritePatterns());
}

/** What a save is checked against: the file's own mtime, in microseconds. A write moves it forward
 *  (it happens after the read), so consecutive saves carry growing revisions, and a file changed by
 *  anything else no longer matches the revision the page started from. No side table: the file is
 *  the state, which is what makes the check survive a restart. */
function revisionOf(info: { mtimeMs: number }): number {
  return Math.round(info.mtimeMs * 1000);
}

/** The stamp a file carries now, or 0 when there is no file — what a write is measured against. */
async function revisionNow(target: string): Promise<number> {
  try {
    return revisionOf(await stat(target));
  } catch {
    return 0;
  }
}

/** One file, written, with the revision it landed on. Every write in this node goes through here, so
 *  a revision always moves forward: Linux takes mtime from a coarse clock (a whole jiffy), and two
 *  writes inside one tick would share a stamp — a page that saved right after reading would look
 *  stale on its very next save. When the clock has not moved, the write moves the stamp itself by a
 *  microsecond, which keeps the revision in the file, where `files-read` finds it again. */
async function writeOne(target: string, content: string): Promise<number> {
  const before = await revisionNow(target);
  await writeFile(target, content, 'utf8');

  let info = await stat(target);
  if (revisionOf(info) > before) return revisionOf(info);

  await utimes(target, info.atime, (before + 1) / 1e6);
  info = await stat(target);
  return Math.max(revisionOf(info), before + 1);
}
/** A duration a model can read at a glance. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** How a session ended, or that it has not. A deadline kill keeps `timeout(1)`'s 124. */
function statusLine(status: SessionStatus): string {
  if (status.running)
    return `running: session ${status.id} (pid ${status.pid}, ${seconds(status.ageMs)})`;
  if (status.timedOut) return `exit ${TIMEOUT_CODE} (killed on timeout)`;
  if (status.signal !== null) return `exit ${status.code ?? '?'} (killed by ${status.signal})`;

  return `exit ${status.code ?? '?'}`;
}

/** One stream as the model reads it, or nothing when it said nothing. */
function streamLines(label: string, read: StreamRead): string[] {
  const body = read.text.trimEnd();
  if (body === '') return [];

  return [
    `${label}:\n${body}${read.more ? '\n… (more output; keep reading with shell.write-stdin)' : ''}`,
  ];
}

/** What `exec` and `write-stdin` both answer with. `hint` adds the next-step line, for `exec`. */
function renderPoll(poll: Poll, hint = false): string {
  const lines = [statusLine(poll.status)];
  lines.push(...streamLines('stdout', poll.stdout), ...streamLines('stderr', poll.stderr));
  if (poll.dropped > 0) lines.push(`… (${poll.dropped} characters of earlier output were dropped)`);
  if (hint && poll.status.running)
    lines.push('keep reading / send input with shell.write-stdin, stop it with shell.kill-session');

  return lines.join('\n');
}

/** How much output one read may hand back. */
function readLimit(args: ToolArgs): number {
  return Math.min(count(args.max_output) ?? MAX_OUTPUT, MAX_OUTPUT);
}

/** One call's wait, capped so a single call cannot hold a turn indefinitely. */
function waitFor(args: ToolArgs, fallback: number): number {
  return Math.min(count(args.yield_ms) ?? fallback, MAX_YIELD_MS);
}

/** Publish one local package from the shell root; the store service does the rest. */
async function publishOp(ctx: NodeContext, root: string, args: ToolArgs): Promise<string> {
  const directory = await resolveInsideRoot(root, text(args.dir) || '.');
  const version = text(args.version) || undefined;
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
    throw new Error('overwrite must be true or false');
  }
  const packed = packLocalPackage({
    directory,
    ...(version === undefined ? {} : { version }),
  });
  // `ctx.call` answers with the value and throws on failure: a publish the store refused is this
  // call's error, not a `{ok: false}` this node would have to unwrap and re-raise.
  const reply = await ctx.call<Record<string, unknown>>('store', 'publish', {
    manifest: packed.manifest,
    archive: Buffer.from(packed.archive).toString('base64'),
    overwrite: args.overwrite === true,
  });
  return JSON.stringify({ ...reply, files: packed.files });
}

/** One command started, waited for a while, and answered with what it said. `exec` and `run-custom`
 *  share it so a saved command can never quietly get a longer deadline, a bigger output ceiling or a
 *  different working directory than the command the user watches in the Console tab. */
async function launch(
  sessions: Sessions,
  args: ToolArgs,
  job: {
    command: string;
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    /** The words after the script: `$0`, `$1`, … (`sessions.ts`). Never joined into `command`. */
    argv?: readonly string[];
  },
): Promise<string> {
  const session = sessions.create(
    job.command,
    job.cwd,
    job.timeoutMs,
    job.env ?? {},
    job.argv ?? [],
  );
  await session.wait(waitFor(args, DEFAULT_YIELD_MS));

  const poll = session.poll(readLimit(args));
  if (poll.status.spawnError !== null)
    throw new Error(`could not start the command: ${poll.status.spawnError}`);
  if (poll.status.running) sessions.adopt(session);

  return renderPoll(poll, true);
}

async function execOp(root: string, args: ToolArgs, sessions: Sessions): Promise<string> {
  const command = text(args.command);
  if (command === '') throw new Error('exec needs a command');

  return await launch(sessions, args, {
    command,
    cwd: fullPath(root, text(args.cwd) || '.'),
    ...(count(args.timeout_ms) === undefined ? {} : { timeoutMs: count(args.timeout_ms) }),
  });
}

/** One row of the permissions page: a capability, what it does, and whether the user allows it. */
type CapabilityRow = {
  cap: string;
  effect: Effect;
  /** True when webui bypasses this switch, keeping the page's own management path reachable. */
  forceWebui: boolean;
  enabled: boolean;
  /** The rule as saved: null when the capability was never touched, else who may call it. */
  callers: string[] | null;
};

/** The switches, as the page draws them and as a save answers with them. */
function policyView(node: string, policy: PermissionPolicy): Record<string, unknown> {
  const caps: CapabilityRow[] = SWITCHABLE.map((cap) => ({
    cap,
    effect: EFFECTS[cap] ?? 'read',
    forceWebui: FORCE_WEBUI.has(cap),
    enabled: policy.enabled(cap),
    callers: policy.callersOf(cap) ?? null,
  }));

  return {
    node,
    caps,
    // The switches as the page holds them: `true` is "any caller may". A capability with a rule that
    // names a few callers reads as off here, because that is what its switch would overwrite.
    switches: Object.fromEntries(caps.map((row) => [row.cap, row.enabled])),
    denied: caps.filter((row) => !row.enabled).map((row) => row.cap),
    // Capabilities the switches hold as rules for named callers, which this page cannot write.
    rules: caps
      .filter((row) => row.callers !== null)
      .map((row) => ({ cap: row.cap, callers: row.callers })),
  };
}

/** Read the switches. `reload` reads this tenant's permissions file again instead of answering from
 *  this process's copy. The file is the node's own (`settings.ts`): history is not consulted. */
async function permissionsOp(
  settings: ShellSettings,
  ctx: NodeContext,
  args: ToolArgs,
): Promise<string> {
  const policy = await settings.policy({ reload: args.reload === true });
  return JSON.stringify({
    ok: true,
    ...policyView(ctx.nodeId, policy),
    warning: settings.policyWarning,
  });
}

/** A `{ cap: boolean }` argument, checked against the capabilities this node actually has: a switch
 *  saved for a name nothing answers to would be a lie the page then draws. */
function capSwitches(value: unknown, node: string): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('caps is an object of capability switches: { "exec": false }');

  const known = new Set(NAMES);
  const switches: Record<string, boolean> = {};
  for (const [cap, allowed] of Object.entries(value)) {
    if (!known.has(cap))
      throw new Error(`${node} has no capability "${cap}": see ${node}.permissions for the list`);
    if (PAGE_ONLY.has(cap))
      throw new Error(`${node}.${cap} is reserved for webui and is not a user switch`);
    if (typeof allowed !== 'boolean')
      throw new Error(`the switch for "${cap}" is true (allowed) or false (refused)`);
    switches[cap] = allowed;
  }
  return switches;
}

/** A `{ cap: [callers] | null }` argument: the same switch, said as who may call it. This is the form
 *  a bus-wide permission check speaks (`system.permissions`), so it is accepted here from the start. */
function capCallers(value: unknown, node: string): Record<string, string[] | null> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('callers is an object: { "exec": ["agent"] }, or null to allow everyone');

  const known = new Set(NAMES);
  const rules: Record<string, string[] | null> = {};
  for (const [cap, callers] of Object.entries(value)) {
    if (!known.has(cap))
      throw new Error(`${node} has no capability "${cap}": see ${node}.permissions for the list`);
    if (PAGE_ONLY.has(cap))
      throw new Error(`${node}.${cap} is reserved for webui and is not a user switch`);
    if (callers === null) {
      rules[cap] = null;
      continue;
    }
    if (
      !Array.isArray(callers) ||
      callers.some((name) => typeof name !== 'string' || name.trim() === '')
    )
      throw new Error(`the callers for "${cap}" are a list of node names, or null`);
    rules[cap] = callers.map((name: string) => name.trim());
  }
  return rules;
}

/** Save the switches to this tenant's permissions file. A write that fails still takes effect here
 *  and says so. */
async function setPermissionsOp(
  settings: ShellSettings,
  ctx: NodeContext,
  args: ToolArgs,
): Promise<string> {
  let next = await settings.policy();
  if (args.caps !== undefined) next = next.withCaps(capSwitches(args.caps, ctx.nodeId));
  for (const [cap, callers] of Object.entries(capCallers(args.callers ?? {}, ctx.nodeId)))
    next = next.withCallers(cap, callers);

  const saved = await settings.savePolicy(next);
  return JSON.stringify({
    ok: true,
    ...policyView(ctx.nodeId, next),
    persisted: saved.persisted,
    error: saved.error,
  });
}

/** The commands, listed or changed. Every answer carries the whole list, so the page re-draws from
 *  one truth instead of patching its own copy. */
async function customCommandsOp(
  settings: ShellSettings,
  ctx: NodeContext,
  args: ToolArgs,
): Promise<string> {
  const commands = await settings.commands(ctx, { reload: args.reload === true });
  const action = text(args.action) || 'list';
  const wanted = text(args.id) || text(args.name);

  if (action === 'list')
    return JSON.stringify({
      ok: true,
      action,
      commands: commands.list(),
      warning: settings.commandsWarning,
    });

  if (action === 'get') {
    const found = commands.find(wanted);
    if (found === undefined)
      throw new Error(`no custom command "${wanted}": see ${ctx.nodeId}.custom-commands`);
    return JSON.stringify({ ok: true, action, command: found });
  }

  let next: CustomCommands;
  if (action === 'add') next = commands.add(args);
  else if (action === 'update') next = commands.update(wanted, args);
  else if (action === 'delete') next = commands.remove(wanted);
  else
    throw new Error(`custom-commands takes list / get / add / update / delete (got "${action}")`);

  const saved = await settings.saveCommands(ctx, next);
  return JSON.stringify({
    ok: true,
    action,
    commands: next.list(),
    persisted: saved.persisted,
    error: saved.error,
  });
}

/** The arguments one `run-custom` call passes: a word each, never joined into the script. A word
 *  that is `; rm -rf /` is a word the script can read and nothing more. */
function customArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new Error(
      `args is a list of words (they reach the command as $1, $2, …), not ${typeof value}`,
    );
  if (value.length > MAX_CUSTOM_ARGS)
    throw new Error(`at most ${MAX_CUSTOM_ARGS} arguments reach one custom command`);

  return value.map((word: unknown) => {
    if (typeof word === 'string') return word;
    if (typeof word === 'number' || typeof word === 'boolean') return String(word);
    throw new Error('an argument is a string, a number or a boolean');
  });
}

/** Run a command the user saved. It gets the same deadline, output ceiling and working directory as
 *  `exec`; the arguments go round the side, as argv and as one JSON variable (`policy.ts`). */
async function runCustomOp(
  settings: ShellSettings,
  ctx: NodeContext,
  workspace: string,
  args: ToolArgs,
  sessions: Sessions,
): Promise<string> {
  const wanted = text(args.name) || text(args.id);
  if (wanted === '')
    throw new Error(
      `run-custom needs a name: the saved command to run (list them with ${ctx.nodeId}.custom-commands)`,
    );

  const commands = await settings.commands(ctx);
  const found: CustomCommand | undefined = commands.find(wanted);
  if (found === undefined)
    throw new Error(
      `no custom command "${wanted}": list them with ${ctx.nodeId}.custom-commands, or add one in the shell page`,
    );

  const argv = customArgs(args.args ?? args.params);
  const timeoutMs = count(args.timeout_ms) ?? found.timeoutMs;

  return await launch(sessions, args, {
    command: found.command,
    cwd: fullPath(workspace, found.cwd ?? '.'),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    env: {
      ...environment(found.env),
      SHELL_CUSTOM_NAME: found.name,
      SHELL_CUSTOM_ID: found.id,
      // The same words, for a script that would rather read them as data than as argv.
      SHELL_CUSTOM_ARGS: JSON.stringify(argv),
      SHELL_CUSTOM_COUNT: String(argv.length),
    },
    argv: [argvName(found), ...argv],
  });
}

/** One row of `list-local-running-nodes`: a node this shell started and the session holding it. */
export type RunNodeRow = {
  session: string;
  /** `package` for a node package (started through the SDK runner), `entry` for a plain script. */
  kind: 'package' | 'entry';
  /** The bus name: the package's `node.id` (or the requested name), or the script's name. */
  name: string | null;
  /** The package directory, or the script's file. */
  path: string;
  /** The package's declared entry file, when `kind` is `package`. */
  entry: string | null;
  cwd: string;
  args: string[];
  pid: number | undefined;
  running: boolean;
  code: number | null;
  startedAt: number;
  ageMs: number;
};

type RunNodeMeta = {
  session: string;
  kind: 'package' | 'entry';
  name: string | null;
  path: string;
  entry: string | null;
  cwd: string;
  args: string[];
  startedAt: number;
};

/** A node package rooted at `directory`: its `package.json` must have a `node` block, because a
 *  plain package.json beside a script is not a node package. The entry is the package's own
 *  `node.entry`, or the SDK runner's conventional `dist/serve.js`. */
function nodePackage(directory: string): { dir: string; id: string; entry: string } | null {
  let at = resolve(directory);
  for (let depth = 0; depth < 4; depth += 1) {
    const file = join(at, 'package.json');
    if (existsSync(file)) {
      let parsed: { name?: unknown; node?: { id?: unknown; entry?: unknown } };
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
      } catch {
        return null;
      }
      if (parsed.node === undefined) return null;
      let id = basename(at);
      if (typeof parsed.node.id === 'string' && parsed.node.id !== '') id = parsed.node.id;
      else if (typeof parsed.name === 'string' && parsed.name !== '') id = parsed.name;
      let entry = 'dist/serve.js';
      if (typeof parsed.node.entry === 'string' && parsed.node.entry !== '')
        entry = parsed.node.entry.replace(/^\.\//, '');
      return { dir: at, id, entry };
    }
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  return null;
}

/** The SDK runner beside the dependency this shell already loads packages with: the same
 *  `node <sdk>/dist/serve.js <package dir>` the store starts an installed node with. It reads the
 *  package's package.json and serves its default-exported Node class. */
function sdkRuntime(): { runner: string; api: string } {
  const require = createRequire(import.meta.url);
  const api = require.resolve('@node-agent/sdk');
  const runner = join(dirname(api), 'serve.js');
  if (!existsSync(runner)) {
    throw new Error(
      `the @node-agent/sdk at ${dirname(api)} has no serve.js: cannot start a package`,
    );
  }
  return { runner, api };
}

/** The runner CLI serves a package under its own `node.id`. For any other name this writes the
 *  one-line launcher that calls the same `servePackage` with the id override, because the CLI has
 *  no flag for it. */
function serveWrapper(api: string, dir: string, id: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'shell-run-node-')), 'serve.web.mjs');
  writeFileSync(
    file,
    [
      `import { servePackage } from ${JSON.stringify(pathToFileURL(api).href)};`,
      `const host = await servePackage(${JSON.stringify(dir)}, { id: ${JSON.stringify(id)} });`,
      'console.log(host.manifest.name + ": joined " + (process.env.NODE_AGENT_BUS_URL ?? ""));',
      'await new Promise((resolve) => {',
      '  process.once("SIGINT", resolve);',
      '  process.once("SIGTERM", resolve);',
      '});',
      'await host.stop();',
      '',
    ].join('\n'),
  );
  return file;
}

/** What `path` names: a node package (a directory, or a file that is its declared entry), or a
 *  plain entry script, started as before. A script that merely lives inside a package is still a
 *  script. */
type RunTarget =
  | { kind: 'package'; dir: string; id: string; entry: string; command: string[] }
  | { kind: 'entry'; file: string; command: string[] };

function resolveRunTarget(workspace: string, args: ToolArgs): RunTarget {
  const given = fullPath(workspace, text(args.path));
  let directory = false;
  try {
    directory = statSync(given).isDirectory();
  } catch {
    throw new Error(`run-node cannot see ${given}`);
  }

  let found = nodePackage(directory ? given : dirname(given));
  if (found !== null && !directory) {
    // Only a file that is the package's own entry (or its serve launcher) is started as a package:
    // a helper script beside it has its own command line, and keeps it.
    const declared = join(found.dir, found.entry);
    const launcher = join(found.dir, 'dist', 'serve.js');
    if (given !== declared && given !== launcher) found = null;
  }

  if (found === null) {
    const python = given.endsWith('.py');
    const runtime = python ? process.env.NODE_AGENT_PYTHON?.trim() || 'python3' : process.execPath;
    const extra = Array.isArray(args.args)
      ? args.args.filter((one): one is string => typeof one === 'string')
      : [];
    return { kind: 'entry', file: given, command: [runtime, given, ...extra] };
  }

  const { runner, api } = sdkRuntime();
  const entry = join(found.dir, found.entry);
  if (!existsSync(entry)) {
    throw new Error(`${found.dir} has no ${found.entry}: build the package first (npm run build)`);
  }
  if (Array.isArray(args.args) && args.args.length > 0) {
    throw new Error('run-node args are for a plain entry script; a node package takes none');
  }
  const id = text(args.name).trim() || found.id;
  const command =
    id === found.id
      ? [process.execPath, runner, found.dir]
      : [process.execPath, serveWrapper(api, found.dir, id)];
  return { kind: 'package', dir: found.dir, id, entry, command };
}

/** run-node: start a local node on the bus this shell is serving. */
async function runNodeOp(
  workspace: string,
  args: ToolArgs,
  sessions: Sessions,
  runNodes: Map<string, RunNodeMeta>,
): Promise<string> {
  if (text(args.path) === '')
    throw new Error('run-node needs path=<node package directory | entry>');

  // The address and token no longer live on the node -- the SDK host owns the connection -- so they
  // come from the environment the host itself was started with. A shell started without a bus has
  // neither, and that is the case this sentence is for.
  const busUrl = (process.env.NODE_AGENT_BUS_URL ?? '').trim();
  const token = (process.env.NODE_AGENT_TOKEN ?? '').trim();
  if (busUrl === '' || token === '') {
    throw new Error('run-node needs this shell to be joined to a bus');
  }

  const target = resolveRunTarget(workspace, args);
  const name =
    target.kind === 'package'
      ? target.id
      : text(args.name).trim() || basename(target.file, extname(target.file));
  const cwd =
    target.kind === 'package'
      ? target.dir
      : fullPath(workspace, text(args.cwd) || dirname(text(args.path)));
  const extra = target.kind === 'package' ? [] : target.command.slice(2);
  const extraEnv: Record<string, string> = { NODE_AGENT_BUS_URL: busUrl, NODE_AGENT_TOKEN: token };
  // A plain script is the old shape and still names itself the old way. A package registers under
  // the id the SDK runner gives it, so there is nothing to pass here.
  if (target.kind === 'entry') extraEnv.NODE_AGENT_NODE_NAME = name;

  const command = target.command.map(shellQuote).join(' ');
  const session = sessions.create(command, cwd, count(args.timeout_ms), extraEnv);
  runNodes.set(session.id, {
    session: session.id,
    kind: target.kind,
    name,
    path: target.kind === 'package' ? target.dir : target.file,
    entry: target.kind === 'package' ? target.entry : null,
    cwd,
    args: extra,
    startedAt: session.status().startedAt,
  });
  await session.wait(waitFor(args, DEFAULT_YIELD_MS));

  const poll = session.poll(readLimit(args));
  if (poll.status.spawnError !== null)
    throw new Error(`could not start the node: ${poll.status.spawnError}`);
  if (poll.status.running) sessions.adopt(session);

  return renderPoll(poll, true);
}

/** list-local-running-nodes: the nodes this shell started, with the session that can stop each one. */
function listRunNodesOp(sessions: Sessions, runNodes: Map<string, RunNodeMeta>): string {
  const rows: RunNodeRow[] = [];
  for (const [id, meta] of runNodes) {
    let status: SessionStatus;
    try {
      status = sessions.get(id).status();
    } catch {
      runNodes.delete(id);
      continue;
    }
    if (!status.running) {
      runNodes.delete(id);
      continue;
    }
    rows.push({
      session: id,
      kind: meta.kind,
      name: meta.name,
      entry: meta.entry,
      path: meta.path,
      cwd: meta.cwd,
      args: meta.args,
      pid: status.pid,
      running: true,
      code: status.code,
      startedAt: meta.startedAt,
      ageMs: status.ageMs,
    });
  }
  return JSON.stringify({ nodes: rows });
}

/** kill-node: the reverse of run-node, by the name it was given or the session it returned. */
async function killNodeOp(
  args: ToolArgs,
  sessions: Sessions,
  runNodes: Map<string, RunNodeMeta>,
): Promise<string> {
  const sessionId = text(args.session_id).trim();
  const name = text(args.name).trim();
  if (sessionId === '' && name === '') {
    throw new Error('kill-node wants name=<run-node name> or session_id=<session>');
  }

  const matches = [...runNodes.entries()].filter(([id, meta]) =>
    sessionId !== '' ? id === sessionId : meta.name === name,
  );
  if (matches.length === 0) {
    throw new Error(
      `no node started by run-node matches ${sessionId !== '' ? `session ${sessionId}` : `name ${name}`}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} nodes match name ${name}; pass session_id to choose one (${matches.map(([id]) => id).join(', ')})`,
    );
  }

  const match = matches[0];
  if (match === undefined) throw new Error(`no node started by run-node matches ${name}`);
  const [id, meta] = match;
  const session = sessions.get(id);
  if (!session.status().running) {
    runNodes.delete(id);
    return `node ${meta.name ?? meta.path} (session ${id}) has already finished`;
  }

  const signal = (text(args.signal) || 'SIGTERM') as NodeJS.Signals;
  session.kill(signal);
  await session.wait(2_500);
  if (session.status().running) {
    throw new Error(
      `node ${meta.name ?? meta.path} (session ${id}) is still running after ${signal}`,
    );
  }
  runNodes.delete(id);
  return `killed node ${meta.name ?? meta.path} (session ${id}, pid ${session.status().pid ?? '?'})`;
}

/** write-stdin: send input and/or read what is new since the last read. */
async function writeStdinOp(args: ToolArgs, sessions: Sessions): Promise<string> {
  const session = sessions.get(text(args.session_id));
  if (typeof args.chars === 'string' && args.chars !== '') session.write(args.chars);
  if (args.eof === true) session.endInput();

  await session.wait(waitFor(args, DEFAULT_POLL_MS));
  return renderPoll(session.poll(readLimit(args)));
}

/** sessions: what this node is still holding, running first. */
function listSessionsOp(sessions: Sessions): string {
  const list = sessions.list();
  if (list.length === 0) return '(no sessions)';

  return list
    .map((status) => {
      const state = status.running
        ? 'running'
        : status.timedOut
          ? `exit ${TIMEOUT_CODE}`
          : `exit ${status.code ?? '?'}`;
      return `${status.id}  ${state}  ${seconds(status.ageMs)}  pid ${status.pid}  ${status.command}`;
    })
    .join('\n');
}

/** kill-session: SIGTERM, with SIGKILL two seconds later if it is still there. */
function killSessionOp(args: ToolArgs, sessions: Sessions): string {
  const session = sessions.get(text(args.session_id));
  if (!session.status().running) return `session ${session.id} has already finished`;

  const signal = (text(args.signal) || 'SIGTERM') as NodeJS.Signals;
  session.kill(signal);
  return `sent ${signal} to session ${session.id}`;
}

/** read: one file as plain text, so the caller can hand it straight back to `edit`. */
async function readFileOp(root: string, args: ToolArgs): Promise<string> {
  const target = await resolveInsideRoot(root, text(args.path));
  const buffer = await readFile(target);
  if (buffer.includes(0)) throw new Error(`not a text file: ${displayPath(root, target)}`);

  const offset = count(args.offset);
  const limit = count(args.limit);
  let body = buffer.toString('utf8');

  if (offset !== undefined || limit !== undefined) {
    const lines = body.split('\n');
    const start = (offset ?? 1) - 1;
    const end = limit === undefined ? lines.length : start + limit;
    body = lines.slice(start, end).join('\n');
    if (end < lines.length) body += `\n… (${lines.length} lines in all; this stops at line ${end})`;
    return body;
  }

  if (buffer.length > MAX_READ_BYTES) {
    body = buffer.subarray(0, MAX_READ_BYTES).toString('utf8');
    body += `\n… (${buffer.length} bytes; only the first ${MAX_READ_BYTES} were read)`;
  }

  return body;
}

/** write: create or overwrite one file; the parent directory is created when it is missing. */
async function writeFileOp(root: string, args: ToolArgs): Promise<string> {
  const target = await resolveInsideRoot(root, text(args.path), 'write');
  const content = text(args.content);
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_WRITE_BYTES)
    throw new Error(`content is ${bytes} bytes, over the ${MAX_WRITE_BYTES} limit`);

  await mkdir(dirname(target), { recursive: true });
  await writeOne(target, content);

  return `wrote ${displayPath(root, target)} (${bytes} bytes, ${content.split('\n').length} lines)`;
}

/** edit: literal snippet replacement; a non-unique `old` is an error unless `replaceAll` is set. */
async function editFileOp(root: string, args: ToolArgs): Promise<string> {
  const target = await resolveInsideRoot(root, text(args.path), 'write');
  const old = text(args.old);
  const replacement = text(args.new);
  if (old === '') throw new Error('edit needs the old text to replace (old cannot be empty)');

  const name = displayPath(root, target);
  const body = await readFile(target, 'utf8');
  const hits = body.split(old).length - 1;
  if (hits === 0) throw new Error(`there is no such text in ${name}`);
  if (hits > 1 && args.replaceAll !== true)
    throw new Error(
      `old appears ${hits} times in ${name}: give more context, or pass replaceAll:true`,
    );

  const index = body.indexOf(old);
  const next =
    args.replaceAll === true
      ? body.split(old).join(replacement)
      : body.slice(0, index) + replacement + body.slice(index + old.length);

  const bytes = Buffer.byteLength(next);
  if (bytes > MAX_WRITE_BYTES)
    throw new Error(`the result is ${bytes} bytes, over the ${MAX_WRITE_BYTES} limit`);
  await writeOne(target, next);

  return `edited ${name} (${hits} replacement${hits === 1 ? '' : 's'})`;
}

/** list: one directory, names and types, capped. */
async function listOp(root: string, args: ToolArgs): Promise<string> {
  const target = await resolveInsideRoot(root, text(args.path) || '.');
  const entries = (await readdir(target, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const lines = await Promise.all(
    entries.slice(0, MAX_LIST).map(async (entry) => {
      if (entry.isDirectory()) return `d ${entry.name}/`;
      const stat = await lstat(join(target, entry.name));
      return `f ${entry.name}  ${stat.size}`;
    }),
  );
  if (entries.length > MAX_LIST) lines.push(`… (${entries.length - MAX_LIST} more)`);

  return lines.join('\n') || '(empty directory)';
}

/** glob: file names, `displayPath`-relative to the workspace, capped. */
async function globOp(root: string, args: ToolArgs): Promise<string> {
  const pattern = text(args.pattern);
  if (pattern === '') throw new Error('glob needs a pattern');

  const base = await resolveInsideRoot(root, text(args.path) || '.');
  const raw = globSync(pattern, { cwd: base }).sort();
  const matches: string[] = [];

  for (const found of raw) {
    if (matches.length >= MAX_MATCHES) break;
    matches.push(displayPath(root, resolve(base, found)));
  }

  matches.push(
    ...(raw.length > matches.length ? [`… (more; only ${matches.length} are listed)`] : []),
  );
  return matches.join('\n') || '(no matches)';
}

/** grep: a regex over a directory's files, `path:line: text` per hit. Symlinks are skipped
 *  (`lstat` says so) so a scan cannot wander off through a link; ask `read` for one directly if
 *  that is what you want. */
async function grepOp(root: string, args: ToolArgs): Promise<string> {
  const pattern = text(args.pattern);
  if (pattern === '') throw new Error('grep needs a pattern');

  const base = await resolveInsideRoot(root, text(args.path) || '.');
  let test: RegExp;
  try {
    test = new RegExp(pattern);
  } catch (e) {
    throw new Error(`invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }

  const lines: string[] = [];
  let scanned = 0;

  for (const found of globSync(text(args.glob) || '**/*', { cwd: base })) {
    if (lines.length >= MAX_MATCHES || scanned >= MAX_FILES) break;

    const target = resolve(base, found);
    let buffer: Buffer;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.size > MAX_GREP_BYTES) continue;
      buffer = await readFile(target);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue;
    scanned += 1;

    const name = displayPath(root, target);
    buffer
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        if (lines.length < MAX_MATCHES && test.test(line))
          lines.push(`${name}:${index + 1}: ${line}`);
      });
  }

  return lines.join('\n') || '(no matches)';
}

/** One row of a `files-tree` answer. `children` is there only while `depth` allowed it: a
 *  directory without it is what the page opens with another call. */
interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
  children?: TreeEntry[];
}

/** One answer's shrinking allowance, so a wide or deep tree cannot fill a frame in one call. */
interface TreeBudget {
  left: number;
  truncated: boolean;
}

/** Directories first, then files, then the rest, each by name — the order a person expects. */
function orderEntries(entries: TreeEntry[]): TreeEntry[] {
  const rank = { dir: 0, file: 1, link: 2, other: 3 } as const;
  return entries.sort((a, b) => rank[a.type] - rank[b.type] || a.name.localeCompare(b.name));
}

/** One directory as the browser sees it: entries for `depth` levels, a symlink shown as itself
 *  (following it is `files-read`'s call, and that one checks where it leads). */
async function readTree(
  root: string,
  target: string,
  depth: number,
  budget: TreeBudget,
): Promise<TreeEntry[]> {
  const listing = (await readdir(target, { withFileTypes: true })).slice(0, MAX_TREE_ENTRIES);
  const entries: TreeEntry[] = [];

  for (const dirent of listing) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }

    const child = join(target, dirent.name);
    let info;
    try {
      info = await lstat(child);
    } catch {
      continue; // gone between the listing and the look: not worth an error row
    }

    const type: TreeEntry['type'] = info.isDirectory()
      ? 'dir'
      : info.isFile()
        ? 'file'
        : info.isSymbolicLink()
          ? 'link'
          : 'other';
    const entry: TreeEntry = {
      name: dirent.name,
      path: displayPath(root, child),
      type,
      size: type === 'dir' ? 0 : info.size,
      mtime: Math.round(info.mtimeMs),
    };
    budget.left -= 1;
    if (type === 'dir' && depth > 1 && budget.left > 0)
      entry.children = await readTree(root, child, depth - 1, budget);
    entries.push(entry);
  }

  return orderEntries(entries);
}

/** files-tree: one accessible directory for the page, as JSON. */
async function treeOp(root: string, args: ToolArgs): Promise<string> {
  if (args.depth !== undefined && count(args.depth) === undefined)
    throw new Error(
      `depth wants a whole number of levels, 1 or more (got ${JSON.stringify(args.depth)})`,
    );
  const depth = Math.min(count(args.depth) ?? 1, MAX_TREE_DEPTH);

  const input = text(args.path) || '.';
  const target = await resolveInsideRoot(root, input);
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(
      `path wants a directory that exists: "${input}" is not there under ${resolve(root)}`,
    );
  }
  if (!info.isDirectory())
    throw new Error(`path wants a directory: "${input}" is a file — read it with files-read`);

  const budget: TreeBudget = { left: MAX_TREE_NODES, truncated: false };
  const entries = await readTree(root, target, depth, budget);

  return JSON.stringify({
    path: displayPath(root, target),
    depth,
    entries,
    truncated: budget.truncated,
  });
}

/** files-read: one file as the page can show it. Text comes with its line count, an image as a data
 *  URL, and anything else is a structured refusal carrying only what is safe to say (size and type)
 *  — bytes that are not text are never turned into text and handed back. */
async function previewOp(root: string, args: ToolArgs): Promise<string> {
  const input = text(args.path);
  if (input === '') throw new Error('path wants a file to read');

  const target = await resolveInsideRoot(root, input);
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(
      `path wants a file that exists: "${input}" is not there under ${resolve(root)}`,
    );
  }
  if (info.isDirectory())
    throw new Error(`path wants a file: "${input}" is a directory — list it with files-tree`);

  const ext = extname(target).toLowerCase();
  const image = IMAGE_TYPES[ext];
  const mime = image ?? TEXT_TYPES[ext] ?? 'application/octet-stream';
  const head = {
    path: displayPath(root, target),
    mime,
    size: info.size,
    mtime: Math.round(info.mtimeMs),
    revision: revisionOf(info),
  };

  if (image !== undefined) {
    if (info.size > MAX_IMAGE_BYTES)
      return JSON.stringify({
        ok: false,
        kind: 'too-large',
        ...head,
        message: `not previewable: ${info.size} bytes is over the ${MAX_IMAGE_BYTES}-byte image limit`,
      });
    const bytes = await readFile(target);
    return JSON.stringify({
      ok: true,
      kind: 'image',
      ...head,
      dataUrl: `data:${image};base64,${bytes.toString('base64')}`,
    });
  }

  if (info.size > MAX_PREVIEW_BYTES)
    return JSON.stringify({
      ok: false,
      kind: 'too-large',
      ...head,
      message: `not previewable: ${info.size} bytes is over the ${MAX_PREVIEW_BYTES}-byte preview limit`,
    });

  const bytes = await readFile(target);
  if (bytes.includes(0))
    return JSON.stringify({
      ok: false,
      kind: 'binary',
      ...head,
      message: `not previewable: ${info.size} bytes of ${mime} (binary)`,
    });

  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return JSON.stringify({
      ok: false,
      kind: 'binary',
      ...head,
      message: `not previewable: ${info.size} bytes of ${mime} (not UTF-8 text)`,
    });
  }

  return JSON.stringify({
    ok: true,
    kind: 'text',
    ...head,
    text: body,
    lines: body === '' ? 0 : body.split('\n').length,
  });
}

/** files-write: save the file the page edited. Three refusals come back as answers (not throws),
 *  because the page shows each of them: a path on the deny list, a body past the write limit, and a
 *  stale `expectedRevision` (`kind: 'conflict'`, carrying the revision that is there now). The last
 *  one is the point of the argument — the page sends the revision it read, so a file somebody else
 *  touched is never written over by accident; leaving `expectedRevision` out is how the page says
 *  "keep mine". A save that lands answers with the new revision. A path outside the root throws like
 *  every other file ability — there is no page to answer out there, and nothing to show it on. */
async function saveOp(root: string, args: ToolArgs): Promise<string> {
  const input = text(args.path);
  if (input === '') throw new Error('path wants a file to save');
  if (typeof args.content !== 'string')
    throw new Error('content wants the whole file contents as a string');

  const target = await resolveInsideRoot(root, input);
  const shown = displayPath(root, target);

  const denied = await deniedWrite(root, target);
  if (denied !== null)
    return JSON.stringify({
      ok: false,
      kind: 'denied',
      path: shown,
      message: `"${denied}" is on this node's deny list (NODE_AGENT_SHELL_DENY_WRITE), so the page will not save ${shown}`,
    });

  const content = args.content;
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_WRITE_BYTES)
    return JSON.stringify({
      ok: false,
      kind: 'too-large',
      path: shown,
      size: bytes,
      message: `${bytes} bytes is over the ${MAX_WRITE_BYTES}-byte write limit`,
    });

  let info;
  try {
    info = await stat(target);
  } catch {
    info = undefined; // a new file has no revision to conflict with
  }
  if (info !== undefined && info.isDirectory())
    throw new Error(`path wants a file: "${input}" is a directory — list it with files-tree`);

  const current = info === undefined ? undefined : revisionOf(info);
  if (args.expectedRevision !== undefined) {
    if (count(args.expectedRevision) === undefined)
      throw new Error(
        `expectedRevision wants the revision number files-read handed out (got ${JSON.stringify(args.expectedRevision)})`,
      );
    const expected = args.expectedRevision;
    if (current !== expected)
      return JSON.stringify({
        ok: false,
        kind: 'conflict',
        path: shown,
        revision: current ?? null,
        message:
          current === undefined
            ? `the file is gone, and the page started from revision ${expected}`
            : `the file changed since revision ${expected} (it is at ${current}) — reload it, or save over it`,
      });
  }

  await mkdir(dirname(target), { recursive: true });
  const revision = await writeOne(target, content);

  const after = await stat(target);
  return JSON.stringify({
    ok: true,
    path: shown,
    revision,
    size: after.size,
    mtime: Math.round(after.mtimeMs),
  });
}

/** Where a tenant's shell works: a test (or a host that mounts one explicitly) may say, otherwise
 *  `NODE_AGENT_WORKSPACE` / `NODE_AGENT_SHELL_ROOT` do, exactly as they did before. */
export type ShellOptions = { workspace?: string; root?: string; home?: string };

/** One tenant's shell in this process: the state that has to outlive a call. */
export class ShellService {
  readonly tenant: string;

  /** The directory relative paths resolve against, and `exec`'s default cwd. */
  readonly workspace: string;

  /** The root every file ability is confined to (`shellRoot`). `exec` is not confined by it. */
  readonly root: string;

  /** Long-running commands, alive across calls; a command outlives the invocation that started it. */
  readonly sessions = new Sessions();

  /** Sessions started by `run-node`, with the local entry that produced each. */
  readonly runNodes = new Map<string, RunNodeMeta>();

  /** What the user decided about this shell: the capability switches (this tenant's own file under
   *  `$NODE_AGENT_HOME`, see `settings.ts`) and the saved commands (still a history unit). */
  readonly settings: ShellSettings;

  constructor(tenant: string, workspace: string, root: string, home?: string) {
    this.tenant = tenant;
    this.workspace = workspace;
    this.root = root;
    this.settings = new ShellSettings(tenant, home);
  }

  /** Why this call is refused, or null when the user's switches allow it.
   *
   *  Every capability goes through here before it runs, which is the whole point of the switches: a
   *  caller that was switched off learns it before anything touches the machine, and the refusal names
   *  both the capability and the caller. Webui bypasses the switches on its force-webui path,
   *  while every other caller (including agents) is still subject to them. Page-only names
   *  (`ui`, `set-permissions`) answer only webui. An unknown capability is not this function's
   *  business: dispatch answers it as before. */
  private async refused(cap: string, ctx: NodeContext): Promise<Error | null> {
    if (PAGE_ONLY.has(cap))
      return ctx.from === 'webui' ? null : new Error(`${ctx.nodeId}.${cap} is reserved for webui`);
    if (!Object.hasOwn(EFFECTS, cap)) return null;
    // The page's own management path bypasses user switches; those switches still apply to every
    // other caller, so an agent can be denied without taking the page away from its user.
    if (ctx.from === 'webui' && FORCE_WEBUI.has(cap)) return null;

    const policy = await this.settings.policy();
    if (policy.allows(cap, ctx.from)) return null;

    return new Error(`${ctx.nodeId}.${cap} is disabled by the user for node "${ctx.from}"`);
  }

  /** Bus-facing entry: the file abilities, the shell abilities, or the node's own page. */
  async handle(cap: string, ctx: NodeContext, args: ToolArgs): Promise<unknown> {
    const refusal = await this.refused(cap, ctx);
    if (refusal !== null) throw refusal;

    switch (cap) {
      case 'read':
        return readFileOp(this.root, args);
      case 'write':
        return writeFileOp(this.root, args);
      case 'edit':
        return editFileOp(this.root, args);
      case 'list':
        return listOp(this.root, args);
      case 'glob':
        return globOp(this.root, args);
      case 'grep':
        return grepOp(this.root, args);
      case 'files-tree':
        return treeOp(this.root, args);
      case 'files-read':
        return previewOp(this.root, args);
      case 'files-write':
        return saveOp(this.root, args);
      case 'publish':
        return publishOp(ctx, this.root, args);
      case 'exec':
        return execOp(this.workspace, args, this.sessions);
      case 'run-node':
        return runNodeOp(this.workspace, args, this.sessions, this.runNodes);
      case 'list-local-running-nodes':
        return listRunNodesOp(this.sessions, this.runNodes);
      case 'kill-node':
        return killNodeOp(args, this.sessions, this.runNodes);
      case 'write-stdin':
        return writeStdinOp(args, this.sessions);
      case 'sessions':
        return listSessionsOp(this.sessions);
      case 'kill-session':
        return killSessionOp(args, this.sessions);
      case 'permissions':
        return await permissionsOp(this.settings, ctx, args);
      case 'set-permissions':
        return await setPermissionsOp(this.settings, ctx, args);
      case 'custom-commands':
        return await customCommandsOp(this.settings, ctx, args);
      case 'run-custom':
        return await runCustomOp(this.settings, ctx, this.workspace, args, this.sessions);
      case PANEL:
        // The page is drawn in the language this visit asked for: `paintPage` writes those words into
        // its `data-text-key` markers and embeds the resource the browser half reads.
        //
        // The page also carries this node's own name as a placeholder, filled in here where the node
        // knows what it is called: a name belongs to whoever started it, so the page cannot have it
        // written in. Only the name is substituted — the quotes are the page's, so both the filled and
        // the unfilled page stay valid JavaScript.
        return paintPage(PAGE, RESOURCE, args).replaceAll('__NODE__', () =>
          JSON.stringify(ctx.nodeId).slice(1, -1),
        );
      default:
        throw new Error(
          `${ctx.nodeId} only provides ${NAMES.join(' / ')} / ${PANEL} (got "${cap}")`,
        );
    }
  }
}

/** The shells this process is serving, one per tenant. Created on first use and never on a timer: a
 *  `ShellService` holds child processes, and those must not be made per call. Keyed by tenant because
 *  one host can serve more than one, and two tenants' sessions must never be each other's. */
const services = new Map<string, ShellService>();

/** The tenant's shell, made on first use. `options` decides where a *new* service works; an existing
 *  one keeps the directories it was made with, so a later caller cannot move a live shell's root. */
export function shellService(tenant: string, options: ShellOptions = {}): ShellService {
  const found = services.get(tenant);
  if (found !== undefined) return found;

  const workspace = options.workspace ?? workspaceRoot();
  const root = options.root ?? shellRoot(workspace);
  const service = new ShellService(tenant, workspace, root, options.home);
  services.set(tenant, service);
  return service;
}

/** Kill a tenant's commands and forget the service. For a process that unloads a tenant, and for
 *  tests; nothing on the bus calls it. `dispose()` must not: it runs after *every* invocation, and the
 *  sessions have to be there for the next one. */
export function closeShellService(tenant: string): void {
  const service = services.get(tenant);
  if (service === undefined) return;

  services.delete(tenant);
  service.sessions.destroyAll();
}

/** shell: reads and writes files and runs the commands the model asks for. Every file ability stays
 *  inside one root and writing refuses a short list of names; `exec` goes wherever the command says.
 *  A command that outlives `yield_ms` becomes a session this node keeps alive.
 *
 *  The SDK host makes one node per invocation and disposes it in a `finally`, so the shell's state --
 *  its sessions, the nodes `run-node` started, the two directories -- lives in the tenant's
 *  `ShellService` instead, made once for the process. There is no `dispose()` override: nothing here
 *  is invocation-local, and clearing the sessions there would kill a command between two calls. */
export class ShellNode extends Node {
  readonly handlers: NodeHandlers;

  private readonly service: ShellService;

  constructor(ctx: NodeContext, options: ShellOptions = {}) {
    super(ctx);
    this.service = shellService(ctx.tenantId, { ...options, home: ctx.home });

    // The same cap names the manifest in package.json carries; the host dispatches by name and
    // refuses any it does not know, so this map and that block have to agree on every entry.
    this.handlers = Object.fromEntries(
      [...NAMES, PANEL].map((cap) => [cap, (args: ToolArgs) => this.handle(cap, args)]),
    );
  }

  /** The node's entry for one capability. The host goes through `handlers`, which is this method;
   *  it stays public so a test can drive one capability without a bus. */
  async handle(cap: string, args: ToolArgs): Promise<unknown> {
    return await this.service.handle(cap, this.ctx, args);
  }

  /** Where this tenant's shell works, and the root its file abilities are confined to: the service
   *  holds both, because a root has to mean the same thing in every invocation. */
  get workspace(): string {
    return this.service.workspace;
  }

  get root(): string {
    return this.service.root;
  }
}

export default ShellNode;

// This file is both the Node class the SDK loads and the package's `npx` bin. Importing it must
// only export ShellNode; running it starts one host against the bus named by the environment.
function invokedAsProgram(): boolean {
  if (process.argv[1] === undefined) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

async function runProgram(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifest = nodeManifestOfPackage(root);
  const at = process.argv.indexOf('--name');
  const named =
    (at === -1 ? '' : (process.argv[at + 1] ?? '')).trim() ||
    (process.env.NODE_AGENT_NODE_ID ?? '').trim();
  const definition = named === '' ? manifest : { ...manifest, name: named, packageId: named };
  const host = new NodeHost({
    definition: { manifest: definition, Node: ShellNode },
    bus: new WebSocketBusSession(),
  });
  const url = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';
  const token = process.env.NODE_AGENT_TOKEN?.trim() || 'demo-token';
  try {
    await host.start(url, token);
  } catch (error: unknown) {
    console.error(
      `shell failed to join ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  console.log(`shell: joined ${url}`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await host.stop();
}

if (invokedAsProgram()) {
  await runProgram();
  process.exit(0);
}
