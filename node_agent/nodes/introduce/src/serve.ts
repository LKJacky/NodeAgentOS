#!/usr/bin/env node
// node-agent-introduce (node id: introduce): the stack's own setup, once, as a process -- and then the
// page that introduces it.
//
// The process only registers and stays on the bus. The node-agent runtime calls `setup` after every
// other node and the deployment user are connected; that handler uses `ctx.call`, so this file needs
// no bus session, caller or scope of its own.
import { fileURLToPath } from 'node:url';
import { servePackage } from '@node-agent/sdk';

/** The package root: this file is `dist/serve.js` once it runs. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the bus is, as every node process is told. */
const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';

/** The token the bus was started with; an empty one authorizes nothing on a bus that has one. */
const TOKEN = (process.env.NODE_AGENT_TOKEN ?? '').trim();

/** Whose transcript this is: the one deployment user, by the bus id the runtime hands out. */
const TENANT =
  process.env.NODE_AGENT_USER_TENANT?.trim() || process.env.NODE_AGENT_TENANT?.trim() || 'default';

/** Resolve when this process should stop -- on a signal, and on nothing else. */
function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
    if (process.connected) process.once('disconnect', () => resolve());
  });
}

async function main(): Promise<void> {
  let host;
  try {
    host = await servePackage(ROOT, { url: BUS_URL, token: TOKEN, tenantId: TENANT });
  } catch (e: unknown) {
    // The failure a container actually hits: the bus is not up yet.
    console.error(
      `introduce failed to join ${BUS_URL}: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  console.log(`introduce: joined ${BUS_URL}`);
  await untilStopped();
  await host.stop();
}

await main();
process.exit(0);
