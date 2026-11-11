// The setup: claim one marker in history, then file the instruction and the heartbeat -- once, in the
// language the system node resolved -- and the node then serves its page.
//
// Ported from the Python test suite (node_agent/nodes/introduce/python/.../test_init_node.py), case for
// case: same order of calls, same titles, same one-shot rule -- plus the marker in history that now
// says whether a stack is new (the instruction document used to be asked, and could only answer
// after the first document was filed), and the page the node still offers afterwards. Choosing the
// language is the first visit's choice: the onboarding page writes it to the profile before it
// calls setup, so every case here reads `system.language`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadResource, resourceValue, type Resource } from '@node-agent/sdk';
import {
  DIARY_TEXT_KEY,
  DIARY_TITLE_KEY,
  HEARTBEAT_KEY,
  IntroduceNode,
  INSTRUCTION_TITLE_KEY,
  INTRODUCTION_KEY,
  LEGACY_INSTRUCTION_TITLE,
  PROFILE_TEXT_KEY,
  PROFILE_TITLE_KEY,
  SETUP_UNIT,
  isLoopback,
  readStatus,
  renderPage,
  runSetup,
  type IntroduceCaller,
  type SetupMarker,
} from '../src/index.ts';

type Call = { node: string; cap: string; args: Record<string, unknown> };
type HeldUnit = { meta: unknown; revision: number };

/**
 * The bus a setup talks to, as far as the setup can tell: history holding one unit per id at a
 * revision (where `save` with `expectedRevision: 0` is create-only, exactly as the history node
 * means it), a system node answering the resolved language, and every other call recorded and
 * answered with an empty frame.
 */
function wired(
  options: {
    /** The marker an earlier start left, if it left one. */
    marker?: SetupMarker;
    /** What `system.language` answers; an Error is a system node that cannot answer at all. */
    language?: string | Error;
    /** The instruction documents an older version filed, for the adoption path. */
    documents?: { title?: string }[];
    /** The one call that is refused, named `node.cap`. */
    refuse?: string;
  } = {},
): { caller: IntroduceCaller; calls: Call[]; units: Map<string, HeldUnit> } {
  const calls: Call[] = [];
  const units = new Map<string, HeldUnit>();
  if (options.marker !== undefined) units.set(SETUP_UNIT, { meta: options.marker, revision: 1 });
  const conflict = (cap: string): never => {
    throw new Error(`history.${cap}: revision conflict`);
  };

  const caller: IntroduceCaller = {
    async call<T>(node: string, cap: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ node, cap, args });
      if (options.refuse === `${node}.${cap}`) throw new Error(`${node}.${cap}: refused`);

      if (node === 'history') {
        const unitId = String(args.unitId);
        const held = units.get(unitId);
        const expected = args.expectedRevision;
        if (cap === 'load') return { unit: held ?? null } as T;
        if (cap === 'save') {
          if (expected === 0 && held !== undefined) conflict('save');
          if (typeof expected === 'number' && expected > 0 && held?.revision !== expected)
            conflict('save');
          const revision = (held?.revision ?? 0) + 1;
          units.set(unitId, { meta: args.meta, revision });
          return { unit: { revision, meta: args.meta } } as T;
        }
        if (cap === 'delete') {
          if (held === undefined || held.revision !== Number(expected)) conflict('delete');
          units.delete(unitId);
          return 'persistent unit deleted' as T;
        }
      }

      if (node === 'notes' && cap === 'list') return (options.documents ?? []) as T;

      if (node === 'system' && cap === 'language') {
        const answer = options.language ?? 'en';
        if (answer instanceof Error) throw answer;
        return answer as T;
      }
      return [] as T;
    },
  };
  return { caller, calls, units };
}

/** The words this package carries, read the way the node reads them. */
function words(locale: string): {
  instruction: string;
  heartbeat: string;
  instructionTitle: string;
  profileTitle: string;
  diaryTitle: string;
  profileText: string;
  diaryText: string;
} {
  const resource = loadResource(new URL('../src/setup-i18n/', import.meta.url));
  return {
    instruction: resourceValue(resource, INTRODUCTION_KEY, locale),
    heartbeat: resourceValue(resource, HEARTBEAT_KEY, locale),
    instructionTitle: resourceValue(resource, INSTRUCTION_TITLE_KEY, locale),
    profileTitle: resourceValue(resource, PROFILE_TITLE_KEY, locale),
    diaryTitle: resourceValue(resource, DIARY_TITLE_KEY, locale),
    profileText: resourceValue(resource, PROFILE_TEXT_KEY, locale),
    diaryText: resourceValue(resource, DIARY_TEXT_KEY, locale),
  };
}

/** The calls of one run, as `node.cap`, in the order the setup made them. */
function order(calls: Call[]): string[] {
  return calls.map((one) => `${one.node}.${one.cap}`);
}

test('a new stack is set up once, in the language the system resolved, and the marker says so', async () => {
  const { caller, calls, units } = wired({ language: 'zh-CN' });
  const lines: string[] = [];
  const outcome = await runSetup(caller, { log: (line) => lines.push(line) });
  assert.equal(outcome, 'ran');
  assert.deepEqual(order(calls), [
    'history.load',
    'system.language',
    'notes.list',
    'history.save',
    'notes.add',
    'notes.add',
    'notes.add',
    'timer.set',
    'agent.chat_no_wait',
    'history.save',
  ]);
  // The instruction first, then the two documents the reader's stack starts with -- titles as well
  // as texts from the resource, so a Chinese stack is filed in Chinese words.
  assert.deepEqual(calls[4]?.args, {
    title: words('zh-CN').instructionTitle,
    text: words('zh-CN').instruction,
    tag: 'instruction',
  });
  assert.deepEqual(
    calls.slice(5, 7).map((one) => one.args),
    [
      { title: words('zh-CN').profileTitle, text: words('zh-CN').profileText, tag: 'profile' },
      { title: words('zh-CN').diaryTitle, text: words('zh-CN').diaryText, tag: 'profile' },
    ],
  );
  const timer = calls[7]?.args ?? {};
  assert.equal(timer.message, words('zh-CN').heartbeat);
  assert.equal(timer.repeat, 'every:3600');
  assert.equal(timer.name, 'heartbeat');
  assert.equal(timer.node, 'agent');
  assert.equal(timer.after_seconds, 3600);
  assert.deepEqual(calls[8]?.args, {
    msg: { role: 'system', content: words('zh-CN').instruction },
    priority: 'queue',
  });

  // The marker is claimed before the first document and finished after the last call: two writes
  // of the one unit, the first of them create-only.
  assert.equal(calls[3]?.args.expectedRevision, 0);
  assert.equal(calls[9]?.args.expectedRevision, 1);
  const marker = units.get(SETUP_UNIT)?.meta as SetupMarker;
  assert.equal(units.get(SETUP_UNIT)?.revision, 2);
  assert.equal(marker.initialized, true);
  assert.equal(marker.language, 'zh-CN');
  assert.match(marker.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(lines.join('\n'), /this stack is set up \(zh-CN\)/);
});

test('a stack whose marker is there is left alone', async () => {
  const marker: SetupMarker = { initialized: true, language: 'en', at: '2026-01-01T00:00:00.000Z' };
  const { caller, calls } = wired({ marker });
  const lines: string[] = [];
  const outcome = await runSetup(caller, { log: (line) => lines.push(line) });
  assert.equal(outcome, 'skipped');
  assert.deepEqual(order(calls), ['history.load']);
  assert.match(lines.join('\n'), /was set up already, leaving it alone/);
});

test('a marker that says an earlier start stopped keeps the next start out too', async () => {
  const marker: SetupMarker = {
    initialized: false,
    language: 'en',
    at: '2026-01-01T00:00:00.000Z',
    error: 'notes.add: refused',
  };
  const { caller, calls } = wired({ marker });
  const lines: string[] = [];
  const outcome = await runSetup(caller, { log: (line) => lines.push(line) });
  assert.equal(outcome, 'skipped');
  assert.deepEqual(order(calls), ['history.load']);
  assert.match(lines.join('\n'), /stopped half way, leaving what it filed alone/);
});

test('a stack an older version set up is adopted, not set up a second time', async () => {
  // Before there was a marker, the instruction document was the marker: such a stack is marked as
  // it stands, and none of its documents, its timer or its system line is filed again.
  const { caller, calls, units } = wired({
    documents: [{ title: '服务指南', tag: 'instruction' }],
  });
  const lines: string[] = [];
  const outcome = await runSetup(caller, { log: (line) => lines.push(line) });
  assert.equal(outcome, 'skipped');
  assert.deepEqual(order(calls), ['history.load', 'system.language', 'notes.list', 'history.save']);
  assert.equal(calls[3]?.args.expectedRevision, 0);
  const marker = units.get(SETUP_UNIT)?.meta as SetupMarker;
  assert.equal(marker.initialized, true);
  assert.equal(marker.adopted, true);
  assert.match(lines.join('\n'), /before the marker existed, adopting it/);

  // The title that stack filed is the one this file used to hold; it is still recognised.
  assert.equal(LEGACY_INSTRUCTION_TITLE, '服务指南');

  // A document of the reader's own, filed under another title, is not this stack's setup.
  const other = wired({ documents: [{ title: '我的笔记', tag: 'instruction' }] });
  assert.equal(await runSetup(other.caller), 'ran');
});

test('a stack set up in English is filed in English words, titles included', async () => {
  const { caller, calls } = wired({ language: 'en' });
  assert.equal(await runSetup(caller), 'ran');
  const english = words('en');
  assert.deepEqual(
    calls.filter((one) => one.node === 'notes' && one.cap === 'add').map((one) => one.args),
    [
      { title: english.instructionTitle, text: english.instruction, tag: 'instruction' },
      { title: english.profileTitle, text: english.profileText, tag: 'profile' },
      { title: english.diaryTitle, text: english.diaryText, tag: 'profile' },
    ],
  );
  // Not a Chinese title in sight: the words a reader opens are all theirs.
  for (const [title, text] of [
    [english.instructionTitle, english.instruction],
    [english.profileTitle, english.profileText],
    [english.diaryTitle, english.diaryText],
  ] as const) {
    assert.doesNotMatch(title, /[\u4e00-\u9fff]/, title);
    assert.doesNotMatch(text, /[\u4e00-\u9fff]/, title);
  }
  // The two texts name those titles too, so they are just as free of the old Chinese words.
  assert.doesNotMatch(english.instruction, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(english.heartbeat, /[\u4e00-\u9fff]/);
});

test('two starts racing on one new stack set it up once', async () => {
  const { caller, calls, units } = wired();
  const outcomes = await Promise.all([runSetup(caller), runSetup(caller)]);
  assert.deepEqual(outcomes.sort(), ['ran', 'skipped']);
  // Three documents once, not twice: the second start lost the claim and wrote nothing.
  assert.equal(calls.filter((one) => one.node === 'notes' && one.cap === 'add').length, 3);
  assert.equal(units.get(SETUP_UNIT)?.revision, 2);
});

test('the words are really in both languages', () => {
  // The same keys in both files, and nothing else: a word one language lacks would reach the user's
  // notes as the other language's words, or as the key itself.
  const resource = loadResource(new URL('../src/setup-i18n/', import.meta.url));
  const keys = [
    DIARY_TEXT_KEY,
    DIARY_TITLE_KEY,
    HEARTBEAT_KEY,
    INSTRUCTION_TITLE_KEY,
    INTRODUCTION_KEY,
    PROFILE_TEXT_KEY,
    PROFILE_TITLE_KEY,
  ].sort();
  assert.deepEqual(Object.keys(resource.en ?? {}).sort(), keys);
  assert.deepEqual(Object.keys(resource['zh-CN'] ?? {}).sort(), keys);
  assert.match(words('zh-CN').instruction, /^你是 Node/);
  assert.match(words('en').instruction, /^You are Node/);
  assert.match(words('zh-CN').heartbeat, /自动 heartbeat/);
  assert.match(words('en').heartbeat, /^This is an automatic heartbeat/);
  // The English guide names the notes by the titles the English stack files them under.
  assert.match(words('en').instruction, /"User profile" and "Companion diary"/);
  assert.match(words('en').instruction, /notes node as "Guide"/);
});

test('the language the system resolved is the one written, in its own forms', async () => {
  for (const [answer, expected] of [
    ['zh-CN', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['en', 'en'],
    ['en-US', 'en'],
  ] as const) {
    const { caller, calls, units } = wired({ language: answer });
    assert.equal(await runSetup(caller), 'ran');
    assert.equal(
      calls.find((one) => one.node === 'notes' && one.cap === 'add')?.args.text,
      words(expected).instruction,
      `system.language ${answer} should read ${expected}`,
    );
    assert.equal((units.get(SETUP_UNIT)?.meta as SetupMarker).language, expected);
  }
});

test('a system node that cannot answer falls back to the SDK default', async () => {
  const { caller, calls, units } = wired({ language: new Error('system is not on the bus') });
  assert.equal(await runSetup(caller), 'ran');
  assert.equal(
    calls.find((one) => one.node === 'notes' && one.cap === 'add')?.args.text,
    words('en').instruction,
  );
  assert.equal((units.get(SETUP_UNIT)?.meta as SetupMarker).language, 'en');
});

test('a resource without the words fails, and gives the claim back', async () => {
  const bare: Resource = { en: {} };
  const { caller, calls, units } = wired();
  const lines: string[] = [];
  const outcome = await runSetup(caller, { resource: bare, log: (line) => lines.push(line) });
  assert.equal(outcome, 'failed');
  assert.match(lines.join('\n'), /no words for "setup.introduction"/);
  // Nothing was filed, so the claim is released and the next start may try the whole setup again.
  assert.deepEqual(order(calls), [
    'history.load',
    'system.language',
    'notes.list',
    'history.save',
    'history.delete',
  ]);
  assert.equal(units.size, 0);
});

test('a refused call stops the setup, and the marker keeps the next start out', async () => {
  const { caller, calls, units } = wired({ refuse: 'notes.add' });
  const lines: string[] = [];
  const outcome = await runSetup(caller, { log: (line) => lines.push(line) });
  assert.equal(outcome, 'failed');
  assert.match(lines.join('\n'), /notes\.add: refused/);
  assert.deepEqual(order(calls), [
    'history.load',
    'system.language',
    'notes.list',
    'history.save',
    'notes.add',
    'history.save',
  ]);
  const marker = units.get(SETUP_UNIT)?.meta as SetupMarker;
  assert.equal(marker.initialized, false);
  assert.equal(marker.language, 'en');
  assert.match(String(marker.error), /notes\.add: refused/);

  // Something may already be in the notes node, so this stack is not set up twice.
  const before = calls.length;
  assert.equal(await runSetup(caller, { log: (line) => lines.push(line) }), 'skipped');
  assert.equal(calls.length, before + 1);
});

// What the page asks on load: has this stack been set up yet, and in which language? It reads the
// marker, and for a stack older than the marker, the instruction document in its notes.
test('status says a fresh stack is not set up, and writes nothing', async () => {
  const { caller, calls } = wired();
  assert.deepEqual(await readStatus(caller), { initialized: false, language: null });
  assert.deepEqual(order(calls), ['history.load', 'system.language', 'notes.list']);
  assert.equal(
    calls.some(
      (one) => ['save', 'delete'].includes(one.cap) || (one.node === 'notes' && one.cap === 'add'),
    ),
    false,
    'status wrote something',
  );
});

test('status reads the marker of a stack that is set up', async () => {
  const marker: SetupMarker = {
    initialized: true,
    language: 'zh-CN',
    at: '2026-01-01T00:00:00.000Z',
  };
  const { caller, calls } = wired({ marker });
  assert.deepEqual(await readStatus(caller), { initialized: true, language: 'zh-CN' });
  // The marker answers it all: notes and the system node are not asked.
  assert.deepEqual(order(calls), ['history.load']);
});

test('a marker that never finished is not a set-up stack', async () => {
  const marker: SetupMarker = {
    initialized: false,
    language: 'en',
    at: '2026-01-01T00:00:00.000Z',
  };
  const { caller } = wired({ marker });
  assert.deepEqual(await readStatus(caller), { initialized: false, language: null });
});

test('an older stack without a marker is set up while its guide is in the notes', async () => {
  // The legacy Chinese title, and the title this build files in the resolved language.
  for (const [language, title] of [
    ['en', LEGACY_INSTRUCTION_TITLE],
    ['en', 'Guide'],
    ['zh-CN', '服务指南'],
  ] as const) {
    const { caller } = wired({ language, documents: [{ title, tag: 'instruction' }] });
    assert.deepEqual(
      await readStatus(caller),
      { initialized: true, language: null },
      `${language} / ${title}`,
    );
  }

  // A note of the reader's own, under another title, is not this stack's setup.
  const other = wired({ documents: [{ title: '我的笔记', tag: 'instruction' }] });
  assert.deepEqual(await readStatus(other.caller), { initialized: false, language: null });
});

test('after the setup, status says the stack is set up in that language', async () => {
  const { caller } = wired({ language: 'zh-CN' });
  assert.equal(await runSetup(caller), 'ran');
  assert.deepEqual(await readStatus(caller), { initialized: true, language: 'zh-CN' });
  // And the setup is still one-shot: a second visit changes nothing.
  assert.equal(await runSetup(caller), 'skipped');
});

// The setup is page-called; the page is what this node has to offer after it. It reads the bus
// this process joined, not an argument from the caller -- and, when the shell sends one, the language
// of the visit. A visit that names none is drawn in the resource's own default, English.
test('it offers the runtime setup entry and the introduction/connect page', () => {
  const node = new IntroduceNode({} as never);
  assert.deepEqual(Object.keys(node.handlers), ['setup', 'status', 'ui']);

  const page = node.handlers.ui?.({});
  assert.equal(typeof page, 'string');
  const html = String(page);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title data-text-key="title">What's NodeAgent · node-agent<\/title>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /it remembers you, it gets things done/);
  // What the product is for and how to attach another computer; the setup/build recipe has moved
  // out of this page.
  for (const section of ['What you can do with it', 'Day to day', 'Attach an external node']) {
    assert.match(html, new RegExp(section));
  }
  assert.doesNotMatch(html, /第一次使用|常用配置|npm install|npm run build/);
  assert.match(html, /node_agent\/nodes\/shell\/dist\/serve\.js/);
  assert.match(html, /NODE_AGENT_BUS_URL/);
  // The guide is its own page now; the first-visit gate is not mixed into it.
  assert.doesNotMatch(html, /id="onboarding"|id="onboarding-language"/);
  assert.doesNotMatch(html, /它是怎么搭起来的|architecture|runtime/i);
  // Nothing leaves this machine but the SDK's browser half, which the shell serves itself: no font,
  // stylesheet, image or other script comes from anywhere.
  assert.doesNotMatch(html, /<link|<img|@import|fonts\./i);
  assert.doesNotMatch(html, /https:\/\//i);
  assert.deepEqual(
    [...html.matchAll(/\ssrc="([^"]*)"/g)].map((one) => one[1]),
    ['/sdk/i18n-client.js'],
  );
  assert.doesNotMatch(html, /\{\{\w+\}\}/);
});

test('the first visit is a separate onboarding page with one language choice', () => {
  const node = new IntroduceNode({} as never);
  const html = String(node.handlers.ui?.({ onboarding: true }));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<select id="onboarding-language">/);
  assert.match(html, /<option value="zh-CN">中文<\/option>/);
  assert.match(html, /<option value="en">English<\/option>/);
  assert.match(html, /id="onboarding-start"/);
  // The first-visit animation is embedded as its own document, and follows the picker.
  assert.match(html, /id="intro-animation"/);
  assert.match(html, /srcdoc="&lt;!doctype html&gt;/);
  assert.match(html, /node-agent:intro-language/);
  assert.match(html, /Online in the cloud, across every device/);
  assert.match(html, /云端在线，多端融合/);
  for (const call of ['system.settings', 'introduce.setup'])
    assert.ok(html.includes(`callNode('${call}'`), `${call} is never called`);
  assert.match(html, /postMessage\(done, location\.origin\)/);
  assert.match(html, /kind: 'node-agent:setup-complete'/);
  assert.match(html, /location\.assign\('\/'\)/);
  // The guide and its connection recipes belong to the other page (the embedded resource still
  // carries every sentence, so look at the body, not the JSON in the head).
  const body = html.slice(html.indexOf('<body>'));
  assert.doesNotMatch(body, /Attach an external node|NODE_AGENT_BUS_URL|node_agent\/nodes\/shell/);
  assert.doesNotMatch(html, /<link|<img|@import|fonts\./i);
  assert.deepEqual(
    [...html.matchAll(/\ssrc="([^"]*)"/g)].map((one) => one[1]),
    ['/sdk/i18n-client.js'],
  );
});

test('the page fills the bus values and escapes them', () => {
  const html = renderPage('ws://127.0.0.1:8788', 'tok<&"');
  assert.match(html, /ws:\/\/127\.0\.0\.1:8788/);
  assert.match(html, /tok&lt;&amp;&quot;/);
  assert.match(html, /listening on loopback/i);
  assert.equal(isLoopback('ws://10.0.0.5:8788'), false);
  assert.match(renderPage('ws://10.0.0.5:8788', 'token'), /not loopback/i);
});

test('the page receives the private join token, never the bus token', () => {
  const oldJoin = process.env.NODE_AGENT_JOIN_TOKEN;
  const oldBus = process.env.NODE_AGENT_TOKEN;
  process.env.NODE_AGENT_JOIN_TOKEN = 'private-join-token';
  process.env.NODE_AGENT_TOKEN = 'bus-secret';
  try {
    const node = new IntroduceNode({} as never);
    const html = String(node.handlers.ui?.({}));
    assert.match(html, /private-join-token/);
    assert.doesNotMatch(html, /bus-secret/);
  } finally {
    if (oldJoin === undefined) delete process.env.NODE_AGENT_JOIN_TOKEN;
    else process.env.NODE_AGENT_JOIN_TOKEN = oldJoin;
    if (oldBus === undefined) delete process.env.NODE_AGENT_TOKEN;
    else process.env.NODE_AGENT_TOKEN = oldBus;
  }
});

/** One resource file as a flat map: `{ a: { b: 'x' } }` becomes `{ 'a.b': 'x' }`, as the SDK reads it. */
function flat(value: unknown, prefix = ''): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const into: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') into[prefix + key] = entry;
    else Object.assign(into, flat(entry, `${prefix}${key}.`));
  }
  return into;
}

/** One of the package's own resource files, read where the node reads it from. */
function resource(locale: string): Record<string, string> {
  const file = new URL(`../src/i18n/${locale}.json`, import.meta.url);
  return flat(JSON.parse(readFileSync(file, 'utf8')));
}

// A key nobody translated would show up as the key itself on the page, which is the one thing a reader
// must never see: the two files carry the same sentences, and the manifest names the copy.
test('both languages carry every sentence, and the manifest names the folder', () => {
  const en = resource('en');
  const zh = resource('zh-CN');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const [locale, texts] of [
    ['en', en],
    ['zh-CN', zh],
  ] as const) {
    for (const [key, text] of Object.entries(texts)) {
      assert.notEqual(text.trim(), '', `${locale} has an empty ${key}`);
    }
  }
  // The node and both its capabilities are named in both languages: that is what the directory shows.
  for (const texts of [en, zh]) {
    assert.equal(typeof texts['label.node'], 'string');
    assert.equal(typeof texts['label.caps.ui'], 'string');
    assert.equal(typeof texts['label.caps.setup'], 'string');
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.node.i18n, 'dist/i18n');
});

/** The page with the resource script taken out: the words a reader is shown, not the catalog behind
 *  them -- a page in one language still carries the other language's sentences in that script. */
function markup(html: string): string {
  return html.replace(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/, '');
}
// The page is painted on the node, before it leaves it: the first byte a reader gets is already in
// their language, and the markers stay for `/sdk/i18n-client.js` to redraw if the language changes.
test('the page is drawn in the language of the visit, marker by marker', () => {
  const en = renderPage('ws://127.0.0.1:8788', 'token');
  const zh = renderPage('ws://127.0.0.1:8788', 'token', { language: 'zh-CN' });
  assert.match(en, /<html lang="en">/);
  assert.match(zh, /<html lang="zh-CN">/);
  assert.match(en, /Day to day/);
  assert.match(zh, /日常怎么用/);
  assert.match(zh, /选择你的 NodeAgent 使用的语言/);
  assert.doesNotMatch(markup(zh), /Day to day/);
  // The loopback warning is a key in the markup, so it follows the same language as the rest.
  assert.match(en, /This bus is listening on loopback/);
  assert.match(zh, /只监听在回环地址上/);
  assert.doesNotMatch(markup(zh), /listening on loopback/);
  // The copy buttons are sentences too, and the page says which ones it can build itself.
  assert.match(en, /Copy start command/);
  assert.match(zh, /复制启动命令/);
  // The same resource the node painted from travels in the page, for the browser half to read.
  assert.match(en, /<script type="application\/json" data-i18n-resource>/);
  assert.match(en, /"copy.done":"Copied"/);

  const texts = { en: resource('en'), 'zh-CN': resource('zh-CN') };
  for (const [locale, html] of [
    ['en', en],
    ['zh-CN', zh],
  ] as const) {
    const marked = [...html.matchAll(/data-text-key="([^"]+)"/g)].map((one) => one[1]);
    assert.ok(marked.length > 20, `${locale} lost its markers`);
    for (const key of marked) assert.ok(texts[locale][key], `${locale} has no words for ${key}`);
  }
});

test('a stack with no join token says so, in the reader language', () => {
  assert.match(renderPage('ws://127.0.0.1:8788', ''), /join token is not configured/);
  assert.match(renderPage('ws://127.0.0.1:8788', '', { language: 'zh-CN' }), /未配置 join token/);
});
