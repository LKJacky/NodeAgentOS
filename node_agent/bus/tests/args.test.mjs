// One command line for every entry: --url and --token, whatever deployment it belongs to. These
// tests pin the parser the entries share:
//
//   - --url / --token (separate or `=`) beat the environment, and a flag is remembered as a flag;
//   - without flags the environment composes the URL, exactly as it always has;
//   - a value that is not ws:// or wss:// is refused where it is given, with one line;
//   - --host and --port are refused by name: an entry is told one address now, and a leftover old
//     command line must not be silently ignored;
//   - an entry that owns a bus reads where to listen out of the same URL.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError, listenAddress, parseBusArgs } from '../dist/index.js';

/** An empty environment: the defaults are then the code's own, not this machine's. */
const CLEAR = {};

test('--url and --token beat the environment, and the address keeps its path', () => {
  const args = parseBusArgs(['--url', 'wss://front/bus', '--token', 't'], {
    NODE_AGENT_BUS_URL: 'ws://env:1',
    NODE_AGENT_TOKEN: 'from-env',
  });

  assert.equal(args.url, 'wss://front/bus');
  assert.equal(args.token, 't');
  assert.equal(args.fromFlag, true);
  assert.deepEqual(args.rest, []);
});

test('a URL with a token inside it is refused: address and token are two things', () => {
  assert.throws(
    () => parseBusArgs(['--url', 'wss://front/bus?token=abc', '--token', 't'], CLEAR),
    /address only/,
  );
});

test('the `=` form is the same flag', () => {
  const args = parseBusArgs(['--url=ws://127.0.0.1:9', '--token=x'], CLEAR);

  assert.equal(args.url, 'ws://127.0.0.1:9');
  assert.equal(args.token, 'x');
});

test('without flags the environment speaks, and a flag is not remembered', () => {
  const args = parseBusArgs([], { NODE_AGENT_BUS_URL: 'ws://core:8788', NODE_AGENT_TOKEN: 'env' });

  assert.equal(args.url, 'ws://core:8788');
  assert.equal(args.token, 'env');
  assert.equal(args.fromFlag, false);
  assert.equal(args.bind, null);
});

test('a bind host and port do not name where a node dials', () => {
  const args = parseBusArgs([], { NODE_AGENT_BUS_HOST: 'core', NODE_AGENT_BUS_PORT: '9000' });

  assert.equal(args.url, 'ws://127.0.0.1:8788');
});

test('something that is not a URL is refused where it is given', () => {
  assert.throws(() => parseBusArgs(['--url', '127.0.0.1:8788'], CLEAR), UsageError);
  assert.throws(() => parseBusArgs(['--url', 'http://127.0.0.1:8788'], CLEAR), UsageError);
  assert.throws(() => parseBusArgs(['--url'], CLEAR), UsageError);
});

test('a flag the parser does not claim is left for the entry to refuse', () => {
  // There is no --host / --port any more, and no silent ignore either: the entry decides, and the
  // entries that have no flags of their own answer `unknown option` (see busArgsOrExit).
  const args = parseBusArgs(['--port', '8788'], CLEAR);

  assert.deepEqual(args.rest, ['--port', '8788']);
});

test('flags an entry owns are left for it', () => {
  const args = parseBusArgs(['--map', 'work', '--url', 'ws://x:1'], CLEAR);

  assert.deepEqual(args.rest, ['--map', 'work']);
  assert.equal(args.url, 'ws://x:1');
});

test('an entry that owns a bus listens where --url says', () => {
  assert.deepEqual(listenAddress('ws://0.0.0.0:8788'), { host: '0.0.0.0', port: 8788 });
  assert.deepEqual(listenAddress('ws://[::1]:8788/'), { host: '::1', port: 8788 });
  // No port: the OS picks one, the same as binding port 0 always has.
  assert.deepEqual(listenAddress('ws://127.0.0.1'), { host: '127.0.0.1', port: 0 });

  // Only an entry that owns a bus reads its --url as a listen address; a joining entry keeps any URL.
  assert.equal(parseBusArgs(['--url', 'wss://front/bus'], CLEAR).bind, null);
  assert.deepEqual(parseBusArgs(['--url', 'ws://0.0.0.0:9100'], CLEAR, true).bind, {
    host: '0.0.0.0',
    port: 9100,
  });
  // ... and that is the one place a wss:// URL is refused: TLS terminates in front of a bus.
  assert.throws(() => parseBusArgs(['--url', 'wss://front/bus'], CLEAR, true), /terminate TLS/);
});

test('a bind address cannot be TLS or carry a path', () => {
  assert.throws(() => listenAddress('wss://127.0.0.1:8788'), /terminate TLS/);
  assert.throws(() => listenAddress('ws://127.0.0.1:8788/bus'), /answers at \//);
});
