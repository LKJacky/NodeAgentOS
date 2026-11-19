// The page's words, and the manifest's: every sentence the page shows has one in both languages, the
// two files hold exactly the same keys, and the directory names the node, every capability and every
// argument of it in the reader's language. A key renamed in the markup and not in the files reads as a
// key on the screen; a sentence only one language has is a hole a translator cannot see.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  labelText,
  loadResource,
  nodeManifestOfPackage,
  paintPage,
  type Resource,
} from '@node-agent/sdk';

const ROOT = new URL('..', import.meta.url);
const HTML = readFileSync(new URL('src/ui.html', ROOT), 'utf8');

/** A resource file as dotted keys: `{ settings: { save: 'Save' } }` → `settings.save`. */
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
  return flatten(JSON.parse(readFileSync(new URL(`src/i18n/${locale}.json`, ROOT), 'utf8')));
}

/** The page as the node serves it, in one language. */
function drawn(language?: string): string {
  const words: Resource = loadResource(new URL('src/i18n/', ROOT));
  return paintPage(HTML, words, language === undefined ? {} : { language });
}

test('every word the page shows has a sentence in both languages', () => {
  const en = resource('en');
  const zh = resource('zh-CN');
  const marked = [...HTML.matchAll(/data-text-(?:placeholder-|label-|title-)?key="([^"]+)"/g)].map(
    (one) => String(one[1]),
  );
  const built = [...HTML.matchAll(/\bt\('([^']+)'/g)].map((one) => String(one[1]));
  assert.ok(marked.length >= 20, 'the page marks the words it shows');
  assert.ok(built.length >= 20, 'the sentences it builds at run time go through t(…)');

  for (const key of [...marked, ...built]) {
    assert.equal(typeof en[key], 'string', `${key} has English`);
    assert.equal(typeof zh[key], 'string', `${key} has Chinese`);
    assert.notEqual(en[key]?.trim(), '', `${key} is not blank in English`);
    assert.notEqual(zh[key]?.trim(), '', `${key} is not blank in Chinese`);
  }

  // One file per language, the same keys in each: a translator sees exactly what is missing.
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());

  // A sentence with a placeholder keeps it in both languages, or the value it carries is lost.
  for (const [key, value] of Object.entries(en)) {
    const holes = [...value.matchAll(/\{(\w+)\}/g)].map((one) => String(one[1])).sort();
    if (holes.length === 0) continue;
    const translated = [...(zh[key] ?? '').matchAll(/\{(\w+)\}/g)].map((one) => String(one[1]));
    assert.deepEqual(translated.sort(), holes, `${key} carries the same placeholders in both`);
  }
});

test('the settings panel has a sentence for every field, in both languages', () => {
  const en = resource('en');
  const zh = resource('zh-CN');
  // The fields the node's `settings` capability takes, each with the words a reader needs: the label
  // and the range under it. A field the panel cannot name is a field nobody can change.
  const fields = [
    'maxAgents',
    'maxInputLengthPerTurn',
    'compressionThreshold',
    'compressionTokens',
    'cacheSize',
    'allowSpawn',
    'allowAskUser',
    'allowSearchCache',
  ];
  // The fields this release removed, and the words a page showed for them: a sentence left behind in
  // one language is a field nobody can change any more, spelled out on the screen.
  const removed = [
    'systemPrompt',
    'systemPromptPlaceholder',
    'systemPromptHint',
    'streamIdleMs',
    'streamIdleMsHint',
    'askTimeoutSeconds',
    'askTimeoutSecondsHint',
    'restoreAgents',
    'restoreAgentsHint',
    'retentionMaxMessages',
    'retentionMaxMessagesHint',
    'retentionTtlMs',
    'retentionTtlMsHint',
  ];
  for (const gone of removed) {
    for (const [locale, filled] of [
      ['en', en],
      ['zh-CN', zh],
    ] as const) {
      assert.equal(
        Object.hasOwn(filled, `settings.${gone}`),
        false,
        `settings.${gone} is gone from ${locale}`,
      );
    }
    assert.equal(
      HTML.includes(`settings.${gone}`),
      false,
      `the page no longer marks settings.${gone}`,
    );
  }
  const others = ['open', 'title', 'hint', 'provider', 'save', 'saving', 'reset', 'close'];
  for (const field of [...fields, ...others]) {
    for (const [locale, filled] of [
      ['en', en],
      ['zh-CN', zh],
    ] as const) {
      assert.equal(
        typeof filled[`settings.${field}`],
        'string',
        `settings.${field} is named in ${locale}`,
      );
    }
  }
  for (const field of fields) {
    assert.equal(typeof en[`settings.${field}Hint`], 'string', `${field} states its range`);
    assert.equal(
      typeof zh[`settings.${field}Hint`],
      'string',
      `${field} states its range in Chinese`,
    );
  }
  // The page's own keys for the two answers a save can produce.
  for (const key of ['saved', 'unchanged', 'resetDone', 'saveFailed', 'readFailed']) {
    assert.equal(typeof en[`settings.${key}`], 'string', `settings.${key} exists`);
    assert.equal(typeof zh[`settings.${key}`], 'string', `settings.${key} exists in Chinese`);
  }
});

test('the manifest names the node, every capability and every argument, in both languages', () => {
  const manifest = nodeManifestOfPackage(fileURLToPath(ROOT));
  const labels = manifest.labels;
  assert.ok(labels, 'the package declares its words, so the manifest carries labels');

  for (const locale of ['en', 'zh-CN'] as const) {
    assert.ok(labelText(labels.node, locale), `the node is named in ${locale}`);
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

  // The settings capability is named the way a reader looking for it would look.
  assert.equal(labelText(labels.caps?.settings, 'en'), 'Settings');
  assert.equal(labelText(labels.caps?.settings, 'zh-CN'), '设置');
  assert.equal(labelText(labels.args?.settings?.maxAgents, 'en'), 'Sub-agents at once');
  assert.equal(labelText(labels.args?.settings?.maxAgents, 'zh-CN'), '同时运行的子智能体');
});

test('the settings panel is drawn in the language asked for', () => {
  const english = drawn('en');
  assert.match(english, /data-text-key="settings.title">Settings</);
  assert.match(english, /data-text-key="settings.compressionThreshold"/);
  assert.match(english, /data-text-key="settings.cacheSize">Cached texts kept</);
  assert.match(english, /data-text-key="settings.allowSpawn">/);
  assert.match(english, /data-text-key="settings.allowAskUser">/);
  assert.match(english, /data-text-key="settings.allowSearchCache">/);
  assert.equal(english.includes('settings.systemPrompt'), false, 'the instruction line is gone');
  assert.match(english, /data-text-key="settings.maxAgents">Sub-agents at once</);
  assert.match(english, /data-text-key="settings.save">/);
  assert.match(english, /data-text-label-key="settings.open"/);
  assert.match(english, /aria-label="Agent settings"/);

  const chinese = drawn('zh-CN');
  assert.match(chinese, /<html lang="zh-CN"/, 'the language asked for is the language drawn');
  assert.match(chinese, /data-text-key="settings.title">设置</);
  assert.match(chinese, /data-text-key="settings.compressionThreshold"/);
  assert.match(chinese, /data-text-key="settings.cacheSize">缓存保留的文本数</);
  assert.match(chinese, /data-text-key="settings.allowSpawn">/);
  assert.match(chinese, /data-text-key="settings.allowAskUser">/);
  assert.match(chinese, /data-text-key="settings.allowSearchCache">/);
  assert.equal(chinese.includes('settings.systemPrompt'), false, 'the instruction line is gone');
  assert.match(chinese, /data-text-key="settings.maxAgents">同时运行的子智能体</);
  assert.match(chinese, /aria-label="智能体设置"/);

  // Both languages travel in the page, so a change of language needs no reload.
  const embedded = /<script type="application\/json" data-i18n-resource>(.*?)<\/script>/.exec(
    english,
  );
  assert.ok(embedded !== null, 'the page carries its resource');
  const carried = JSON.parse(embedded[1] ?? '') as Record<string, Record<string, string>>;
  assert.equal(carried.en?.['settings.save'], 'Save');
  assert.equal(carried['zh-CN']?.['settings.save'], '保存');
});
