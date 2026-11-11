#!/usr/bin/env node
import { servePackages } from './runner.js';

const directories = process.argv.slice(2);
if (directories.length === 0) {
  console.error('usage: @node-agent/sdk <node-package-directory> [...]');
  process.exit(2);
}

const hosts = await servePackages(directories);
for (const host of hosts) {
  console.log(
    `${host.manifest.name}: joined ${process.env.NODE_AGENT_BUS_URL ?? 'ws://127.0.0.1:8788'}`,
  );
}

await new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
for (const host of hosts.reverse()) await host.stop();
