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
// A node is a package root with `dist/serve.js`; the runtime starts it as a worker and waits for its manifest to
// appear in the global registry. `NODE_AGENT_NODES` names extra package roots (comma separated);
// `NODE_AGENT_USER` names the deployment user. Core nodes are connected to a private runtime service
// user while they start, so system can call history before the deployment user exists.
//
//   NODE_AGENT_NODES=node-agent-webui node-agent
//
// NODE_AGENT_ACCESS_TOKEN puts the optional proxy in front of the page (src/proxy.ts): one token, one
// login page, /bus and /events piped through. Unset, nothing is added and no port is opened.
//
// Stopping is SIGINT / SIGTERM, and nothing else.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVICE_TENANT, privateNodeToken } from 'node-agent-bus';
import { busArgsOrExit } from './index.js';
import { LocalRuntime } from './local.js';
import { startProxy, type ProxyHandle, type ProxyOptions } from './proxy.js';

const ARGS = busArgsOrExit('node-agent', { ownsBus: true });
const PORT = ARGS.bind?.port ?? Number(process.env.NODE_AGENT_BUS_PORT ?? 0);
const BIND = ARGS.bind?.host ?? process.env.NODE_AGENT_BUS_BIND ?? '127.0.0.1';
// No store node here: this is the personal build, whose third-party nodes dial the local bus
// themselves (`npx @node-agent/sdk .`) instead of being published and connected through a store.
/** The package that runs the stack's setup once, after everything else is up. */
const INTRODUCE = 'node-agent-introduce';

const DEFAULT_NODES =
  'node-agent-provider,node-agent-webui,node-agent-notes,node-agent-todo,node-agent-timer,node-agent-search,node-agent-introduce';

/** A project that is a sibling checkout rather than a workspace package. */
interface SiblingNode {
  env: string;
  fallback: string;
}

const SIBLINGS: Record<string, SiblingNode> = {
  'node-agent-provider': {
    env: 'NODE_AGENT_PROVIDER_ROOT',
    fallback: '../../nodes/provider',
  },
};

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

/** Resolve a node package to its root: a sibling checkout when configured, else node resolution. */
function rootOf(moduleName: string): string {
  const sibling = SIBLINGS[moduleName];
  if (sibling !== undefined) {
    return (
      process.env[sibling.env]?.trim() || fileURLToPath(new URL(sibling.fallback, import.meta.url))
    );
  }
  const local = fileURLToPath(new URL(`../../nodes/${moduleName}`, import.meta.url));
  if (existsSync(join(local, 'package.json'))) return local;
  const require = createRequire(import.meta.url);
  let root = dirname(require.resolve(moduleName));
  while (!existsSync(join(root, 'package.json'))) root = dirname(root);
  return root;
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

  const runtime = new LocalRuntime({
    host: BIND,
    basePort: PORT,
    token: ARGS.token,
    logger: console,
  });

  // 1. Runtime: bind the one bus every node and every user shares.
  let bus;
  try {
    bus = await runtime.launchBus({ host: BIND, port: PORT, token: ARGS.token });
  } catch (e: unknown) {
    console.error(
      `runtime failed to start (port ${PORT}): ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  const names: string[] = [];
  const userId = process.env.NODE_AGENT_USER?.trim() || 'default';
  const userTenant = runtime.busUser(userId);
  // The page advertises this, never the shared bus token: a node that presents it registers
  // privately in this user's space and therefore appears in this user's UI.
  const joinToken = privateNodeToken(bus.token, userTenant);

  try {
    // 2. Nodes: start and register globally. The service user is connected as each one arrives so
    // core nodes can call each other during their own startup.
    const core = [
      new URL('../../nodes/history', import.meta.url).pathname,
      new URL('../../nodes/agent', import.meta.url).pathname,
      new URL('../../nodes/system', import.meta.url).pathname,
    ];
    const roots = [
      ...core,
      ...specs.filter((spec) => spec.module !== INTRODUCE).map((spec) => rootOf(spec.module)),
    ];
    for (const root of roots) {
      // NODE_AGENT_USER_TENANT is the deployment user's bus id: a node that has to speak as that
      // user before anyone has called it (introduce seeds the user's transcript) needs the identity the
      // caller would otherwise hand it.
      const handle = await runtime.launchNode(root, {
        dir: root,
        env: { NODE_AGENT_USER_TENANT: userTenant, NODE_AGENT_JOIN_TOKEN: joinToken },
      });
      names.push(handle.name);
      runtime.bus?.user(SERVICE_TENANT, true)?.connect(handle.name);
    }

    // 3. The deployment user exists only after the shared nodes do.
    await runtime.createUser(userId);

    // 4. Then grant that user every node this process started.
    for (const name of names) await runtime.connect(userId, name);

    // 5. Last, start the node that owns the page. Its setup is the page's to run: the reader picks
    //    a language there, and the node files the stack's first documents then. Nothing at startup
    //    calls it -- a stack that is never visited stays uninitialized, and says so on its page.
    for (const spec of specs.filter((one) => one.module === INTRODUCE)) {
      const root = rootOf(spec.module);
      const handle = await runtime.launchNode(root, {
        dir: root,
        env: { NODE_AGENT_USER_TENANT: userTenant, NODE_AGENT_JOIN_TOKEN: joinToken },
      });
      names.push(handle.name);
      await runtime.connect(userId, handle.name);
    }
  } catch (e: unknown) {
    await runtime.stopAll();
    console.error(`node-agent failed to come up: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  console.log(`bus: ${BIND}:${bus.port}`);
  console.log(`nodes: ${names.join(', ')}`);
  const user = runtime.bus?.user(runtime.busUser(userId));
  console.log(`user: ${userId} -> ${[...(user?.nodes ?? [])].join(', ')}`);

  // The webui prints the address it actually bound (port 0 gets a real port), so surface that line
  // once it has had a moment to flush, without duplicating every node's log.
  let webui: string | undefined;
  if (names.includes('webui')) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const match = runtime.nodeOutput('webui')?.match(/webui: (http:\/\/\S+)/);
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
  await runtime.stopBus();
}

await main();
process.exit(process.exitCode ?? 0);
