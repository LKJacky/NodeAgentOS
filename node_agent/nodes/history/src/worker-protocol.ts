// What the main thread and a SQLite worker say to each other, and nothing else: one request shape, one
// reply shape, and the three lines that carry an error across the boundary. A worker thread shares the
// process's memory but not its objects, so what crosses is a plain value — the name of the error, so
// the main thread can hand the caller the very class it would have caught locally, and its message.
//
// Imports name the `.ts` file: this module is loaded by a thread that runs the sources as they are
// (a test, or history-serve started the way the deploy tree starts it) as well as from `dist`, and
// `tsc` rewrites the extension on the way out (see tsconfig.json, rewriteRelativeImportExtensions).
import {
  RevisionConflictError,
  StorageLimitError,
  UnitNotFoundError,
  type PersistentUnit,
  type PersistentUnitSummary,
} from './store.ts';

/** Which half of the store a worker is: the one that writes, or one of the ones that only reads. */
export type WorkerRole = 'writer' | 'reader';

/** The one thing a worker needs to know before it opens anything. */
export type WorkerData = { role: WorkerRole; path: string };

/** Everything a worker can be asked, without the id that says which answer this is. */
export type WorkerOperation =
  | { op: 'load'; user: string; node: string; unit: string }
  | {
      op: 'save';
      user: string;
      node: string;
      unit: string;
      meta: unknown;
      expectedRevision?: number;
    }
  | { op: 'delete'; user: string; node: string; unit: string; expectedRevision: number }
  | { op: 'list'; user: string; node: string }
  | { op: 'usage'; user: string }
  | { op: 'reset'; user: string; node: string }
  | { op: 'ping' }
  /** Close the database and leave: the last thing a worker is asked. */
  | { op: 'close' };

export type WorkerRequest = WorkerOperation & { id: number };

/** An error as it travels: the class is not cloned, so its name travels beside its message. */
export type SerializedError = { name: string; message: string };

/** What a worker posts to the main thread: that it opened the database, that it could not, and one
 *  reply per request. */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'fatal'; error: SerializedError }
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: SerializedError };

/** The names the classes below are known by on the other side. They do not set `name` themselves —
 *  they are told apart by class — so the class is what says which name travels. */
const SHIPPED_NAMES = new Map<unknown, string>([
  [RevisionConflictError, 'RevisionConflictError'],
  [UnitNotFoundError, 'UnitNotFoundError'],
  [StorageLimitError, 'StorageLimitError'],
]);

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: SHIPPED_NAMES.get(error.constructor) ?? error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}

/** The classes a caller has to be able to tell apart, by the name they travelled under. Anything else
 *  comes back as an Error that keeps its name, which is what a SQLite failure of its own looks like. */
const ERROR_CLASSES: Record<string, new (message: string) => Error> = {
  RevisionConflictError,
  UnitNotFoundError,
  StorageLimitError,
};

export function restoreError(serialized: SerializedError): Error {
  const Known = ERROR_CLASSES[serialized.name];
  if (Known !== undefined) return new Known(serialized.message);
  const error = new Error(serialized.message);
  error.name = serialized.name;
  return error;
}
