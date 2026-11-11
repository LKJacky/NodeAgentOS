// The network backend: a client for a history server — history-serve, which wraps the same SQLite
// store this package already had. Plain JSON over HTTP and nothing else, so a deployment gains a
// shared history without gaining a client library to keep in step with a server. The wire is small
// on purpose:
//
//     GET    /v1/units?node=<n>                           -> { units: [{ unitId, revision, createdAt, updatedAt }] }
//     GET    /v1/units/<node>/<unit>                       -> { unit: PersistentUnit | null }
//     PUT    /v1/units/<node>/<unit>                       -> { unit: PersistentUnit }
//                body { meta, expectedRevision? }
//     DELETE /v1/units/<node>/<unit>?expectedRevision=<n>  -> { deleted: true }
//
// There is no user anywhere in it: the bearer token names the user on the server, and that is the one
// identity a process cannot change by accident or on a caller's behalf. The `user` parameter of the
// HistoryStore methods is therefore accepted (the interface has it, and a local store needs it) and
// then dropped — one client is one identity.
//
// A refusal keeps the meaning it has locally: 409 (revision conflict) and 404 (no such unit) come back
// as the very error classes a SQLite store throws, so a caller above this file cannot tell which
// backend it is on — which is the point of the interface in store.ts.
import {
  RevisionConflictError,
  UnitNotFoundError,
  identifier,
  isRecord,
  positiveInteger,
  serializeMeta,
  type HistoryStore,
  type PersistentUnit,
  type PersistentUnitSummary,
} from './store.js';

/** How long one request may take before it is given up on. Without a limit a server that accepts a
 *  connection and then says nothing would hang the turn that is waiting for an answer. */
export const DEFAULT_HISTORY_TIMEOUT_MS = 30_000;

export type HttpHistoryStoreOptions = {
  /** The bearer token the server accepts for this user. There is no anonymous form: units are
   *  private, and this token is what says whose they are. */
  token?: string;
  /** Overrides DEFAULT_HISTORY_TIMEOUT_MS — a slow link or a test that means to see a timeout. */
  timeoutMs?: number;
  /** How many requests this store keeps in flight at once; sixteen unless the deployment says
   *  otherwise (NODE_AGENT_HISTORY_CONCURRENCY also works). */
  concurrency?: number;
};

/** One unit's path. Every name is encoded on its own, because a unit id is any name its owner chose —
 *  dots, slashes and question marks included — and the server decodes each segment on its way in. */
function unitPath(node: string, unit: string): string {
  return `/v1/units/${[node, unit].map((name) => encodeURIComponent(name)).join('/')}`;
}

/** A unit as the server sent it, or an error saying what it sent instead: an answer this package
 *  cannot read is worth a line naming the server, not a crash later in an agent. */
function unitOf(value: unknown, source: string): PersistentUnit {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !('meta' in value)
  ) {
    throw new Error(`${source} did not answer with a persistent unit`);
  }
  return value as PersistentUnit;
}

/** One row of `list`, checked the same way and for the same reason. */
function summaryOf(value: unknown, source: string): PersistentUnitSummary {
  if (
    !isRecord(value) ||
    typeof value.unitId !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new Error(`${source} did not answer with a unit summary`);
  }
  return {
    unitId: value.unitId,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** The history of one user, kept by a shared server. */
/** A counting semaphore: at most  holders at a time, in the order they asked. Nothing here
 *  knows what it guards - the store uses it to bound how many units one caller can ask for at once. */
class Semaphore {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.free = Math.max(1, Math.floor(size));
  }

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next === undefined) this.free += 1;
    else next();
  }
}

export class HttpHistoryStore implements HistoryStore {
  /** The server's base URL, without a trailing slash: `http://127.0.0.1:8791`. */
  readonly url: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly limit: Semaphore;

  constructor(url: string, options: HttpHistoryStoreOptions = {}) {
    const parsed = httpUrl(url);
    this.url = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    this.token = options.token?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
    this.limit = new Semaphore(
      options.concurrency ?? (Number(process.env.NODE_AGENT_HISTORY_CONCURRENCY ?? '') || 16),
    );
  }

  async load(_user: string, node: string, unit: string): Promise<PersistentUnit | null> {
    const path = unitPath(identifier(node, 'calling node name'), identifier(unit, 'unitId'));
    const answer = await this.request('GET', path);
    if (answer.unit === null) return null;
    return unitOf(answer.unit, `history server at ${this.url}`);
  }

  async save(
    _user: string,
    node: string,
    unit: string,
    meta: unknown,
    expectedRevision?: number,
  ): Promise<PersistentUnit> {
    const path = unitPath(identifier(node, 'calling node name'), identifier(unit, 'unitId'));
    // The value is checked here, not only on the server, so a value JSON cannot carry is refused with
    // the wording the local store uses instead of failing somewhere inside JSON.stringify below.
    const value = serializeMeta(meta);
    const expected =
      expectedRevision === undefined
        ? undefined
        : expectedRevision === 0
          ? 0
          : positiveInteger(expectedRevision, 'expectedRevision');
    const body =
      expected === undefined
        ? `{"meta":${value}}`
        : `{"meta":${value},"expectedRevision":${expected}}`;
    const answer = await this.request('PUT', path, body);
    return unitOf(answer.unit, `history server at ${this.url}`);
  }

  async delete(_user: string, node: string, unit: string, expectedRevision: number): Promise<void> {
    const path = unitPath(identifier(node, 'calling node name'), identifier(unit, 'unitId'));
    const expected = positiveInteger(expectedRevision, 'expectedRevision');
    await this.request('DELETE', `${path}?expectedRevision=${expected}`);
  }

  async list(_user: string, node: string): Promise<PersistentUnitSummary[]> {
    const query = new URLSearchParams({ node: identifier(node, 'calling node name') });
    const answer = await this.request('GET', `/v1/units?${query.toString()}`);
    if (!Array.isArray(answer.units)) {
      throw new Error(`history server at ${this.url} did not answer with a list of units`);
    }
    return answer.units.map((entry) => summaryOf(entry, `history server at ${this.url}`));
  }

  /** Nothing to release: the connection pool belongs to fetch, and it is shared with every other
   *  client in this process. */
  close(): void {}

  /** One request, one answer as a JSON object — or the error the server named. A status the wire
   *  defines as a refusal is rethrown as the same error class a local store throws. */
  private async request(
    method: string,
    path: string,
    body?: string,
  ): Promise<Record<string, unknown>> {
    // One request per unit, and a caller may ask for thousands at once: the socket budget is the
    // process's, not the caller's, so the store holds a ceiling of its own.
    await this.limit.acquire();
    try {
      return await this.send(method, path, body);
    } finally {
      this.limit.release();
    }
  }

  private async send(
    method: string,
    path: string,
    body?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    // This client belongs to one tenant; its token is that tenant identity on the server.
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const where = `${method} ${this.url}${path}`;
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`history request ${where} failed: ${reasonOf(error)}`, { cause: error });
    }

    const text = await response.text();
    const answer = objectOf(text);
    if (response.ok) return answer;

    const message =
      typeof answer.error === 'string' ? answer.error : text.trim() || `HTTP ${response.status}`;
    if (answer.code === 'conflict') throw new RevisionConflictError(message);
    if (answer.code === 'not_found') throw new UnitNotFoundError(message);
    throw new Error(`history request ${where} answered ${response.status}: ${message}`);
  }
}

/** The URL itself, once it is known to be one this client can talk to: an address whose scheme is
 *  not http(s) would otherwise fail on the first request, deep inside fetch, with a message about a
 *  protocol rather than about the setting someone mistyped. */
function httpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch (error) {
    throw new Error(`history server URL is not a URL: ${JSON.stringify(url)}`, { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `history server URL must be http:// or https:// (TLS ends in front of the server), ` +
        `not ${JSON.stringify(url)}`,
    );
  }
  return parsed;
}

/** An answer body as an object. A body that is not JSON is an empty object: the status and the text
 *  are what an error message is made of then, and an answer that is fine is JSON by construction. */
function objectOf(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    // A timeout names itself: "The operation was aborted due to timeout". Say which side gave up.
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'gave up waiting';
    return error.message;
  }
  return String(error);
}
