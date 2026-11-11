#!/usr/bin/env node
// node-agent-notes: the notes node as its own process, against a bus that already exists.
//
// The runtime owns the host, the bus session and the transport (@node-agent/sdk's runner): this entry
// only says "serve this package" and waits for a signal, the way every node process here does. The
// store runs its own host and never executes this file; it is here for `npm start` and for the
// python launcher in `python/`, which spawns `dist/serve.js`.
import { fileURLToPath } from 'node:url';
import { servePackage } from '@node-agent/sdk';

const directory = fileURLToPath(new URL('..', import.meta.url));
const host = await servePackage(directory);

// One line for a human; a caller can also just wait until `notes.*` shows up in the directory.
console.log(
  `${host.manifest.name}: joined ${process.env.NODE_AGENT_BUS_URL ?? 'ws://127.0.0.1:8788'}`,
);

function untilStopped(): Promise<void> {
  // A supervisor closing the pipe means stop; a container gets /dev/null on fd 0, where a read gives
  // EOF at once, so only the signals are listened for. Docker stops it with SIGTERM.
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

await untilStopped();
await host.stop();
