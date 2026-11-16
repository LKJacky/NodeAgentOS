#!/usr/bin/env node
// @node-agent/provider: the provider node as its own process, against a bus that already exists.
//
//     node dist/serve.js          registers as `provider`
//     node dist/serve.js --local  registers as `local-provider`
//     npx @node-agent/provider --local      (the bin is this file)
//
// This is the package's only process entry, and `node.entry` in package.json names it: the SDK asks a
// package's bin targets to include its entry, so the entry is the CLI. `index.ts` beside it is the
// Node class and nothing else - it used to carry a `provider-entry` bin that awaited
// `import('./serve.js')`, which the runner answered by importing `dist/index.js` back: the process
// printed `unsettled top-level await`, exited 13 and registered nothing at all.
//
// Local mode is this same package under the second name, for a stack that serves its own endpoint
// beside the shared one: the capacities, the page and the stored rows are the package's, only the
// address the agent dials changes - and the words under it. The topic a stream is published on does
// not change with it: every stream has a `provider.stream.<stream_id>` of its own, whichever node
// serves it.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { servePackage, type LocalizedText, type ServeOptions } from '@node-agent/sdk';
import { providerMode, type ProviderMode } from './mode.js';
import ProviderNode from './index.js';

export default ProviderNode;

/** The package root: this file is `dist/serve.js` once it runs. */
const DIRECTORY = fileURLToPath(new URL('..', import.meta.url));

/** Where the bus is, when the environment does not say. */
const BUS_URL = process.env.NODE_AGENT_BUS_URL ?? 'ws://127.0.0.1:8788';

/** What the directory writes under a node renamed to `local-provider`: local mode says so in both
 *  languages, because the node is not the package's shared one any more. */
export function localLabel(): LocalizedText {
  return { 'zh-CN': '本地模型服务', en: 'Local provider' };
}

/** The options `servePackage` takes for this mode.
 *
 *  The id and the label travel together: the runner renames `name` and `packageId` from the id and
 *  writes the label into `labels.node`, so `--local` registers as `local-provider` *listed* as the
 *  local one. A shared start passes `{}` - no id, no label - and the manifest keeps the package's
 *  own name and its own words. */
export function serveOptions(mode: ProviderMode): ServeOptions {
  return mode.local
    ? { id: mode.id, label: mode.label ?? localLabel() }
    : {};
}

/** Resolve when this process should stop -- on a signal, and on nothing else. */
function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

/** Register, say where, and serve until a signal arrives. */
async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const host = await servePackage(DIRECTORY, serveOptions(providerMode(argv))).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`provider: cannot join ${BUS_URL}: ${message}`);
      process.exit(1);
    },
  );

  // The registered name, not the package's: local mode answers as `local-provider`.
  console.log(`${host.manifest.name}: joined ${BUS_URL}`);

  await untilStopped();
  await host.stop();
}

// This file is both the package's entry (the SDK imports it for `ProviderNode`) and its executable.
// Importing it must not start a host; running it must.
//
// Started, not awaited: `servePackage` loads this package, and the loader imports `node.entry` - the
// same file, which would then still be evaluating. Waiting here would wait for ourselves (exit 13,
// `unsettled top-level await`, nothing registered). Not awaiting lets the module finish first, and
// the runner's import then finds the finished module.
const invoked = process.argv[1];
const self = realpathSync(fileURLToPath(import.meta.url));
if (invoked !== undefined && realpathSync(invoked) === self) void main();
