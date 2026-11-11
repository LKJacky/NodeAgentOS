// The page and the manifest: the node fills its own name in, every script block parses, the
// capabilities the page calls are the ones this package declares, and `ui` hands the page out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadNodePackage, manifestFromPackage } from '@node-agent/sdk';
import { CAPABILITIES, page } from '../src/agent.ts';
import { ScriptedProvider } from './scripted_model.ts';
import { FakeNet, startAgent } from './harness.ts';

const ROOT = new URL('..', import.meta.url);
const SOURCE = readFileSync(new URL('src/ui.html', ROOT), 'utf8');

test('the page is handed out with this node name filled in', () => {
  assert.match(SOURCE, /const INJECTED = "__NODE__";/, 'the shipped page carries the placeholder');
  const filled = page('agent-2');
  assert.doesNotMatch(filled, /__NODE__/);
  assert.match(filled, /const INJECTED = "agent-2";/);
  // The renderer is inlined: the page draws Markdown without reaching for another route.
  assert.doesNotMatch(filled, /__MARKDOWN_IT__/);
  assert.match(filled, /markdownit/);
});

test('the renderer inlined in the page can be used the way the page uses it', () => {
  // The page registers its markdown plugins with `.use(...)` before it does anything else that touches
  // markdown. A renderer without `use` throws on that line and nothing after it runs — no transcript,
  // no provider list, no token counters — so the fallback has to carry the same surface as the real
  // bundle, and the package has to find a bundle in copies that ship no `dist/markdown-it.min.js`.
  const source = readFileSync(new URL('src/agent.ts', ROOT), 'utf8');
  const fallback = /const PLAIN_TEXT_RENDERER = `([\s\S]*?)`;/.exec(source)?.[1];
  assert.ok(fallback, 'the fallback renderer is a literal');
  assert.match(fallback, /use\s*:/, 'the fallback carries use()');
  assert.match(fallback, /render\s*:/, 'and render()');
  assert.match(
    source,
    /markdown-it\/dist\/markdown-it\.js/,
    'a package without the minified bundle still gives the page the real renderer',
  );
});

test('every script the page carries parses', () => {
  const blocks = [...SOURCE.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length > 0, 'the page has scripts');
  for (const [index, block] of blocks.entries()) {
    const code = block[1] ?? '';
    if (code.trim() === '') continue;
    assert.doesNotThrow(() => new vm.Script(code), `script block ${index} parses`);
  }
});

test('the manifest declares the capabilities this package serves', () => {
  const manifest = manifestFromPackage(
    JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')),
    { directory: fileURLToPath(ROOT) },
  );
  assert.equal(manifest.name, 'agent');
  assert.deepEqual(Object.keys(manifest.caps).sort(), [...CAPABILITIES].sort());
  assert.deepEqual(manifest.bindings, ['agent-runtime'], 'the runtime the host keeps per tenant');
  const panel = manifest.caps['ui'] as Record<string, unknown>;
  assert.equal(panel.slot, 'left', 'the webui puts the agent in the left column');
  assert.match(String(panel.icon), /^<svg/);
  assert.match(String(manifest.caps['chat']?.description), /hand this agent one message/);
});

test('the page calls only capabilities this node has', () => {
  const called = new Set(
    [...SOURCE.matchAll(/\$\{NODE\}\.([a-z_]+)/g)].map((match) => match[1] as string),
  );
  assert.ok(called.size > 0, 'the page calls its own node');
  for (const cap of called) {
    assert.ok((CAPABILITIES as readonly string[]).includes(cap), `page calls ${cap}`);
  }
  for (const wanted of ['chat_no_wait', 'history', 'status', 'stop', 'provider', 'answer']) {
    assert.ok(called.has(wanted), `the page uses ${wanted}`);
  }
});

test('the ui capability answers with the page', async () => {
  const agent = await startAgent({ net: new FakeNet(), provider: new ScriptedProvider() });
  try {
    const html = String(await agent.call('ui', {}));
    assert.match(html, /const INJECTED = "agent";/);
    assert.doesNotMatch(html, /__NODE__/);
  } finally {
    await agent.stop();
  }
});

test('the page draws the question, the stop button and the provider switch', () => {
  for (const wanted of [
    'ask-choice',
    'ask-countdown',
    'ask_timeout',
    'id="stop"',
    'provider-switch',
    'reasoning_content',
    'prompt-tokens',
  ]) {
    assert.ok(SOURCE.includes(wanted), `the page carries ${wanted}`);
  }
});

test('the package loads as a node definition the shared runtime can host', async () => {
  const loaded = await loadNodePackage(fileURLToPath(ROOT));
  assert.equal(loaded.manifest.name, 'agent');
  assert.equal(loaded.Node.name, 'AgentNode');
  const instance = new loaded.Node({
    nodeId: 'agent',
    tenantId: 't',
    from: 'probe',
    deadline: Date.now() + 1_000,
    signal: new AbortController().signal,
    call: async () => ({}),
    publish: () => undefined,
    fetch,
  });
  assert.deepEqual(Object.keys(instance.handlers).sort(), [...CAPABILITIES].sort());
  await instance.dispose();
});
