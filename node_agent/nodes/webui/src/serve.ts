#!/usr/bin/env node
// node-agent-webui: run the browser front end as its own SDK node against a bus that exists.
import { fileURLToPath } from 'node:url';
import { WebSocketBusSession, nodeManifestOfPackage } from '@node-agent/sdk';
import { WebuiNode } from './index.js';

const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';
const BUS_TOKEN = process.env.NODE_AGENT_TOKEN?.trim() || 'demo-token';
const WEBUI_PORT = Number(process.env.NODE_AGENT_WEBUI_PORT ?? 8790);
const NAME = process.env.NODE_AGENT_WEBUI_NAME?.trim() || '';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

const bus = new WebSocketBusSession();
const base = nodeManifestOfPackage(ROOT);
const manifest = NAME === '' ? base : { ...base, name: NAME };

await bus.connect(BUS_URL, BUS_TOKEN);
await bus.register(manifest);

const webui = new WebuiNode(bus);
bus.onEvent((event) => {
  const payload = event.payload as { node?: unknown; topic?: unknown; value?: unknown };
  if (typeof payload.node === 'string' && typeof payload.topic === 'string')
    webui.onEvent(event.tenantId, payload.node, payload.topic, payload.value, event.from);
});

console.log(`webui: ${await webui.serve(WEBUI_PORT)}`);

await untilStopped();
webui.close();
await bus.unregister(manifest.name);
await bus.close();
process.exit(0);
