#!/usr/bin/env node
// @node-agent/shell: the shell node as its own process, against a bus that already exists.
//
// The package is a node, not a process: the SDK runner reads package.json's `node` block, builds the
// host and keeps the capabilities registered until a signal arrives. This entry only says where the
// bus is and waits, so `node dist/serve.js` (or `node src/serve.ts` on Node with type stripping) is
// enough to run the shell from a machine that has this checkout.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { servePackage } from '@node-agent/sdk';
import ShellNode from './index.js';

export default ShellNode;

/** The package root: this file is `dist/serve.js` once it runs. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the bus is, as the runner resolves it. */
const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';

/** Where to register, when not the package's own `node.id`: `--name computer`, or NODE_AGENT_NODE_ID.
 *
 * The runner takes the id as an option, so a stack that has always called this node `computer` keeps
 * that name - and the capabilities that come with it (`computer.read`, ...) - instead of being renamed
 * by whichever package it happens to run from. A name the bus would refuse is refused by the runner.
 */
function namedId(): string | undefined {
  const at = process.argv.indexOf('--name');
  const flag = at === -1 ? '' : (process.argv[at + 1] ?? '').trim();
  const named = flag || (process.env.NODE_AGENT_NODE_ID ?? '').trim();
  return named || undefined;
}

/** Resolve when this process should stop -- on a signal, and on nothing else. */
function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

async function main(): Promise<void> {
  let host;
  try {
    const id = namedId();
    host = await servePackage(ROOT, id === undefined ? {} : { id });
  } catch (error: unknown) {
    console.error(
      `shell failed to join ${BUS_URL}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  console.log(`shell: joined ${BUS_URL}`);

  await untilStopped();
  await host.stop();
}

// The same file is both the package's Node class entry and its executable. Importing it must not
// start a second process; running it (directly or through the npx bin symlink) must.
const invoked = process.argv[1] === undefined ? '' : realpathSync(process.argv[1]);
const self = realpathSync(fileURLToPath(import.meta.url));
if (invoked === self) {
  await main();

  // A client socket still open would keep the event loop alive; this process exists to be started
  // and stopped by a supervisor, so once its job is done it leaves.
  process.exit(0);
}
