// Where the shell's two settings live: in this process for as long as the tenant's service does, and
// somewhere durable for longer than that. A `ShellService` is made once per tenant and holds one of
// these, so the copy a capability reads is the copy the page just saved.
//
// **The two settings are persisted in two different places, on purpose.**
//
//   1. The capability switches are this node's own state, so this node keeps them itself: one file per
//      tenant under the node-agent home (`nodeAgentHome()` / `nodeAgentDir('shell')` from the SDK), at
//
//        <node-agent-home>/shell/tenants/<tenant-key>/permissions.json
//        { version: 1, rules: [{ cap, callers }] }
//
//      `<node-agent-home>` is `$NODE_AGENT_HOME` when it is set, else `~/.node_agent`. The `<tenant-key>`
//      is the tenant name made into one safe path segment (`a/b` and `a b` may not become a directory
//      traversal, or share a file whose switches are somebody else's) -- the readable part of the name,
//      cut short, plus twelve hex characters of its SHA-256. Two tenants therefore always get two
//      files: a shell is one per tenant in a process, and one tenant's switches are never another's.
//
//   2. The user's custom commands are still filed with the history node, under `shell.custom_commands`
//      (`{ version: 1, commands: [...] }`), exactly as before: what moved off the history node here is
//      the *permissions*, and the commands were not part of that. Moving them is a separate change.
//
// **A read that fails fails open, loudly.** These switches are the user's preference, not a sandbox
// (see `policy.ts`), and a shell whose permissions file is corrupt must still run the command the user
// is watching -- so an unreadable or malformed file means "nothing is switched off", and the page is
// told why instead of the caller being handed an error about a settings file. A file that is simply
// *not there yet* is not a failure: nobody has saved anything, which is the same as allowing
// everything, and warning about it would put a warning on every fresh install. A *write* that fails
// keeps the new value in memory (the switch the user just flipped does work) and answers with
// `persisted: false` and the reason, so the page can say "saved here, not saved for the next restart".
//
// Writes are atomic: the new file is written beside the old one and renamed over it, so a process that
// dies mid-save leaves the previous switches intact rather than half a JSON document.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { nodeAgentDir, type NodeContext } from '@node-agent/sdk';
import { CustomCommands, PermissionPolicy } from './policy.js';

/** The unit the user's custom commands are filed in: the history node, unchanged by this change. */
export const COMMANDS_UNIT = 'shell.custom_commands';

/** One tenant's part of a path: readable, one segment, and unique. `agent/../..` and `agent ..` both
 *  become names of their own rather than reaching outside the shell's directory, and the digest keeps
 *  two tenants that slug alike apart. */
export function tenantKey(tenant: string): string {
  const slug = tenant
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 48);
  const digest = createHash('sha256').update(tenant).digest('hex').slice(0, 12);
  return `${slug === '' ? 'tenant' : slug}-${digest}`;
}

/** Where one tenant's capability switches are kept: a file of this node's own, not a history unit. */
export function permissionsFile(tenant: string, home = nodeAgentDir('shell')): string {
  return join(home, 'tenants', tenantKey(tenant), 'permissions.json');
}

/** A history unit as the history capability answers with it. */
type UnitAnswer = { unit?: { meta?: unknown; revision?: unknown } };

/** How one saved value went: `persisted` says it is stored, `error` says why not. */
export type SaveResult = { persisted: boolean; error: string | null };

/** One tenant's settings, with the copy in memory that every call reads. */
export class ShellSettings {
  readonly tenant: string;

  /** This tenant's permissions file: under the node-agent home, resolved when the tenant's shell is
   *  made, so a host that set `NODE_AGENT_HOME` in its own environment is honoured. */
  readonly permissionsPath: string;

  private policyCache: PermissionPolicy | null = null;
  private policyProblem: string | null = null;

  private commandsCache: CustomCommands | null = null;
  private commandsProblem: string | null = null;
  private commandsRevision: number | null = null;

  constructor(tenant: string, home = nodeAgentDir('shell')) {
    this.tenant = tenant;
    this.permissionsPath = permissionsFile(tenant, home);
  }

  /** Why the switches in force are not the ones the file holds, or null. Shown, never thrown. */
  get policyWarning(): string | null {
    return this.policyProblem;
  }

  get commandsWarning(): string | null {
    return this.commandsProblem;
  }

  /** The switches in force, read from this tenant's file on first use. `reload` forgets what this
   *  process knows and reads the file again -- the page's Refresh, or a second shell in the process. */
  async policy(options: { reload?: boolean } = {}): Promise<PermissionPolicy> {
    if (options.reload === true) {
      this.policyCache = null;
      this.policyProblem = null;
    }
    if (this.policyCache !== null) return this.policyCache;

    try {
      const saved = JSON.parse(await readFile(this.permissionsPath, 'utf8'));
      this.policyCache = PermissionPolicy.from(saved);
      this.policyProblem = null;
    } catch (error) {
      // Fail open: an unconfigured shell is what this node was before the page existed. The file is
      // named in the warning, because the reader who has to fix it is a person with a text editor.
      this.policyCache = PermissionPolicy.empty();
      this.policyProblem = absent(error) ? null : `${this.permissionsPath}: ${message(error)}`;
    }
    return this.policyCache;
  }

  /** The switches, saved: memory first, then this tenant's file. */
  async savePolicy(policy: PermissionPolicy): Promise<SaveResult> {
    this.policyCache = policy;
    this.policyProblem = null;
    try {
      await writeAtomic(this.permissionsPath, `${JSON.stringify(policy.toMeta(), null, 2)}\n`);
      return { persisted: true, error: null };
    } catch (error) {
      this.policyProblem = message(error);
      return { persisted: false, error: this.policyProblem };
    }
  }

  /** The user's commands, read from history on first use. */
  async commands(ctx: NodeContext, options: { reload?: boolean } = {}): Promise<CustomCommands> {
    if (options.reload === true) {
      this.commandsCache = null;
      this.commandsProblem = null;
      this.commandsRevision = null;
    }
    if (this.commandsCache !== null) return this.commandsCache;

    try {
      const units = await read(ctx, COMMANDS_UNIT);
      this.commandsCache = CustomCommands.from(units.meta);
      this.commandsRevision = units.revision;
      this.commandsProblem = null;
    } catch (error) {
      // No commands to fall back to: an empty list, and the page says why it is empty.
      this.commandsCache = CustomCommands.empty();
      this.commandsProblem = message(error);
    }
    return this.commandsCache;
  }

  /** The commands, saved: memory first, then history. */
  async saveCommands(ctx: NodeContext, commands: CustomCommands): Promise<SaveResult> {
    this.commandsCache = commands;
    this.commandsProblem = null;
    try {
      this.commandsRevision = await write(
        ctx,
        COMMANDS_UNIT,
        commands.toMeta(),
        this.commandsRevision,
      );
      return { persisted: true, error: null };
    } catch (error) {
      this.commandsProblem = message(error);
      return { persisted: false, error: this.commandsProblem };
    }
  }
}

/** One file written whole, or not at all: beside the target, then renamed over it. The mode keeps a
 *  user's switches out of other eyes on a shared host, and a failed write leaves no temp file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });

  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** One unit read, with the revision it came at (so a later save can say which version it replaces). */
async function read(
  ctx: NodeContext,
  unit: string,
): Promise<{ meta: unknown; revision: number | null }> {
  try {
    const answer = await ctx.call<UnitAnswer>('history', 'load', { unitId: unit });
    const revision = answer?.unit?.revision;
    return {
      meta: answer?.unit?.meta,
      revision: typeof revision === 'number' ? revision : null,
    };
  } catch (error) {
    // The one refusal that is an answer: nobody has saved this unit yet.
    if (/does not exist/i.test(message(error))) return { meta: undefined, revision: null };
    throw error;
  }
}

async function write(
  ctx: NodeContext,
  unit: string,
  meta: unknown,
  revision: number | null,
): Promise<number | null> {
  const answer = await ctx.call<UnitAnswer>('history', 'save', {
    unitId: unit,
    meta,
    ...(revision === null ? {} : { expectedRevision: revision }),
  });
  const saved = answer?.unit?.revision;
  return typeof saved === 'number' ? saved : revision;
}

/** Nobody has saved anything yet: not a failure, just the default. */
function absent(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
