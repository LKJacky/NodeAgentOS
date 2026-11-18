#!/usr/bin/env node
// system is not a store package: it needs one bus connection and one NodeHost for capability calls.
// This process is the privileged runtime the rest of the system can rely on.
//
// The timer queue is held per tenant, inside the node's own binding (`system-scheduler`): a timer is
// set in the tenant of the call that set it and must fire there. This entry therefore installs no
// scheduler of its own - a whole-process one would belong to whatever tenant the runtime joined
// under (the service tenant), and every user's timers would fire into it instead of into theirs.
import { fileURLToPath } from 'node:url';
import { NodeHost, WebSocketBusSession, nodeManifestOfPackage } from '@node-agent/sdk';
import { SystemNode } from './index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';
const TOKEN = process.env.NODE_AGENT_TOKEN?.trim() || 'demo-token';

if (process.argv.includes('--tls-insecure')) process.env.NODE_AGENT_TLS_INSECURE = '1';

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
    if (process.connected) process.once('disconnect', () => resolve());
  });
}

async function main(): Promise<void> {
  const host = new NodeHost({
    definition: { manifest: nodeManifestOfPackage(ROOT), Node: SystemNode },
    bus: new WebSocketBusSession(),
  });
  try {
    await host.start(BUS_URL, TOKEN);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`system failed to start: ${reason}`);
    await host.stop();
    process.exit(1);
  }

  console.log(`system: joined ${BUS_URL}`);
  await untilStopped();
  await host.stop();
}

await main();
process.exit(0);
