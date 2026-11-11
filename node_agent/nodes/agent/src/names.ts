// A sub-agent is not a node: it answers through the family's one registration, and the `agent`
// argument of a capability names it. Its topic is `<bus name>.<its name>`, which is what its page
// feed follows; a bus node name cannot contain a dot, so the two can never collide.
const SUBAGENT_PREFIX = 'agent.';

/** The sub-agent's own name, whether the caller passed `helper` or `agent.helper`. */
export function agentNameOf(value: string): string {
  return value.startsWith(SUBAGENT_PREFIX) ? value.slice(SUBAGENT_PREFIX.length) : value;
}
