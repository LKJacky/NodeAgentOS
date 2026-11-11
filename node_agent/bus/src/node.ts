// Where the bus is: the listening defaults, `host:port` as a URL, and the one variable an entry
// dials with.
//
// There is no node client in this package any more. A node is the SDK's (NodeHost /
// WebSocketBusSession); what stays here are the address helpers every entry needs before it can
// join, because they are about the bus, not about the client.
export const DEFAULT_HOST = '127.0.0.1';

/** The port the bus listens on when nothing names one: 8788 is the number every entry in this
 *  workspace agrees on (the bus's own default, and the python twin's). */
export const DEFAULT_PORT = 8788;

/** `host:port` as one ws:// URL — with the brackets a bare IPv6 address needs inside a URL. */
export function socketUrl(host: string, port: number): string {
  const bare = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `ws://${bare}:${port}`;
}

/** Where an *entry* dials: NODE_AGENT_BUS_URL, or ws://127.0.0.1:8788 when it names nothing.
 *
 *  This is the launcher's side of the address, not the client's. There is one variable and one
 *  default on purpose - a host and a port would be a second way to say the same thing, and the two
 *  would drift (a bus behind a front door has a path, a query and a scheme, none of which fit in a
 *  host and a port). Where a bus *listens* is NODE_AGENT_BUS_BIND / NODE_AGENT_BUS_PORT, which is
 *  the server's question, not this one's. Read when it is called, so a supervisor that sets it late
 *  still counts. */
export function busFromEnv(env: Record<string, string | undefined> = process.env): string {
  return busAddress(env.NODE_AGENT_BUS_URL ?? '') ?? socketUrl(DEFAULT_HOST, DEFAULT_PORT);
}

/** The bus a string names, in full, or null when it does not name one.
 *
 * Only ws:// and wss:// count: those are the two schemes this wire answers on, and an http(s)
 * address is a mistake to say out loud rather than a URL to dial and fail on. */
export function busAddress(text: string | undefined): string | null {
  if (typeof text !== 'string') return null;
  const named = text.trim();
  if (!/^wss?:\/\//i.test(named)) return null;
  try {
    // Parsed only to refuse what a WebSocket would refuse anyway, and with a reason that names it.
    if (new URL(named).hostname === '') return null;
  } catch {
    return null;
  }
  return named;
}
