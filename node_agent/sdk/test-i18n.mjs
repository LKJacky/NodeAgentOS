// i18n as the SDK now sees it: tags are vocabulary, and a sentence is a `Text` the caller wrote.
// There is no catalog to test here — the SDK has no words of its own.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOCALE,
  LOCALES,
  RESOURCE_ATTRIBUTE,
  Text,
  acceptLanguageTags,
  flattenResource,
  isLocale,
  labelText,
  manifestLabels,
  paintPage,
  paintResource,
  loadResource,
  normalizeLocale,
  resolveAcceptLanguage,
  resolveLocale,
  resourceScript,
  resourceTexts,
  resourceValue,
} from './dist/index.js';

// --- locale tags --------------------------------------------------------------------------------

for (const [value, wanted] of [
  ['zh-CN', 'zh-CN'],
  ['zh', 'zh-CN'],
  ['zh-Hans-CN', 'zh-CN'],
  ['zh-TW', 'zh-CN'],
  ['ZH_cn', 'zh-CN'],
  ['  zh-CH  ', 'zh-CN'],
  ['en', 'en'],
  ['en-US', 'en'],
  ['en_gb', 'en'],
  ['fr-FR', null],
  ['', null],
  ['   ', null],
  [null, null],
  [undefined, null],
  [42, null],
  [{}, null],
]) {
  assert.equal(normalizeLocale(value), wanted, `normalizeLocale(${JSON.stringify(value)})`);
}

assert.equal(DEFAULT_LOCALE, 'en');
assert.deepEqual([...LOCALES], ['zh-CN', 'en']);
assert.ok(isLocale('zh-CN') && isLocale('en'));
assert.equal(isLocale('zh'), false);
assert.equal(isLocale('fr'), false);

assert.equal(resolveLocale('zh-CN'), 'zh-CN');
assert.equal(resolveLocale('zh'), 'zh-CN');
assert.equal(resolveLocale('fr-CA'), DEFAULT_LOCALE);
assert.equal(resolveLocale(null), DEFAULT_LOCALE);
assert.equal(resolveLocale(undefined), DEFAULT_LOCALE);

// --- Accept-Language ----------------------------------------------------------------------------

assert.deepEqual(acceptLanguageTags('zh-CN,zh;q=0.9,en;q=0.8'), ['zh-CN', 'zh', 'en']);
assert.deepEqual(acceptLanguageTags('en;q=0.4, zh-CN;q=0.9'), ['zh-CN', 'en']);
assert.deepEqual(acceptLanguageTags('fr;q=0.5,de;q=0.5,zh-CN;q=0'), ['fr', 'de']);
assert.deepEqual(acceptLanguageTags(''), []);
assert.deepEqual(acceptLanguageTags(undefined), []);

assert.equal(resolveAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8'), 'zh-CN');
assert.equal(resolveAcceptLanguage('en-US,en;q=0.9'), 'en');
assert.equal(resolveAcceptLanguage('fr-FR,fr;q=0.9'), DEFAULT_LOCALE);
assert.equal(resolveAcceptLanguage(''), DEFAULT_LOCALE);
assert.equal(resolveAcceptLanguage(undefined), DEFAULT_LOCALE);
assert.equal(resolveAcceptLanguage('fr-FR,zh-CN;q=0.7'), 'zh-CN');

// --- the sentence the caller wrote --------------------------------------------------------------

// The documented usage, exactly: en/cn keys, read by one tag or the other.
const ok = new Text({ en: 'OK', cn: '确认' });
assert.equal(ok.get('zh-CN'), '确认');
assert.equal(ok.get('en'), 'OK');

// Every tag the user's profile can hold, and the variants a browser sends.
assert.equal(ok.get('zh'), '确认');
assert.equal(ok.get('zh-TW'), '确认');
assert.equal(ok.get('en-US'), 'OK');
// A tag we have no words for is resolved to the default before the lookup.
assert.equal(ok.get('fr-FR'), 'OK');
assert.equal(ok.get(), 'OK');
assert.equal(ok.get(null), 'OK');

// Both spellings of the Chinese key are accepted, and the full tag wins over the short one.
const spelled = new Text({ en: 'Save', 'zh-CN': '保存', cn: '存档' });
assert.equal(spelled.get('zh-CN'), '保存');
assert.equal(new Text({ en: 'Save', cn: '保存' }).get('zh-CN'), '保存');

// A sentence written in one language only is not blank in the other: it falls back to en.
assert.equal(new Text({ en: 'Only English' }).get('zh-CN'), 'Only English');
// ...and a text with no en at all falls back to the first value it has, then to an empty string.
assert.equal(new Text({ cn: '只有中文' }).get('en'), '只有中文');
assert.equal(new Text({}).get('en'), '');
// An empty entry is not a sentence: it is skipped.
assert.equal(new Text({ en: '', cn: '确认' }).get('en'), '确认');

// Parameters are filled per language; a placeholder with no value stays visible.
const greeting = new Text({ en: 'Hello, {name}', cn: '你好，{name}' });
assert.equal(greeting.get('en', { name: 'Ada' }), 'Hello, Ada');
assert.equal(greeting.get('zh-CN', { name: '阿达' }), '你好，阿达');
assert.equal(greeting.get('en'), 'Hello, {name}');
assert.equal(greeting.get('en', { other: 'x' }), 'Hello, {name}');
assert.equal(greeting.get('en', { name: 42 }), 'Hello, 42');

// A bare string is a sentence in English, and `Text.of` is the same thing without `new`.
assert.equal(new Text('Plain').get('zh-CN'), 'Plain');
assert.equal(Text.of({ en: 'OK', cn: '确认' }).get('zh-CN'), '确认');
assert.ok(Text.of('x') instanceof Text);

// `has` answers about what was written, not what would be shown; `toString` reads the default.
assert.equal(ok.has('zh-CN'), true);
assert.equal(ok.has('en'), true);
assert.equal(new Text({ en: 'Only English' }).has('zh-CN'), false);
assert.equal(`${ok}`, 'OK');

// The instance is a value: frozen, and the language is an argument rather than a field, so one
// instance renders two users at once.
const messages = { en: 'OK', cn: '确认' };
const shared = new Text(messages);
messages.cn = 'changed after construction';
assert.equal(shared.get('zh-CN'), '确认');
assert.ok(Object.isFrozen(shared.messages));
assert.equal(shared.get('en'), 'OK');
assert.equal(shared.get('zh-CN'), '确认');

// --- the browser half ---------------------------------------------------------------------------

// Outside a browser the module is a library: it starts nothing, and it says what it is set to.
const client = await import('./dist/i18n-client.js');
assert.equal(typeof globalThis.nodeAgentI18n, 'undefined');
assert.equal(client.currentLocale(), 'en');
// The page builds its sentences with the same class the node used.
assert.equal(new client.Text({ en: 'OK', cn: '确认' }).get(client.currentLocale()), 'OK');

assert.equal(client.setLocale('zh-CN'), 'zh-CN');
assert.equal(client.currentLocale(), 'zh-CN');
assert.equal(client.setLocale('fr-FR'), DEFAULT_LOCALE);

// A marked element carries its own sentence: `data-text-en` / `data-text-cn`, nothing global.
function element(attributes) {
  return {
    values: { ...attributes },
    textContent: '',
    get attributes() {
      return Object.entries(this.values).map(([name, value]) => ({ name, value }));
    },
    getAttribute(name) {
      return this.values[name] ?? null;
    },
    setAttribute(name, value) {
      this.values[name] = value;
    },
  };
}
const text = element({ 'data-text-en': 'OK', 'data-text-cn': '确认' });
const chineseOnly = element({ 'data-text-cn': '只有中文' });
const englishOnly = element({ 'data-text-en': 'English only' });
const placeholder = element({
  'data-text-placeholder-en': 'Search',
  'data-text-placeholder-cn': '搜索',
});
const untouched = element({ class: 'plain' });

client.setLocale('zh-CN');
assert.equal(client.textOf(text), '确认');
assert.equal(client.textOf(chineseOnly), '只有中文');
assert.equal(client.textOf(englishOnly), 'English only'); // fallback, not blank
assert.equal(client.textOf(untouched), null);
assert.equal(client.textOf(englishOnly, 'en'), 'English only');

const root = {
  querySelectorAll(selector) {
    if (selector.includes('data-text-placeholder')) return [placeholder];
    if (selector.includes('data-text-en')) return [text, chineseOnly, englishOnly, untouched];
    return [];
  },
};
client.applyTranslations(root);
assert.equal(text.textContent, '确认');
assert.equal(chineseOnly.textContent, '只有中文');
assert.equal(englishOnly.textContent, 'English only');
assert.equal(placeholder.getAttribute('placeholder'), '搜索');
assert.equal(untouched.textContent, '');
client.setLocale('en');
client.applyTranslations(root);
assert.equal(text.textContent, 'OK');
assert.equal(chineseOnly.textContent, '只有中文');
assert.equal(placeholder.getAttribute('placeholder'), 'Search');
// Something that is not a DOM is ignored rather than thrown at.
client.applyTranslations(null);
client.applyTranslations({});

// A language change arrives as one Server-Sent Event, wrapped by the webui. A browser has a document,
// so the test gives it one: that is where `setLocale` draws and where the announcement is dispatched.
const announced = [];
const documentDouble = {
  documentElement: { lang: '' },
  querySelectorAll: (selector) => root.querySelectorAll(selector),
  dispatchEvent: (event) => {
    announced.push(event);
    return true;
  },
};
globalThis.document = documentDouble;

const streams = [];
class FakeSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    streams.push(this);
  }
  close() {
    this.closed = true;
  }
}
const stop = client.watchLanguage({ source: FakeSource });
assert.equal(streams.length, 1);
assert.equal(streams[0].url, '/events?node=system&topic=language');

streams[0].onmessage({
  data: JSON.stringify({
    node: 'system',
    topic: 'language',
    from: 'system',
    value: { language: 'zh-CN', resolved: 'zh-CN' },
  }),
});
assert.equal(client.currentLocale(), 'zh-CN');
assert.equal(text.textContent, '确认', 'the page was redrawn when the language changed');
assert.equal(placeholder.getAttribute('placeholder'), '搜索');
assert.equal(documentDouble.documentElement.lang, 'zh-CN', 'the document says what it is drawn in');
assert.equal(announced.length, 1);
assert.equal(announced[0].type, 'node-agent:language');
assert.equal(announced[0].detail.language, 'zh-CN');
assert.equal(announced[0].detail.value.language, 'zh-CN');

// A bare payload works too, and an unreadable frame changes nothing (and announces nothing).
streams[0].onmessage({ data: JSON.stringify({ language: 'en' }) });
assert.equal(client.currentLocale(), 'en');
assert.equal(text.textContent, 'OK');
assert.equal(announced.length, 2);
streams[0].onmessage({ data: 'not json' });
assert.equal(client.currentLocale(), 'en');
streams[0].onmessage({ data: JSON.stringify({ value: null }) });
assert.equal(client.currentLocale(), 'en');
assert.equal(announced.length, 2);
// The same language again is not news: no redraw, no announcement.
streams[0].onmessage({ data: JSON.stringify({ language: 'en' }) });
assert.equal(announced.length, 2);

stop();
assert.equal(streams[0].closed, true);
// A webui supplies a logical handle, not another physical EventSource per translated page.
const sharedCalls = [];
const sharedStream = { close() { this.closed = true; } };
globalThis.NodeAgentEvents = { connect(url) { sharedCalls.push(url); return sharedStream; } };
const stopShared = client.watchLanguage();
assert.deepEqual(sharedCalls, ['/events?node=system&topic=language']);
sharedStream.onmessage({ data: JSON.stringify({ node: 'system', topic: 'language', value: { language: 'zh-CN' } }) });
assert.equal(client.currentLocale(), 'zh-CN');
stopShared();
assert.equal(sharedStream.closed, true);
// An explicitly injected source still wins, even inside a webui.
const stopInjected = client.watchLanguage({ source: FakeSource });
assert.equal(streams.length, 2);
assert.equal(sharedCalls.length, 1);
stopInjected();
delete globalThis.NodeAgentEvents;
delete globalThis.document;
assert.equal(typeof client.watchLanguage({ source: undefined }), 'function');

// --- the words in files ------------------------------------------------------------------------

// A resource is what a node writes down: one entry per language, keys as they read in the code.
const resource = {
  en: { save: 'Save settings', counts: { waiting: '{count} waiting' }, only: 'English only' },
  'zh-CN': { save: '保存设置', counts: { waiting: '{count}个等待中' } },
};
assert.deepEqual(flattenResource(resource.en), {
  save: 'Save settings',
  'counts.waiting': '{count} waiting',
  only: 'English only',
});
assert.deepEqual(flattenResource({ a: { b: { c: 'x' } }, skip: 1, also: null, list: ['x'] }), {
  'a.b.c': 'x',
});
assert.deepEqual(flattenResource(null), {});
assert.deepEqual(flattenResource([1, 2]), {});

// Every key becomes a Text, in the languages that wrote it — nested keys included.
const texts = resourceTexts(resource);
assert.equal(texts.save.get('zh-CN'), '保存设置');
assert.equal(texts.save.get('en'), 'Save settings');
assert.equal(texts['counts.waiting'].get('zh-CN', { count: 3 }), '3个等待中');
assert.equal(texts['counts.waiting'].get('en', { count: 3 }), '3 waiting');
// A key written only in English still reads in Chinese (the fallback is the point).
assert.equal(texts.only.get('zh-CN'), 'English only');
assert.equal(texts.only.has('zh-CN'), false);
// A short `cn` spelling in a file is the same language.
assert.equal(
  resourceTexts({ en: { save: 'Save' }, cn: { save: '保存' } }).save.get('zh-CN'),
  '保存',
);
// English is required: a key without it has nothing to fall back to, and the error says which.
assert.throws(
  () => resourceTexts({ en: { save: 'Save' }, 'zh-CN': { other: '只有中文' } }),
  /missing English for 1 key\(s\): other/,
);
assert.throws(() => resourceTexts({ 'zh-CN': { save: '保存' } }), /missing English/);
assert.deepEqual(resourceTexts({ en: {} }), {});
// An empty entry is not a sentence: a key with only whitespace-free emptiness in English is nameless.
assert.throws(
  () => resourceTexts({ en: { save: '' }, cn: { save: '保存' } }),
  /missing English for 1 key\(s\): save/,
);

// The same resource, ready for a page: one JSON script tag and no way to close it early.
const script = resourceScript({ en: { save: '</script><b>no</b>' } });
assert.ok(script.startsWith(`<script type="application/json" ${RESOURCE_ATTRIBUTE}>`));
assert.ok(script.endsWith('</script>'));
assert.equal(script.includes('</script><b>'), false);
const payload = JSON.parse(script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>')));
assert.deepEqual(payload, { en: { save: '</script><b>no</b>' } });

// The folder form: en.json + zh-CN.json beside each other, nested or not.
const folder = mkdtempSync(join(tmpdir(), 'na-i18n-'));
try {
  writeFileSync(
    join(folder, 'en.json'),
    JSON.stringify({ save: 'Save settings', counts: { waiting: '{count} waiting' } }),
  );
  writeFileSync(join(folder, 'zh-CN.json'), JSON.stringify({ save: '保存设置' }));
  const loaded = loadResource(folder);
  assert.deepEqual(loaded, {
    en: { save: 'Save settings', 'counts.waiting': '{count} waiting' },
    'zh-CN': { save: '保存设置' },
  });
  assert.equal(resourceTexts(loaded).save.get('zh-CN'), '保存设置');
  assert.equal(resourceValue(loaded, 'save', 'zh-TW'), '保存设置');
  assert.equal(resourceValue(loaded, 'counts.waiting', 'en'), '{count} waiting');
  assert.equal(resourceValue(loaded, 'nope', 'en'), 'nope', 'an absent key shows itself');

  // A file: URL works too (that is how a node addresses its own folder).
  const viaUrl = loadResource(new URL(`file://${folder}/`));
  assert.equal(resourceTexts(viaUrl).save.get('en'), 'Save settings');

  // En-only is a valid resource; `cn.json` is accepted for the Chinese file.
  const englishOnly = mkdtempSync(join(tmpdir(), 'na-i18n-'));
  try {
    writeFileSync(join(englishOnly, 'en.json'), '{"save":"Save"}');
    assert.deepEqual(loadResource(englishOnly), { en: { save: 'Save' } });
    writeFileSync(join(englishOnly, 'cn.json'), '{"save":"保存"}');
    assert.equal(resourceTexts(loadResource(englishOnly)).save.get('zh-CN'), '保存');
  } finally {
    rmSync(englishOnly, { recursive: true, force: true });
  }

  // A folder with no resource file, or with a broken one, fails at the name it read.
  const empty = mkdtempSync(join(tmpdir(), 'na-i18n-'));
  try {
    assert.throws(() => loadResource(empty), /no i18n resource files/);
    writeFileSync(join(empty, 'en.json'), '{not json');
    assert.throws(() => loadResource(empty), /en\.json is not valid JSON/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}

// --- a page that draws from the node's resource ----------------------------------------------

// The page carries the resource in a JSON script tag; the client reads it and never invents a key.
const resourceTag = {
  textContent: JSON.stringify({
    en: { save: 'Save', counts: { waiting: '{count} waiting' }, only: 'English only' },
    'zh-CN': { save: '保存', counts: { waiting: '{count}个等待中' } },
  }),
};
assert.deepEqual(client.resourceFromDocument({ querySelector: () => resourceTag }), {
  en: { save: 'Save', counts: { waiting: '{count} waiting' }, only: 'English only' },
  'zh-CN': { save: '保存', counts: { waiting: '{count}个等待中' } },
});
assert.equal(client.resourceFromDocument({ querySelector: () => null }), null);
assert.equal(
  client.resourceFromDocument({ querySelector: () => ({ textContent: '{not json' }) }),
  null,
);
assert.equal(client.resourceFromDocument(null), null);

const keyed = element({ 'data-text-key': 'save' });
const keyedParams = element({
  'data-text-key': 'counts.waiting',
  'data-text-params': '{"count":2}',
});
const keyedMissing = element({ 'data-text-key': 'nope' });
keyedMissing.textContent = 'untouched';
const keyedPlaceholder = element({ 'data-text-placeholder-key': 'save' });
const keyRoot = {
  querySelectorAll(selector) {
    if (selector === '[data-text-key]') return [keyed, keyedParams, keyedMissing];
    if (selector === '[data-text-placeholder-key]') return [keyedPlaceholder];
    return [];
  },
};

client.setLocale('zh-CN');
client.applyResource(client.resourceFromDocument({ querySelector: () => resourceTag }), keyRoot);
assert.equal(keyed.textContent, '保存');
assert.equal(keyedParams.textContent, '2个等待中');
assert.equal(keyedPlaceholder.getAttribute('placeholder'), '保存');
assert.equal(keyedMissing.textContent, 'untouched', 'an absent key is not invented');
assert.equal(client.keyText('only', 'zh-CN'), 'English only', 'a key only English wrote');
assert.equal(client.keyText('nope'), null);

// A language change redraws the keyed elements too (the page's document is the root).
const keyDocument = {
  documentElement: { lang: '' },
  querySelectorAll: (selector) => keyRoot.querySelectorAll(selector),
  dispatchEvent: () => true,
};
globalThis.document = keyDocument;
client.setLocale('en');
assert.equal(keyed.textContent, 'Save');
assert.equal(keyedParams.textContent, '2 waiting');
assert.equal(keyedPlaceholder.getAttribute('placeholder'), 'Save');
assert.equal(keyDocument.documentElement.lang, 'en');
delete globalThis.document;

// Dropping the resource leaves everything as it was drawn.
client.applyResource(null, keyRoot);
assert.equal(client.keyText('save'), null);

// --- display names for identifiers ------------------------------------------------------------

// The same files carry `label.*`: what a page shows for a node, a cap or an argument. The names
// themselves stay canonical — these are only what a reader sees.
const labelled = {
  en: {
    label: {
      node: 'System',
      caps: { add_timer: 'Add timer', settings: 'Settings' },
      args: { add_timer: { id: 'Timer id', at: 'Fires at' }, settings: { language: 'Language' } },
    },
    'settings.save': 'Save settings',
  },
  'zh-CN': {
    label: {
      node: '系统',
      caps: { add_timer: '新增计时器' },
      args: { add_timer: { id: '计时器 id' } },
    },
    'settings.save': '保存设置',
  },
};
const labels = manifestLabels(labelled);
assert.deepEqual(labels?.node, { en: 'System', 'zh-CN': '系统' });
assert.deepEqual(labels?.caps?.add_timer, { en: 'Add timer', 'zh-CN': '新增计时器' });
assert.deepEqual(labels?.caps?.settings, { en: 'Settings' });
assert.deepEqual(labels?.args?.add_timer, {
  id: { en: 'Timer id', 'zh-CN': '计时器 id' },
  at: { en: 'Fires at' },
});
// The sentences beside them are not labels.
assert.equal(labels?.caps?.['settings.save'], undefined);
assert.equal(manifestLabels({ en: { save: 'Save' } }), undefined, 'no label section, no labels');

// Reading a label: this language, then English, then whatever exists, then nothing.
assert.equal(labelText({ en: 'System', 'zh-CN': '系统' }, 'zh-CN'), '系统');
assert.equal(labelText({ en: 'System', 'zh-CN': '系统' }, 'zh-TW'), '系统', 'zh-TW folds to zh-CN');
assert.equal(labelText({ en: 'System' }, 'zh-CN'), 'System');
assert.equal(
  labelText({ de: 'System' }, 'en'),
  'System',
  'an unknown language still shows something',
);
assert.equal(labelText({ en: '' }, 'en'), undefined);
assert.equal(labelText(undefined, 'en'), undefined);

// --- written in before the page leaves the node ------------------------------------------------

// A page's markup is authored in one language; a reader of the other must not see it while the
// browser half loads. `paintResource` fills the text of the marked elements, attributes untouched,
// and leaves containers and unknown keys exactly as they were.
const words = resourceTexts({ en: { save: 'Save' }, 'zh-CN': { save: '保存' } });
const painted = paintResource(
  [
    '<h1 data-text-key="save">保存</h1>',
    '<button id="b" type="button" data-text-key="save">保存</button>',
    '<div data-text-key="missing">unchanged</div>',
    '<div data-text-key="save"><b>child</b></div>',
    '<span>no marker</span>',
  ].join(''),
  words,
  'en',
);
assert.match(painted, /<h1 data-text-key="save">Save<\/h1>/);
assert.match(painted, /<button id="b" type="button" data-text-key="save">Save<\/button>/);
assert.match(painted, /data-text-key="missing">unchanged</, 'an unknown key keeps the markup');
assert.match(
  painted,
  /data-text-key="save"><b>child<\/b><\/div>/,
  'a container is left to the browser',
);
assert.match(painted, /<span>no marker<\/span>/);
assert.match(
  paintResource('<i data-text-key="save">Save</i>', words, 'zh-CN'),
  /<i data-text-key="save">保存<\/i>/,
);

// --- a page, ready to send ------------------------------------------------------------

// `paintPage` does the whole hand-off: the words of the request's language in the markup, the
// language declared on <html>, and the resource in the slot the browser half reads.
const pageResource = { en: { save: 'Save', field: 'Key' }, 'zh-CN': { save: '保存', field: '密钥' } };
const pageHtml = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><title data-text-key="save">Save</title><!-- node-agent:i18n-resource --></head>',
  '<body>',
  '<input data-text-placeholder-key="field" placeholder="Key" data-text-label-key="field" aria-label="Key" />',
  '<button data-text-key="save">Save</button>',
  '</body>',
  '</html>',
].join('');

const english = paintPage(pageHtml, pageResource, {});
assert.match(english, /<html lang="en">/);
assert.match(english, /<button data-text-key="save">Save<\/button>/);
assert.match(english, /placeholder="Key"/);
assert.match(english, /aria-label="Key"/);
assert.match(english, /data-i18n-resource/);

const chinese = paintPage(pageHtml, pageResource, { language: 'zh-CN' });
assert.match(chinese, /<html lang="zh-CN">/);
assert.match(chinese, /<button data-text-key="save">保存<\/button>/);
assert.match(chinese, /placeholder="密钥"/);
assert.match(chinese, /aria-label="密钥"/, 'a tag may carry more than one marker');
// An unknown language falls back to the resource default rather than to nothing.
assert.match(paintPage(pageHtml, pageResource, { language: 'fr' }), /<html lang="en">/);
// A sentence with a quote cannot end the attribute it is written into.
const quoted = paintPage(
  '<input data-text-placeholder-key="field" placeholder="Key" />',
  { en: { field: 'a "quoted" value' } },
  { language: 'en' },
);
assert.match(quoted, /placeholder="a &quot;quoted&quot; value"/);

console.log('i18n: ok');
