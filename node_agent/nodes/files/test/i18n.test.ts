import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { labelText, nodeManifestOfPackage } from '@node-agent/sdk';
import { NAMES, PANEL } from '../src/index.ts';

/** A resource file as dotted keys: `{ label: { node: 'x' } }` → `label.node`. */
function flatten(entries: unknown, prefix = '', into: Record<string, string> = {}) {
  for (const [name, value] of Object.entries((entries ?? {}) as Record<string, unknown>)) {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    if (typeof value === 'string') into[key] = value;
    else if (value !== null && typeof value === 'object') flatten(value, key, into);
  }
  return into;
}

/** One language's file, flat: what a translator edits, as the manifest reads it. */
function resource(locale: 'en' | 'zh-CN'): Record<string, string> {
  return flatten(
    JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), 'utf8')),
  );
}

test('the manifest names the node, every capability and every argument, in both languages', () => {
  const manifest = nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(manifest.name, 'files');
  const labels = manifest.labels;
  assert.ok(labels, 'the package declares its words, so the manifest carries labels');

  assert.equal(labelText(labels.node, 'en'), 'Files');
  assert.equal(labelText(labels.node, 'zh-CN'), '文件');
  assert.equal(
    labelText(labels.desc, 'zh-CN'),
    '总线上所有节点共享的文件：列出、读取、写入、删除、重命名，数据存放在 history 节点',
  );

  for (const locale of ['en', 'zh-CN'] as const) {
    for (const cap of [...NAMES, PANEL]) {
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

test('every word the page shows has a sentence in both languages', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  const en = resource('en');
  const zh = resource('zh-CN');

  // What the markup marks (text, placeholder, aria-label) plus what its script builds with t('…').
  const marked = [...html.matchAll(/data-text-(?:placeholder-|label-)?key="([^"]+)"/g)].map((one) =>
    String(one[1]),
  );
  const built = [...html.matchAll(/\bt\('([^']+)'/g)].map((one) => String(one[1]));
  assert.ok(marked.length >= 8, 'the page marks the words it shows');
  assert.ok(built.length >= 6, 'the sentences it builds at run time go through t(…)');

  for (const key of [...marked, ...built]) {
    assert.equal(typeof en[key], 'string', `${key} has English`);
    assert.equal(typeof zh[key], 'string', `${key} has Chinese`);
    assert.notEqual(en[key]?.trim(), '', `${key} is not blank in English`);
    assert.notEqual(zh[key]?.trim(), '', `${key} is not blank in Chinese`);
  }
});

test('both language files carry the same keys, and none of them is blank', () => {
  const en = resource('en');
  const zh = resource('zh-CN');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.notEqual(value.trim(), '', `${key} is not blank in English`);
    assert.notEqual(zh[key]?.trim(), '', `${key} is not blank in Chinese`);
  }
});

test('the package carries its own drawing, and it is a drawing rather than a script', () => {
  const icon = readFileSync(new URL('../src/icon.svg', import.meta.url), 'utf8').trim();
  assert.match(icon, /^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(icon, /viewBox="0 0 24 24"/, 'a node draws in the pages’ 24-unit box');
  assert.match(icon, /<(path|circle|rect|line|polyline)\b/, 'there is something to draw');
  assert.doesNotMatch(icon, /<script\b|[\s"'/]on[a-z]+\s*=|javascript:/i);

  const manifest = nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(manifest.icon.trim(), icon, 'the manifest hands over this very drawing');
});
