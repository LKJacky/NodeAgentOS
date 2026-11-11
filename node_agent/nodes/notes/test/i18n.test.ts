import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { labelText, nodeManifestOfPackage } from '@node-agent/sdk';
import { NAMES, NotesNode } from '../src/index.ts';
import { testContext } from './support.ts';

/** A resource file as dotted keys: `{ label: { node: 'x' } }` → `label.node`. */
function flatten(entries: unknown, prefix = '', into: Record<string, string> = {}) {
  for (const [name, value] of Object.entries((entries ?? {}) as Record<string, unknown>)) {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    if (typeof value === 'string') into[key] = value;
    else if (value !== null && typeof value === 'object') flatten(value, key, into);
  }
  return into;
}

/** One language's file, flat: what a translator edits, as the page and the manifest read it. */
function resource(locale: 'en' | 'zh-CN'): Record<string, string> {
  return flatten(
    JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), 'utf8')),
  );
}

test('every word the page shows has a sentence in both languages', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  const en = resource('en');
  const zh = resource('zh-CN');

  // What the markup marks (text, placeholder, aria-label) plus what its script builds with t('…').
  const marked = [...html.matchAll(/data-text-(?:placeholder-|label-)?key="([^"]+)"/g)].map((one) =>
    String(one[1]),
  );
  const built = [...html.matchAll(/\bt\('([^']+)'/g)].map((one) => String(one[1]));
  assert.ok(marked.length >= 20, 'the page marks the words it shows');
  assert.ok(built.length >= 20, 'the sentences it builds at run time go through t(…));');

  for (const key of [...marked, ...built]) {
    assert.equal(typeof en[key], 'string', `${key} has English`);
    assert.equal(typeof zh[key], 'string', `${key} has Chinese`);
    assert.notEqual(en[key]?.trim(), '', `${key} is not blank in English`);
    assert.notEqual(zh[key]?.trim(), '', `${key} is not blank in Chinese`);
  }

  // One file per language, the same keys in each: a translator sees exactly what is missing.
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('the manifest names the node, every capability and every argument, in both languages', () => {
  const manifest = nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url)));
  const labels = manifest.labels;
  assert.ok(labels, 'the package declares its words, so the manifest carries labels');

  for (const locale of ['en', 'zh-CN'] as const) {
    assert.equal(labelText(labels.node, locale), locale === 'en' ? 'Notes' : '笔记');
    for (const cap of [...NAMES, 'ui']) {
      assert.ok(labelText(labels.caps?.[cap], locale), `${cap} is named in ${locale}`);
      const schema = manifest.caps[cap] as { properties?: Record<string, unknown> };
      for (const arg of Object.keys(schema.properties ?? {}))
        assert.ok(
          labelText(labels.args?.[cap]?.[arg], locale),
          `${cap}.${arg} is named in ${locale}`,
        );
    }
  }
});

test('the page is drawn in the language asked for, and its words arrive with it', async () => {
  const notes = new NotesNode(testContext());
  const english = String(await notes.handlers.ui!({}));

  assert.match(english, /<html lang="en">/, 'a page asked for without a language is English');
  assert.match(english, /data-text-key="title">Notes · node_agent</, 'the first paint is right');
  assert.match(english, /data-text-placeholder-key="search\.placeholder"/);
  assert.match(english, /placeholder="Search your memos…"/);
  assert.match(english, /data-text-key="button\.save">Save now</);

  // The slot is filled with this node's resource, its name is in place, and the markers stay so a
  // later change of language is redrawn by the SDK's browser half without a reload.
  assert.doesNotMatch(english, /node-agent:i18n-resource/);
  assert.doesNotMatch(english, /__NODE__/);
  assert.match(english, /src="\/sdk\/i18n-client\.js"/);

  const embedded = /<script type="application\/json" data-i18n-resource>(.*?)<\/script>/.exec(
    english,
  );
  assert.ok(embedded !== null, 'the page carries its resource');
  const carried = JSON.parse(embedded[1] ?? '') as Record<string, Record<string, string>>;
  assert.equal(carried.en?.['editor.createTitle'], 'Create a memo');
  assert.equal(carried['zh-CN']?.['editor.createTitle'], '新建笔记');

  const chinese = String(await notes.handlers.ui!({ language: 'zh-CN' }));
  assert.match(chinese, /<html lang="zh-CN">/, 'the language asked for is the language drawn');
  assert.match(chinese, /data-text-key="title">笔记 · node_agent</);
  assert.match(chinese, /data-text-key="button\.save">立即保存</);
  assert.match(chinese, /data-text-key="editor\.createTitle">新建笔记</);
  assert.match(chinese, /data-text-placeholder-key="search\.placeholder"/);
  assert.match(chinese, /placeholder="搜索你的笔记…"/);
  assert.match(chinese, /data-text-label-key="search\.label"/);
  assert.match(chinese, /aria-label="搜索笔记"/);
  // A sentence with a count in it is painted with the count the page starts from.
  assert.match(chinese, /data-text-key="editor\.countEmpty"[\s\S]{0,80}>0 个字符</);
});
