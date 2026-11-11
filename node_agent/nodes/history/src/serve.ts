#!/usr/bin/env node
import { servePackage } from '@node-agent/sdk';
import { defaultHistoryTarget } from './index.js';

/** Start the history package as an SDK node. The runtime owns the bus session and the process
 *  lifetime; this entry only waits for a signal to stop. */
const host = await servePackage(new URL('..', import.meta.url).pathname);
console.log(`history: joined ${process.env.NODE_AGENT_BUS_URL ?? ''}`);
console.log(`history: storage ${defaultHistoryTarget()}`);

await new Promise<void>((resolve) => {
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());
});
await host.stop();
