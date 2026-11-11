// The runtime API: a small HTTP surface over the Runtime interface.
//
// The server owns no process table of its own; it forwards every request to the Runtime it was
// constructed with. That keeps the transport (HTTP) separate from the policy (who may start what),
// and lets one Runtime be used in-process by tests and out-of-process by a service entry.
//
// Authentication is a service bearer token. A runtime is not a public API: callers are a frontend
// or a store, both of which already hold a service credential.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Link, Remote } from 'node-agent-bus';
import { createHash } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import {
  RuntimeError,
  type BusHandle,
  type NodeHandle,
  type Runtime,
  type RuntimeLogger,
} from './base.js';

export interface RuntimeApiOptions {
  runtime: Runtime;
  /** Required service token. `Authorization: Bearer <token>`. */
  token: string;
  host?: string;
  port?: number;
  logger?: RuntimeLogger;
}

export interface RuntimeApiAddress {
  host: string;
  port: number;
  url: string;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const pieces: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += piece.length;
    if (size > 64 * 1024) throw new RuntimeError('invalid_user', 'request body is too large');
    pieces.push(piece);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(pieces).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('body must be a JSON object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new RuntimeError(
      'invalid_user',
      `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new RuntimeError('invalid_user', `body.${field} must be a non-empty string`);
  return value.trim();
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function busView(handle: BusHandle): Record<string, unknown> {
  return {
    kind: 'bus',
    host: handle.host,
    port: handle.port,
    url: handle.url,
    pid: handle.pid ?? null,
    state: handle.state,
  };
}

function nodeView(handle: NodeHandle): Record<string, unknown> {
  return {
    kind: 'node',
    name: handle.name,
    version: handle.version,
    dir: handle.dir,
    pid: handle.pid ?? null,
    state: handle.state,
  };
}

function statusOf(error: RuntimeError): number {
  switch (error.code) {
    case 'invalid_user':
    case 'invalid_node':
      return 400;
    case 'bus_not_running':
    case 'node_not_running':
      return 404;
    case 'spawn_failed':
    case 'bus_start_failed':
    case 'node_start_failed':
      return 502;
    default:
      return 500;
  }
}

/** The HTTP runtime service. `start()` binds; `stop()` releases the socket. */
export class RuntimeServer {
  private readonly runtime: Runtime;
  private readonly token: string;
  private readonly host: string;
  private readonly port: number;
  private readonly logger?: RuntimeLogger;
  private server: ReturnType<typeof createServer> | undefined;
  private address: RuntimeApiAddress | undefined;

  constructor(options: RuntimeApiOptions) {
    if (options.token.trim() === '')
      throw new RuntimeError('invalid_user', 'a runtime server needs a service token');
    this.runtime = options.runtime;
    this.token = options.token;
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.logger = options.logger;
  }

  get url(): string | undefined {
    return this.address?.url;
  }

  async start(): Promise<RuntimeApiAddress> {
    if (this.server !== undefined) return this.address!;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      void this.upgrade(req, socket as Socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : this.port;
    this.server = server;
    this.address = { host: this.host, port, url: `http://${this.host}:${port}` };
    this.logger?.info(`runtime api: ${this.address.url}`);
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    this.address = undefined;
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const prefix = 'Bearer ';
    return header.startsWith(prefix) && equal(header.slice(prefix.length), this.token);
  }

  private stackNodes(): string[] {
    const raw =
      process.env.NODE_AGENT_RUNTIME_NODES ??
      'history,agent,system,provider,notes,todo,timer,search,webui';
    return raw
      .split(',')
      .map((one) => one.trim())
      .filter((one) => one !== '');
  }

  /** A private WebSocket door onto the one shared bus. */
  private async upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://runtime.local');
    const match = /^\/bus\/([^/]+)$/.exec(url.pathname);
    if (match === null || !this.authorized(req)) {
      socket.destroy();
      return;
    }
    const user = decodeURIComponent(match[1]!);
    const session = (await this.runtime.sessions(user)) as { agents?: unknown[] };
    if ((session.agents ?? []).length === 0) {
      socket.destroy();
      return;
    }
    const target = (
      this.runtime as unknown as { busTarget?: () => { url: string; token: string } }
    ).busTarget?.();
    if (target === undefined) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const link = new Link(socket, head);
    const dial = new URL(target.url);
    dial.searchParams.set('token', target.token);
    const remote = new Remote(target.url, dial.toString());
    const pending: string[] = [];
    remote.receive(
      (frame) => link.send(JSON.stringify(frame)),
      () => link.close(),
    );
    link.receive(
      (frame) => {
        const text = JSON.stringify(frame);
        if (!remote.send(text)) pending.push(text);
      },
      () => remote.close(),
    );
    remote.dial().then(
      () => {
        for (const text of pending) remote.send(text);
        pending.length = 0;
      },
      (error: unknown) => {
        this.logger?.warn(`bus proxy: ${error instanceof Error ? error.message : String(error)}`);
        link.close();
      },
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://runtime.local');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/healthz') {
        json(res, 200, { ok: true, service: 'runtime' });
        return;
      }
      if (!this.authorized(req)) {
        res.setHeader('www-authenticate', 'Bearer');
        json(res, 401, {
          error: 'missing or wrong service token',
          code: 'unauthorized',
        });
        return;
      }
      if (req.method === 'GET' && path === '/whoami') {
        json(res, 200, { ok: true, service: 'runtime' });
        return;
      }

      const body = req.method === 'POST' ? await bodyOf(req) : {};

      // User lifecycle. A user is the persistent boundary; destroying it removes only that home
      // and that user's node table, never the shared bus or its processes.
      if (req.method === 'POST' && (path === '/users/create' || path === '/create_user')) {
        const user = text(body.user, 'user');
        const handle = await this.runtime.createUser(user);
        json(res, 201, { user: handle.user, home: handle.home, state: handle.state });
        return;
      }
      if (req.method === 'POST' && (path === '/users/destroy' || path === '/destroy_user')) {
        const user = text(body.user, 'user');
        await this.runtime.destroyUser(user);
        json(res, 200, { ok: true, user });
        return;
      }

      // Bus lifecycle. One bus, shared nodes; a user is only a connection.
      if (req.method === 'POST' && path === '/bus/launch') {
        const handle = await this.runtime.launchBus(object(body.options) as never);
        json(res, 201, busView(handle));
        return;
      }
      if (req.method === 'POST' && path === '/bus/stop') {
        await this.runtime.stopBus();
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && path === '/agents/create') {
        const user = text(body.user, 'user');
        const name =
          typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : user;
        await this.runtime.createUser(user);
        await this.runtime.launchBus();
        for (const ref of this.stackNodes()) {
          const node = await this.runtime.launchNode(ref);
          await this.runtime.connect(user, node.name);
        }
        json(res, 200, { user, name, state: 'running' });
        return;
      }
      if (req.method === 'POST' && path === '/agents/stop') {
        const user = text(body.user, 'user');
        const session = (await this.runtime.sessions(user)) as {
          nodes?: Array<{ name?: unknown }>;
        };
        for (const node of session.nodes ?? []) {
          if (typeof node.name === 'string') await this.runtime.disconnect(user, node.name);
        }
        json(res, 200, { user, stopped: true });
        return;
      }

      // Node lifecycle.
      if (req.method === 'POST' && path === '/node/launch') {
        const node = text(body.node, 'node');
        const handle = await this.runtime.launchNode(node, object(body.options) as never);
        json(res, 201, nodeView(handle));
        return;
      }
      if (req.method === 'POST' && path === '/node/stop') {
        const node = text(body.node, 'node');
        await this.runtime.stopNode(node);
        json(res, 200, { ok: true, node });
        return;
      }

      // The composed operations.
      if (req.method === 'POST' && (path === '/connect' || path === '/nodes/connect')) {
        const user = text(body.user, 'user');
        const node = text(body.node ?? body.name, 'name');
        const handle = await this.runtime.connect(user, node, object(body.options) as never);
        json(res, 200, {
          user,
          name: handle.name,
          version: handle.version,
          started: false,
          running: handle.state === 'running',
          session: handle.name,
          dir: handle.dir,
          pid: handle.pid ?? null,
        });
        return;
      }
      if (req.method === 'POST' && (path === '/disconnect' || path === '/nodes/disconnect')) {
        const user = text(body.user, 'user');
        const node = text(body.node ?? body.name, 'name');
        await this.runtime.disconnect(user, node);
        json(res, 200, { ok: true, user, name: node, stopped: true });
        return;
      }

      if (req.method === 'GET' && path === '/sessions') {
        const asked = (url.searchParams.get('user') ?? '').trim();
        json(res, 200, await this.runtime.sessions(asked === '' ? undefined : asked));
        return;
      }

      json(res, 404, {
        error: `no route: ${req.method ?? '?'} ${path}`,
        code: 'not_found',
      });
    } catch (error) {
      if (error instanceof RuntimeError) {
        json(res, statusOf(error), { error: error.message, code: error.code });
        return;
      }
      this.logger?.error(
        `runtime api: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      json(res, 500, { error: 'runtime request failed', code: 'internal' });
    }
  }
}
