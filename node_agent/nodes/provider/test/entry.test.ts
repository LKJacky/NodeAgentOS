// The process entry as a process, joining a bus that lives inside this test.
//
// The bug this file is here for: the package carried a second bin (`provider-entry` -> dist/index.js)
// whose whole body was `await import('./serve.js')`. The runner loads the package's `node.entry`,
// which was that same dist/index.js, so the two waited for each other: the process printed
// `unsettled top-level await`, exited 13 and registered nothing. Now there is one bin
// (`provider` -> dist/serve.js), `node.entry` names it, and dist/index.js is only the class.
//
// The bus is the real one, in-process, so no deployment is needed: what is asserted is the manifest
// the bus accepted, labels and all.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bus } from '../../../bus/src/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'provider-entry-token';
const LOCAL_LABEL = { 'zh-CN': '本地模型服务', en: 'Local provider' };
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
  node: { entry: string };
};

/** A bus of this test's own, and one provider process started against it. */
async function started(t: { after: (fn: () => Promise<void> | void) => void }, args: string[]) {
  const bus = await new Bus(TOKEN).listen();
  const output: string[] = [];
  // The package's own bin, as `npx @node-agent/provider` would run it.
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
    bus,
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

/** Run a built file to completion and report how it ended. */
function exit(pathParts: string[], args: string[] = []): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, ...pathParts), ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_AGENT_BUS_URL: 'ws://127.0.0.1:9', NODE_AGENT_TOKEN: 'x' },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code));
  });
}

test('one bin, and it is the package entry', () => {
  // The SDK requires a bin target to be `node.entry`; the entry is therefore the CLI file too.
  assert.deepEqual(PACKAGE.bin, { provider: 'dist/serve.js' });
  assert.equal(PACKAGE.node.entry, 'dist/serve.js');
});

test('dist/index.js is the class, not a CLI: it exits 0 instead of 13', async () => {
  // The regression: `provider-entry` (dist/index.js) used to wait for the runner that loads it.
  assert.equal(await exit(['dist', 'index.js']), 0);
  assert.equal(await exit(['dist', 'index.js'], ['--local']), 0);
  const built = (await import('../dist/index.js')) as { default?: unknown };
  assert.equal(typeof built.default, 'function');
  assert.equal((built.default as { name: string }).name, 'ProviderNode');
});

test('a plain start registers provider under the package words', async (t) => {
  const { bus, registered } = await started(t, []);
  const manifest = await registered('provider');

  assert.equal(manifest.packageId, 'provider');
  // Nothing was overridden: the manifest is the package's own.
  assert.deepEqual(manifest.labels?.node, { en: 'Provider', 'zh-CN': '模型服务' });
  assert.ok(Object.keys(manifest.caps).includes('providers'));
  assert.equal(bus.envelopeNodes.has('local-provider'), false);
});

test('--local registers local-provider, labelled as the local one', async (t) => {
  const { bus, registered } = await started(t, ['--local']);
  const manifest = await registered('local-provider');

  assert.equal(manifest.packageId, 'local-provider');
  // The words a page reads move with the address, and the caps stay the package's.
  assert.deepEqual(manifest.labels?.node, LOCAL_LABEL);
  // Only the node's own words moved: its capabilities keep the labels the package translated.
  assert.ok(manifest.labels?.caps?.providers !== undefined);
  assert.ok(Object.keys(manifest.caps).includes('providers'));
  assert.equal(bus.envelopeNodes.has('provider'), false, 'local mode must not claim the shared id');
});
