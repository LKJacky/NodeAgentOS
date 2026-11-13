// The runtime as a client of its HTTP surface. `LocalRuntime` and `RuntimeServer` are one process;
// a store, a launcher or a test can use this class to speak to that process without importing it.
// Every method is the same contract as Runtime, and errors keep the server's stable code.
import {
  RuntimeError,
  type BusHandle,
  type BusOptions,
  type NodeHandle,
  type NodeOptions,
  type Runtime,
  type RuntimeLogger,
  type UserHandle,
} from './base.js';

export interface RuntimeClientOptions {
  /** Base URL printed by RuntimeServer, e.g. `http://127.0.0.1:8793`. */
  url: string;
  /** The service token the server was constructed with. */
  token: string;
  logger?: RuntimeLogger;
  /** Injection point for tests and for a fetch implementation with a dispatcher. */
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

function failure(value: unknown): RuntimeError {
  if (typeof value === 'object' && value !== null) {
    const body = value as { error?: unknown; code?: unknown };
    const code = typeof body.code === 'string' ? body.code : 'internal';
    const message = typeof body.error === 'string' ? body.error : 'runtime request failed';
    return new RuntimeError(code as RuntimeError['code'], message);
  }
  return new RuntimeError('internal', 'runtime request failed');
}

export class RuntimeClient implements Runtime {
  readonly url: string;
  private readonly token: string;
  private readonly logger?: RuntimeLogger;
  private readonly fetcher: typeof fetch;

  constructor(options: RuntimeClientOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.logger = options.logger;
    this.fetcher = options.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let value: unknown = {};
    if (text !== '') {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new RuntimeError('internal', `runtime answered with non-JSON (${response.status})`);
      }
    }
    if (!response.ok) throw failure(value);
    return value as T;
  }

  async createUser(user: string): Promise<UserHandle> {
    return this.call<UserHandle>('POST', '/users/create', { user });
  }

  async destroyUser(user: string): Promise<void> {
    await this.call('POST', '/users/destroy', { user });
  }

  async launchBus(options: BusOptions = {}): Promise<BusHandle> {
    const view = await this.call<Json>('POST', '/bus/launch', { options });
    return {
      kind: 'bus',
      host: String(view.host ?? ''),
      port: Number(view.port ?? 0),
      url: String(view.url ?? ''),
      token: String(view.token ?? ''),
      pid: typeof view.pid === 'number' ? view.pid : undefined,
      state: 'running',
      stop: async () => await this.stopBus(),
    };
  }

  async stopBus(): Promise<void> {
    await this.call('POST', '/bus/stop');
  }

  async launchNode(node: string, options: NodeOptions = {}): Promise<NodeHandle> {
    const view = await this.call<Json>('POST', '/node/launch', { node, options });
    return nodeHandle(this, view);
  }

  async stopNode(node: string): Promise<void> {
    await this.call('POST', '/node/stop', { node });
  }

  async connect(user: string, node: string, options: NodeOptions = {}): Promise<NodeHandle> {
    const view = await this.call<Json>('POST', '/connect', { user, node, options });
    return nodeHandle(this, view);
  }

  async disconnect(user: string, node: string): Promise<void> {
    await this.call('POST', '/disconnect', { user, node });
  }

  async tenant(user: string): Promise<string> {
    const view = await this.call<Json>('GET', `/users/tenant?user=${encodeURIComponent(user)}`);
    return String(view.tenant ?? '');
  }

  async hasNode(node: string): Promise<boolean> {
    const view = await this.call<Json>('GET', `/node/has?node=${encodeURIComponent(node)}`);
    return view.found === true;
  }

  async output(node: string): Promise<string | undefined> {
    const view = await this.call<Json>('GET', `/node/output?node=${encodeURIComponent(node)}`);
    return typeof view.output === 'string' ? view.output : undefined;
  }

  async sessions(user?: string): Promise<Record<string, unknown>> {
    const query = user === undefined ? '' : `?user=${encodeURIComponent(user)}`;
    return this.call<Record<string, unknown>>('GET', `/sessions${query}`);
  }
}

function nodeHandle(client: RuntimeClient, view: Json): NodeHandle {
  const name = String(view.name ?? '');
  const running = view.running !== undefined ? view.running === true : view.state === 'running';
  return {
    kind: 'node',
    name,
    version: String(view.version ?? ''),
    dir: String(view.dir ?? ''),
    pid: typeof view.pid === 'number' ? view.pid : undefined,
    state: running ? 'running' : 'starting',
    stop: async () => await client.stopNode(name),
  };
}
