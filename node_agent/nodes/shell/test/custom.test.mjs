// The commands a user keeps on this shell: their shapes, their validation, and what running one does —
// including the part that matters most, that an argument is a word and never a piece of the script.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fakeHistory } from './history-double.mjs';
import { ShellNode, closeShellService, context, tenant, withEnv } from './support.mjs';

/** A workspace, a history node, and one tenant whose shell can be made again. */
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'shell-custom-'));
  await mkdir(join(root, 'sub'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const history = fakeHistory();
  const id = tenant();
  t.after(() => closeShellService(id));

  const make = (from = 'test-caller') =>
    new ShellNode(context(id, { from, call: history.call }), { workspace: root });

  return { root, history, id, make, node: make('webui'), caller: make('test-caller') };
}

/** One `custom-commands` call, answered as the page parses it. */
async function commands(node, args = {}) {
  return JSON.parse(String(await node.handle('custom-commands', args)));
}

/** A command added, so a run test can get to the running. */
function add(node, command) {
  return commands(node, { action: 'add', ...command });
}

test('a command is added, changed, deleted, and a restart keeps what is left', async (t) => {
  const { root, history, id, make, node } = await setup(t);

  const added = await add(node, {
    name: 'greet',
    description: 'say hello',
    command: 'printf "hello %s\n" "$1"',
  });
  assert.equal(added.persisted, true);
  assert.equal(added.commands.length, 1);
  assert.deepEqual(added.commands[0], {
    id: 'greet',
    name: 'greet',
    description: 'say hello',
    command: 'printf "hello %s\n" "$1"',
  });

  // Filed in history under this node, in the shape the unit names.
  const unit = history.units.get('shell.custom_commands');
  assert.deepEqual(unit.meta, {
    version: 1,
    commands: [
      {
        id: 'greet',
        name: 'greet',
        description: 'say hello',
        command: 'printf "hello %s\n" "$1"',
      },
    ],
  });

  // The optional fields a save carries when they are given.
  const full = await add(node, {
    name: 'build',
    command: 'make',
    cwd: 'sub',
    timeoutMs: 5_000,
    env: ['SHELL_CUSTOM_TEST', 'SHELL_CUSTOM_TEST'],
  });
  assert.deepEqual(full.commands[1], {
    id: 'build',
    name: 'build',
    description: '',
    command: 'make',
    cwd: 'sub',
    timeoutMs: 5_000,
    env: ['SHELL_CUSTOM_TEST'],
  });

  // A rename keeps the id: a link to a command survives the command's name changing.
  const renamed = await commands(node, {
    action: 'update',
    id: 'greet',
    name: 'greeter',
    command: 'echo hi',
  });
  assert.equal(renamed.commands[0].id, 'greet');
  assert.equal(renamed.commands[0].name, 'greeter');
  assert.equal(renamed.commands[0].description, '', 'an update is the whole command, not a patch');

  // A restart reads the list back from history.
  closeShellService(id);
  const again = make('webui');
  assert.deepEqual(
    (await commands(again)).commands.map((command) => command.name),
    ['greeter', 'build'],
  );

  // One by name, one by id; both work, which is what the page's links and a caller's `name` need.
  assert.equal((await commands(again, { action: 'get', name: 'build' })).command.cwd, 'sub');
  assert.equal((await commands(again, { action: 'get', id: 'greet' })).command.name, 'greeter');

  const deleted = await commands(again, { action: 'delete', id: 'greet' });
  assert.deepEqual(
    deleted.commands.map((command) => command.name),
    ['build'],
  );
  assert.deepEqual(
    history.units.get('shell.custom_commands').meta.commands.map((command) => command.name),
    ['build'],
  );
  assert.ok(root.length > 0);
});

test('a command that could never run is refused when it is saved, with the reason', async (t) => {
  const { node } = await setup(t);

  const bad = [
    [{ command: 'echo hi' }, /a command name is/],
    [{ name: '../escape', command: 'echo hi' }, /a command name is/],
    [{ name: 'a b', command: 'echo hi' }, /a command name is/],
    [{ name: 'empty' }, /needs a command/],
    [{ name: 'blank', command: '   ' }, /needs a command/],
    [{ name: 'slow', command: 'true', timeoutMs: 0 }, /positive whole number/],
    [{ name: 'slower', command: 'true', timeoutMs: 1.5 }, /positive whole number/],
    [{ name: 'slowest', command: 'true', timeoutMs: 4_000_000 }, /at most 1800000 ms/],
    [{ name: 'env', command: 'true', env: ['BAD NAME'] }, /is not a variable name/],
    [
      { name: 'token', command: 'true', env: ['NODE_AGENT_TOKEN'] },
      /NODE_AGENT_\* is the shell's own credential family/,
    ],
    [
      { name: 'too-many', command: 'true', env: Array.from({ length: 33 }, (_, i) => `V${i}`) },
      /at most 32 variables/,
    ],
  ];
  for (const [command, pattern] of bad) {
    await assert.rejects(node.handle('custom-commands', { action: 'add', ...command }), {
      message: pattern,
    });
  }

  await add(node, { name: 'greet', command: 'echo hi' });
  await assert.rejects(
    node.handle('custom-commands', { action: 'add', name: 'greet', command: 'echo' }),
    {
      message: 'there is already a custom command named "greet"',
    },
  );
  await assert.rejects(
    node.handle('custom-commands', { action: 'update', id: 'nope', command: 'x' }),
    {
      message: /no custom command "nope"/,
    },
  );
  await assert.rejects(node.handle('custom-commands', { action: 'delete', name: 'nope' }), {
    message: /no custom command "nope"/,
  });
  await assert.rejects(node.handle('custom-commands', { action: 'explode' }), {
    message: /custom-commands takes list \/ get \/ add \/ update \/ delete/,
  });
});

test('run-custom runs the script, and an argument is a word never a piece of code', async (t) => {
  const { root, node } = await setup(t);
  await add(node, {
    name: 'echoes',
    command: 'printf "$#|%s|%s|%s\n" "$1" "$2" "$SHELL_CUSTOM_ARGS"',
  });

  const plain = await node.handle('run-custom', {
    name: 'echoes',
    args: ['one', 'two words'],
  });
  assert.match(plain, /^exit 0/m);
  assert.match(plain, /2\|one\|two words\|\["one","two words"\]/);

  // The words that would be code if they were pasted into the script: they arrive as words, the
  // files they name are never made, and `$(…)` is never run.
  const hostile = await node.handle('run-custom', {
    name: 'echoes',
    args: ['; touch pwned', '$(touch pwned2)'],
  });
  assert.match(hostile, /2\|; touch pwned\|\$\(touch pwned2\)\|/);
  await assert.rejects(readFile(join(root, 'pwned')));
  await assert.rejects(readFile(join(root, 'pwned2')));

  // `$0` says which command ran, so a script can name itself.
  await add(node, { name: 'whoami-ish', command: 'echo "$0"' });
  assert.match(await node.handle('run-custom', { name: 'whoami-ish' }), /shell-custom:whoami-ish/);

  // A word may be a number: the JSON form of the arguments keeps it as the caller wrote it.
  await add(node, { name: 'counts', command: 'printf "%s\n" "$SHELL_CUSTOM_COUNT"' });
  assert.match(await node.handle('run-custom', { name: 'counts', args: [1, 2, 3] }), /3/);
});

test('run-custom runs where the command says, and with the variables it named', async (t) => {
  const { root, node } = await setup(t);
  withEnv(t, { SHELL_CUSTOM_TEST: 'from the shell', NODE_AGENT_TOKEN: 'do not leak' });

  await add(node, { name: 'where', command: 'pwd' });
  assert.match(await node.handle('run-custom', { name: 'where' }), new RegExp(`^${root}$`, 'm'));

  await add(node, { name: 'inside', command: 'pwd', cwd: 'sub' });
  assert.match(
    await node.handle('run-custom', { name: 'inside' }),
    new RegExp(`^${root}/sub$`, 'm'),
  );

  await add(node, {
    name: 'named',
    command: 'printf "%s\n" "${SHELL_CUSTOM_TEST:-unset}"',
    env: ['SHELL_CUSTOM_TEST'],
  });
  assert.match(await node.handle('run-custom', { name: 'named' }), /from the shell/);

  // A variable it did not name is not there, and the environment of the node is not inherited: the
  // same whitelist `exec` lives under still holds.
  await add(node, {
    name: 'unnamed',
    command: 'printf "[%s]\n" "${SHELL_CUSTOM_TEST:-unset}" "${NODE_AGENT_TOKEN:-unset}"',
  });
  assert.match(await node.handle('run-custom', { name: 'unnamed' }), /\[unset\]\n\[unset\]/);
});

test("run-custom keeps exec's deadline and output ceiling", async (t) => {
  const { node } = await setup(t);

  await add(node, { name: 'slow', command: 'sleep 5', timeoutMs: 300 });
  const killed = await node.handle('run-custom', { name: 'slow', yield_ms: 3_000 });
  assert.match(killed, /exit 124 \(killed on timeout\)/);

  // The command's own deadline is the default; a call may only shorten it, never outlive the ceiling.
  await add(node, { name: 'chatty', command: 'head -c 5000 /dev/zero | tr "\\0" "y"' });
  const cut = await node.handle('run-custom', { name: 'chatty' });
  assert.ok(cut.length < 4_500, `the answer was ${cut.length} characters`);
  assert.match(cut, /more output; keep reading with shell\.write-stdin/);
});

test('run-custom obeys the switches, and says which one refused it', async (t) => {
  const { node, caller } = await setup(t);
  await add(node, { name: 'greet', command: 'echo hi' });

  await node.handle('set-permissions', { caps: { 'run-custom': false } });
  await assert.rejects(caller.handle('run-custom', { name: 'greet' }), {
    message: 'shell.run-custom is disabled by the user for node "test-caller"',
  });

  // The command is still there to be read and to be switched back on: the refusal is about running.
  assert.equal((await commands(node)).commands.length, 1);
  await node.handle('set-permissions', { caps: { 'run-custom': true } });
  assert.match(await node.handle('run-custom', { name: 'greet' }), /hi/);
});

test('the custom-commands switch controls agents but not webui', async (t) => {
  const { node, caller } = await setup(t);
  await add(node, { name: 'greet', command: 'echo hi' });

  await node.handle('set-permissions', { caps: { 'custom-commands': false } });
  await assert.rejects(caller.handle('custom-commands', { action: 'list' }), {
    message: 'shell.custom-commands is disabled by the user for node "test-caller"',
  });
  // The page still manages its commands while the agent-facing switch is off.
  assert.equal((await commands(node)).commands.length, 1);

  await node.handle('set-permissions', { caps: { 'custom-commands': true } });
  assert.equal((await commands(caller)).commands.length, 1);
});

test('run-custom asks for a name, and knows which names it has', async (t) => {
  const { node } = await setup(t);
  await assert.rejects(node.handle('run-custom', {}), { message: /run-custom needs a name/ });
  await assert.rejects(node.handle('run-custom', { name: 'nope' }), {
    message: /no custom command "nope"/,
  });

  await add(node, { name: 'greet', command: 'echo hi' });
  await assert.rejects(node.handle('run-custom', { name: 'greet', args: 'not a list' }), {
    message: /args is a list of words/,
  });
  await assert.rejects(node.handle('run-custom', { name: 'greet', args: [{}] }), {
    message: /an argument is a string, a number or a boolean/,
  });
});
