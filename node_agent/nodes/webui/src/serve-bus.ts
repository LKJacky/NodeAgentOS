#!/usr/bin/env node
// node-agent-bus-webui: the bus and the browser front end, in one process.
import { fileURLToPath } from 'node:url';
import { Bus, busArgsOrExit } from 'node-agent-bus';
import { WebSocketBusSession, nodeManifestOfPackage } from '@node-agent/sdk';
import { WebuiNode } from './index.js';

const ARGS = busArgsOrExit('node-agent-bus-webui', { ownsBus: true });
const BUS_PORT = ARGS.bind?.port ?? Number(process.env.NODE_AGENT_BUS_PORT ?? 8788);
const WEBUI_PORT = Number(process.env.NODE_AGENT_WEBUI_PORT ?? 8790);
const BUS_BIND = ARGS.bind?.host ?? process.env.NODE_AGENT_BUS_BIND ?? '127.0.0.1';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

async function main(): Promise<void> {
  let bus: Bus;
  try {
    bus = await new Bus(ARGS.token).listen(BUS_PORT, BUS_BIND);
  } catch (e: unknown) {
    console.error(
      `bus failed to start (port ${BUS_PORT}): ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  const session = new WebSocketBusSession();
  const manifest = nodeManifestOfPackage(ROOT);
  const webui = new WebuiNode(session);

  try {
    await session.connect(bus.url, ARGS.token);
    await session.register(manifest);
    session.onEvent((event) => {
      const payload = event.payload as { node?: unknown; topic?: unknown; value?: unknown };
      if (typeof payload.node === 'string' && typeof payload.topic === 'string')
        webui.onEvent(event.tenantId, payload.node, payload.topic, payload.value, event.from);
    });

    console.log(`bus: ${BUS_BIND}:${bus.port}`);
    console.log(`webui: ${await webui.serve(WEBUI_PORT)}`);

    await untilStopped();
  } finally {
    webui.close();
    await session.unregister(manifest.name);
    await session.close();
    bus.close();
  }
}

await main();
process.exit(0);
