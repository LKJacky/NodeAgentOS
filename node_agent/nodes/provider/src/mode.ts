// Which name this provider process registers under.
//
// One node package, two addresses: `provider` is the shared node a whole bus may use, and
// `local-provider` is the same node pointed at the endpoint this stack runs itself (a model server
// on the same host, say). A stack that runs both wants the agent to prefer the near one, so the
// choice is made here, from the command line, and told to the package by name.
import { join } from 'node:path';
import { nodeAgentDir } from '@node-agent/sdk';

export const PROVIDER_ID = 'provider';
export const LOCAL_PROVIDER_ID = 'local-provider';

/** The environment variable that asks for local mode instead of the flag (a supervisor's way). */
export const LOCAL_ENV = 'NODE_AGENT_LOCAL';

export type ProviderMode = {
  readonly local: boolean;
  /** The id to register under: `local-provider` in local mode, `provider` otherwise. */
  readonly id: string;
};

/** Read `--local` (or NODE_AGENT_LOCAL=1) off the command line this process was started with. */
export function providerMode(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ProviderMode {
  const named = env[LOCAL_ENV]?.trim().toLowerCase();
  const local = argv.includes('--local') || named === '1' || named === 'true';
  return { local, id: local ? LOCAL_PROVIDER_ID : PROVIDER_ID };
}

/** The variable that names the file local mode keeps its rows in, instead of the bus's history. */
export const CONFIG_ENV = 'NODE_AGENT_PROVIDER_CONFIG';

/** The file name inside this node's own directory (`<node-agent-home>/<node-name>/`). */
export const LOCAL_CONFIG_FILE = 'local-provider.json';

/** The file a local provider keeps its provider rows in, or null when this process is the shared one.
 *
 * Local mode is the address, not a second switch: the node that answers as `local-provider` points at
 * the endpoint this stack runs itself, so its credentials belong to that stack, on that machine - a
 * file - while `provider` serves a whole bus and keeps its rows in the bus's history as before. The
 * name is the one the host registered the node under (`ctx.nodeId`), not something read back from
 * the environment. A file
 * that cannot be parsed fails rather than starting over: an empty list would show one blank row and let
 * the page's next save overwrite every row the file held.
 */
export function localConfigPath(
  id: string,
  env: Record<string, string | undefined> = process.env,
  home?: string,
): string | null {
  if (id !== LOCAL_PROVIDER_ID) return null;
  const named = env[CONFIG_ENV]?.trim();
  return named ? named : join(home ?? nodeAgentDir(id), LOCAL_CONFIG_FILE);
}
