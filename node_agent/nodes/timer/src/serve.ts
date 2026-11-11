#!/usr/bin/env node
// node-agent-timer: the timer node as its own process, against a bus that already exists.
//
// The runtime owns the bus, so this file is only the entry a supervisor starts: the SDK's runner reads
// package.json's `node` block (entry `dist/system.js`), builds the host and keeps the capabilities
// registered until a signal arrives. It does not own the bus -- it joins one. NODE_AGENT_BUS_URL
// (+ NODE_AGENT_TOKEN) say which one. Once registered it prints exactly one line
//
//     timer: joined ws://127.0.0.1:<port>
//
// (for a human; a caller can also just wait until `timer.*` shows up in the bus directory), then serves
// until SIGINT / SIGTERM.
//
// This file exists because `LocalRuntime.packageEntry` starts a node package at `dist/serve.js`; the
// manifest entry (`dist/system.js`) is the class, not a process.
import { fileURLToPath } from 'node:url';
import { servePackage } from '@node-agent/sdk';

/** The package root: this file is `dist/serve.js` once it runs. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the bus is, as the runner resolves it. */
const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';

/** Resolve when this process should stop -- on a signal, and on nothing else. A supervisor closing the
 *  pipe is not a reason: a container started detached gets /dev/null on fd 0. */
function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

async function main(): Promise<void> {
  let host;
  try {
    host = await servePackage(ROOT);
  } catch (e: unknown) {
    // The failure a container actually hits: the bus is not up yet (or this is not its port).
    // One line, not a stack trace.
    console.error(`timer failed to join ${BUS_URL}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  console.log(`timer: joined ${BUS_URL}`);

  await untilStopped();
  await host.stop();
}

await main();

// A client socket still open would keep the event loop alive; this process exists to be started and
// stopped by a supervisor, so once its job is done it leaves.
process.exit(0);
