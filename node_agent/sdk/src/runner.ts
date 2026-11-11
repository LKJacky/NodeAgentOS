// The runtime owns NodeHost. A node package only exports its Node class and describes itself in
// package.json; it never builds a host, a bus session or a process entry of its own.
import { NodeHost } from './host.js';
import { LegacyBusSession } from './legacy_session.js';
import { WebSocketBusSession } from './bus_session.js';
import { isNodeId, loadNodePackage } from './package.js';
import type { NodeManifest } from './envelope.js';

export type BusTransport = 'legacy' | 'websocket';

export interface ServeOptions {
  readonly url?: string;
  readonly token?: string;
  readonly tenantId?: string;
  readonly transport?: BusTransport;
  /** Register under this node id instead of the package's `node.id`.
   *
   *  One package can then serve under two names on one bus - a `provider` and a `local_provider` -
   *  without a second copy of its package.json. The rest of the manifest (capabilities, entry,
   *  icon) is still the package's own; only the address it answers to changes. */
  readonly id?: string;
}

/** The manifest this host registers under: the package's own, renamed when `options.id` says so. */
function manifestOf(manifest: NodeManifest, id: string | undefined): NodeManifest {
  if (id === undefined) return manifest;
  if (!isNodeId(id)) throw new Error(`serve id is not a bus name: ${id}`);
  // The package id is the node id (see package.ts), so a rename renames both halves of it.
  return { ...manifest, name: id, packageId: id };
}

function environment(options: ServeOptions) {
  return {
    url: options.url ?? process.env.NODE_AGENT_BUS_URL ?? 'ws://127.0.0.1:8788',
    token: options.token ?? process.env.NODE_AGENT_TOKEN ?? 'demo-token',
    tenantId: options.tenantId ?? process.env.NODE_AGENT_TENANT ?? 'default',
    // Envelope is the bus's native protocol; the legacy client stays reachable with an explicit
    // NODE_AGENT_TRANSPORT=legacy for the Python bus and older deployments.
    transport:
      options.transport ?? (process.env.NODE_AGENT_TRANSPORT === 'legacy' ? 'legacy' : 'websocket'),
  } as const;
}

/** Start one package as a node. Standalone use and tests; shared runtimes use the same loader. */
export async function servePackage(
  directory: string,
  options: ServeOptions = {},
): Promise<NodeHost> {
  const { manifest, Node } = await loadNodePackage(directory);
  const { url, token, tenantId, transport } = environment(options);
  const host = new NodeHost({
    definition: { manifest: manifestOf(manifest, options.id), Node },
    bus: transport === 'legacy' ? new LegacyBusSession({ tenantId }) : new WebSocketBusSession(),
  });
  await host.start(url, token);
  return host;
}

/** Start several packages, each with its own bus connection, in this process. */
export async function servePackages(
  directories: readonly string[],
  options: ServeOptions = {},
): Promise<NodeHost[]> {
  if (directories.length === 0) throw new Error('no node package directories given');
  const hosts: NodeHost[] = [];
  try {
    for (const directory of directories) hosts.push(await servePackage(directory, options));
    return hosts;
  } catch (error) {
    for (const host of hosts.reverse()) await host.stop();
    throw error;
  }
}
