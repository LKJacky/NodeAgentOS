#!/usr/bin/env node
// @node-agent/shell: the shell node as its own process, against a bus that already exists.
//
//     node dist/serve.js                   registers as `shell`
//     node dist/serve.js --name computer    registers as `computer`
//     npx @node-agent/shell --name computer  (the bin is this file)
//
// This is the package's only process entry. `index.ts` beside it is the Node class and nothing else,
// which is why the start-up code lives here: the package used to carry two copies of it - one in
// `index.ts` for the `npx` bin, one here for `node dist/serve.js` - and the copy the bin ran was the
// one that renamed the address without renaming the label.
//
// A rename is three values, not one: the address the bus answers on (`name`), the package id that
// moves with it (`packageId`), and the words the directory writes under the node (`labels.node`).
// `namedServeOptions` decides all three for `servePackage`, and `test/naming.test.ts` reads it
// without a bus; `test/named-entry.test.ts` reads what the bus actually accepted.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { servePackage } from '@node-agent/sdk';
import type { LocalizedText, ServeOptions } from '@node-agent/sdk';
import ShellNode from './index.js';

export default ShellNode;

/** The package root: this file is `dist/serve.js` once it runs. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the bus is, as the runner resolves it. */
const BUS_URL = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';

/** The name this process was asked to answer as: `--name <id>`, else NODE_AGENT_NODE_ID, else ''. */
export function namedId(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): string {
  const at = argv.indexOf('--name');
  const flag = at === -1 ? '' : (argv[at + 1] ?? '').trim();
  return flag || (env.NODE_AGENT_NODE_ID ?? '').trim();
}

/** What the directory writes under a node renamed to `named`: the name itself, in every language.
 *
 *  There is nothing to translate in a name the user chose, and the package's own words (`Shell /`
 *  终端`) belong to an address this process is no longer on. */
export function namedLabel(named: string): LocalizedText {
  return { 'zh-CN': named, en: named };
}

/** The options `servePackage` takes for this process.
 *
 *  The label travels with the id: the runner renames `name` and `packageId`, writes the label into
 *  `labels.node`, and a rename without it left the node answering as `computer` while the directory
 *  still showed `Shell / 终端`. An empty name is `{}` - no id, no label - so a start without
 *  `--name` registers exactly the package. A name the bus would refuse is refused by the runner. */
export function namedServeOptions(named: string): ServeOptions {
  return named === '' ? {} : { id: named, label: namedLabel(named) };
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
    host = await servePackage(ROOT, namedServeOptions(namedId()));
  } catch (error: unknown) {
    console.error(
      `shell failed to join ${BUS_URL}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  console.log(`shell: joined ${BUS_URL}`);

  await untilStopped();
  await host.stop();

  // A client socket still open would keep the event loop alive; this process exists to be started
  // and stopped by a supervisor, so once its job is done it leaves.
  process.exit(0);
}

// The same file is both the package's Node class entry and its executable. Importing it must not
// start a second process; running it (directly or through the npx bin symlink) must.
const invoked = process.argv[1] === undefined ? '' : realpathSync(process.argv[1]);
const self = realpathSync(fileURLToPath(import.meta.url));
if (invoked === self) {
  // Started, not awaited: `servePackage` loads this package, and the loader imports `node.entry` -
  // which is this same file. Waiting here would wait for our own module evaluation to finish, which
  // is waiting for us: the process printed `unsettled top-level await` and joined nothing. Not
  // awaiting lets the module finish first, and the runner's import then finds the finished module.
  void main();
}
