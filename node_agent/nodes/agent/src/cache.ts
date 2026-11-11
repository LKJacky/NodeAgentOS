// A bounded list of long texts the agent kept instead of sending.
//
// A tool answer, a pasted file or a log can be a hundred kilobytes on one line, and one line like
// that can spend a whole turn's budget on itself. The line is not thrown away: it goes here, and the
// model is handed its head and tail plus the entry number to read the rest with `read_cache`.
//
// Nothing lives in the process: each entry is one history unit `cache.<id>`, and the counter that
// numbers them is a unit of its own (`cache`, meta `{"total": n}`), so a read is a history read and
// a restart continues from the same units. `maxSize` is the number of entries kept: adding one past
// it deletes the oldest unit from history.
import type { BindingScope } from '@node-agent/sdk';

export const CACHE_UNIT = 'cache';

/** How long one regex search may run before it is stopped, in milliseconds. */
export const SEARCH_TIMEOUT_MS = Number(process.env.NODE_AGENT_CACHE_SEARCH_TIMEOUT ?? '1') * 1000;

export type CacheMatch = { entry: number; position: number; text: string };

/** The history node's surface, as this package uses it. A bus without history makes a cache that
 *  holds nothing but still answers, which is what a deployment with no history node gets. */
export interface CacheHistory {
  load(unitId: string): Promise<{ meta?: unknown; revision?: number } | null>;
  save(unitId: string, meta: unknown, expectedRevision?: number): Promise<number | null>;
  remove(unitId: string): Promise<void>;
  /** Every unit history holds for this caller, with the revision a delete can name. */
  units(): Promise<{ unitId: string; revision?: number }[]>;
}

/**
 * The history node, addressed the way the Python twin addresses it.
 *
 * History files a unit under the *calling node*, and every agent of one identity shares that caller:
 * the main agent and each of its sub-agents. `prefix` is what keeps their units apart — `''` for the
 * main agent, `sub.<name>.` for a sub-agent — so one identity holds one transcript per agent instead
 * of one shared transcript, and a sub-agent's `conversation.0` is not the main agent's.
 */
export function historyOverBus(bus: BindingScope, prefix = ''): CacheHistory {
  const at = (unitId: string): string => `${prefix}${unitId}`;
  return {
    async load(unitId) {
      const reply = await bus.call<{ unit: { meta?: unknown; revision?: number } | null }>(
        'history',
        'load',
        { unitId: at(unitId) },
      );
      return reply.unit ?? null;
    },
    async save(unitId, meta, expectedRevision) {
      const reply = await bus.call<{ unit: { revision?: number } | null }>('history', 'save', {
        unitId: at(unitId),
        meta,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      });
      return reply.unit?.revision ?? null;
    },
    async remove(unitId) {
      await bus.call('history', 'delete', { unitId: at(unitId) });
    },
    async units() {
      const reply = await bus.call<{ units?: unknown }>('history', 'list', {});
      const units = reply?.units;
      if (!Array.isArray(units)) return [];
      return units.filter(
        (unit): unit is { unitId: string; revision?: number } =>
          typeof unit === 'object' &&
          unit !== null &&
          typeof (unit as { unitId?: unknown }).unitId === 'string',
      );
    },
  };
}

export class Cache {
  readonly maxSize: number;
  #history: CacheHistory | null;
  /** How many texts have ever been added: the number `add` returned for the last one. */
  #total = 0;
  /** The revision of the counter unit, so a write can name what it replaces. */
  #totalRevision: number | undefined;
  readonly #log: (line: string) => void;

  constructor(
    maxSize: number,
    history: CacheHistory | null,
    log: (line: string) => void = (line) => console.error(line),
  ) {
    if (maxSize < 1) throw new Error('cache size must be at least 1');
    this.maxSize = maxSize;
    this.#history = history;
    this.#log = log;
  }

  /** Forget the history node (or attach one) without losing the counter. */
  useHistory(history: CacheHistory | null): void {
    this.#history = history;
  }

  get enabled(): boolean {
    return this.#history !== null;
  }

  /** The ids history holds now, oldest first (the newest is last). */
  async ids(): Promise<number[]> {
    if (this.#history === null) return [];
    const numbers: number[] = [];
    for (let id = 1; id <= this.#total; id += 1) {
      if ((await this.#loadEntry(id)) !== null) numbers.push(id);
    }
    return numbers;
  }

  /** Read the counter back from history, so a restart does not reuse an id. A missing counter falls
   *  back to the highest `cache.<n>` unit, and an unreadable history is a fresh cache. */
  async restore(): Promise<void> {
    if (this.#history === null) return;
    try {
      const unit = await this.#history.load(CACHE_UNIT);
      const meta = unit?.meta as { total?: unknown } | undefined;
      if (typeof meta?.total === 'number' && Number.isSafeInteger(meta.total)) {
        this.#total = Math.max(this.#total, meta.total);
      }
      if (typeof unit?.revision === 'number') this.#totalRevision = unit.revision;
    } catch {
      // No counter is a fresh cache.
    }
  }

  /** Write one text as its own unit and return its id, deleting the oldest past `maxSize`. */
  async add(text: string): Promise<number> {
    this.#total += 1;
    const id = this.#total;
    await this.#saveEntry(id, text);
    await this.#saveTotal();
    const expired = id - this.maxSize;
    if (expired >= 1) await this.delete(expired);
    return id;
  }

  /** The slice `start ... start+length` of entry `id` (`length === null`: through the end). `null`
   *  means history does not hold that entry. */
  async read(id: number, start = 0, length: number | null = null): Promise<string | null> {
    const text = await this.#loadEntry(id);
    if (text === null) return null;
    if (start < 0 || (length !== null && length < 0)) {
      throw new Error('start and length must not be negative');
    }
    return length === null ? text.slice(start) : text.slice(start, start + length);
  }

  /** Find `pattern` (a regular expression) in entry `id`, with `context` characters on each side. */
  async search(
    id: number,
    pattern: string,
    context = 100,
    timeoutMs: number = SEARCH_TIMEOUT_MS,
  ): Promise<CacheMatch[]> {
    if (context < 0) throw new Error('context must not be negative');
    if (timeoutMs <= 0) throw new Error('timeout must be positive');
    let compiled: RegExp;
    try {
      compiled = new RegExp(pattern, 'g');
    } catch (error) {
      throw new Error(
        `pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await this.read(id);
    if (text === null) return [];

    const matches: CacheMatch[] = [];
    const deadline = Date.now() + timeoutMs;
    for (const match of text.matchAll(compiled)) {
      const at = match.index ?? 0;
      const start = Math.max(0, at - context);
      const end = Math.min(text.length, at + match[0].length + context);
      matches.push({ entry: id, position: at, text: text.slice(start, end) });
      // A catastrophic pattern cannot be interrupted inside one `exec`, but a long list of matches
      // can, and that is the case this budget is for.
      if (Date.now() > deadline) {
        throw new Error(
          `pattern took longer than ${timeoutMs / 1000}s on cache entry ${id}; use a simpler pattern`,
        );
      }
    }
    return matches;
  }

  async delete(id: number): Promise<void> {
    if (this.#history === null) return;
    try {
      await this.#history.remove(`${CACHE_UNIT}.${id}`);
    } catch (error) {
      this.#log(`cannot delete cache entry ${id}: ${String(error)}`);
    }
  }

  async #saveEntry(id: number, text: string): Promise<void> {
    if (this.#history === null) return;
    try {
      await this.#history.save(`${CACHE_UNIT}.${id}`, { text, length: text.length });
    } catch (error) {
      // A cache write may not fail a turn.
      this.#log(`cannot write cache entry ${id}: ${String(error)}`);
    }
  }

  async #saveTotal(): Promise<void> {
    if (this.#history === null) return;
    try {
      const revision = await this.#history.save(
        CACHE_UNIT,
        { total: this.#total },
        this.#totalRevision,
      );
      if (revision !== null) this.#totalRevision = revision;
    } catch (error) {
      // A lost counter is one line, not a failed turn.
      this.#log(`cannot write the cache counter: ${String(error)}`);
    }
  }

  async #loadEntry(id: number): Promise<string | null> {
    if (this.#history === null) return null;
    try {
      const unit = await this.#history.load(`${CACHE_UNIT}.${id}`);
      const meta = unit?.meta as { text?: unknown } | undefined;
      return typeof meta?.text === 'string' ? meta.text : null;
    } catch {
      return null;
    }
  }
}
