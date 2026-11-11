// The language half of the system node: what a profile holds before anyone has chosen, the one write
// a first visit may make, and the event that tells every open page the answer changed.
//
// These tests talk to the scheduler and the node's handlers directly, over a history double, because
// what is being pinned is the stored shape and the decision — not the bus (system.test.ts covers the
// capabilities end to end, and webui/test covers the first visit from the browser's side).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeContext, OutboundCallEnvelope, ResultEnvelope, ToolArgs } from '@node-agent/sdk';
import { SystemNode, setSystemScheduler } from '../src/index.ts';
import {
  PROFILE_UNIT,
  SystemScheduler,
  type EnsuredLocale,
  type LocaleView,
  type Profile,
  type SchedulerBus,
} from '../src/scheduler.ts';

interface StoredUnit {
  readonly meta: unknown;
  readonly revision: number;
}

/** The history node's two capabilities, in memory: load and save with a revision check. */
class FakeHistory {
  readonly units = new Map<string, StoredUnit>();
  saves = 0;

  answered(call: OutboundCallEnvelope, payload: ResultEnvelope['payload']): ResultEnvelope {
    return {
      id: 'result',
      type: 'result',
      from: 'history',
      to: 'system',
      replyTo: call.id,
      tenantId: call.tenantId,
      payload,
    };
  }

  async call(call: OutboundCallEnvelope): Promise<ResultEnvelope> {
    const unitId = String(call.payload.args?.unitId ?? '');
    if (call.payload.cap === 'load')
      return this.answered(call, { ok: true, value: { unit: this.units.get(unitId) ?? null } });
    if (call.payload.cap !== 'save') throw new Error(`unexpected history cap ${call.payload.cap}`);
    const expected = call.payload.args?.expectedRevision;
    const existing = this.units.get(unitId);
    if (typeof expected === 'number' && existing !== undefined && existing.revision !== expected)
      return this.answered(call, { ok: false, error: 'revision conflict' });
    const unit: StoredUnit = {
      // A copy, so a later mutation in the scheduler cannot change what history kept.
      meta: JSON.parse(JSON.stringify(call.payload.args?.meta ?? null)),
      revision: (existing?.revision ?? 0) + 1,
    };
    this.units.set(unitId, unit);
    this.saves += 1;
    return this.answered(call, { ok: true, value: { unit } });
  }

  /** The profile as it sits in storage, which is what a later process will load. */
  profile(): Record<string, unknown> {
    const unit = this.units.get(PROFILE_UNIT);
    assert.ok(unit !== undefined, 'no profile was ever saved');
    return unit.meta as Record<string, unknown>;
  }
}

interface Harness {
  readonly history: FakeHistory;
  readonly scheduler: SystemScheduler;
  readonly node: SystemNode;
  /** Every event the node published, in order. */
  readonly published: Array<{ topic: string; value: unknown }>;
  call(cap: string, args?: ToolArgs): Promise<unknown>;
}

/** One system node over one history double, with the scheduler installed the way serve.ts does it. */
async function withSystem(
  run: (harness: Harness) => Promise<void>,
  seed?: Record<string, unknown>,
): Promise<void> {
  const history = new FakeHistory();
  if (seed !== undefined) history.units.set(PROFILE_UNIT, { meta: seed, revision: 1 });
  const scheduler = new SystemScheduler(history as unknown as SchedulerBus, 'language-test');
  setSystemScheduler(scheduler);
  const published: Array<{ topic: string; value: unknown }> = [];
  const ctx = {
    tenantId: 'language-test',
    from: 'webui',
    nodeId: 'system',
    deadline: Date.now() + 10_000,
    signal: new AbortController().signal,
    call: async () => {
      throw new Error('the language tests make no outbound calls');
    },
    publish: (topic: string, value: unknown) => published.push({ topic, value }),
    fetch: globalThis.fetch,
  } as unknown as NodeContext;
  const node = new SystemNode(ctx);
  const call = async (cap: string, args: ToolArgs = {}): Promise<unknown> => {
    const handler = node.handlers[cap];
    assert.ok(handler !== undefined, `system has no ${cap}`);
    return await handler(args);
  };
  try {
    await scheduler.start();
    await run({ history, scheduler, node, published, call });
  } finally {
    scheduler.stop();
    setSystemScheduler(null);
  }
}

const localeOf = async (harness: Harness): Promise<LocaleView> =>
  (await harness.call('locale')) as LocaleView;

const ensure = async (harness: Harness, browser?: string): Promise<EnsuredLocale> =>
  (await harness.call(
    'ensure_language',
    browser === undefined ? {} : { browser },
  )) as EnsuredLocale;

const settings = async (harness: Harness, args: ToolArgs): Promise<Profile> =>
  (await harness.call('settings', args)) as Profile;

test('a fresh profile has no language, and still answers with one', async () => {
  await withSystem(async (harness) => {
    // Stored: null. That is the point — nobody has chosen yet, and only a visit may decide.
    const stored = harness.history.profile();
    assert.equal(stored.language, null);
    assert.ok('language' in stored, 'the profile keeps the field, it is not simply absent');
    // Detected, not null: a machine can tell you its timezone and nobody has to choose one.
    assert.equal(typeof stored.timezone, 'string');
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: String(stored.timezone) }));

    assert.deepEqual(await localeOf(harness), { language: null, resolved: 'en' });
    // The capability the agent prompt reads is unchanged: a tag, never null.
    assert.equal(await harness.call('language'), 'en');
  });
});

test('the first visit decides the language, and only the first visit writes', async () => {
  await withSystem(async (harness) => {
    // Starting on an empty history already wrote the profile once, with no language in it.
    const created = harness.history.saves;
    const first = await ensure(harness, 'zh-CN,zh;q=0.9,en;q=0.8');
    assert.deepEqual(first, { language: 'zh-CN', resolved: 'zh-CN', changed: true });
    assert.deepEqual(harness.published, [
      { topic: 'language', value: { language: 'zh-CN', resolved: 'zh-CN' } },
    ]);
    assert.equal(harness.history.profile().language, 'zh-CN');
    assert.equal(harness.history.saves, created + 1);

    // A second browser — a second visit, an English header, a page that does not agree — changes
    // nothing: the choice was made once, and it is the user's, not the browser's.
    const again = await ensure(harness, 'en-US,en;q=0.9');
    assert.deepEqual(again, { language: 'zh-CN', resolved: 'zh-CN', changed: false });
    assert.equal(harness.history.saves, created + 1, 'a second visit must not write the profile');
    assert.equal(harness.published.length, 1, 'a second visit must not announce a change');
    assert.equal(await harness.call('language'), 'zh-CN');
  });
});

test('the browser header decides between zh-CN and en', async () => {
  for (const [browser, wanted] of [
    ['zh-CN,zh;q=0.9,en;q=0.8', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['en-GB,en;q=0.9', 'en'],
    ['en', 'en'],
    // A browser that speaks neither gets the default rather than an empty profile.
    ['fr-FR,fr;q=0.9', 'en'],
    ['', 'en'],
  ] as const) {
    await withSystem(async (harness) => {
      const ensured = await ensure(harness, browser);
      assert.equal(ensured.language, wanted, browser);
      assert.equal(ensured.changed, true, browser);
      assert.equal(harness.history.profile().language, wanted, browser);
    });
  }
  // No header at all is a browser that said nothing: the default stands.
  await withSystem(async (harness) => {
    assert.equal((await ensure(harness)).language, 'en');
  });
});

test('two first visits at once choose once', async () => {
  await withSystem(async (harness) => {
    const created = harness.history.saves;
    const [chinese, english] = await Promise.all([
      ensure(harness, 'zh-CN'),
      ensure(harness, 'en-US'),
    ]);
    assert.equal(chinese.language, english.language, 'both calls see the same decision');
    assert.equal(harness.history.saves, created + 1, 'the profile was written once, not twice');
    assert.equal(harness.published.length, 1, 'and announced once');
  });
});

test('settings switches the language, persists it, and announces the change', async () => {
  await withSystem(async (harness) => {
    await ensure(harness, 'en-US');
    harness.published.length = 0;

    const profile = await settings(harness, { language: 'zh-CN' });
    assert.deepEqual(profile, {
      language: 'zh-CN',
      timezone: harness.history.profile().timezone,
    });
    assert.equal(harness.history.profile().language, 'zh-CN');
    assert.deepEqual(harness.published, [
      { topic: 'language', value: { language: 'zh-CN', resolved: 'zh-CN' } },
    ]);
    assert.equal(await harness.call('language'), 'zh-CN');

    // The same language again is not a change: no write, no event (a page would redraw for nothing).
    const saves = harness.history.saves;
    await settings(harness, { language: 'zh-CN' });
    assert.equal(harness.history.saves, saves);
    assert.equal(harness.published.length, 1, 'nothing was announced for an unchanged language');

    // A timezone on its own is not a language change either.
    await settings(harness, { timezone: 'Asia/Shanghai' });
    assert.equal(harness.published.length, 1);
    assert.equal(harness.history.profile().timezone, 'Asia/Shanghai');

    // Reading settings without arguments stays a read.
    const read = await settings(harness, {});
    assert.deepEqual(read, { language: 'zh-CN', timezone: 'Asia/Shanghai' });
    assert.equal(harness.published.length, 1);
  });
});

test('a language this build does not have is refused, and nothing is written', async () => {
  await withSystem(async (harness) => {
    await ensure(harness, 'en');
    harness.published.length = 0;
    const before = harness.history.saves;
    await assert.rejects(() => settings(harness, { language: 'fr' }), /zh-CN or en/);
    await assert.rejects(() => settings(harness, { language: '' }), /zh-CN or en/);
    assert.equal(harness.history.saves, before);
    assert.equal(harness.history.profile().language, 'en');
    assert.deepEqual(harness.published, []);
  });
});

test('the page is drawn in the language in force, with its own words', async () => {
  await withSystem(async (harness) => {
    const fresh = String(await harness.call('ui'));
    assert.match(fresh, /<html lang="en">/, 'an unchosen profile draws in the default');
    // The node id the page calls back with was filled in, and nothing is left as a placeholder.
    assert.match(fresh, /const INJECTED = 'system'/);
    assert.doesNotMatch(fresh, /__SYSTEM_NODE__/);
    // Both languages of a sentence live in the node's resource file, and the browser half is loaded.
    assert.match(fresh, /data-text-key="settings\.save"/);
    assert.doesNotMatch(fresh, /node-agent:i18n-resource|data-text-en=/);
    const embedded = /<script type="application\/json" data-i18n-resource>(.*?)<\/script>/.exec(
      fresh,
    );
    assert.ok(embedded, 'the page carries its resource');
    const resource = JSON.parse(embedded[1] ?? '');
    assert.equal(resource.en['permissions.allowAll'], 'Allow everyone (*)');
    assert.equal(resource['zh-CN']['permissions.allowAll'], '全部允许（*）');
    assert.equal(resource.en.sub, 'Language, timezone, and the timers waiting right now.');
    assert.match(fresh, /from '\/sdk\/i18n-client\.js'/);
    // The SDK's dictionary is not involved: the words are this node's files.
    assert.doesNotMatch(fresh, /MESSAGES|data-i18n=|common\.save/);

    await harness.call('settings', { language: 'zh-CN' });
    const chosen = String(await harness.call('ui'));
    assert.match(chosen, /<html lang="zh-CN">/);
  });
});

/** The settings form as the first paint shows it: which language option is selected, and the zone. */
function formOf(html: string): { selected: string[]; timezone: string | undefined } {
  const languageSelect = /<select id="language"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
  const selected = [...languageSelect.matchAll(/<option value="([^"]*)"[^>]*\sselected[\s>]/g)].map(
    (match) => match[1] ?? '',
  );
  const timezone = /<select id="timezone"[^>]*>\s*<option value="([^"]*)"[^>]*\sselected/.exec(
    html,
  )?.[1];
  return { selected, timezone };
}

// Regression: the language <select> listed "中文" first and nothing was selected in the markup, so an
// English page showed "中文" (and an empty timezone) until its own system.settings call came back,
// then flipped to English — about a second over a forwarded port. The first paint must already be
// the stored choice, after a switch as well as before it.
test('the settings form is drawn already holding the stored language and timezone', async () => {
  await withSystem(async (harness) => {
    // Nobody has chosen yet: the language in force (the default) is the one selected.
    assert.deepEqual(formOf(String(await harness.call('ui'))).selected, ['en']);

    await harness.call('settings', { language: 'en', timezone: 'America/New_York' });
    const english = String(await harness.call('ui'));
    assert.deepEqual(formOf(english), { selected: ['en'], timezone: 'America/New_York' });
    // The only Chinese an English page may show is the name of the other language, unselected.
    assert.match(
      english,
      /<option value="zh-CN" data-text-key="settings\.languageZh">中文<\/option>/,
    );

    await harness.call('settings', { language: 'zh-CN' });
    assert.deepEqual(formOf(String(await harness.call('ui'))).selected, ['zh-CN']);
    await harness.call('settings', { language: 'en' });
    assert.deepEqual(formOf(String(await harness.call('ui'))).selected, ['en']);
  });
});

test('a profile written by an older version still loads', async () => {
  // Old builds detected the language at startup and wrote it as a plain string; some wrote nothing.
  for (const [stored, wanted, resolved] of [
    [{ language: 'zh-CN', timezone: 'Asia/Shanghai' }, 'zh-CN', 'zh-CN'],
    [{ language: 'en', timezone: 'Asia/Shanghai' }, 'en', 'en'],
    // A tag only an older/newer build would produce: read as the language it obviously meant.
    [{ language: 'zh', timezone: 'Asia/Shanghai' }, 'zh-CN', 'zh-CN'],
    [{ language: 'en-US', timezone: 'Asia/Shanghai' }, 'en', 'en'],
    // Nothing usable: "nobody has chosen yet", which the next visit will fill in.
    [{ timezone: 'Asia/Shanghai' }, null, 'en'],
    [{ language: null, timezone: 'Asia/Shanghai' }, null, 'en'],
    [{ language: 'fr-FR', timezone: 'Asia/Shanghai' }, null, 'en'],
    [{ language: 42, timezone: 'Asia/Shanghai' }, null, 'en'],
  ] as const) {
    await withSystem(
      async (harness) => {
        assert.deepEqual(
          await localeOf(harness),
          { language: wanted, resolved },
          JSON.stringify(stored),
        );
        assert.equal(await harness.call('language'), resolved, JSON.stringify(stored));
        assert.equal(harness.history.profile().timezone, 'Asia/Shanghai', 'the rest is kept');
      },
      stored as unknown as Record<string, unknown>,
    );
  }
});

test('an old profile with no usable language is decided by the next visit', async () => {
  await withSystem(
    async (harness) => {
      const ensured = await ensure(harness, 'zh-CN');
      assert.deepEqual(ensured, { language: 'zh-CN', resolved: 'zh-CN', changed: true });
      assert.equal(harness.history.profile().language, 'zh-CN');
      // The timezone the old profile held survives the write.
      assert.equal(harness.history.profile().timezone, 'Asia/Shanghai');
    },
    { language: 'fr-FR', timezone: 'Asia/Shanghai' },
  );
});
