// The two things a user can decide about this node, as data: which of its capabilities a caller may
// use, and the commands the user keeps on it. Nothing here touches a file or a bus — the shapes are
// parsed, asked and serialized, and both `settings.ts` (which keeps the switches in this tenant's own
// file, and the commands in a history unit) and the capabilities in `index.ts` read the same objects.
//
// **The switches are a preference, not a boundary.** `exec` already reaches the whole machine, and
// `read` / `write` were never confined to the workspace, so a shell that has never been configured
// allows everything — the default is what this node did before there was a page. A switch that is
// off is enforced by *this* node, before the capability runs, and the refusal names the caller.
// The boundary that holds against a hostile caller is still the container's (`doc/node_agent/shell-safety.md`)
// and, later, the bus-wide permission check in `system.permissions` — which is why the saved shape is
// a rule list of callers rather than a boolean: `{ cap, callers }` is a row that store can host as it
// is, with `target` being the name this node registers under.
import { SESSION_MAX_MS } from './sessions.js';

/** Everyone, in a caller list. A rule that carries it is a rule for no one in particular. */
export const ANYONE = '*';

/** A capability name, as the bus names them. */
const CAP_NAME = /^[a-z][a-z0-9-]*$/;

/** Who may call one capability. Empty is nobody; `['*']` is everybody; names are bus node names. */
export type Callers = readonly string[];

/** One capability's rule, as the page and a future bus check both read it. */
export type CapabilityRule = {
  cap: string;
  callers: string[];
};

/** The unit's shape on disk. `version` is written so a later reader can tell a rule list it does not
 *  understand from one it does; an older unit without it is read as version 1. */
export type PermissionUnit = {
  version: 1;
  rules: CapabilityRule[];
};

function capName(value: unknown): string {
  if (typeof value !== 'string' || !CAP_NAME.test(value))
    throw new Error(`a capability name is [a-z][a-z0-9-]*, not ${JSON.stringify(value)}`);

  return value;
}

function callerList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('callers must be a list of node names');

  return value.map((caller: unknown) => {
    if (typeof caller !== 'string' || caller.trim() === '')
      throw new Error('a caller is a non-empty node name');
    return caller.trim();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The switches in force: one rule per restricted capability, and no rule at all for a capability
 *  the user never touched. Immutable — `withCaps` / `withCallers` answer a new set — so a save that
 *  the disk refuses never leaves the running shell half-changed. */
export class PermissionPolicy {
  private readonly rules: Map<string, string[]>;

  private constructor(rules: Map<string, string[]>) {
    this.rules = rules;
  }

  /** Nothing restricted: the behaviour of a shell nobody has configured. */
  static empty(): PermissionPolicy {
    return new PermissionPolicy(new Map());
  }

  /** What a saved unit says. Three shapes are understood, because a unit outlives the code that
   *  wrote it and a hand-written one should not be a startup failure:
   *
   *  - `{ rules: [{ cap, callers }] }` — what this file writes, and what `system.permissions` stores;
   *  - `{ caps: { exec: false } }` — the form the page's switches take;
   *  - `{ exec: false }` — a bare boolean map. */
  static from(meta: unknown): PermissionPolicy {
    if (meta === null || meta === undefined) return PermissionPolicy.empty();
    if (!isRecord(meta)) throw new Error('the saved shell permission unit is not an object');

    const rules = new Map<string, string[]>();

    if (meta.rules !== undefined) {
      if (!Array.isArray(meta.rules))
        throw new Error('the saved shell permission unit has no rules list');
      for (const rule of meta.rules) {
        if (!isRecord(rule)) throw new Error('a saved shell permission rule is not an object');
        rules.set(capName(rule.cap), callerList(rule.callers));
      }
    }

    // `caps` is the page's form; the bare map is what `caps` looks like once the unit is a plain
    // object. Only booleans are read here — a rule list is the shape that can name callers.
    const caps =
      meta.caps !== undefined
        ? meta.caps
        : meta.rules === undefined
          ? Object.fromEntries(Object.entries(meta).filter(([key]) => key !== 'version'))
          : undefined;
    if (caps !== undefined) {
      if (!isRecord(caps)) throw new Error('caps must be an object of capability switches');
      for (const [cap, allowed] of Object.entries(caps)) {
        if (typeof allowed !== 'boolean') continue;
        const name = capName(cap);
        if (allowed) rules.delete(name);
        else rules.set(name, []);
      }
    }

    return new PermissionPolicy(rules);
  }

  /** Capabilities with a rule; the rest are allowed. */
  get size(): number {
    return this.rules.size;
  }

  /** Who may call one capability: `undefined` when there is no rule (allowed), else the list. */
  callersOf(cap: string): string[] | undefined {
    const found = this.rules.get(cap);
    return found === undefined ? undefined : [...found];
  }

  /** Whether `from` may call `cap`. A rule for someone else is a refusal, not a fallback. */
  allows(cap: string, from: string): boolean {
    const callers = this.rules.get(cap);
    if (callers === undefined) return true;
    if (callers.includes(ANYONE)) return true;
    return callers.includes(from);
  }

  /** The switch's position: may an ordinary caller use this capability? A rule that only names a few
   *  callers leaves the switch off — that is what the page shows, and what it would overwrite. */
  enabled(cap: string): boolean {
    const callers = this.rules.get(cap);
    return callers === undefined || callers.includes(ANYONE);
  }

  /** One rule replaced. `null` removes the rule, which is the same as allowing everyone. */
  withCallers(cap: string, callers: Callers | null): PermissionPolicy {
    const name = capName(cap);
    const next = new Map(this.rules);
    if (callers === null || callers.includes(ANYONE)) next.delete(name);
    else next.set(name, callerList(callers));
    return new PermissionPolicy(next);
  }

  /** The page's own form: a boolean per capability. `true` drops the rule instead of writing
   *  `['*']`, so an unconfigured capability stays unconfigured and the unit holds only refusals. */
  withCaps(caps: Record<string, boolean>): PermissionPolicy {
    const next = new Map(this.rules);
    for (const [cap, allowed] of Object.entries(caps)) {
      if (typeof allowed !== 'boolean')
        throw new Error(`${JSON.stringify(cap)} is a switch: true (allowed) or false (refused)`);
      const name = capName(cap);
      if (allowed) next.delete(name);
      else next.set(name, []);
    }
    return new PermissionPolicy(next);
  }

  /** The unit as it is saved. */
  toMeta(): PermissionUnit {
    return {
      version: 1,
      rules: [...this.rules.entries()].map(([cap, callers]) => ({ cap, callers: [...callers] })),
    };
  }
}

/** What one custom command is. The arguments a caller passes are *not* part of it: they reach the
 *  script as its argv, never pasted into `command`. */
export type CustomCommand = {
  /** The handle the page edits and deletes by. Made from the name when the command is added, and
   *  kept when the name changes, so a link to a command survives a rename. */
  id: string;
  /** What `run-custom` names. Unique on this node, and what the script sees as `$0` / `SHELL_CUSTOM_NAME`. */
  name: string;
  description: string;
  /** A `/bin/sh` script, run with `-c` exactly as written. */
  command: string;
  /** Where it runs: resolved like `exec`'s `cwd`, from the workspace unless it is absolute. */
  cwd?: string;
  /** Its own deadline, under the session ceiling. `run-custom` may pass one for a single call. */
  timeoutMs?: number;
  /** Extra variable names to hand the command from the shell's own environment, on top of the short
   *  list every command gets (`sessions.ts`). Never `NODE_AGENT_*`: see `environment()` below. */
  env?: string[];
};

/** The unit's shape on disk. */
export type CommandsUnit = {
  version: 1;
  commands: CustomCommand[];
};

/** A command name: what a caller types, and what becomes `$0`. Kept to one unquoted word. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A variable name a script may be handed. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A saved id: the name's slug, so it is safe in a URL fragment and in a row's `data-id`. */
const COMMAND_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Characters of one script. A script is a snippet the user saved, not a file. */
const MAX_COMMAND_CHARS = 16_384;

/** Variables one command may name. */
export const MAX_ENV_NAMES = 32;

/** Words one `run-custom` call may pass. */
export const MAX_CUSTOM_ARGS = 64;

/** Commands one shell keeps. A page listing more than this is a page nobody reads. */
export const MAX_CUSTOM_COMMANDS = 100;

/** What a command may not name: the bus's own credential family. `exec` hands a command a short
 *  whitelist of variables and nothing else (`sessions.ts` says why), and `run-node` adds the two a
 *  local node needs on purpose. A user naming more variables for one command is that same deliberate
 *  act — but `NODE_AGENT_*` is the family that walks off with the bus, and no command definition is
 *  a good place to say that. */
const WITHHELD_PREFIX = 'NODE_AGENT_';

/** The variables a command gets from the shell's own environment: only the ones it named, and only
 *  the ones that are set. A name that is not set is not an error — the script's own `:-` default is
 *  the better place to decide what a missing variable means. */
export function environment(names: readonly string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** The word the script sees as `$0`: it says which command ran, and it is not an argument. */
export function argvName(command: CustomCommand): string {
  return `shell-custom:${command.name}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A comma-separated string or a list, as the names a command asked for. */
function envNames(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const listed = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(listed)) throw new Error('env must be a list of variable names');

  const names: string[] = [];
  for (const item of listed) {
    if (typeof item !== 'string') throw new Error('env must be a list of variable names');
    const name = item.trim();
    if (name === '') continue;
    if (!ENV_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a variable name`);
    if (name.startsWith(WITHHELD_PREFIX))
      throw new Error(
        `env may not name ${name}: ${WITHHELD_PREFIX}* is the shell's own credential family and no command is handed it`,
      );
    if (!names.includes(name)) names.push(name);
  }

  if (names.length > MAX_ENV_NAMES) throw new Error(`env names at most ${MAX_ENV_NAMES} variables`);
  return names.length === 0 ? undefined : names;
}

/** A positive whole number of milliseconds, or undefined when it was not given. */
function timeoutField(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const ms = typeof value === 'string' ? Number(value) : value;
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0)
    throw new Error('timeoutMs must be a positive whole number of milliseconds');
  if (ms > SESSION_MAX_MS)
    throw new Error(`timeoutMs is at most ${SESSION_MAX_MS} ms (the ceiling on any one command)`);
  return ms;
}

/** One command from the wire (or from history), validated. `existing` is the command an update
 *  replaces: its id stays, and its name is free even when nothing else changed. */
function normalizeCommand(
  input: unknown,
  options: { id?: string; taken?: (name: string) => boolean } = {},
): CustomCommand {
  if (!isRecord(input)) throw new Error('a custom command is an object with a name and a command');

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!COMMAND_NAME.test(name))
    throw new Error(
      `a command name is 1-64 letters, digits, dot, dash or underscore, starting with a letter or digit (got ${JSON.stringify(input.name)})`,
    );
  if (options.taken?.(name) === true)
    throw new Error(`there is already a custom command named ${JSON.stringify(name)}`);

  const command = typeof input.command === 'string' ? input.command : '';
  if (command.trim() === '') throw new Error('a custom command needs a command: the script to run');
  if (command.length > MAX_COMMAND_CHARS)
    throw new Error(`a custom command is at most ${MAX_COMMAND_CHARS} characters`);

  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const cwd = stringField(input.cwd)?.trim();
  const timeoutMs = timeoutField(input.timeoutMs);
  const env = envNames(input.env);

  return {
    id: options.id ?? slugOf(name),
    name,
    description,
    command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(env === undefined ? {} : { env }),
  };
}

/** A name as an id: what a command is filed under when nobody said. A name that slugs to nothing
 *  (all punctuation) still has to produce something usable. */
function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 64);
  return slug === '' ? 'command' : slug;
}

/** The commands a user keeps on this shell, as a list that answers a new list for every change — the
 *  same reason `PermissionPolicy` is immutable: a save history refuses leaves nothing half-done. */
export class CustomCommands {
  private readonly items: readonly CustomCommand[];

  private constructor(items: readonly CustomCommand[]) {
    this.items = items;
  }

  static empty(): CustomCommands {
    return new CustomCommands([]);
  }

  /** What a saved unit says. An entry this build cannot read is dropped rather than failing the
   *  whole list: one broken row must not hide the commands that are still fine. */
  static from(meta: unknown): CustomCommands {
    if (meta === null || meta === undefined) return CustomCommands.empty();
    if (!isRecord(meta)) throw new Error('the saved custom command unit is not an object');
    if (meta.commands === undefined) return CustomCommands.empty();
    if (!Array.isArray(meta.commands))
      throw new Error('the saved custom command unit has no commands list');

    const kept: CustomCommand[] = [];
    for (const entry of meta.commands) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === 'string' && COMMAND_ID.test(entry.id) ? entry.id : undefined;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (kept.some((command) => command.name === name)) continue;
      try {
        kept.push(normalizeCommand({ ...entry, id: undefined }, id === undefined ? {} : { id }));
      } catch {
        continue;
      }
    }
    return new CustomCommands(kept);
  }

  get size(): number {
    return this.items.length;
  }

  /** Every command, in the order they were added. */
  list(): CustomCommand[] {
    return this.items.map((command) => ({ ...command }));
  }

  /** One command by name, or failing that by id — a caller (and a page link) may have either. */
  find(nameOrId: string): CustomCommand | undefined {
    const wanted = nameOrId.trim();
    const found =
      this.items.find((command) => command.name === wanted) ??
      this.items.find((command) => command.id === wanted);
    return found === undefined ? undefined : { ...found };
  }

  /** One more command. A name already in use is refused: names are how `run-custom` finds a command,
   *  so two of them would make the caller's answer depend on the order of the list. */
  add(input: unknown): CustomCommands {
    if (this.items.length >= MAX_CUSTOM_COMMANDS)
      throw new Error(`this shell keeps at most ${MAX_CUSTOM_COMMANDS} custom commands`);

    const command = normalizeCommand(input, {
      taken: (name) => this.items.some((kept) => kept.name === name),
    });
    command.id = this.uniqueId(command.id);
    return new CustomCommands([...this.items, command]);
  }

  /** One command changed in place: the id is the handle and never changes, the name may. */
  update(nameOrId: string, input: unknown): CustomCommands {
    const at = this.indexOf(nameOrId);
    const before = this.items[at];
    if (before === undefined)
      throw new Error(`no custom command ${JSON.stringify(nameOrId)}: see shell.custom-commands`);

    const command = normalizeCommand(input, {
      id: before.id,
      taken: (name) => this.items.some((kept) => kept.name === name && kept.id !== before.id),
    });
    const next = [...this.items];
    next[at] = command;
    return new CustomCommands(next);
  }

  /** One command deleted. Named by id or by name; a name that is not there is an error, so a click
   *  that raced someone else's delete says so instead of quietly doing nothing. */
  remove(nameOrId: string): CustomCommands {
    const at = this.indexOf(nameOrId);
    if (at === -1)
      throw new Error(`no custom command ${JSON.stringify(nameOrId)}: see shell.custom-commands`);
    return new CustomCommands(this.items.filter((_, index) => index !== at));
  }

  toMeta(): CommandsUnit {
    return { version: 1, commands: this.list() };
  }

  private indexOf(nameOrId: string): number {
    const wanted = nameOrId.trim();
    const byName = this.items.findIndex((command) => command.name === wanted);
    return byName === -1 ? this.items.findIndex((command) => command.id === wanted) : byName;
  }

  /** The slug, or the slug with a number after it: two commands may slug alike without sharing a
   *  name (`a b` and `a-b`). */
  private uniqueId(base: string): string {
    let candidate = base;
    let suffix = 2;
    while (this.items.some((command) => command.id === candidate)) {
      candidate = `${base}-${suffix++}`;
    }
    return candidate;
  }
}
