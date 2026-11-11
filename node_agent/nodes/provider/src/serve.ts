#!/usr/bin/env node
// node-agent-provider: the provider node as its own process, against a bus that already exists.
//
//     node dist/serve.js          registers as `provider`
//     node dist/serve.js --local  registers as `local-provider`
//
// Local mode is this same package under the second name, for a stack that serves its own endpoint
// beside the shared one: the capacities, the page and the stored rows are the package's, only the
// address the agent dials changes. The topic a stream is published on does not change with it:
// every stream has a `provider.stream.<stream_id>` of its own, whichever node serves it.
import { fileURLToPath } from 'node:url';
import { servePackage } from '@node-agent/sdk';
import { providerMode } from './mode.js';

const directory = fileURLToPath(new URL('..', import.meta.url));
const mode = providerMode(process.argv.slice(2));
// The host renames the manifest; the node reads that name from its context (`ctx.nodeId`) for the page
// it draws, so the chosen id is passed here and nowhere else.
const host = await servePackage(directory, mode.local ? { id: mode.id } : {});

console.log(
  `${host.manifest.name}: joined ${process.env.NODE_AGENT_BUS_URL ?? 'ws://127.0.0.1:8788'}`,
);

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

await untilStopped();
await host.stop();
