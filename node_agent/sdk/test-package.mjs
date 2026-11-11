import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNodePackage, manifestFromPackage, nodeManifestOfPackage } from './dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'node-agent-package-'));
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.js'), 'export default class ExampleNode {}\n');
writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({
    name: 'node-agent-example',
    version: '1.2.3',
    publisher: 'tester',
    type: 'module',
    node: {
      id: 'example',
      desc: 'an example node',
      entry: 'dist/index.js',
      caps: { ping: { type: 'object', properties: {} } },
      icon: 'icon.svg',
    },
  }),
);

const manifest = nodeManifestOfPackage(root);
const loaded = await loadNodePackage(root);
assert.equal(typeof loaded.Node, 'function');
assert.equal(manifest.packageId, 'example', 'the package id is node.id, not a second field');
assert.deepEqual(manifest, {
  packageId: 'example',
  name: 'example',
  desc: 'an example node',
  version: '1.2.3',
  publisher: 'tester',
  icon: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  caps: { ping: { type: 'object', properties: {} } },
});

// A package that names its i18n folder gets its display names from the files in it — and its
// identifiers stay exactly what the manifest declared.
const labelledRoot = mkdtempSync(join(tmpdir(), 'node-agent-labelled-'));
mkdirSync(join(labelledRoot, 'dist', 'i18n'), { recursive: true });
writeFileSync(join(labelledRoot, 'dist', 'index.js'), 'export default class LabelledNode {}\n');
writeFileSync(
  join(labelledRoot, 'dist', 'i18n', 'en.json'),
  '{"label":{"node":"Labelled","caps":{"ping":"Ping"},"args":{"ping":{"n":"Count"}}}}',
);
writeFileSync(
  join(labelledRoot, 'dist', 'i18n', 'zh-CN.json'),
  '{"label":{"node":"标签","caps":{"ping":"探查"}}}',
);
writeFileSync(
  join(labelledRoot, 'package.json'),
  JSON.stringify({
    name: 'node-agent-labelled',
    version: '1.0.0',
    publisher: 'tester',
    type: 'module',
    node: {
      id: 'labelled',
      desc: 'a labelled node',
      entry: 'dist/index.js',
      i18n: 'dist/i18n',
      caps: { ping: { type: 'object', properties: {} } },
      icon: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    },
  }),
);
try {
  const labelled = nodeManifestOfPackage(labelledRoot);
  assert.deepEqual(labelled.labels, {
    node: { en: 'Labelled', 'zh-CN': '标签' },
    caps: { ping: { en: 'Ping', 'zh-CN': '探查' } },
    args: { ping: { n: { en: 'Count' } } },
  });
  assert.deepEqual(
    Object.keys(labelled.caps),
    ['ping'],
    'the cap names are still the manifest ones',
  );
  assert.deepEqual(labelled.caps.ping, { type: 'object', properties: {} }, 'not a label in sight');

  // A folder that is named but unreadable is an error at load, not a page of canonical names.
  writeFileSync(
    join(labelledRoot, 'package.json'),
    JSON.stringify({
      name: 'node-agent-labelled',
      version: '1.0.0',
      publisher: 'tester',
      type: 'module',
      node: {
        id: 'labelled',
        desc: 'a labelled node',
        entry: 'dist/index.js',
        i18n: 'dist/lang',
        caps: { ping: { type: 'object', properties: {} } },
        icon: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      },
    }),
  );
  assert.throws(() => nodeManifestOfPackage(labelledRoot), /no i18n resource files/);
} finally {
  rmSync(labelledRoot, { recursive: true, force: true });
}

assert.throws(
  () =>
    manifestFromPackage({
      name: 'bad',
      version: '1.0.0',
      publisher: 'tester',
      type: 'module',
      bin: { bad: './dist/serve.js' },
      node: {
        id: 'Bad Name',
        desc: 'bad',
        entry: 'dist/serve.js',
        caps: { ping: { type: 'object' } },
      },
    }),
  /node.id/,
);
assert.throws(
  () =>
    manifestFromPackage({
      name: 'bad',
      version: '1.0.0',
      publisher: 'tester',
      type: 'module',
      bin: { bad: './dist/other.js' },
      node: {
        id: 'bad',
        desc: 'bad',
        entry: 'dist/serve.js',
        caps: { ping: { type: 'object' } },
        icon: '<svg></svg>',
      },
    }),
  /bin targets/,
);
assert.throws(
  () =>
    manifestFromPackage({
      name: 'bad',
      version: '1.0.0',
      type: 'module',
      bin: { bad: './dist/serve.js' },
      node: { id: 'bad', desc: 'bad', entry: 'dist/serve.js', caps: { ping: { type: 'object' } } },
    }),
  /publisher/,
);

const frontEnd = manifestFromPackage({
  name: 'node-agent-webui',
  version: '0.1.0',
  publisher: 'node-agent',
  type: 'module',
  bin: { 'node-agent-webui': './dist/serve.js' },
  node: { id: 'webui', desc: 'front end', entry: 'dist/serve.js', caps: {}, icon: '<svg></svg>' },
});
assert.deepEqual(frontEnd.caps, {}, 'a front end may have no callable capability');

const underscored = manifestFromPackage({
  name: 'node-agent-underscored',
  version: '0.1.0',
  publisher: 'node-agent',
  type: 'module',
  node: {
    id: 'underscored',
    desc: 'underscore capability',
    entry: 'dist/index.js',
    caps: { chat_stream: { type: 'object' } },
    icon: '<svg></svg>',
  },
});
assert.deepEqual(
  Object.keys(underscored.caps),
  ['chat_stream'],
  'a capability may use an underscore',
);

// A packed package carries the icon as a string, so no directory is needed to read it back.
const inlineIcon = manifestFromPackage({
  name: 'node-agent-inline-icon',
  version: '0.1.0',
  publisher: 'node-agent',
  type: 'module',
  node: {
    id: 'inline-icon',

    desc: 'inline icon',
    entry: 'dist/index.js',
    caps: { ping: { type: 'object' } },
    icon: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  },
});
assert.equal(inlineIcon.icon, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

assert.throws(
  () =>
    manifestFromPackage({
      name: 'node-agent-no-icon',
      version: '0.1.0',
      publisher: 'node-agent',
      type: 'module',
      node: { id: 'no-icon', desc: 'no icon', entry: 'dist/index.js', caps: {} },
    }),
  /node.icon/,
);

// node.bindings: the keys a node may keep an object under, declared up front and validated here.
const pkg = (bindings) => ({
  name: 'node-agent-bindings',
  version: '0.1.0',
  publisher: 'node-agent',
  type: 'module',
  node: {
    id: 'bindings',
    desc: 'declares what it keeps',
    entry: 'dist/index.js',
    caps: { ping: { type: 'object' } },
    icon: '<svg></svg>',
    ...(bindings === undefined ? {} : { bindings }),
  },
});

assert.equal(
  manifestFromPackage(pkg(undefined)).bindings,
  undefined,
  'a node that keeps nothing declares nothing',
);
assert.deepEqual(manifestFromPackage(pkg(['tasks', 'sessions'])).bindings, ['tasks', 'sessions']);
assert.deepEqual(
  manifestFromPackage(pkg(['tasks'])).bindings,
  ['tasks'],
  'bindings reach the manifest the bus registers',
);

for (const [bad, why] of [
  [['tasks', 'tasks'], /names tasks twice/],
  [[], /at least one binding/],
  ['tasks', /must be an array/],
  [[1], /is not a binding name/],
  [[''], /is not a binding name/],
  [['Tasks'], /is not a binding name/],
  [['two words'], /is not a binding name/],
]) {
  assert.throws(() => manifestFromPackage(pkg(bad)), why, JSON.stringify(bad));
}

rmSync(root, { recursive: true, force: true });
console.log('package format ok');
