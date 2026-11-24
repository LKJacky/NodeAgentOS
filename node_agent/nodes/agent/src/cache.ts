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

export const CACHE_UNIT = 'cache';

/** How many entries a cache keeps when neither the environment (`NODE_AGENT_CACHE_SIZE`) nor the
 *  agent's `cacheSize` setting names another number. */
export const DEFAULT_CACHE_SIZE = 500;

/** How long one regex search may run before it is stopped, in milliseconds. */
export const SEARCH_TIMEOUT_MS = Number(process.env.NODE_AGENT_CACHE_SEARCH_TIMEOUT ?? '1') * 1000;

export type CacheMatch = { entry: number; position: number; text: string };

/** The history node's surface, as this package uses it. A bus without history makes a cache that
 *  holds nothing but still answers, which is what a deployment with no history node gets. */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

import { RE2JS } from 're2js';

import type { BindingScope } from '@node-agent/sdk';
import { cacheCounter, cacheEntry } from './storage.js';
import { isHigh, isLow } from './helpers.js';

/** Where this process' `re2js` is, so the worker -- source, not a file -- loads the same copy. */
const RE2JS_PATH = createRequire(import.meta.url).resolve('re2js');

/** One slice of a cache entry: the text, how long the whole entry is, and the window this read
 *  covers. A model reading a long text a page at a time needs the first two to know where it is. */
export interface CacheSlice {
  /** The characters `start ... start+length` of the entry. */
  text: string;
  /** Characters in the whole entry. */
  total: number;
  /** Where the slice starts in the entry. */
  start: number;
  /** Characters in the slice. */
  length: number;
}

/** `text` from `start` to `end`, never cut between the two halves of a surrogate pair: an edge that
 *  would leave a lone half moves in by one unit instead. */
function windowOf(text: string, start: number, end: number): string {
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (from > 0 && from < text.length && isLow(text.charCodeAt(from))) from += 1;
  if (to > 0 && to < text.length && isHigh(text.charCodeAt(to - 1))) to -= 1;
  return text.slice(from, to);
}

/** One search, in a thread that can be killed when the budget runs out.
 *
 *  The worker is source rather than a file so it loads the same way from `src` (tests run the TS
 *  through a loader) and from `dist`. It answers either the matches or the reason it could not
 *  compile the pattern; nothing else crosses back.
 *
 *  The pattern is compiled with `re2js` (RE2 syntax): a match over a hundred kilobytes of text a
 *  user did not write is linear, which is what keeps `(a+)+$` from pinning a core. The thread is
 *  still killed at the budget -- a second line of defence behind the engine, not a replacement for
 *  it. */
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { RE2JS } = require(workerData.re2js);

// A window that never leaves half a surrogate pair at an edge (the same rule as \`windowOf\`).
const high = (u) => u >= 0xd800 && u <= 0xdbff;
const low = (u) => u >= 0xdc00 && u <= 0xdfff;
const windowOf = (text, start, end) => {
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (from > 0 && from < text.length && low(text.charCodeAt(from))) from += 1;
  if (to > 0 && to < text.length && high(text.charCodeAt(to - 1))) to -= 1;
  return text.slice(from, to);
};

parentPort.on('message', ({ text, pattern, context }) => {
  try {
    const matcher = RE2JS.compile(pattern).matcher(text);
    const matches = [];
    // Every match, in order, advanced the way String.prototype.matchAll advances: a match that
    // consumed something continues after it, and an empty one moves on by a single UTF-16 unit --
    // which is what keeps the empty match at the end of the text as one of the answers.
    let from = 0;
    while (from <= text.length && matcher.find(from)) {
      const at = matcher.start();
      const end = matcher.end();
      matches.push({ position: at, text: windowOf(text, at - context, end + context) });
      from = end > at ? end : at + 1;
    }
    parentPort.postMessage({ matches });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
`;

/** Run one search in its own thread; answers its matches or throws the budget's error. */
async function searchInThread(
  text: string,
  pattern: string,
  context: number,
  timeoutMs: number,
  id: number,
): Promise<CacheMatch[]> {
  const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { re2js: RE2JS_PATH } });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const answer = await Promise.race([
      new Promise<{ matches?: Omit<CacheMatch, 'entry'>[]; error?: string }>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
        worker.postMessage({ text, pattern, context });
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `pattern took longer than ${timeoutMs / 1000}s on cache entry ${id}; use a simpler pattern`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    if (answer.error !== undefined) throw new Error(answer.error);
    return (answer.matches ?? []).map((match) => ({ entry: id, ...match }));
  } finally {
    if (timer !== null) clearTimeout(timer);
    // Whether it answered, failed, or was killed for running long: the thread is done either way.
    void worker.terminate();
  }
}

export class Cache {
  /** How many entries are kept. Not readonly: a saved `cacheSize` is put in force on a cache that was
   *  already built (`setMaxSize`). */
  #maxSize: number;
  #scope: BindingScope | null;
  #prefix: string;
  /** How many texts have ever been added: the number `add` returned for the last one. */
  #total = 0;
  readonly #log: (line: string) => void;

  constructor(
    maxSize: number,
    scope: BindingScope | null = null,
    prefix = '',
    log: (line: string) => void = (line) => console.error(line),
  ) {
    if (maxSize < 1) throw new Error('cache size must be at least 1');
    this.#maxSize = maxSize;
    this.#scope = scope;
    this.#prefix = prefix;
    this.#log = log;
  }

  /** How many entries this cache keeps now. */
  get maxSize(): number {
    return this.#maxSize;
  }

  /** Put a new cap in force, letting go of what is already past it. The runtime calls this when an
   *  operator saves `cacheSize`, so a shrunken cap is the one the next turn runs on rather than one
   *  the next `add` eventually catches up with. */
  async setMaxSize(maxSize: number): Promise<void> {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
      throw new Error('cache size must be a whole number of at least 1');
    }
    this.#maxSize = maxSize;
    const held = await this.ids();
    const drop = held.length - maxSize;
    for (const id of held.slice(0, Math.max(0, drop))) await this.delete(id);
  }

  /** Attach the bus this cache stores on, or detach it, without losing the counter. */
  useScope(scope: BindingScope | null, prefix = ''): void {
    this.#scope = scope;
    this.#prefix = prefix;
  }

  get enabled(): boolean {
    return this.#scope !== null;
  }

  /** The ids history holds now, oldest first (the newest is last). */
  async ids(): Promise<number[]> {
    if (this.#scope === null) return [];
    const numbers: number[] = [];
    for (let id = 1; id <= this.#total; id += 1) {
      if ((await this.#loadEntry(id)) !== null) numbers.push(id);
    }
    return numbers;
  }

  /** Read the counter back from history, so a restart does not reuse an id. A missing counter falls
   *  back to the highest `cache.<n>` unit, and an unreadable history is a fresh cache. */
  async restore(): Promise<void> {
    if (this.#scope === null) return;
    try {
      const unit = cacheCounter(this.#scope, this.#prefix);
      await unit.load();
      if (typeof unit.meta.total === 'number' && Number.isSafeInteger(unit.meta.total)) {
        this.#total = Math.max(this.#total, unit.meta.total);
      }
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

  /** The slice `start ... start+length` of entry `id` (`length === null`: through the end), with
   *  the entry's whole length and the window it covers. `null` means history does not hold that
   *  entry. */
  async read(id: number, start = 0, length: number | null = null): Promise<CacheSlice | null> {
    const text = await this.#loadEntry(id);
    if (text === null) return null;
    if (start < 0 || (length !== null && length < 0)) {
      throw new Error('start and length must not be negative');
    }
    const slice = length === null ? text.slice(start) : text.slice(start, start + length);
    return { text: slice, total: text.length, start, length: slice.length };
  }

  /** Find `pattern` (an RE2-syntax regular expression, via `re2js`) in entry `id`, with `context`
   *  characters on each side.
   *
   *  The match runs in a thread of its own and the budget is enforced by killing that thread. The
   *  engine is already linear (no backtracking, so `(a+)+b` over a megabyte is not a hang) and the
   *  thread is the second line of defence behind it: a match is not interruptible from the outside,
   *  so a search that somehow runs long is stopped by terminating the thread rather than by asking
   *  it to stop. */
  async search(
    id: number,
    pattern: string,
    context = 100,
    timeoutMs: number = SEARCH_TIMEOUT_MS,
  ): Promise<CacheMatch[]> {
    if (context < 0) throw new Error('context must not be negative');
    if (timeoutMs <= 0) throw new Error('timeout must be positive');
    try {
      RE2JS.compile(pattern);
    } catch (error) {
      throw new Error(
        `pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const slice = await this.read(id);
    if (slice === null) return [];
    return await searchInThread(slice.text, pattern, context, timeoutMs, id);
  }

  async delete(id: number): Promise<void> {
    if (this.#scope === null) return;
    try {
      const unit = cacheEntry(this.#scope, this.#prefix, id);
      await unit.load();
      if (unit.revision > 0) await unit.delete();
    } catch (error) {
      this.#log(`cannot delete cache entry ${id}: ${String(error)}`);
    }
  }

  async #saveEntry(id: number, text: string): Promise<void> {
    if (this.#scope === null) return;
    try {
      const unit = cacheEntry(this.#scope, this.#prefix, id);
      unit.meta = { text, length: text.length };
      await unit.save();
    } catch (error) {
      // A cache write may not fail a turn.
      this.#log(`cannot write cache entry ${id}: ${String(error)}`);
    }
  }

  async #saveTotal(): Promise<void> {
    if (this.#scope === null) return;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const unit = cacheCounter(this.#scope, this.#prefix);
        await unit.load();
        unit.meta = { total: this.#total };
        try {
          await unit.save();
          return;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    } catch (error) {
      // A lost counter is one line, not a failed turn.
      this.#log(`cannot write the cache counter: ${String(error)}`);
    }
  }

  async #loadEntry(id: number): Promise<string | null> {
    if (this.#scope === null) return null;
    try {
      const unit = cacheEntry(this.#scope, this.#prefix, id);
      await unit.load();
      return unit.revision > 0 && typeof unit.meta.text === 'string' ? unit.meta.text : null;
    } catch {
      return null;
    }
  }
}
