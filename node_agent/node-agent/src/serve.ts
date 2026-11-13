#!/usr/bin/env node
// node-agent: the headless core as a process — one runtime, one shared bus, every node on it.
//
// The order is deliberate:
//
//   1. runtime starts and binds the bus
//   2. core and optional nodes start and register with that bus (global, not per user)
//   3. the deployment's user is created
//   4. that user is connected to the nodes this process started
//
// A node is a package with `dist/serve.js`; the runtime discovers its root by package name or node id,
// starts it as a worker and waits for its manifest to appear in the global registry. `NODE_AGENT_NODES`
// names extra nodes (comma separated); `NODE_AGENT_USER` names the deployment user. Core nodes are
// connected to a private runtime service user while they start, so system can call history before the
// deployment user exists.
//
//   NODE_AGENT_NODES=node-agent-webui node-agent
//
// NODE_AGENT_ACCESS_TOKEN puts the optional proxy in front of the page (src/proxy.ts): one token, one
// login page, /bus and /events piped through. Unset, nothing is added and no port is opened.
//
// Stopping is SIGINT / SIGTERM, and nothing else.
import { randomBytes } from 'node:crypto';
import { privateNodeToken } from './bus/index.js';
import { RuntimeClient, RuntimeServer, UsageError, busArgsOrExit, busUsage } from './index.js';
import { LocalRuntime } from './local.js';
import { startProxy, type ProxyHandle, type ProxyOptions } from './proxy.js';

const RUNTIME_USAGE = '[--runtime-port <port>] [--runtime-token <token>] [--runtime-bind <host>]';
const ARGS = busArgsOrExit('node-agent', {
  ownsBus: true,
  allowsRest: true,
  extra: RUNTIME_USAGE,
});
const PORT = ARGS.bind?.port ?? Number(process.env.NODE_AGENT_BUS_PORT ?? 0);
const BIND = ARGS.bind?.host ?? process.env.NODE_AGENT_BUS_BIND ?? '127.0.0.1';

interface RuntimeApiConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

/** The optional HTTP runtime API. The port is the switch; when it is set a service token is required. */
function runtimeApiConfig(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
): RuntimeApiConfig | null {
  let host = env.NODE_AGENT_RUNTIME_BIND?.trim() || '127.0.0.1';
  let portText = env.NODE_AGENT_RUNTIME_PORT?.trim() ?? '';
  let token = env.NODE_AGENT_RUNTIME_SERVICE_TOKEN?.trim() ?? '';
  let tokenFlag = false;

  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at] ?? '';
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = rest[at + 1];
      if (next === undefined) throw new UsageError(`${name} wants a value`);
      at += 1;
      return next;
    };
    if (name === '--runtime-port') portText = value();
    else if (name === '--runtime-token') {
      token = value();
      tokenFlag = true;
    } else if (name === '--runtime-bind') host = value();
    else throw new UsageError(`unknown option: ${arg}`);
  }

  if (portText === '') {
    if (tokenFlag) throw new UsageError('--runtime-token needs --runtime-port');
    return null;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new UsageError(`--runtime-port wants a port, not "${portText}"`);
  if (token === '')
    throw new UsageError(
      'the runtime API needs --runtime-token or NODE_AGENT_RUNTIME_SERVICE_TOKEN',
    );
  if (host.trim() === '') throw new UsageError('--runtime-bind wants a host');
  return { host, port, token };
}

let RUNTIME_API: RuntimeApiConfig | null;
try {
  RUNTIME_API = runtimeApiConfig(ARGS.rest, process.env);
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`node-agent: ${error.message}`);
  console.error(busUsage('node-agent', RUNTIME_USAGE));
  process.exit(2);
}
// No store node here: this is the personal build, whose third-party nodes dial the local bus
// themselves (`npx @node-agent/sdk .`) instead of being published and connected through a store.
/** The package that runs the stack's setup once, after everything else is up. */
const INTRODUCE = 'node-agent-introduce';

const DEFAULT_NODES =
  'node-agent-provider,node-agent-webui,node-agent-notes,node-agent-todo,node-agent-timer,node-agent-search,node-agent-introduce';

interface NodeSpec {
  module: string;
}

function specsFrom(value: string): NodeSpec[] {
  const text = value.trim();
  if (text === '') return [];
  return text.split(',').map((item) => {
    const module = item.split(':')[0]?.trim() ?? '';
    if (module === '') throw new Error(`NODE_AGENT_NODES item "${item.trim()}" names no module`);
    return { module };
  });
}

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

/** NODE_AGENT_PROXY_*: loopback HTTP by default, because the browser is normally on this host. */
function proxyOptions(env: NodeJS.ProcessEnv, token: string, upstream: string): ProxyOptions {
  const bind = env.NODE_AGENT_PROXY_BIND?.trim() || '127.0.0.1';
  const port = Number(env.NODE_AGENT_PROXY_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`NODE_AGENT_PROXY_PORT "${env.NODE_AGENT_PROXY_PORT}" is not a port`);
  }
  // Opt-in and off by default: a login over plain loopback HTTP must still be able to set a cookie.
  const secure = env.NODE_AGENT_PROXY_SECURE === '1';
  return { token, upstream, bind, port, secure };
}

async function main(): Promise<void> {
  let specs: NodeSpec[];
  try {
    specs = specsFrom(process.env.NODE_AGENT_NODES ?? DEFAULT_NODES);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const localRuntime = new LocalRuntime({
    host: BIND,
    basePort: PORT,
    token: ARGS.token,
    logger: console,
  });

  // The server is the boundary: everything below starts nodes and creates users through the same
  // HTTP client a store or another process would use. It always binds loopback; a configured port
  // only makes it reachable to callers outside this process.
  const runtimeToken = RUNTIME_API?.token ?? randomBytes(24).toString('hex');
  const runtimeApi = new RuntimeServer({
    runtime: localRuntime,
    token: runtimeToken,
    host: RUNTIME_API?.host ?? '127.0.0.1',
    port: RUNTIME_API?.port ?? 0,
    logger: console,
  });
  let address;
  try {
    address = await runtimeApi.start();
    console.log(`runtime: ${address.url}`);
  } catch (error) {
    console.error(
      `runtime api failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const runtime = new RuntimeClient({ url: address.url, token: runtimeToken, logger: console });

  // 1. Runtime: bind the one bus every node and every user shares.
  let bus;
  try {
    bus = await runtime.launchBus({ host: BIND, port: PORT, token: ARGS.token });
  } catch (e: unknown) {
    await runtimeApi.stop();
    console.error(
      `runtime failed to start (port ${PORT}): ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  const names: string[] = [];
  const userId = process.env.NODE_AGENT_USER?.trim() || 'default';
  const userTenant = await runtime.tenant(userId);
  // The page advertises this, never the shared bus token: a node that presents it registers
  // privately in this user's space and therefore appears in this user's UI.
  const joinToken = privateNodeToken(bus.token, userTenant);

  // Resolve every requested name before starting any node, so a typo fails the whole start rather
  // than leaving half a stack behind. The client still launches by name; this is only a preflight.
  const core = ['history', 'agent', 'system'];
  const refs = [...core, ...specs.map((spec) => spec.module)];

  // Only the page node needs the deployment user's identity before its first call. Keep the switch
  // by node name so adding a special case stays local to the launch loop.
  const nodeEnv = (name: string): Record<string, string> => {
    if (name === INTRODUCE) {
      return { NODE_AGENT_USER_TENANT: userTenant, NODE_AGENT_JOIN_TOKEN: joinToken };
    } else if (name === 'node-agent-webui') {
      return { NODE_AGENT_USER_TENANT: userTenant };
    } else {
      return {};
    }
  };

  try {
    // Resolve every requested name before starting any node, so a typo fails the whole start.
    for (const ref of refs) {
      if (!(await runtime.hasNode(ref))) throw new Error(`not a node package: ${ref}`);
    }

    // 2. Nodes: names only. LocalRuntime discovers the package root, whether it is bundled,
    // a workspace sibling, or a version the runtime installed for a user.
    for (const ref of refs) {
      const handle = await runtime.launchNode(ref, { env: nodeEnv(ref) });
      names.push(handle.name);
    }

    // 3. The deployment user exists only after the shared nodes do.
    await runtime.createUser(userId);

    // 4. Then grant that user every node this process started. The page node's setup is the page's
    // to run; a stack that is never visited stays uninitialized and says so on its page.
    for (const name of names) await runtime.connect(userId, name);
  } catch (e: unknown) {
    await runtime.stopBus().catch(() => undefined);
    await runtimeApi.stop();
    console.error(`node-agent failed to come up: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  console.log(`bus: ${BIND}:${bus.port}`);
  console.log(`nodes: ${names.join(', ')}`);
  const session = (await runtime.sessions(userId)) as {
    nodes?: Array<{ name?: unknown }>;
  };
  const connected = (session.nodes ?? [])
    .map((node) => (typeof node.name === 'string' ? node.name : ''))
    .filter((name) => name !== '');
  console.log(`user: ${userId} -> ${connected.join(', ')}`);

  // The webui prints the address it actually bound (port 0 gets a real port), so surface that line
  // once it has had a moment to flush, without duplicating every node's log.
  let webui: string | undefined;
  if (names.includes('webui')) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const match = (await runtime.output('webui'))?.match(/webui: (http:\/\/\S+)/);
      if (match !== null && match !== undefined) {
        webui = match[1];
        console.log(`webui: ${webui}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // The optional door. NODE_AGENT_ACCESS_TOKEN is the switch: unset, none of the below runs, no port
  // is opened, and the lines above are the whole output exactly as before. It is deliberately not
  // NODE_AGENT_TOKEN: that one is the bus credential and never leaves this host.
  let proxy: ProxyHandle | undefined;
  const accessToken = (process.env.NODE_AGENT_ACCESS_TOKEN ?? '').trim();
  if (accessToken !== '') {
    if (webui === undefined) {
      console.error('proxy not started: the webui never printed its address');
      process.exitCode = 1;
    } else {
      try {
        proxy = await startProxy(proxyOptions(process.env, accessToken, webui));
        console.log(`proxy: ${proxy.url}`);
      } catch (e: unknown) {
        console.error(`proxy failed to start: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    }
  }

  const connectUrl = proxy?.url ?? webui;
  console.log('Ready to connect');
  if (connectUrl === undefined) {
    console.log('connect: no web UI enabled');
  } else {
    console.log(`connect: ${connectUrl}`);
  }

  await untilStopped();
  await proxy?.close();
  try {
    await runtime.stopBus();
  } finally {
    await runtimeApi.stop();
  }
}

await main();
process.exit(process.exitCode ?? 0);
