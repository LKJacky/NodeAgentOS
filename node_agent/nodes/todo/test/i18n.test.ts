import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  labelText,
  loadResource,
  nodeManifestOfPackage,
  paintPage,
  type Resource,
} from '@node-agent/sdk';

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

/** The page as the node serves it, in one language. */
function drawn(language?: string): string {
  const page = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  const words: Resource = loadResource(new URL('../src/i18n/', import.meta.url));
  return paintPage(page, words, language === undefined ? {} : { language });
}

// A page and a resource drift apart one key at a time: a sentence renamed in the markup and not in the
// files reads as a key on the screen, and a sentence only one language has is a hole a reader falls
// into. So the marks are collected from the page itself, not from a list kept here.
test('every word the page shows has a sentence in both languages', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  const en = resource('en');
  const zh = resource('zh-CN');

  const marked = [...html.matchAll(/data-text-(?:placeholder-|label-)?key="([^"]+)"/g)].map((one) =>
    String(one[1]),
  );
  const built = [...html.matchAll(/\bt\('([^']+)'/g)].map((one) => String(one[1]));
  assert.ok(marked.length >= 8, 'the page marks the words it shows');
  assert.ok(built.length >= 20, 'the sentences it builds at run time go through t(…))');

  // Keys the page picks through a variable (`t('row.' + …)`, a mode's own keys) cannot be read off the
  // markup, so they are named here: the page and this list have to agree.
  const chosen = [
    'row.moveUp',
    'row.moveDown',
    'row.reopen',
    'row.checkOff',
    'toast.movedUp',
    'toast.movedDown',
    'sort.manual',
    'sort.manualTitle',
    'sort.updated',
    'sort.updatedTitle',
    'sync.connecting',
    'sync.live',
    'sync.reconnecting',
  ];
  assert.match(html, /t\(`sync\.\$\{syncState\}`/, 'the sync light names its three states');
  assert.match(html, /titleKey: 'sort\.manualTitle'/, 'the sort modes name their words');

  for (const key of [...marked, ...built, ...chosen]) {
    assert.equal(typeof en[key], 'string', `${key} has English`);
    assert.equal(typeof zh[key], 'string', `${key} has Chinese`);
    assert.notEqual(en[key]?.trim(), '', `${key} is not blank in English`);
    assert.notEqual(zh[key]?.trim(), '', `${key} is not blank in Chinese`);
  }

  // One file per language, the same keys in each: a translator sees exactly what is missing.
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());

  // A sentence with a placeholder keeps it in both languages, or the count it carries is lost.
  for (const [key, value] of Object.entries(en)) {
    const holes = [...value.matchAll(/\{(\w+)\}/g)].map((one) => String(one[1])).sort();
    if (holes.length === 0) continue;
    const translated = [...(zh[key] ?? '').matchAll(/\{(\w+)\}/g)].map((one) => String(one[1]));
    assert.deepEqual(translated.sort(), holes, `${key} carries the same placeholders in both`);
  }
});

// The directory is the one place a caller learns what this node can do, and it speaks the reader's
// language: the node, every capability and every argument it takes.
test('the manifest names the node, every capability and every argument, in both languages', () => {
  const manifest = nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url)));
  const labels = manifest.labels;
  assert.ok(labels, 'the package declares its words, so the manifest carries labels');

  for (const locale of ['en', 'zh-CN'] as const) {
    assert.equal(labelText(labels.node, locale), locale === 'en' ? 'To-do' : '待办');
    for (const cap of Object.keys(manifest.caps)) {
      assert.ok(labelText(labels.caps?.[cap], locale), `${cap} is named in ${locale}`);
      const schema = manifest.caps[cap] as { properties?: Record<string, unknown> };
      for (const arg of Object.keys(schema.properties ?? {}))
        assert.ok(
          labelText(labels.args?.[cap]?.[arg], locale),
          `${cap}.${arg} is named in ${locale}`,
        );
    }
  }

  // The page itself is a capability too, and it is the one a directory lists last.
  assert.equal(labelText(labels.caps?.ui, 'en'), 'To-do page');
  assert.equal(labelText(labels.caps?.ui, 'zh-CN'), '待办页面');
});

test('the page is drawn in the language asked for, and its words arrive with it', () => {
  const english = drawn();

  assert.match(english, /<html lang="en"/, 'no language asked for is English');
  assert.match(english, /data-text-key="title">To-do · node_agent</);
  assert.match(english, /data-text-key="today\.title">Today</);
  assert.match(english, /data-text-placeholder-key="list\.placeholder"/);
  assert.match(english, /placeholder="Add a todo…"/);
  assert.match(english, /data-text-label-key="sort\.label"/);
  assert.match(english, /aria-label="Sort"/);
  assert.match(english, /data-text-key="list\.add">Add</);

  // The slot is filled with this node's resource, its name is in place, and the markers stay so a
  // later change of language is redrawn by the SDK's browser half without a reload.
  assert.doesNotMatch(english, /node-agent:i18n-resource/);
  assert.match(english, /src="\/sdk\/i18n-client\.js"/);
  assert.match(english, /data-text-key="today\.title"/, 'the marker is still there');

  const embedded = /<script type="application\/json" data-i18n-resource>(.*?)<\/script>/.exec(
    english,
  );
  assert.ok(embedded !== null, 'the page carries its resource');
  const carried = JSON.parse(embedded[1] ?? '') as Record<string, Record<string, string>>;
  assert.equal(carried.en?.['toast.moved'], 'Moved');
  assert.equal(carried['zh-CN']?.['toast.moved'], '已移动');

  const chinese = drawn('zh-CN');
  assert.match(chinese, /<html lang="zh-CN"/, 'the language asked for is the language drawn');
  assert.match(chinese, /data-text-key="title">待办 · node_agent</);
  assert.match(chinese, /data-text-key="today\.title">今天</);
  assert.match(chinese, /data-text-key="list\.title">你的清单</);
  assert.match(chinese, /data-text-placeholder-key="list\.placeholder"/);
  assert.match(chinese, /placeholder="添加待办…"/);
  assert.match(chinese, /data-text-label-key="sort\.label"/);
  assert.match(chinese, /aria-label="排序"/);
  assert.match(chinese, /data-text-label-key="list\.newLabel"/);
  assert.match(chinese, /aria-label="新待办的标题"/);
  assert.match(chinese, /data-text-key="presses\.summary">最近按下的按钮</);

  // A language nobody supports is not a language: the page is drawn in English rather than in keys.
  assert.match(drawn('fr-FR'), /data-text-key="today\.title">Today</);
});
