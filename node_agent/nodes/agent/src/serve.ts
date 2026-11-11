#!/usr/bin/env node
// node-agent-agent: the agent node by itself, against a bus that already exists.
//
// The package is a node definition, so this entry does what every entry does: hand the package to
// the shared runtime (`servePackage`), which loads the manifest, builds the host and picks the
// transport. The host is what gives the agent everything it needs to outlive an invocation: the
// tenant's `ctx.bind` scope, whose bus keeps working after the call that started a turn is answered.
//
// It adds only `--name` / NODE_AGENT_NODE_NAME, so one package can serve several agents on one bus.
//
// Once the capabilities are registered it prints exactly one line
//
//     agent: joined ws://127.0.0.1:8788
//
// then serves until SIGINT / SIGTERM. The model comes from a provider node on the bus; a bus with
// none leaves the agent answering `no provider on the bus`.
import { loadNodePackage, servePackage } from '@node-agent/sdk';

const ROOT = new URL('..', import.meta.url).pathname;
const BUS_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** The bus name to answer as: `--name <id>`, else NODE_AGENT_NODE_NAME, else the package's own. */
function nameFromArgs(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--name');
  const given = at >= 0 ? argv[at + 1] : process.env.NODE_AGENT_NODE_NAME;
  const name = given?.trim();
  return name === undefined || name === '' ? undefined : name;
}

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

async function main(): Promise<void> {
  const url = process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788';

  const wanted = nameFromArgs(process.argv.slice(2));
  const name = wanted ?? (await loadNodePackage(ROOT)).manifest.name;
  if (!BUS_NAME.test(name)) {
    console.error(`agent: not a bus name: ${name}`);
    process.exit(2);
  }

  let host;
  try {
    // The tenant is the SDK's to read (NODE_AGENT_TENANT); this entry names only the node.
    host = await servePackage(ROOT, { id: wanted });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`agent failed to join ${url}: ${reason}`);
    process.exit(1);
  }

  console.log(`agent: joined ${url}`);
  await untilStopped();
  await host.stop();
}

await main();
process.exit(0);
