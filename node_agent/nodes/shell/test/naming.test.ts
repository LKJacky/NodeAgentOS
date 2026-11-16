// What the shell registers under, without a bus in the way.
//
// `dist/serve.js` is the package's one process entry and the file its `bin` names, so the way a name
// becomes a registration is a pure function there and these tests read it directly. The bug they
// pin down: `npx @node-agent/shell --name computer` answered as `computer` (and `computer.exec`, ...)
// while `labels.node` still said `Shell / 终端` - the address moved and the words did not.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeManifestOfPackage } from '@node-agent/sdk';
import { namedId, namedLabel, namedServeOptions } from '../src/serve.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
  node: { entry: string };
};

/** The manifest the package really declares, i18n labels and all. */
const manifest = nodeManifestOfPackage(ROOT);

test('the bin is the process entry, and the package entry is the same file', () => {
  // `npx @node-agent/shell` runs dist/serve.js: one CLI entry, no second copy of the start-up code.
  assert.equal(PACKAGE.bin['node-agent-shell'], './dist/serve.js');
  // The SDK requires a bin target to be `node.entry`, so the entry is the CLI file too; it still
  // exports `ShellNode` as its default, which is what the loader takes the class from.
  assert.equal(PACKAGE.node.entry, 'dist/serve.js');
  assert.deepEqual(Object.keys(PACKAGE.bin), ['node-agent-shell']);
});

test('the package on its own is called shell, and says so', () => {
  assert.equal(manifest.name, 'shell');
  assert.equal(manifest.packageId, 'shell');
  assert.deepEqual(manifest.labels?.node, { en: 'Shell', 'zh-CN': '终端' });
});

test('--name computer is handed to the runner as an id *and* a label', () => {
  // The label is the part that used to be missed: `servePackage` renames `name` and `packageId` from
  // the id, and writes the label into `labels.node`. `test/named-entry.test.ts` checks the result on
  // a real bus; here it is the options the entry builds.
  assert.deepEqual(namedServeOptions('computer'), {
    id: 'computer',
    label: { 'zh-CN': 'computer', en: 'computer' },
  });
  assert.deepEqual(namedLabel('computer'), { 'zh-CN': 'computer', en: 'computer' });
});

test('a start without --name overrides nothing', () => {
  assert.deepEqual(namedServeOptions(''), {});
});

test('the name comes from --name, then NODE_AGENT_NODE_ID', () => {
  const argv = ['node', 'dist/serve.js'];
  assert.equal(namedId([...argv, '--name', 'computer'], {}), 'computer');
  assert.equal(namedId([...argv, '--name', '  computer  '], {}), 'computer');
  assert.equal(namedId(argv, { NODE_AGENT_NODE_ID: 'computer' }), 'computer');
  // A flag beats the environment: a supervisor sets the variable, the user typed the command.
  assert.equal(namedId([...argv, '--name', 'laptop'], { NODE_AGENT_NODE_ID: 'computer' }), 'laptop');
  // Nothing asked for: the package's own id stands.
  assert.equal(namedId(argv, {}), '');
  assert.equal(namedId([...argv, '--name'], {}), '');
  assert.equal(namedId(argv, { NODE_AGENT_NODE_ID: '   ' }), '');
});
