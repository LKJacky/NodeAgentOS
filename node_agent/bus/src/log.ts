// The bus's own diagnostic log, on stderr, next to every other process log.
//
// `NODE_AGENT_LOG_LEVEL` selects `silent`, `error`, `warn`, `info` (the default) or
// `debug`. Debug adds one line per call start and completion, which is what a stuck request needs;
// info keeps the topology (listen, connect, register, refuse) without one line per tool call.
// Nothing here logs a token or a manifest body — node names, tenants and capabilities are enough to
// follow a request and are already visible to the bus.

export type BusLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<BusLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function configured(): number {
  const value = (process.env.NODE_AGENT_LOG_LEVEL ?? 'info').trim().toLowerCase();
  return Object.hasOwn(ORDER, value) ? ORDER[value as BusLogLevel] : ORDER.info;
}

/** One line, `key=value` fields, never a newline inside a value. */
function field(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return /^[A-Za-z0-9_.:/@-]+$/.test(text) ? text : JSON.stringify(text);
}

export function busLog(
  level: Exclude<BusLogLevel, 'silent'>,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (ORDER[level] > configured()) return;
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${field(value)}`);
  console.error(`[bus] ${level} ${event}${pairs.length > 0 ? ` ${pairs.join(' ')}` : ''}`);
}
