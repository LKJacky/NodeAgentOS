// The thread that owns the SQLite file.
//
// One of these is the writer: it opens the database for writing, brings an old schema up to date, and
// runs every transaction — so writes stay serial however many callers the server has, because there is
// one thread to take them in the order they arrived. The rest are readers: the same SqliteHistoryStore
// with `readOnly` set, which is `PRAGMA query_only` on its own connection to the same file. A read
// therefore never waits for the writer to finish anything but a commit, and — the point of the whole
// file — never blocks the event loop of the process answering HTTP, because it is not that process.
//
// The protocol is worker-protocol.ts. A message is answered by exactly one message, and the operations
// are synchronous SQLite calls taken one at a time off this thread's port: the port is the queue.
import { parentPort, workerData } from 'node:worker_threads';
import { SqliteHistoryStore } from './store.ts';
import {
  serializeError,
  type WorkerData,
  type WorkerMessage,
  type WorkerRequest,
} from './worker-protocol.ts';

const port = parentPort;
if (port === null) throw new Error('the history sqlite worker must be started as a thread');

const { role, path } = workerData as WorkerData;

function post(message: WorkerMessage): void {
  port?.postMessage(message);
}

/** Opening here, before `ready`, is what makes an unopenable path or a newer schema one message to
 *  the main thread instead of a request that never answers. */
let store: SqliteHistoryStore | null;
try {
  store = new SqliteHistoryStore(path, { readOnly: role === 'reader' });
} catch (error) {
  post({ type: 'fatal', error: serializeError(error) });
  throw error;
}

/** One request, one answer. Each operation is a synchronous SQLite call, so the order the port hands
 *  them over is the order they run in — which is what keeps the writer's transactions serial. */
function answer(request: WorkerRequest): unknown {
  const database = store;
  if (database === null) throw new Error('this history worker has already closed its database');
  switch (request.op) {
    case 'load':
      return database.load(request.user, request.node, request.unit);
    case 'save':
      return database.save(
        request.user,
        request.node,
        request.unit,
        request.meta,
        request.expectedRevision,
      );
    case 'delete':
      database.delete(request.user, request.node, request.unit, request.expectedRevision);
      return null;
    case 'list':
      return database.list(request.user, request.node);
    case 'usage':
      return database.usage(request.user);
    case 'reset':
      return database.reset(request.user, request.node);
    case 'ping':
      database.ping();
      return null;
    case 'close':
      return null;
  }
}

/** Closing is the one request that ends this thread: the database goes first — so every committed
 *  transaction is on disk before the answer leaves — and then the port is told to let go of the event
 *  loop, which leaves this thread nothing to do and it exits by itself. */
function closeAndLeave(id: number): void {
  try {
    store?.close();
    store = null;
    post({ type: 'reply', id, ok: true, result: null });
  } finally {
    port?.off('message', onMessage);
    port?.unref();
  }
}

function onMessage(request: WorkerRequest): void {
  if (request.op === 'close') {
    closeAndLeave(request.id);
    return;
  }
  try {
    post({ type: 'reply', id: request.id, ok: true, result: answer(request) });
  } catch (error) {
    // A refusal is an answer: the classes the caller knows (conflict, not found, limit) travel by
    // name, so a server can turn them into the statuses it already answers with.
    post({ type: 'reply', id: request.id, ok: false, error: serializeError(error) });
  }
}

port.on('message', onMessage);
post({ type: 'ready' });
