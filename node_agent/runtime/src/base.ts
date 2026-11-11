// The runtime contract: a server that owns one shared bus and the nodes on it.
//
// The interface is deliberately small. A runtime creates and stops two kinds of process — a bus and
// shared nodes — while a user is only an access relation: connect(user, node) ensures both exist and
// adds the node to that user's table; disconnect(user, node) removes only the relation.
//
// Everything here is transport-neutral. LocalRuntime uses worker threads by default; a remote
// implementation can implement the same methods over HTTP without changing a caller.

export type RuntimeState = 'starting' | 'running' | 'stopped' | 'failed';

export type Env = Record<string, string | undefined>;

/** A small logger, so a runtime can be used from a process that already has one. */
export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RuntimeServerOptions {
  /** Runtime-owned state (users, packages). Defaults to `<NODE_AGENT_HOME>/runtime`. */
  home?: string;
  /** Address the user's bus listens on. Defaults to loopback. */
  host?: string;
  /** Base port for allocation. 0 (the default) asks the OS for a free port. */
  basePort?: number;
  /** How many ports above basePort may be tried. Defaults to 100. */
  portSpan?: number;
  /** Token used for the bus. A runtime-generated token is used when unset. */
  token?: string;
  /** Extra environment for every child, after the runtime's own defaults. */
  env?: Env;
  /** Node binary. Defaults to process.execPath. */
  nodeBinary?: string;
  /** How a node is isolated: a worker thread in this runtime process, or a child process.
   *  Worker is the default, so a personal stack is one OS process: bus + every default node. */
  isolation?: 'worker' | 'process';
  logger?: RuntimeLogger;
}

export interface BusOptions {
  host?: string;
  port?: number;
  token?: string;
  env?: Env;
}

export interface NodeOptions {
  /** Package root or package name. Defaults to `node` itself. */
  dir?: string;
  /** Bus name. Defaults to the package's `node.id`. */
  name?: string;
  /** Extra environment for this node only. */
  env?: Env;
  /** Extra command line arguments. */
  args?: readonly string[];
}

export interface UserHandle {
  readonly user: string;
  readonly home: string;
  state: 'ready' | 'removed';
}

export interface BusHandle {
  readonly kind: 'bus';
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly token: string;
  readonly pid: number | undefined;
  state: RuntimeState;
  /** Stop this bus. Nodes on it are stopped first. */
  stop(): Promise<void>;
}

export interface NodeHandle {
  readonly kind: 'node';
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly pid: number | undefined;
  state: RuntimeState;
  /** Stop this node. */
  stop(): Promise<void>;
}

/** The runtime server interface. Every method is async; there is no synchronous twin. */
export interface Runtime {
  /** Create a user's persistent home. Idempotent. */
  createUser(user: string): Promise<UserHandle>;
  /** Stop the user's bus and nodes, then remove the user's home. Idempotent. */
  destroyUser(user: string): Promise<void>;

  /** Start the shared bus; returns the existing one when it is already running. */
  launchBus(options?: BusOptions): Promise<BusHandle>;
  /** Stop the shared bus and every node still on it. Idempotent. */
  stopBus(): Promise<void>;
  /** Start one shared node against the bus, creating the bus when needed. */
  launchNode(node: string, options?: NodeOptions): Promise<NodeHandle>;
  /** Stop one shared node. Idempotent. */
  stopNode(node: string): Promise<void>;
  /** Compose: ensure the bus and node, then connect that user to the node. */
  connect(user: string, node: string, options?: NodeOptions): Promise<NodeHandle>;
  /** Compose: remove the user's access. The shared node and bus stay up. */
  disconnect(user: string, node: string): Promise<void>;
  /** One user's table, or every user's table when no user is named. */
  sessions(user?: string): Promise<Record<string, unknown>>;
}

export type RuntimeErrorCode =
  | 'invalid_user'
  | 'invalid_node'
  | 'bus_not_running'
  | 'bus_start_failed'
  | 'node_not_running'
  | 'node_start_failed'
  | 'package_failed'
  | 'spawn_failed';

/** A refusal a caller can show: code is stable, message is for a human. */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

const USER = /^[a-z][a-z0-9_-]{0,62}$/;
const NODE = /^[a-z][a-z0-9-]{0,62}$/;

/** A user name is also a directory name: refuse anything that could escape one. */
export function userName(value: string): string {
  if (!USER.test(value))
    throw new RuntimeError('invalid_user', `not a user name: ${JSON.stringify(value)}`);
  return value;
}

/** A node name is a bus name: same rule the package manifest is held to. */
export function nodeName(value: string): string {
  if (!NODE.test(value))
    throw new RuntimeError('invalid_node', `not a node name: ${JSON.stringify(value)}`);
  return value;
}
