import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root for persistent files owned by node-agent. */
export function nodeAgentHome(): string {
  return process.env.NODE_AGENT_HOME?.trim() || join(homedir(), '.node_agent');
}

/** One node's private directory: <node-agent-home>/<node-name>. */
export function nodeAgentDir(nodeName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nodeName))
    throw new Error(`invalid node name for storage: ${nodeName}`);
  return join(nodeAgentHome(), nodeName);
}
