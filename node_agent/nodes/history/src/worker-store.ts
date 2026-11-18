// The same SQLite store, off the event loop.
//
// A history server holds one file for a whole fleet: the synchronous store it used to open would block
// the one thread that answers HTTP for as long as a query took, and every read queued behind every
// other read. This backend keeps the store exactly as it is — SqliteHistoryStore is still the only
// thing that touches the file, and is still what a local history node opens — and moves it into
// worker threads:
//
//   * one writer, which runs load / save / delete / usage / reset, so writes are serial by
//     construction: one thread takes them in the order they arrived, and its transactions are
//     committed before it answers;
//   * N readers (NODE_AGENT_HISTORY_READERS, two by default), which run load / list / usage / ping on
//     connections opened with `PRAGMA query_only`, round-robin, so reads run beside each other instead
//     of behind each other.
//
// The main thread only ever posts a message and waits for the one that answers it: a request id, a
// promise, and a queue with a ceiling — a store that is asked for more than it can hold refuses with
// HistoryQueueFullError (503) rather than growing until the process does. WAL is what makes the read
// side correct as well as fast: a reader's every statement opens a fresh read transaction, so it sees
// exactly what the writer has committed, and save / delete answer only after their commit.
//
// Only the server uses this (serve.ts): a local history node keeps opening SqliteHistoryStore directly,
// where a synchronous answer is the right one and a thread would be one more thing to own.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  HistoryQueueFullError,
  defaultHistoryPath,
  type HistoryStore,
  type HistoryUsage,
  type PersistentUnit,
  type PersistentUnitSummary,
} from './store.ts';
import {
  restoreError,
  type WorkerData,
  type WorkerMessage,
  type WorkerOperation,
  type WorkerRequest,
  type WorkerRole,
} from './worker-protocol.ts';

/** Two readers is what a two-core machine can use: one more thread than the writer, which is where a
 *  read stops having to wait for another read. More than that only contends for one file. */
export const DEFAULT_READER_COUNT = 2;

/** The most readers this will open, whatever it is told: a typo in an environment variable should be
 *  a small number of threads, not a hundred. */
export const MAX_READER_COUNT = 4;

/** How many requests one worker may have waiting before it refuses with HistoryQueueFullError. The
 *  request bodies are what this bounds, so it is also the memory a busy store can hold. */
export const DEFAULT_QUEUE_LIMIT = 256;

/** How long a worker gets to close its database and leave before it is ended. */
const STOP_TIMEOUT_MS = 2000;

/** How many readers to open: NODE_AGENT_HISTORY_READERS, else two, never above MAX_READER_COUNT. */
export function defaultReaderCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NODE_AGENT_HISTORY_READERS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_READER_COUNT;
  const wanted = Number(raw);
  if (!Number.isInteger(wanted) || wanted < 1) return DEFAULT_READER_COUNT;
  return Math.min(wanted, MAX_READER_COUNT);
}

export type WorkerHistoryStoreOptions = {
  /** The SQLite file every worker opens. Defaults to the one a local history node uses. */
  path?: string;
  /** How many reader workers; defaults to `defaultReaderCount()`. */
  readers?: number;
  /** How many requests one worker may have waiting; defaults to DEFAULT_QUEUE_LIMIT. */
  queueLimit?: number;
  /** The script a worker runs. Left out it is the one next to this file — see `defaultWorkerUrl`. */
  workerUrl?: URL;
};

/** One promise waiting on one worker reply. */
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A worker thread and everything waiting on it. */
type Slot = {
  readonly role: WorkerRole;
  readonly thread: Worker;
  readonly pending: Map<number, Pending>;
  /** Settles when the worker has opened its database and is ready — or with why it could not. */
  readonly ready: Promise<void>;
  readonly resolveReady: () => void;
  readonly rejectReady: (error: Error) => void;
  /** True once it has left, on purpose or not: nothing more is posted to it. */
  stopped: boolean;
};

/** Where a worker script is. Built, it is `sqlite-worker.js` beside this file; run from the sources (a
 *  test, or history-serve started from the deploy tree) Node strips the types of `sqlite-worker.ts`
 *  instead, and the file names its imports with the extension it has on disk. */
function defaultWorkerUrl(): URL {
  const built = new URL('./sqlite-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(built))) return built;
  return new URL('./sqlite-worker.ts', import.meta.url);
}

export class WorkerHistoryStore implements HistoryStore {
  /** How many readers this store opened: what `NODE_AGENT_HISTORY_READERS` was turned into. */
  readonly readerCount: number;
  readonly queueLimit: number;

  private readonly path: string;
  private readonly workerUrl: URL;
  private readonly writer: Slot;
  private readonly readers: Slot[];
  /** Resolves once the readers were started — after the writer had the schema in place. */
  private readonly openReaders: Promise<void>;
  /** Where the round robin is: the next request for a read starts looking here. */
  private nextReader = 0;
  private lastId = 0;
  private closed = false;
  private stopping: Promise<void> | null = null;

  constructor(options: WorkerHistoryStoreOptions = {}) {
    this.path = options.path ?? defaultHistoryPath();
    if (this.path === ':memory:') {
      // Each thread would open a database of its own, and the writer's units would never be visible to
      // a reader: one file on disk is the whole premise. A test that wants speed uses a temporary file.
      throw new Error(
        'a worker history store needs a file: every worker thread would get its own :memory: database',
      );
    }
    this.queueLimit = Math.max(1, Math.floor(options.queueLimit ?? DEFAULT_QUEUE_LIMIT));
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();

    // The writer opens the file and migrates it; the readers open the same file only after that,
    // because a reader may not create a table and refuses a schema it was not built for. Until they
    // are there a read goes to the writer, which is the same file — never to a thread that is not up.
    this.writer = this.open('writer');
    const wanted = Math.max(1, Math.floor(options.readers ?? defaultReaderCount()));
    this.readerCount = Math.min(wanted, MAX_READER_COUNT);
    this.readers = [];
    this.openReaders = this.writer.ready
      .then(async () => {
        if (this.closed) return;
        for (let at = 0; at < this.readerCount; at += 1) this.readers.push(this.open('reader'));
        // A reader that cannot open is not waited for here: `fail` has already told whoever asks for
        // one, and the writer still answers.
        await Promise.all(this.readers.map((slot) => slot.ready.catch(() => {})));
      })
      .catch(() => {});
  }

  async load(user: string, node: string, unit: string): Promise<PersistentUnit | null> {
    return this.request<PersistentUnit | null>(this.reader(), { op: 'load', user, node, unit });
  }

  async save(
    user: string,
    node: string,
    unit: string,
    meta: unknown,
    expectedRevision?: number,
  ): Promise<PersistentUnit> {
    return this.request<PersistentUnit>(this.writer, {
      op: 'save',
      user,
      node,
      unit,
      meta,
      expectedRevision,
    });
  }

  async delete(user: string, node: string, unit: string, expectedRevision: number): Promise<void> {
    await this.request(this.writer, { op: 'delete', user, node, unit, expectedRevision });
  }

  async list(user: string, node: string): Promise<PersistentUnitSummary[]> {
    return this.request<PersistentUnitSummary[]>(this.reader(), { op: 'list', user, node });
  }

  async usage(user: string): Promise<HistoryUsage> {
    return this.request<HistoryUsage>(this.reader(), { op: 'usage', user });
  }

  async reset(user: string, node: string): Promise<number> {
    return this.request<number>(this.writer, { op: 'reset', user, node });
  }

  /** A `SELECT 1` on a read-only connection: what /healthz asks instead of a query over somebody's
   *  units, so a probe costs a statement and never a scan. */
  async ping(): Promise<void> {
    await this.request(this.reader(), { op: 'ping' });
  }

  /** Resolves once the writer has the file open and migrated and every reader has opened it too: a
   *  caller that wants to know the store is usable (a server before it listens) awaits this. It
   *  rejects when the writer could not open the database at all. */
  async ready(): Promise<void> {
    await this.writer.ready;
    await this.openReaders;
  }

  /** Release every worker. The contract's `close` returns at once; a caller that owns the process
   *  awaits `shutdown()` so a commit that is still being flushed is not cut off by an exit. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.shutdown();
  }

  /** Stop every worker and wait for each to close its database and leave. Idempotent: the second
   *  caller waits on the same stop. */
  shutdown(): Promise<void> {
    this.closed = true;
    this.stopping ??= Promise.all([this.writer, ...this.readers].map((slot) => this.stop(slot))).then(
      () => undefined,
    );
    return this.stopping;
  }

  /** A new worker, and the promise that says it is ready once the thread has posted `ready`. */
  private open(role: WorkerRole): Slot {
    const thread = new Worker(this.workerUrl, {
      workerData: { role, path: this.path } satisfies WorkerData,
      // A worker that cannot start is a store that cannot answer: the error goes to the request that
      // needed it, not to an uncaught exception in a process that is still serving other requests.
      name: `history-${role}`,
    });
    let resolveReady = () => {};
    let rejectReady = (_error: Error) => {};
    const opened = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const slot: Slot = {
      role,
      thread,
      pending: new Map(),
      ready: opened,
      resolveReady,
      rejectReady,
      stopped: false,
    };
    // Nobody may be waiting for `ready` yet (a worker that dies before the first request would
    // otherwise be an unhandled rejection); the request that does wait gets the error.
    slot.ready.catch(() => {});
    thread.on('message', (message: WorkerMessage) => this.onMessage(slot, message));
    thread.on('error', (error: Error) => this.fail(slot, error));
    thread.on('exit', (code: number) =>
      this.fail(slot, new Error(`the history ${role} worker stopped (exit ${code})`)),
    );
    return slot;
  }

  private onMessage(slot: Slot, message: WorkerMessage): void {
    if (message.type === 'ready') {
      slot.resolveReady();
      return;
    }
    if (message.type === 'fatal') {
      slot.rejectReady(restoreError(message.error));
      return;
    }
    const waiting = slot.pending.get(message.id);
    if (waiting === undefined) return;
    slot.pending.delete(message.id);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(restoreError(message.error));
  }

  /** A worker that is gone — closed on purpose, or thrown out of: nothing waits on it any more, and
   *  nothing is posted to it, so a caller gets an error instead of a promise that never settles. */
  private fail(slot: Slot, error: Error): void {
    if (slot.stopped) return;
    slot.stopped = true;
    slot.rejectReady(error);
    const waiting = [...slot.pending.values()];
    slot.pending.clear();
    for (const one of waiting) one.reject(error);
  }

  /** One post, one answer. The ceiling is checked once the worker is up and before anything is posted,
   *  so a store already holding it refuses here at once instead of growing a list of requests nobody
   *  has started. */
  private async request<R>(slot: Slot, operation: WorkerOperation): Promise<R> {
    if (this.closed) throw new Error('the history store is closed');
    if (slot.stopped) throw new Error(`the history ${slot.role} worker is not running`);
    await slot.ready;
    // Counted here and not before the wait: a caller that arrived while the worker was still opening
    // its database is waiting too, and a burst that entered together is exactly the burst this
    // ceiling is for.
    if (this.closed) throw new Error('the history store is closed');
    if (slot.stopped) throw new Error(`the history ${slot.role} worker is not running`);
    if (slot.pending.size >= this.queueLimit) {
      throw new HistoryQueueFullError(
        `history ${slot.role} is busy: ${slot.pending.size} requests are already waiting ` +
          `(limit ${this.queueLimit})`,
      );
    }
    const id = (this.lastId += 1);
    const answered = new Promise<unknown>((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
    });
    slot.thread.postMessage({ ...operation, id } satisfies WorkerRequest);
    return (await answered) as R;
  }

  /** Round robin over the readers that are still there; a store whose readers have all gone still
   *  answers from the writer, because it is the same file and a slow read beats no read. */
  private reader(): Slot {
    const count = this.readers.length;
    for (let step = 0; step < count; step += 1) {
      const at = (this.nextReader + step) % count;
      const slot = this.readers[at] as Slot;
      if (!slot.stopped) {
        this.nextReader = (at + 1) % count;
        return slot;
      }
    }
    return this.writer;
  }

  /** Ask one worker to close its database and leave, and wait until it has — so a stop is finished
   *  business for whoever awaited it, and still bounded: a worker that will not leave is ended. */
  private async stop(slot: Slot): Promise<void> {
    const running = !slot.stopped;
    this.fail(slot, new Error('the history store is closed'));
    const thread = slot.thread;
    const finished = new Promise<void>((resolve) => {
      const hurry = setTimeout(() => void thread.terminate().catch(() => {}), STOP_TIMEOUT_MS);
      thread.once('exit', () => {
        clearTimeout(hurry);
        resolve();
      });
    });
    if (running) {
      try {
        thread.postMessage({ id: 0, op: 'close' });
      } catch {
        void thread.terminate().catch(() => {});
      }
    } else {
      void thread.terminate().catch(() => {});
    }
    await finished;
  }
}
