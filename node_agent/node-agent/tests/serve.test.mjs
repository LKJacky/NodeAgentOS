// Tests for the entry itself: the lines it prints, what NODE_AGENT_NODES can and cannot do, and the
// stop rule that makes it usable as a container command.
//
// The stop rule is the one that already bit this repo once: an entry that treats end of stdin as
// "stop" ends the moment a container starts it detached, because /dev/null reads as EOF at once. The
// entry is started here with stdin ignored (which is /dev/null) and must stay up.
//
// Every child gets a throwaway NODE_AGENT_HOME: the tests must never write into the real ~/.node_agent.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { line, portOf, start, tenant } from './entry.mjs';
import { TOKEN, connectProbe } from './probe.mjs';

// The deployment set this entry starts when NODE_AGENT_NODES says nothing: the whole set of
// companions beside the core, search first and the page last (serve.ts carries the same list). The
// home set: the reader's connect page is inside introduce, so there is no standalone userpage module
// for this entry to know.
const DEFAULT_NODES =
  'history, agent, system, provider, webui, notes, todo, timer, search, introduce';

test('the default is the whole set, and it survives /dev/null on stdin', async (t) => {
  const entry = tenant(t);

  const busLine = await line(entry, 'bus: ');
  assert.ok(portOf(busLine) > 0, busLine);
  assert.equal(await line(entry, 'nodes: '), `nodes: ${DEFAULT_NODES}`);

  // The regression: EOF on stdin must not be read as "stop".
  await delay(500);
  assert.equal(entry.child.exitCode, null, 'the entry stopped on EOF from /dev/null');

  // The node that owns a port opened it, and the page answers.
  const page = (await line(entry, 'webui: ')).slice('webui: '.length);
  assert.equal((await fetch(page)).status, 200);
  assert.equal(await line(entry, 'connect: '), `connect: ${page}`);

  const stopped = once(entry.child, 'exit');
  entry.child.kill('SIGTERM');
  assert.equal((await stopped)[0], 0);
});

test('NODE_AGENT_NODES= is the bare core', async (t) => {
  const entry = tenant(t, { NODE_AGENT_NODES: '' });

  assert.equal(await line(entry, 'nodes: '), 'nodes: history, agent, system');
  assert.deepEqual(
    entry.lines.filter((l) => l.startsWith('webui: ')),
    [],
    'the bare core opens no web UI',
  );
});

test('the loaded nodes are really on the bus, not just printed', async (t) => {
  const entry = tenant(t);
  const port = portOf(await line(entry, 'bus: '));
  await line(entry, 'nodes: ');

  const probe = await connectProbe(port);
  t.after(() => probe.close());
  const tools = await probe.tools();
  for (const tool of ['history.list', 'agent.chat', 'system.settings', 'provider.providers'])
    assert.ok(tools.includes(tool), `${tool} missing from ${tools.join(' ')}`);

  // A capability on each end of the stack answers: the settings the user owns, and the agent that
  // holds the conversation. (`provider.providers` is the model's own row and names one caller, so a
  // probe outside the stack is refused it -- which is why the list above checks it is published.)
  const language = await probe.call('system.language', {});
  assert.equal(language.ok, true, JSON.stringify(language));
  assert.equal(typeof language.value, 'string');
  const status = await probe.call('agent.status', {});
  assert.equal(status.ok, true, JSON.stringify(status));
});

// A module that cannot be loaded must be one line and exit 1: a typo must not quietly hand a
// deployment a stack without that node.
test('a NODE_AGENT_NODES that cannot be loaded is one line and exit 1', async () => {
  // A spec names a module and nothing else; an item with no module in it is refused.
  const malformed = start({ NODE_AGENT_NODES: 'node-agent-notes, ,' });
  assert.equal((await once(malformed.child, 'exit'))[0], 1);
  assert.match(malformed.errors.join(''), /names no module/);
  assert.deepEqual(malformed.lines, [], 'it printed a boot line as if it had started');

  // A module that is not installed: still one line, still exit 1.
  const missing = start({ NODE_AGENT_NODES: 'node-agent-does-not-exist:Nope' });
  assert.equal((await once(missing.child, 'exit'))[0], 1);
  assert.match(missing.errors.join(''), /node-agent-does-not-exist/);
  assert.equal(
    missing.lines.some((line) => line.startsWith('nodes: ')),
    false,
    'it printed the completed-stack banner after a startup failure',
  );
});

test("this entry does not know a standalone reader's page", async () => {
  const source = readFileSync(new URL('../src/serve.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /userpage/i, 'the connect page lives inside introduce now');

  const page = start({ NODE_AGENT_NODES: 'userpage' });
  assert.equal((await once(page.child, 'exit'))[0], 1);
  assert.match(page.errors.join(''), /userpage/);
  // The bus comes up before the first node is resolved, so that one line is expected; what must not
  // appear is a stack claiming it started, or a page it does not know.
  assert.deepEqual(
    page.lines.filter(
      (one) =>
        !one.startsWith('bus: ') &&
        !one.startsWith('runtime api: ') &&
        !one.startsWith('runtime: '),
    ),
    [],
    'nothing was started, let alone a page',
  );
});

test('--runtime-port serves the runtime API with its own token', async (t) => {
  const entry = tenant(t, { NODE_AGENT_NODES: '' }, [
    '--runtime-port',
    '0',
    '--runtime-token',
    'runtime-secret',
  ]);
  await line(entry, 'Ready to connect');
  const url = (await line(entry, 'runtime: ')).slice('runtime: '.length);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const refused = await fetch(`${url}/whoami`);
  assert.equal(refused.status, 401);
  const allowed = await fetch(`${url}/whoami`, {
    headers: { authorization: 'Bearer runtime-secret' },
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true, service: 'runtime' });

  const stopped = once(entry.child, 'exit');
  entry.child.kill('SIGTERM');
  assert.equal((await stopped)[0], 0);
});

test('--runtime-port without a token is refused before the bus starts', async () => {
  const entry = start({ NODE_AGENT_NODES: '' }, ['--runtime-port', '0']);
  const [code] = await once(entry.child, 'exit');
  assert.equal(code, 2);
  assert.match(entry.errors.join(''), /runtime API needs --runtime-token/);
});
