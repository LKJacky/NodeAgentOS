#!/usr/bin/env node
// node-agent-todo: the todo node as its own process, against a bus that already exists.
//
// The runtime owns the bus now, so this file is only the entry a supervisor (or the python launcher)
// starts: the SDK's runner reads package.json's `node` block, builds the host and keeps the
// capabilities registered until a signal arrives. It does not own the bus -- it joins one.
// NODE_AGENT_BUS_URL (+ NODE_AGENT_TOKEN) say which bus, the same way every other node process here is
// told. Once the capabilities are registered it prints exactly one line
//
//     todo: joined 127.0.0.1:<port>
//
// (for a human; a caller can also just wait until `todo.*` shows up in the bus directory), then serves
// until SIGINT / SIGTERM.
import { fileURLToPath } from 'node:url';
import { servePackage } from '@node-agent/sdk';

/** The package root: this file is `dist/serve.js` once it runs. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the bus is, as the runner resolves it (--url is not read here: a process entry is told by the
 *  environment, and `npx @node-agent/sdk .` is the command line that takes flags). */
const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';

/** Resolve when this process should stop -- on a signal, and on nothing else. Docker stops it with
 *  SIGTERM; a supervisor closing the pipe is not a reason, because a container started detached gets
 *  /dev/null on fd 0 and would otherwise end the moment it began. */
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
    console.error(`todo failed to join ${BUS_URL}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  console.log(`todo: joined ${BUS_URL}`);

  await untilStopped();
  await host.stop();
}

await main();

// A client socket still open would keep the event loop alive; this process exists to be started and
// stopped by a supervisor, so once its job is done it leaves.
process.exit(0);
