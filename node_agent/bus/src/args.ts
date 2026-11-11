// One way in for every entry: `--url` and `--token`, the same two names whether the bus is this
// process, a neighbour on the same network, or a front door on another machine. Nothing here asks
// which deployment shape it is talking to - the URL already says, and the token is whatever that bus
// accepts. The environment (NODE_AGENT_BUS_URL / NODE_AGENT_TOKEN) is the fallback a container uses;
// a flag wins over it, so running an entry by hand needs no exported variable.
import { DEFAULT_HOST, busAddress, busFromEnv } from './node.js';

/** A command line this entry will not act on: answered with one line, not a stack trace. */
export class UsageError extends Error {}

export interface BusArgs {
  /** The bus as one URL: `--url`, else NODE_AGENT_BUS_URL, else ws://127.0.0.1:8788. */
  url: string;
  /** `--token`, else NODE_AGENT_TOKEN (whose own default is `demo-token`). */
  token: string;
  /** Whether `--url` was on the command line: an entry that owns a bus binds where it says, instead
   *  of at NODE_AGENT_BUS_BIND / NODE_AGENT_BUS_PORT. */
  fromFlag: boolean;
  /** For an entry that owns a bus: the host and port `--url` names. `null` when no URL was given, so
   *  the environment keeps deciding (`NODE_AGENT_BUS_BIND` / `NODE_AGENT_BUS_PORT`). */
  bind: { host: string; port: number } | null;
  /** Everything the bus flags did not claim, for an entry with options of its own (`--map`, `--tui`). */
  rest: string[];
}

export function busUsage(name: string, extra = ''): string {
  return `usage: ${name} [--url <ws://host:port | wss://host/bus>] [--token <token>]${extra ? ` ${extra}` : ''}`;
}

/** Parse the bus flags. Pure: throws `UsageError` for a bad or removed one, never exits. */
export function parseBusArgs(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  ownsBus = false,
): BusArgs {
  let url: string | undefined;
  let token: string | undefined;
  const rest: string[] = [];

  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[at + 1];
      if (next === undefined) throw new UsageError(`${name} wants a value`);
      at += 1;
      return next;
    };

    if (name === '--url') url = value();
    else if (name === '--token') token = value();
    else rest.push(arg);
  }

  const named = url === undefined ? undefined : (busAddress(url) ?? undefined);
  if (url !== undefined && named === undefined)
    throw new UsageError(`--url wants a ws:// or wss:// URL, not "${url}"`);
  // The address says where; `--token` says who. A URL with the token baked in was the old form and is
  // refused here, at the command line, rather than deep in a dial that would otherwise look fine.
  if (named !== undefined && /([?&])token=/.test(named))
    throw new UsageError(
      '--url carries the address only: pass the token as --token (or NODE_AGENT_TOKEN)',
    );

  return {
    url: named ?? busFromEnv(env),
    token: token ?? env.NODE_AGENT_TOKEN ?? 'demo-token',
    fromFlag: url !== undefined,
    bind: !ownsBus || named === undefined ? null : listenAddress(named),
    rest,
  };
}

/** How `busArgsOrExit` treats the flags it did not claim: `extra` is appended to the usage line, an
 *  entry that owns a bus has its `--url` read as a listen address, and one with options of its own
 *  (`--map`, `--tui`) keeps the leftovers instead of refusing them. */
export interface BusArgsOptions {
  extra?: string;
  ownsBus?: boolean;
  allowsRest?: boolean;
}

/** `parseBusArgs`, with the answers an entry owes its caller: `--help` prints the usage and exits 0; a
 *  bad command line or a flag the entry does not know prints one line plus the usage and exits 2. */
export function busArgsOrExit(name: string, options: BusArgsOptions = {}): BusArgs {
  const extra = options.extra ?? '';
  let args: BusArgs;
  try {
    args = parseBusArgs(process.argv.slice(2), process.env, options.ownsBus ?? false);
    if (args.rest.includes('--help') || args.rest.includes('-h')) {
      console.log(busUsage(name, extra));
      process.exit(0);
    }
    if (!options.allowsRest && args.rest.length > 0)
      throw new UsageError(`unknown option: ${args.rest[0]}`);
  } catch (e: unknown) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${name}: ${e.message}`);
    console.error(busUsage(name, extra));
    process.exit(2);
  }
  return args;
}

/** Where an entry that owns a bus should listen, read from the URL it was given. Only the plain
 *  protocol: TLS ends in front of the process, so a wss:// URL is a deployment asking this entry to
 *  do something it does not. */
export function listenAddress(url: string): { host: string; port: number } {
  const named = busAddress(url);
  if (named === null) throw new UsageError(`--url wants a ws:// or wss:// URL, not "${url}"`);
  const parsed = new URL(named);
  if (parsed.protocol === 'wss:')
    throw new UsageError('this entry serves plain ws://; terminate TLS in front of it');
  if (parsed.pathname !== '' && parsed.pathname !== '/')
    throw new UsageError(`an entry that binds its own bus answers at /, not ${parsed.pathname}`);
  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, '$1') || DEFAULT_HOST,
    port: Number(parsed.port) || 0,
  };
}
