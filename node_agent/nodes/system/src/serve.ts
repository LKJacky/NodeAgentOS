#!/usr/bin/env node
// system is not a store package: it needs one bus connection for the scheduler and one NodeHost for
// capability calls. This process is the privileged runtime the rest of the system can rely on.
import { fileURLToPath } from 'node:url';
import { NodeHost, WebSocketBusSession, nodeManifestOfPackage } from '@node-agent/sdk';
import { SystemNode, setSystemScheduler } from './index.ts';
import { SystemScheduler } from './scheduler.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';
const TOKEN = process.env.NODE_AGENT_TOKEN?.trim() || 'demo-token';
const TENANT = process.env.NODE_AGENT_TENANT?.trim() || 'default';

if (process.argv.includes('--tls-insecure')) process.env.NODE_AGENT_TLS_INSECURE = '1';

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
    if (process.connected) process.once('disconnect', () => resolve());
  });
}

async function main(): Promise<void> {
  const bus = new WebSocketBusSession();
  const scheduler = new SystemScheduler(bus, TENANT);
  setSystemScheduler(scheduler);

  const host = new NodeHost({
    definition: { manifest: nodeManifestOfPackage(ROOT), Node: SystemNode },
    bus,
  });
  try {
    await host.start(BUS_URL, TOKEN);
    await scheduler.start();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`system failed to start: ${reason}`);
    await host.stop();
    process.exit(1);
  }

  console.log(`system: joined ${BUS_URL}`);
  await untilStopped();
  scheduler.stop();
  setSystemScheduler(null);
  await host.stop();
}

await main();
process.exit(0);
