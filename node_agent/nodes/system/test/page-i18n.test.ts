// The settings page is bilingual only if every word on it has a key and both files answer that key.
//
// The page is one file drawn per request: the node writes the words of the language in force into the
// `data-text-key` markers before it leaves (`paintPage`), and the browser half redraws the same markers
// on a language change. A word written straight into the markup, or a key only one language answers,
// survives both — as the other language's text, at the wrong moment or forever. So this suite reads
// the markup and the two files the way the node does, and refuses either gap.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = new URL('../src/', import.meta.url);
const PAGE = readFileSync(new URL('ui.html', SRC), 'utf8');
const LOCALES = ['en', 'zh-CN'] as const;
type Locale = (typeof LOCALES)[number];

/** { a: { b: 'x' } } → { 'a.b': 'x' }, the shape both halves look a key up in. */
function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  const into: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof entry === 'string') into[name] = entry;
    else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      Object.assign(into, flatten(entry as Record<string, unknown>, name));
  }
  return into;
}

function resource(locale: Locale): Record<string, string> {
  return flatten(
    JSON.parse(readFileSync(new URL(`i18n/${locale}.json`, SRC), 'utf8')) as Record<
      string,
      unknown
    >,
  );
}

const RESOURCES: Record<Locale, Record<string, string>> = {
  en: resource('en'),
  'zh-CN': resource('zh-CN'),
};

/** Every key the page names, wherever it names one: markup, attributes, or the script's own lookups. */
function pageKeys(html: string): string[] {
  const keys = new Set<string>();
  const patterns = [
    /data-text-(?:placeholder-|label-)?key="([^"]+)"/g,
    /\bt\(\s*'([^']+)'/g,
    /\bmark\(\s*[\w$.]+\s*,\s*'([^']+)'/g,
    /\bchoice\(\s*'([^']+)'/g,
  ];
  for (const pattern of patterns)
    for (const match of html.matchAll(pattern)) if (match[1] !== undefined) keys.add(match[1]);
  return [...keys].sort();
}

const KEYS = pageKeys(PAGE);

/** The `{name}` placeholders of a sentence, so a translation cannot lose one. */
function placeholders(sentence: string): string[] {
  return [...sentence.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '').sort();
}

/** Each marked element of the page and what it holds: markup is what the server-side pass skips. */
function markedElements(html: string): { key: string; inner: string }[] {
  const found: { key: string; inner: string }[] = [];
  for (const element of html.matchAll(
    /<([a-zA-Z][\w-]*)\b[^>]*\sdata-text-key="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g,
  ))
    found.push({ key: element[2] ?? '', inner: element[3] ?? '' });
  return found;
}

test('the page names keys, and both languages answer every one of them', () => {
  assert.ok(KEYS.length > 0, 'the page names no keys at all');
  const gaps: string[] = [];
  for (const locale of LOCALES) {
    for (const key of KEYS) {
      const sentence = RESOURCES[locale][key];
      if (sentence === undefined || sentence.trim() === '') gaps.push(`${locale}: ${key}`);
    }
    // The same key set in both files: a key only one language carries is a page that falls back.
    for (const key of Object.keys(RESOURCES[locale]))
      for (const other of LOCALES)
        if (other !== locale && RESOURCES[other][key] === undefined)
          gaps.push(`${locale} has a key ${other} lacks: ${key}`);
    for (const key of Object.keys(RESOURCES[locale]))
      assert.deepEqual(
        placeholders(RESOURCES[locale][key] ?? ''),
        placeholders(RESOURCES.en[key] ?? ''),
        `${locale}: ${key}`,
      );
  }
  assert.deepEqual(gaps, [], `translation gaps: ${gaps.sort().join(' | ')}`);
});

test('every word of the files is a word the page says', () => {
  const unused = Object.keys(RESOURCES.en).filter(
    (key) => !KEYS.includes(key) && !key.startsWith('label.'),
  );
  assert.deepEqual(unused, [], `keys no page word uses: ${unused.join(', ')}`);
});

// A marked element is painted by the node *and* by the browser half, and both write text into the
// element itself. A child element inside the marker makes the server-side pass skip it (the SDK fills
// an element only while its content is plain text), so the first paint keeps the language the file was
// authored in. `permissions.hint` differed between the two languages, which is how that showed: an
// English page kept saying 按目标节点分组 until the script ran.
test('every marked element carries plain text, so the node can paint it before sending', () => {
  const nested = markedElements(PAGE)
    .filter((element) => element.inner.includes('<'))
    .map((element) => element.key);
  assert.deepEqual(nested, [], `marked elements holding markup: ${nested.join(', ')}`);
  assert.ok(markedElements(PAGE).length >= 12, 'the page is marked up, not painted by hand');
});

test('the page keeps one resource slot, and no word is written outside a key', () => {
  assert.equal(
    [...PAGE.matchAll(/<!-- node-agent:i18n-resource -->/g)].length,
    1,
    'exactly one slot, in the head, where the resource script goes',
  );
  assert.match(PAGE, /<html lang="[a-zA-Z-]+">/, 'the tag `paintPage` writes the language into');

  // A word that is not inside a marked element is a word neither the node nor the script can change
  // — the one thing a bilingual page must not have.
  const body = /<body>([\s\S]*)<\/body>/.exec(PAGE)?.[1] ?? '';
  const unmarked = body
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[a-zA-Z][\w-]*\b[^>]*\sdata-text-key="[^"]+"[^>]*>[^<]*<\/[a-zA-Z][\w-]*>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .trim();
  assert.equal(unmarked, '', `text outside any key: ${JSON.stringify(unmarked.slice(0, 120))}`);

  // The attribute markers the SDK paints, for the attributes a page may carry them on.
  for (const [attribute, marker] of [
    ['placeholder', 'data-text-placeholder-key'],
    ['aria-label', 'data-text-label-key'],
  ] as const)
    for (const tag of PAGE.matchAll(/<[a-zA-Z][\w-]*\b[^>]*>/g))
      if (new RegExp(`\\b${attribute}="`).test(tag[0]))
        assert.match(
          tag[0],
          new RegExp(`\\b${marker}="`),
          `${attribute} without ${marker}: ${tag[0]}`,
        );
});

// The two files are what the manifest's display names are read from as well, so a label that names a
// capability or an argument the manifest no longer declares is a page describing something the bus
// would refuse. (`manifests.test.ts` checks the same shape for every package that publishes labels.)
test('both files label the node, every capability and every argument of it', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    node?: { caps?: Record<string, { properties?: Record<string, unknown> }> };
  };
  const caps = manifest.node?.caps ?? {};
  const gaps: string[] = [];
  for (const locale of LOCALES) {
    const words = RESOURCES[locale];
    if ((words['label.node'] ?? '') === '') gaps.push(`${locale}: label.node`);
    for (const [cap, schema] of Object.entries(caps)) {
      if ((words[`label.caps.${cap}`] ?? '') === '') gaps.push(`${locale}: label.caps.${cap}`);
      for (const argument of Object.keys(schema.properties ?? {}))
        if ((words[`label.args.${cap}.${argument}`] ?? '') === '')
          gaps.push(`${locale}: label.args.${cap}.${argument}`);
    }
  }
  assert.deepEqual(gaps, [], `label gaps: ${gaps.join(' | ')}`);
});
