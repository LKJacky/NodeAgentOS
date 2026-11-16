#!/usr/bin/env node
// node-agent-files: the files node as its own process, against a bus that already exists.
//
// The runtime owns the host, the bus session and the transport (@node-agent/sdk's runner): this entry
// only says "serve this package" and waits for a signal. `LocalRuntime.packageEntry` starts a node
// package at `dist/serve.js`, which is why the file exists at all - the manifest entry
// (`dist/index.js`) is the class, not a process.
import { fileURLToPath } from 'node:url';
import { servePackage } from '@node-agent/sdk';

/** The package root: this file is `dist/serve.js` once it runs. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the bus is, as the runner resolves it. */
const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';

/** Resolve when this process should stop - on a signal, and on nothing else: a container started
 *  detached gets /dev/null on fd 0, and a read there gives EOF at once. */
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
  } catch (error) {
    // The failure a container actually hits: the bus is not up yet (or this is not its port).
    console.error(
      `files failed to join ${BUS_URL}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  console.log(`files: joined ${BUS_URL}`);

  await untilStopped();
  await host.stop();
}

await main();

// A client socket still open would keep the event loop alive; this process exists to be started and
// stopped by a supervisor, so once its job is done it leaves.
process.exit(0);
