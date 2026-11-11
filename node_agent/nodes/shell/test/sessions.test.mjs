// Long-running commands: the shell node spawns them, hands back a session handle, and keeps the
// process alive across calls. Each test builds its own node over a temp workspace and takes it
// down afterwards, so a leaked process group would show up as a live pid.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHILD_ENV_KEEP, childEnv, MAX_SESSIONS_RUNNING } from '../dist/index.js';
import { ShellNode, closeShellService, context, shell, tenant } from './support.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'shell-session-'));
  const node = shell(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { node };
}

/** Is this pid still around? */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait out a signal + the grace period the node gives before SIGKILL. */
function settle(ms = 800) {
  return new Promise((done) => setTimeout(done, ms));
}

/** The pid of `s1` as the `sessions` ability prints it. */
function pidOf(list) {
  const found = /pid (\d+)/.exec(list);
  assert.ok(found, `no pid in the sessions output: ${list}`);
  return Number(found[1]);
}

test('a short command comes back inline, without a session', async (t) => {
  const { node } = await setup(t);
  const output = await node.handle('exec', { command: 'echo hello' });

  assert.match(output, /^exit 0/);
  assert.match(output, /stdout:\nhello/);
  assert.equal(await node.handle('sessions', {}), '(no sessions)');
});

test('a long command comes back as a session handle', async (t) => {
  const { node } = await setup(t);
  const output = await node.handle('exec', {
    command: 'echo first; sleep 30',
    yield_ms: 300,
  });

  assert.match(output, /^running: session s1/);
  assert.match(output, /stdout:\nfirst/);
  assert.match(output, /shell\.write-stdin/);
  assert.match(await node.handle('sessions', {}), /^s1 {2}running/m);
});

test('write-stdin reads only what is new', async (t) => {
  const { node } = await setup(t);
  await node.handle('exec', { command: 'echo one; sleep 30', yield_ms: 300 });

  const poll = await node.handle('write-stdin', { session_id: 's1', yield_ms: 200 });
  assert.match(poll, /^running: session s1/);
  assert.doesNotMatch(poll, /one/);
});

test('write-stdin can feed stdin and then read the exit code', async (t) => {
  const { node } = await setup(t);
  await node.handle('exec', { command: 'read line; echo got:$line', yield_ms: 300 });

  const output = await node.handle('write-stdin', {
    session_id: 's1',
    chars: 'hi\n',
    yield_ms: 3000,
  });
  assert.match(output, /^exit 0/);
  assert.match(output, /got:hi/);
});

test('timeout_ms kills the command and still reports 124', async (t) => {
  const { node } = await setup(t);
  const output = await node.handle('exec', {
    command: 'sleep 30',
    yield_ms: 5000,
    timeout_ms: 300,
  });

  assert.match(output, /^exit 124/);
});

test('output is capped per read and can be drained', async (t) => {
  const { node } = await setup(t);
  let output = await node.handle('exec', {
    command: 'seq 1 2000; sleep 30',
    yield_ms: 400,
    max_output: 100,
  });
  assert.match(output, /more output/);

  for (let round = 0; round < 30 && /more output/.test(output); round += 1) {
    output = await node.handle('write-stdin', { session_id: 's1', yield_ms: 100 });
  }

  assert.doesNotMatch(output, /more output/);
  assert.match(output, /2000/);
});

test('kill-session stops the whole process group, not just the shell', async (t) => {
  const { node } = await setup(t);
  const output = await node.handle('exec', {
    command: 'sleep 30 & echo bg=$!; wait',
    yield_ms: 400,
  });
  const grandchild = Number(/bg=(\d+)/.exec(output)[1]);
  assert.ok(alive(grandchild), 'background child should be running');

  assert.match(await node.handle('kill-session', { session_id: 's1' }), /sent SIGTERM/);
  await settle();

  assert.equal(alive(grandchild), false, 'background child outlived the kill');
});

test("closing a tenant's service takes its live sessions down with it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shell-session-'));
  const id = tenant();
  const node = new ShellNode(context(id), { workspace: root });
  t.after(async () => {
    closeShellService(id);
    await rm(root, { recursive: true, force: true });
  });
  await node.handle('exec', { command: 'sleep 30', yield_ms: 300 });
  const pid = pidOf(await node.handle('sessions', {}));
  assert.ok(alive(pid));

  closeShellService(id);
  await settle();

  assert.equal(alive(pid), false);
});

test('running sessions are capped', async (t) => {
  const { node } = await setup(t);
  for (let i = 0; i < MAX_SESSIONS_RUNNING; i += 1) {
    await node.handle('exec', { command: 'sleep 30', yield_ms: 200 });
  }

  await assert.rejects(
    node.handle('exec', { command: 'sleep 30', yield_ms: 200 }),
    /at most 8 long commands/,
  );
});

test('an unknown session id is a plain error', async (t) => {
  const { node } = await setup(t);
  await assert.rejects(node.handle('write-stdin', { session_id: 's9' }), /no session/);
  await assert.rejects(node.handle('kill-session', { session_id: 's9' }), /no session/);
});

test('a command that cannot start reports why instead of hanging', async (t) => {
  const { node } = await setup(t);
  await assert.rejects(
    node.handle('exec', { command: 'echo hi', cwd: 'missing', yield_ms: 1000 }),
    /could not start the command/,
  );
});

/** Set some variables in this process's environment for one test, and put them back afterwards. */
function withEnv(t, vars) {
  const saved = new Map();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('childEnv keeps the whitelist and drops every other name', () => {
  const env = childEnv({
    PATH: '/usr/bin',
    HOME: '/home/x',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    USER: 'u',
    LOGNAME: 'u',
    TMPDIR: '/tmp',
    TZ: 'UTC',
    NODE_AGENT_TOKEN: 't',
    NODE_AGENT_BUS_URL: 'ws://127.0.0.1:7000',
    SERVE_PASSWORD: 'p',
    DEEPSEEK_API_KEY: 'k',
    MY_SECRET: 's',
    SSH_AUTH_SOCK: '/tmp/ssh',
    AWS_ACCESS_KEY_ID: 'a',
    GITHUB_TOKEN: 'g',
    NPM_TOKEN: 'n',
    NODE_OPTIONS: '--inspect',
    LD_PRELOAD: '/tmp/evil.so',
  });

  assert.deepEqual(Object.keys(env).sort(), [
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TZ',
    'USER',
  ]);
  assert.equal(env.PATH, '/usr/bin', 'a kept name keeps its value');
});

test('the whitelist itself never names something that looks like a secret', () => {
  // The whole point of the whitelist is that it is short and boring. This assertion is the guard
  // on the guard: if someone adds `DEEPSEEK_API_KEY` or `GITHUB_TOKEN` here "so the command can see
  // it", the leak is back, and this test says so instead of the next reader having to notice.
  for (const pattern of CHILD_ENV_KEEP) {
    const name = pattern.replace(/\*$/, '');
    assert.doesNotMatch(
      name,
      /(TOKEN|SECRET|KEY|PASS|PASSWORD)$/i,
      `"${pattern}" in CHILD_ENV_KEEP looks like a secret: a command must not inherit it`,
    );
    assert.doesNotMatch(
      name,
      /^(NODE_AGENT_|SERVE_)/,
      `"${pattern}" in CHILD_ENV_KEEP is this node's own: a command must not inherit it`,
    );
  }
});

test('a command cannot read the node\'s own secrets', async (t) => {
  const probe = 'bus-token-must-not-leak';
  withEnv(t, {
    NODE_AGENT_TOKEN: probe,
    SERVE_PASSWORD: probe,
    DEEPSEEK_API_KEY: probe,
    GITHUB_TOKEN: probe,
  });
  const { node } = await setup(t);

  const output = await node.handle('exec', { command: 'echo "[$NODE_AGENT_TOKEN]"; env' });
  assert.match(output, /stdout:\n\[\]/, 'the token expanded to nothing');
  assert.doesNotMatch(output, new RegExp(probe));
  assert.doesNotMatch(output, /^(NODE_AGENT_|SERVE_|DEEPSEEK_API_KEY|GITHUB_TOKEN)/m);
});

test('a command still gets PATH, so the tools are findable', async (t) => {
  const { node } = await setup(t);
  const output = await node.handle('exec', { command: 'echo "path=$PATH"; command -v sh' });

  assert.match(output, /path=\/\S+/, 'PATH is set and not empty');
  assert.match(output, /\/sh/, 'sh resolves inside the command');
});
