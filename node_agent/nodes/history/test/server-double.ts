// The server this package's HTTP client is written against, as a test double. The deployment's own
// history server is a separate product; what lives here is the wire between the two, and only that:
//
//     GET    /v1/units?node=<n>                            -> { units: [{ unitId, revision, createdAt, updatedAt }] }
//     GET    /v1/units/<node>/<unit>                        -> { unit: PersistentUnit | null }
//     PUT    /v1/units/<node>/<unit>                        -> { unit: PersistentUnit }
//                body { meta, expectedRevision? }
//     DELETE /v1/units/<node>/<unit>?expectedRevision=<n>   -> { deleted: true }
//
// The bearer token names the user, and a refusal carries the code the client turns back into the same
// error class a local store throws: `conflict` for a stale writer, `not_found` for a unit that is not
// there. A request without a token is refused: units are private, and the token is what says whose.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RevisionConflictError, UnitNotFoundError, type HistoryStore } from '../src/index.ts';

type Answer = { status: number; body: unknown };

function json(status: number, body: unknown): Answer {
  return { status, body };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The body of one request, as text: a PUT carries its unit in it. */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** A history server over any store: the units of every user, kept by the store it is handed. */
export class HistoryServer {
  readonly store: HistoryStore;
  readonly #server: Server;

  constructor(options: { store: HistoryStore }) {
    this.store = options.store;
    this.#server = createServer((request, response) => {
      void (async () => {
        const body = await bodyOf(request);
        const answer = await this.#handle(request, body);
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      })().catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: messageOf(error), code: 'failed' }));
      });
    });
  }

  async listen(port = 0): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(port, '127.0.0.1', resolve));
    const address = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** One request: the token picks the user, and the path picks the unit. */
  async #handle(request: IncomingMessage, body: string): Promise<Answer> {
    const presented = request.headers.authorization;
    const match = presented === undefined ? null : /^Bearer\s+(.+)$/.exec(presented.trim());
    const user = match?.[1];
    if (user === undefined) return json(401, { error: 'a bearer token names the user' });

    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://history.test');
    const parts = url.pathname.split('/').filter((part) => part !== '');
    if (parts[0] !== 'v1' || parts[1] !== 'units') return json(404, { error: 'no such route' });

    if (parts.length === 2) {
      if (method !== 'GET') return json(405, { error: `${method} is not allowed here` });
      const node = url.searchParams.get('node');
      if (node === null) return json(400, { error: 'list wants a node' });
      return json(200, { units: await this.store.list(user, node) });
    }

    if (parts.length !== 4) return json(404, { error: 'no such route' });
    const node = decodeURIComponent(parts[2] as string);
    const unit = decodeURIComponent(parts[3] as string);
    try {
      if (method === 'GET') return json(200, { unit: await this.store.load(user, node, unit) });
      if (method === 'PUT') {
        const sent = JSON.parse(body === '' ? '{}' : body) as {
          meta?: unknown;
          expectedRevision?: unknown;
        };
        const expected =
          typeof sent.expectedRevision === 'number' ? sent.expectedRevision : undefined;
        return json(200, { unit: await this.store.save(user, node, unit, sent.meta, expected) });
      }
      if (method === 'DELETE') {
        const expected = Number(url.searchParams.get('expectedRevision'));
        await this.store.delete(user, node, unit, expected);
        return json(200, { deleted: true });
      }
      return json(405, { error: `${method} is not allowed here` });
    } catch (error) {
      if (error instanceof RevisionConflictError)
        return json(409, { error: messageOf(error), code: 'conflict' });
      if (error instanceof UnitNotFoundError)
        return json(404, { error: messageOf(error), code: 'not_found' });
      throw error;
    }
  }
}
