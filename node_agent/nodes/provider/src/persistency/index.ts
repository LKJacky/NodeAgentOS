// Where the provider rows live.
//
// The node has one question - "which rows were saved" - and two answers, because it has two addresses:
// `provider` serves a whole bus, so its rows belong to that bus's history, while `local-provider` is
// this stack's own endpoint and its credentials belong on this machine, in a file. Both answers are
// this interface, so the manager never learns which one it was given; the choice is made once, in
// `providerStore`, from the mode `mode.ts` read.
import type { NodeContext } from '@node-agent/sdk';
import type { JsonObject } from '../providers/base.js';
import { HistoryStore } from './history.js';
import { LocalStore } from './local.js';

/** One provider row, exactly as its `dump()` wrote it. */
export type ProviderRow = JsonObject;
export type ProviderRows = Record<string, ProviderRow>;

export interface ProviderStore {
  /** Whether the rows may be expected to survive this process; the page shows it as `persistent`. */
  persistent: boolean;

  /** The rows that were saved, or null when nothing has been saved yet. */
  read(): Promise<ProviderRows | null>;

  /** Replace the saved rows with these. */
  write(rows: ProviderRows): Promise<void>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A provider name, as a row key and as a caller spells it. */
export function validateName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!NAME.test(name))
    throw new Error('provider name must use 1-64 letters, numbers, underscores, or hyphens');
  return name;
}

/** The rows a saved document holds, refusing anything that is not an object of objects.
 *
 * Shared by both stores: history and the file hold the same document, so a file that was hand-edited
 * into nonsense is refused with the same sentence a history unit would be.
 */
export function rowsIn(configs: unknown): ProviderRows {
  if (
    configs !== undefined &&
    configs !== null &&
    (typeof configs !== 'object' || Array.isArray(configs))
  )
    throw new Error('saved providers must be an object');
  const rows: ProviderRows = {};
  for (const [name, config] of Object.entries((configs as JsonObject | undefined) ?? {})) {
    if (config === null || typeof config !== 'object' || Array.isArray(config))
      throw new Error(`provider "${name}" config must be an object`);
    rows[validateName(name)] = config as ProviderRow;
  }
  return rows;
}

/** The store this process answers with: the file `configPath` names, or the bus's history. */
export function providerStore(ctx: NodeContext, configPath: string | null): ProviderStore {
  return configPath === null ? new HistoryStore(ctx) : new LocalStore(configPath);
}
