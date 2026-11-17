// The settings an operator may change from this agent's page: what each one is, what it may be, and
// how a stored unit is turned back into values.
//
// Three rules this file keeps:
//
// - every field is read by code that was already here (the sub-agent cap, the per-turn input limit,
//   the compression pair the model compresses with, the size of the cache), so a field is never a
//   knob with nothing behind it;
// - a value that was not given means "whatever this deployment falls back to", which is why a save
//   stores only the fields it names: setting one field leaves the environment's default in force for
//   the others;
// - a value read back from history is checked exactly like one a caller sent, so a unit written by
//   hand, or by an older release, cannot put the agent in a state its own validation refuses.
import { DEFAULT_CACHE_SIZE } from './cache.js';
import { COMPRESSION_THRESHOLD, COMPRESSION_TOKENS } from './model.js';

/** The history unit one agent's settings live in. The runtime prefixes it for a sub-agent, so one
 *  identity's agents keep one set each (`agent.settings`, `sub.agent.settings`). */
export const SETTINGS_UNIT = 'agent.settings';

/** The version of the stored shape, so a later release can migrate what an older one wrote. */
export const SETTINGS_VERSION = 1;

/** Every setting in force for one agent. */
export type AgentSettings = {
  /** How many sub-agents this agent may have running at once. */
  maxAgents: number;
  /** One line longer than this is kept in the cache and handed to the model trimmed. */
  maxInputLengthPerTurn: number;
  /** Above this many tokens of prompt, the transcript starts to be compressed away: the oldest lines
   *  are summed up in a notice and forgotten, so one long conversation does not outgrow the window. */
  compressionThreshold: number;
  /** How many tokens one compression lets go of at once. */
  compressionTokens: number;
  /** How many long texts the cache keeps: one more than this deletes the oldest entry. */
  cacheSize: number;
  /** Whether the model is offered `create_agent` / `destroy_agent` at all. A sub-agent never is,
   *  whatever this says: an agent that was started by another may not start one of its own. */
  allowSpawn: boolean;
  /** Whether the model is offered `ask_user`. Off, a turn that has to ask a person ends with the
   *  tool's refusal instead of a question nobody is watching for. */
  allowAskUser: boolean;
};

/** What one save may name: every field, all optional, laid over what is already stored. */
export type SettingsPatch = {
  maxAgents?: number;
  maxInputLengthPerTurn?: number;
  compressionThreshold?: number;
  compressionTokens?: number;
  cacheSize?: number;
  allowSpawn?: boolean;
  allowAskUser?: boolean;
};

/** What a bus with no stored unit, and no environment saying otherwise, runs on. The compression pair
 *  and the cache size are the numbers the model and the cache were already built with, so a
 *  deployment that saves nothing behaves exactly as it did before these settings existed; the two
 *  switches are on, which is what an agent could do before they existed. */
export const DEFAULT_SETTINGS: AgentSettings = {
  maxAgents: 32,
  maxInputLengthPerTurn: 8192,
  compressionThreshold: COMPRESSION_THRESHOLD,
  compressionTokens: COMPRESSION_TOKENS,
  cacheSize: DEFAULT_CACHE_SIZE,
  allowSpawn: true,
  allowAskUser: true,
};

/** The whole numbers a setting accepts: the range is the one its own validation keeps it in, so a
 *  field can never be set to a number the code behind it would not survive. */
const NUMBERS: Record<string, { min: number; max: number }> = {
  maxAgents: { min: 1, max: 64 },
  maxInputLengthPerTurn: { min: 256, max: 1_000_000 },
  compressionThreshold: { min: 1_024, max: 1_000_000 },
  compressionTokens: { min: 256, max: 262_144 },
  cacheSize: { min: 1, max: 10_000 },
};

/** The settings a save may give as a key of their own: a value that is not `true` or `false` is
 *  refused, because there is nothing else a switch could mean. */
const BOOLEANS = ['allowSpawn', 'allowAskUser'] as const;

/** Every name a caller may use, for the sentence that refuses the one it did not. */
export const SETTINGS_NAMES: readonly string[] = [
  'maxAgents',
  'maxInputLengthPerTurn',
  'compressionThreshold',
  'compressionTokens',
  'cacheSize',
  'allowSpawn',
  'allowAskUser',
];

/** The settings that are in force from the next turn on: every one of them, because the runtime hands
 *  a saved value to the cache and to a model that was already built rather than waiting for a
 *  restart. */
export const LIVE_SETTINGS: readonly string[] = [...SETTINGS_NAMES];

/** Nothing here is read once and kept: a save reaches the components that use it, so no field needs
 *  a restart. The list stays in the answer so a page can say which fields need one. */
export const RESTART_REQUIRED_SETTINGS: readonly string[] = [];

/** A number the environment named, when it named a positive whole one: how a deployment sets the
 *  value a page starts from. */
export function envNumber(name: string): number | null {
  const value = Number(process.env[name] ?? '');
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** What a value looks like in a refusal: a caller that sent `"8"` is told it sent text, not a number. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return Array.isArray(value) ? 'a list' : 'an object';
}

/** The refusal for one whole number, or null when it is one this agent accepts. */
function numberProblem(name: string, value: unknown): string | null {
  const range = NUMBERS[name] as { min: number; max: number };
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return `${name} must be a whole number between ${range.min} and ${range.max} (got ${describe(value)})`;
  }
  if (value < range.min || value > range.max) {
    return `${name} must be between ${range.min} and ${range.max} (got ${value})`;
  }
  return null;
}

/** One of the plain numbers, written into a patch the compiler can see the shape of. */
function putNumber(
  values: SettingsPatch,
  name:
    | 'maxAgents'
    | 'maxInputLengthPerTurn'
    | 'compressionThreshold'
    | 'compressionTokens'
    | 'cacheSize',
  value: number,
): void {
  values[name] = value;
}

const PLAIN_NUMBERS = [
  'maxAgents',
  'maxInputLengthPerTurn',
  'compressionThreshold',
  'compressionTokens',
  'cacheSize',
] as const;

/**
 * One caller's arguments as a patch. `report` false is the read path: a value this release would
 * refuse to save is dropped quietly instead of being reported, so a unit written by hand falls back
 * to the deployment's default for that one field rather than failing the whole read.
 */
export function parseSettingsPatch(
  input: Record<string, unknown>,
  report: boolean,
): { values: SettingsPatch; problems: string[] } {
  const values: SettingsPatch = {};
  const problems: string[] = [];
  const reject = (problem: string): void => {
    if (report) problems.push(problem);
  };
  for (const [name, value] of Object.entries(input)) {
    if ((PLAIN_NUMBERS as readonly string[]).includes(name)) {
      const problem = numberProblem(name, value);
      if (problem !== null) reject(problem);
      else putNumber(values, name as (typeof PLAIN_NUMBERS)[number], value as number);
      continue;
    }
    if ((BOOLEANS as readonly string[]).includes(name)) {
      if (typeof value !== 'boolean') {
        reject(`${name} must be true or false (got ${describe(value)})`);
        continue;
      }
      values[name as (typeof BOOLEANS)[number]] = value;
      continue;
    }
    reject(`unknown setting "${name}"; this agent takes ${SETTINGS_NAMES.join(', ')}`);
  }
  return { values, problems };
}

/** `base` with `patch` laid over it, one field at a time: a field the patch does not name keeps the
 *  value `base` had, which is what makes a save of one field leave the others where they were. */
export function mergePatches(base: SettingsPatch, patch: SettingsPatch): SettingsPatch {
  return { ...base, ...patch };
}

/** One agent's settings: what this deployment falls back to, with the agent's own choices over it. */
export function effectiveSettings(base: AgentSettings, stored: SettingsPatch): AgentSettings {
  return {
    maxAgents: stored.maxAgents ?? base.maxAgents,
    maxInputLengthPerTurn: stored.maxInputLengthPerTurn ?? base.maxInputLengthPerTurn,
    compressionThreshold: stored.compressionThreshold ?? base.compressionThreshold,
    compressionTokens: stored.compressionTokens ?? base.compressionTokens,
    cacheSize: stored.cacheSize ?? base.cacheSize,
    allowSpawn: stored.allowSpawn ?? base.allowSpawn,
    allowAskUser: stored.allowAskUser ?? base.allowAskUser,
  };
}

/** The values one stored unit holds, checked the way a save is checked. */
export function readStoredSettings(meta: unknown): SettingsPatch {
  const unit = meta as { version?: unknown; values?: unknown } | null | undefined;
  const values = unit?.values;
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return {};
  return parseSettingsPatch(values as Record<string, unknown>, false).values;
}

/** The unit one save writes. */
export function settingsUnit(values: SettingsPatch): { version: number; values: SettingsPatch } {
  return { version: SETTINGS_VERSION, values };
}

/** How a history node says that someone else wrote first: the real one says `changed concurrently`, a
 *  store that has to answer over HTTP says the same thing, and a test's double says `conflict`. */
const CONFLICT = /conflict|concurrently|does not exist/i;

/** Whether a refused save was refused because the unit had moved on, rather than by a bug. */
export function isSettingsConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return CONFLICT.test(message);
}
