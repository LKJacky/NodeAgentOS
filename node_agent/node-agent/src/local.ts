// LocalRuntime: one shared bus, and one worker thread per node in this process by default.
//
// Nodes are global. A user is a table on the bus (which nodes it may use), not a second copy of the
// processes. `connect` ensures the shared node exists and adds it to that user's table; `disconnect`
// only removes the table entry and leaves the node and the runtime-owned bus running.
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Bus, SERVICE_TENANT } from './bus/index.js';
import {
  RuntimeError,
  nodeName,
  userName,
  type BusHandle,
  type BusOptions,
  type Env,
  type NodeHandle,
  type NodeOptions,
  type Runtime,
  type RuntimeLogger,
  type RuntimeServerOptions,
  type RuntimeState,
  type UserHandle,
} from './runtime/index.js';

interface ProcessRecord {
  /** A child process, or a worker thread when the runtime is in one-process mode. */
  readonly child: ChildProcess | Worker;
  readonly worker?: Worker;
  readonly log: ReturnType<typeof createWriteStream>;
  output: string;
  exitCode: number | null;
  exited: Promise<void>;
}

interface BusRecord {
  readonly bus: Bus;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly token: string;
  state: RuntimeState;
  handle: BusHandle;
}

interface NodeRecord extends ProcessRecord {
  /** The live process record; `output` above is a snapshot and does not update. */
  readonly outputRef: ProcessRecord;
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  state: RuntimeState;
  handle: NodeHandle;
}

function envStrings(env: Env | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {}))
    if (typeof value === 'string') out[key] = value;
  return out;
}

function tail(text: string, limit = 1200): string {
  return text.length <= limit ? text : text.slice(-limit);
}

/** A port the bus can listen on: 0 asks the OS, otherwise scan from the base. */
async function allocatePort(host: string, base = 0, span = 100): Promise<number> {
  const { createServer } = await import('node:net');
  const listen = (port: number): Promise<number | null> =>
    new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(null));
      server.listen(port, host, () => {
        const address = server.address();
        const picked = typeof address === 'object' && address !== null ? address.port : port;
        server.close(() => resolve(picked));
      });
    });
  if (base <= 0) {
    const picked = await listen(0);
    if (picked === null) throw new RuntimeError('bus_start_failed', 'could not allocate a port');
    return picked;
  }
  for (let port = base; port < base + Math.max(1, span); port += 1) {
    const picked = await listen(port);
    if (picked !== null) return picked;
  }
  throw new RuntimeError('bus_start_failed', `no free port in ${base}..${base + span - 1}`);
}

function nodeAgentRoot(): string {
  return resolve(process.env.NODE_AGENT_HOME?.trim() || join(homedir(), '.node_agent'));
}

/** Runtime-owned state (user homes, installed packages, bus logs) lives beside node data, under
 *  `<node-agent-home>/runtime`. An explicit option remains for tests and embedders. */
function runtimeRoot(explicit?: string): string {
  return explicit === undefined ? join(nodeAgentRoot(), 'runtime') : resolve(explicit);
}

function startProcess(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  logPath: string,
): ProcessRecord {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, [...args], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExit = resolve));
  const record: ProcessRecord = { child, log, output: '', exitCode: null, exited };
  const keep = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    record.output = tail(record.output + text, 16_000);
    log.write(chunk);
  };
  child.once('exit', (code) => {
    record.exitCode = code;
    resolveExit();
  });
  child.once('error', (error) => {
    record.output = tail(`${record.output}${error.message}\n`, 16_000);
    log.write(`${error.message}\n`);
    if (record.exitCode === null) record.exitCode = 1;
    resolveExit();
  });
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return record;
}

/** Start one node as a worker thread: same OS process, its own module graph and event loop. */
function startWorker(
  entry: string,
  args: readonly string[],
  env: Record<string, string>,
  logPath: string,
): ProcessRecord {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const worker = new Worker(entry, {
    argv: [...args],
    env: {
      ...env,
      // A debugger attached to the parent must not also attach to every node worker.
      NODE_OPTIONS: '',
      VSCODE_INSPECTOR_OPTIONS: '',
    },
    execArgv: [],
    stdin: false,
    stdout: true,
    stderr: true,
  });
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExit = resolve));
  const record: ProcessRecord = { child: worker, worker, log, output: '', exitCode: null, exited };
  const keep = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    record.output = tail(record.output + text, 16_000);
    log.write(chunk);
  };
  worker.stdout?.on('data', keep);
  worker.stderr?.on('data', keep);
  worker.once('exit', (code) => {
    record.exitCode = code;
    resolveExit();
  });
  worker.once('error', (error: unknown) => {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    record.output = tail(`${record.output}${text}\n`, 16_000);
    log.write(`${text}\n`);
    if (record.exitCode === null) record.exitCode = 1;
    resolveExit();
  });
  return record;
}

async function stopProcess(record: ProcessRecord): Promise<void> {
  if (record.exitCode !== null) {
    record.log.end();
    return;
  }
  const exited = record.exited;
  if (record.worker !== undefined) {
    await record.worker.terminate();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
    record.log.end();
    return;
  }
  const child = record.child as ChildProcess;
  const pid = child.pid;
  try {
    if (pid !== undefined) process.kill(-pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
  await Promise.race([exited, timeout]);
  if (record.exitCode === null) {
    try {
      if (pid !== undefined) process.kill(-pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // already gone
    }
    await exited;
  }
  record.log.end();
}

/** Resolve a package name or a package root to the directory holding package.json. */
function packageRoot(ref: string): string {
  const direct = resolve(ref);
  if (existsSync(join(direct, 'package.json'))) return direct;
  try {
    const require = createRequire(import.meta.url);
    let root = dirname(require.resolve(ref));
    while (!existsSync(join(root, 'package.json'))) {
      const parent = dirname(root);
      if (parent === root) break;
      root = parent;
    }
    if (existsSync(join(root, 'package.json'))) return root;
  } catch {
    // fall through to the workspace sibling
  }
  const sibling = fileURLToPath(new URL(`../../${ref}`, import.meta.url));
  if (existsSync(join(sibling, 'package.json'))) return sibling;
  if (!ref.includes('/') && !ref.startsWith('.')) {
    try {
      return packageRoot(`node-agent-${ref}`);
    } catch {
      // fall through
    }
  }
  throw new RuntimeError('node_start_failed', `not a node package: ${ref}`);
}

function packageEntry(root: string): string {
  const built = join(root, 'dist', 'serve.js');
  if (existsSync(built)) return built;
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { main?: unknown };
    if (typeof json.main === 'string' && json.main !== '') return join(root, json.main);
  } catch {
    // fall through to the error below
  }
  throw new RuntimeError('node_start_failed', `node entry does not exist under ${root}`);
}

function manifestVersion(root: string): string {
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof json.version === 'string' ? json.version : '';
  } catch {
    return '';
  }
}

function manifestName(root: string): string {
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      name?: unknown;
      node?: { id?: unknown };
    };
    const id = json.node?.id;
    if (typeof id === 'string' && id !== '') return nodeName(id);
    if (typeof json.name === 'string' && json.name !== '') return nodeName(json.name);
  } catch {
    // fall through
  }
  throw new RuntimeError('invalid_node', `package has no node.id: ${root}`);
}

async function waitForNode(
  bus: Bus,
  name: string,
  record: ProcessRecord,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bus.envelopeNodes.has(name)) return;
    if (record.exitCode !== null)
      throw new RuntimeError('node_start_failed', `${name} exited with ${record.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new RuntimeError('node_start_failed', `${name} did not register within ${timeoutMs}ms`);
}

export class LocalRuntime implements Runtime {
  /** One node launch at a time: two users asking at startup must not spawn the same shared node twice. */
  private launchQueue: Promise<void> = Promise.resolve();
  private readonly options: RuntimeServerOptions;
  private readonly logger?: RuntimeLogger;
  private busRecord: BusRecord | undefined;
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly knownUsers = new Set<string>();

  constructor(options: RuntimeServerOptions = {}) {
    this.options = options;
    this.logger = options.logger;
  }

  /** The shared bus, once it is listening. Used by the process entry to print its user table. */
  get bus(): Bus | undefined {
    return this.busRecord?.bus;
  }

  private home(user: string): string {
    const root = runtimeRoot(this.options.home);
    const users = join(root, 'users');
    const dir = join(users, userName(user));
    if (!dir.startsWith(users + '/'))
      throw new RuntimeError('invalid_user', `user home escapes the runtime root: ${user}`);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    return dir;
  }

  private nodeHome(name: string): string {
    // Node-owned durable files live under the node-agent home, not the runtime's own user/package
    // home: `<node-agent-home>/<node-name>/`. The runtime only creates the log directory here; a node
    // owns everything else below it.
    const root = nodeAgentRoot();
    const dir = join(root, nodeName(name));
    if (!dir.startsWith(root + '/'))
      throw new RuntimeError('invalid_node', `node home escapes the node-agent home: ${name}`);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    return dir;
  }

  /** The bus never sees a display name: it sees a stable digest of the name. */
  private busId(user: string): string {
    return user === SERVICE_TENANT ? SERVICE_TENANT : this.busUser(user);
  }

  busUser(user: string): string {
    userName(user);
    if (this.busRecord === undefined)
      throw new RuntimeError('bus_not_running', 'the bus is not running');
    return createHash('sha256').update(`node-agent\0${user}`).digest('hex');
  }

  private tokenFor(): string {
    const token = this.options.token;
    if (typeof token === 'string' && token !== '') return token;

    // Keep a generated token under the runtime home (0600) so credentials derived from it - private
    // node join tokens and the remote history bearer - stay stable across a restart. An explicit
    // NODE_AGENT_TOKEN still wins and is never written here.
    const directory = runtimeRoot(this.options.home);
    const file = join(directory, 'bus-token');
    try {
      const kept = readFileSync(file, 'utf8').trim();
      if (kept !== '') return kept;
    } catch {
      // first start, or an unreadable file: generate one below
    }

    const generated = `runtime-${randomUUID()}`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${generated}\n`, { mode: 0o600 });
    } catch (error) {
      throw new RuntimeError(
        'bus_start_failed',
        `cannot persist the runtime bus token at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return generated;
  }

  async launchBus(options: BusOptions = {}): Promise<BusHandle> {
    const current = this.busRecord;
    if (current !== undefined && current.state === 'running') return current.handle;

    const host = options.host ?? this.options.host ?? '127.0.0.1';
    const port =
      options.port ?? (await allocatePort(host, this.options.basePort, this.options.portSpan));
    const token = options.token ?? this.tokenFor();
    const bus = new Bus(token);
    try {
      await bus.listen(port, host);
    } catch (error) {
      throw new RuntimeError(
        'bus_start_failed',
        `could not start the bus on ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const record: BusRecord = {
      bus,
      host,
      port: bus.port,
      url: bus.url,
      token,
      state: 'running',
      handle: undefined as unknown as BusHandle,
    };
    record.handle = {
      kind: 'bus',
      host: record.host,
      port: record.port,
      url: record.url,
      token: record.token,
      pid: process.pid,
      get state() {
        return record.state;
      },
      stop: async () => await this.stopBus(),
    };
    this.busRecord = record;
    this.logger?.info(`bus: ${record.url}`);
    return record.handle;
  }

  async stopBus(): Promise<void> {
    for (const node of [...this.nodes.values()]) await this.stopNode(node.name);
    const record = this.busRecord;
    if (record === undefined) return;
    record.state = 'stopped';
    record.bus.close();
    this.busRecord = undefined;
  }

  async launchNode(node: string, options: NodeOptions = {}): Promise<NodeHandle> {
    const run = this.launchQueue.then(() => this.launchNodeNow(node, options));
    this.launchQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async launchNodeNow(node: string, options: NodeOptions = {}): Promise<NodeHandle> {
    const root = packageRoot(options.dir ?? node);
    const name = nodeName(options.name ?? manifestName(root));
    const version = manifestVersion(root);
    const existing = this.nodes.get(name);
    if (existing !== undefined && existing.state === 'running' && existing.exitCode === null)
      return existing.handle;

    const bus = await this.launchBus();
    const entry = packageEntry(root);

    const dir = this.nodeHome(name);
    const env: Record<string, string> = {
      ...process.env,
      ...envStrings(this.options.env),
      ...envStrings(options.env),
      NODE_AGENT_BUS_URL: bus.url,
      NODE_AGENT_TOKEN: bus.token,
      // The history node files units under its bearer, so that credential must survive a runtime
      // restart even though the bus token is deliberately random per start.
      NODE_AGENT_HISTORY_TOKEN:
        process.env.NODE_AGENT_HISTORY_TOKEN?.trim() ||
        process.env.NODE_AGENT_TOKEN?.trim() ||
        bus.token,
      // The bus has one envelope protocol; packages built against the older SDK default must
      // still use its WebSocket session, not the removed legacy handshake.
      NODE_AGENT_TRANSPORT: 'websocket',
      NODE_AGENT_TENANT: SERVICE_TENANT,
      NODE_AGENT_NODE_NAME: name,
    };
    let record: ProcessRecord;
    try {
      record =
        (this.options.isolation ?? 'worker') === 'worker'
          ? startWorker(entry, options.args ?? [], env, join(dir, 'logs', `${name}.log`))
          : startProcess(
              this.options.nodeBinary ?? process.execPath,
              [entry, ...(options.args ?? [])],
              env,
              join(dir, 'logs', `${name}.log`),
            );
    } catch (error) {
      throw new RuntimeError(
        'spawn_failed',
        `could not spawn ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const nodeRecord: NodeRecord = {
      ...record,
      outputRef: record,
      name,
      version,
      dir: root,
      state: 'starting',
      handle: undefined as unknown as NodeHandle,
    };
    nodeRecord.handle = {
      kind: 'node',
      name,
      version,
      dir: root,
      pid: nodeRecord.worker === undefined ? (nodeRecord.child as ChildProcess).pid : process.pid,
      get state() {
        return nodeRecord.state;
      },
      stop: async () => await this.stopNode(name),
    };
    this.nodes.set(name, nodeRecord);

    try {
      await waitForNode(this.busRecord!.bus, name, nodeRecord);
      this.busRecord!.bus.user(SERVICE_TENANT, true)!.connect(name);
    } catch (error) {
      nodeRecord.state = 'failed';
      this.nodes.delete(name);
      await stopProcess(nodeRecord);
      throw new RuntimeError(
        'node_start_failed',
        `${error instanceof Error ? error.message : String(error)}\n${tail(nodeRecord.output)}`,
      );
    }
    nodeRecord.state = 'running';
    this.logger?.info(`node ${name}: ${nodeRecord.worker === undefined ? 'pid' : 'worker'}`);
    return nodeRecord.handle;
  }

  async stopNode(node: string): Promise<void> {
    const name = nodeName(node);
    const record = this.nodes.get(name);
    if (record === undefined) return;
    record.state = 'stopped';
    await stopProcess(record);
    this.nodes.delete(name);
    for (const space of this.busRecord?.bus.users.values() ?? []) space.disconnect(name);
  }

  async createUser(user: string): Promise<UserHandle> {
    const dir = this.home(user);
    this.knownUsers.add(user);
    if (this.busRecord !== undefined) this.busRecord.bus.user(this.busId(user), true);
    return { user, home: dir, state: 'ready' };
  }

  async destroyUser(user: string): Promise<void> {
    userName(user);
    const dir = this.home(user);
    if (this.busRecord !== undefined) this.busRecord.bus.users.delete(this.busId(user));
    await rm(dir, { recursive: true, force: true });
  }

  async connect(user: string, node: string, options: NodeOptions = {}): Promise<NodeHandle> {
    this.knownUsers.add(user);
    // A connect by node name must reuse the already-running shared node; only a launch by package
    // root needs package resolution.
    const existing = this.nodes.get(nodeName(node));
    let resolved = options;
    if (existing === undefined || existing.state !== 'running' || existing.exitCode !== null) {
      const name = nodeName(node);
      const installed = this.installedPackage(user, name);
      if (installed !== undefined) resolved = { ...options, dir: installed };
    }
    const handle =
      existing !== undefined && existing.state === 'running' && existing.exitCode === null
        ? existing.handle
        : await this.launchNode(node, resolved);
    this.busRecord!.bus.user(this.busId(user), true)!.connect(handle.name);
    return handle;
  }

  async disconnect(user: string, node: string): Promise<void> {
    userName(user);
    const name = nodeName(node);
    if (this.busRecord !== undefined) this.busRecord.bus.user(this.busId(user))?.disconnect(name);
  }

  /** Every user this runtime has connected, and the shared nodes each one may reach. */
  async sessions(user?: string): Promise<Record<string, unknown>> {
    const wanted =
      user === undefined ? [...this.knownUsers] : this.knownUsers.has(user) ? [user] : [];
    const bus = this.busRecord?.bus;
    const table = wanted.map((one) => {
      const connected = bus === undefined ? undefined : bus.user(this.busId(one));
      const names = connected === undefined ? [] : [...connected.nodes];
      const webui = this.webuiTarget();
      return {
        user: one,
        agents: names.includes('agent')
          ? [{ name: one, running: this.nodeRunning('agent'), rss_bytes: null, webui }]
          : [],
        nodes: names.map((name) => ({
          name,
          version: this.nodes.get(name)?.version ?? '',
          running: this.nodeRunning(name),
          dir: this.nodes.get(name)?.dir ?? '',
          pid:
            this.nodes.get(name)?.worker === undefined
              ? ((this.nodes.get(name)?.child as ChildProcess | undefined)?.pid ?? null)
              : process.pid,
        })),
        userpage: names.includes('userpage'),
      };
    });
    return user === undefined
      ? { users: table }
      : (table[0] ?? { user, agents: [], nodes: [], userpage: false });
  }

  /** The newest package the installer materialized for this user, if there is one. */
  private installedPackage(user: string, name: string): string | undefined {
    const root = join(runtimeRoot(this.options.home), 'packages', user, name);
    try {
      const versions = readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'package.json')),
        )
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const version = versions.at(-1);
      return version === undefined ? undefined : join(root, version);
    } catch {
      return undefined;
    }
  }

  private nodeRunning(name: string): boolean {
    const record = this.nodes.get(name);
    return record !== undefined && record.state === 'running' && record.exitCode === null;
  }

  /** Where the shared page node printed its address, if it has started yet. */
  private webuiTarget(): { host: string; port: number } | undefined {
    const output = this.nodeOutput('webui') ?? '';
    const found = /webui:\s*http:\/\/([^:\s/]+):(\d+)/.exec(output);
    if (found === null) return undefined;
    const port = Number(found[2]);
    return port > 0 && port <= 65535 ? { host: found[1]!, port } : undefined;
  }

  /** The shared bus, for a trusted caller that has to proxy an outside node. */
  busTarget(): { url: string; token: string } | undefined {
    const record = this.busRecord;
    return record === undefined ? undefined : { url: record.url, token: record.token };
  }

  /** Recent stdout/stderr of one running node, for the entry process to surface its address. */
  nodeOutput(node: string): string | undefined {
    return this.nodes.get(nodeName(node))?.outputRef.output;
  }

  async stopAll(): Promise<void> {
    await this.stopBus();
  }
}
