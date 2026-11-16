// The bin as a process, joining a bus that lives inside this test.
//
// `test/naming.test.ts` checks the decision; this checks that the process really makes it, and that
// the built files are the ones the package advertises: `dist/serve.js` is the bin, and the class is
// still what `dist/index.js` exports (the SDK loads the package entry for it).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bus } from '../../../bus/src/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'shell-entry-token';

/** A bus of this test's own, and one shell process started against it. */
async function started(t: { after: (fn: () => Promise<void> | void) => void }, args: string[]) {
  const bus = await new Bus(TOKEN).listen();
  const output: string[] = [];
  // The package's own bin, as `npx @node-agent/shell` would run it.
  const child = spawn(process.execPath, [join(ROOT, 'dist', 'serve.js'), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_AGENT_BUS_URL: bus.url,
      NODE_AGENT_TOKEN: TOKEN,
      NODE_AGENT_TENANT: 'default',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  t.after(async () => {
    child.kill('SIGTERM');
    bus.close();
  });

  return {
    /** The manifest the bus registered under `name`, once it has. */
    registered: async (name: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const node = bus.envelopeNodes.get(name);
        if (node !== undefined) return node.manifest;
        if (child.exitCode !== null)
          assert.fail(
            `dist/serve.js exited (${child.exitCode}) without registering: ${output.join('')}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return assert.fail(`dist/serve.js never registered ${name}: ${output.join('')}`);
    },
  };
}

test('--name computer registers computer, and is listed as computer', async (t) => {
  const { registered } = await started(t, ['--name', 'computer']);
  const manifest = await registered('computer');

  assert.equal(manifest.packageId, 'computer');
  assert.deepEqual(manifest.labels?.node, { 'zh-CN': 'computer', en: 'computer' });
  // The capabilities are still the shell's: only the address and its name moved.
  assert.ok(Object.keys(manifest.caps).includes('exec'));
  assert.deepEqual(manifest.labels?.caps?.exec, { en: 'Run a command', 'zh-CN': '执行命令' });
});

test('a start without --name registers shell under the package words', async (t) => {
  const { registered } = await started(t, []);
  const manifest = await registered('shell');

  assert.equal(manifest.packageId, 'shell');
  assert.deepEqual(manifest.labels?.node, { en: 'Shell', 'zh-CN': '终端' });
});

test('the built entry still exports the Node class', async () => {
  // What the SDK loads: `node.entry` is dist/index.js, and it must stay a library - importing it
  // starts no host and needs no bus.
  const built = (await import('../dist/index.js')) as { default?: unknown };
  assert.equal(typeof built.default, 'function');
  assert.equal((built.default as { name: string }).name, 'ShellNode');
});
