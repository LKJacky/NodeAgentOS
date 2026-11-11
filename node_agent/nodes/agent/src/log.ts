// The agent's own diagnostic log, on stderr beside the other node logs.
//
// `NODE_AGENT_LOG_LEVEL` selects `silent`, `error`, `warn`, `info` (default) or `debug`. The log
// never carries message text or tool arguments: turn lengths, provider rows, tool names and
// timings are enough to tell a stuck turn from a slow model without copying a reader's transcript.

export type AgentLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<AgentLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function configured(): number {
  const value = (process.env.NODE_AGENT_LOG_LEVEL ?? 'info').trim().toLowerCase();
  return Object.hasOwn(ORDER, value) ? ORDER[value as AgentLogLevel] : ORDER.info;
}

function field(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return /^[A-Za-z0-9_.:/@-]+$/.test(text) ? text : JSON.stringify(text);
}

export function agentLog(
  level: Exclude<AgentLogLevel, 'silent'>,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (ORDER[level] > configured()) return;
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${field(value)}`);
  console.error(`[agent] ${level} ${event}${pairs.length > 0 ? ` ${pairs.join(' ')}` : ''}`);
}
