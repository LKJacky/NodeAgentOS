// The search node, end to end on a real bus: what it sends to DeepSeek, what it does with the key, and
// what survives a restart. Every test here talks to the node the way the model and the page do --
// through capabilities -- so the contract being checked is the one a caller sees.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http';
import type { DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek';
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web';
import { nodeManifestOfPackage, type NodeHost, type Outcome } from '@node-agent/sdk';
import type { DeepSeekSearchOptions, KeyState, SearchProviderApi } from '../src/index.ts';
import { Caller, Fixture, FakeHistoryStore, joinSearch, startHistory } from './support.ts';

/** What a test may ask for: the node's options, whether history is on the bus at all, and a value to
 *  plant in a unit before the node joins. */
type Settings = {
  options?: DeepSeekSearchOptions;
  history?: boolean;
  prepare?: (store: FakeHistoryStore) => void;
};

/** One bus and one search node, plus a history node behind it and a caller in front of it. */
type Open = {
  caller: Caller;
  store: FakeHistoryStore;
  /** A fresh search node on the same bus and the same history: what a restart looks like. */
  restart: () => Promise<void>;
  close: () => Promise<void>;
};

async function open(settings: Settings = {}): Promise<Open> {
  const fixture = await Fixture.open();
  const store = new FakeHistoryStore();
  // Anything a unit already holds is put there before the node joins: what a join makes of it is the
  // thing under test, so it has to be in place before the join happens.
  settings.prepare?.(store);
  const history = settings.history === false ? null : await startHistory(fixture, store);
  const options = settings.options ?? {};
  let search: NodeHost = await joinSearch(fixture, options);
  const caller = await Caller.join(fixture);

  return {
    caller,
    store,
    restart: async () => {
      await search.stop();
      search = await joinSearch(fixture, options);
    },
    close: async () => {
      await caller.close();
      await search.stop();
      await history?.close();
      await fixture.close();
    },
  };
}

async function withSearch<T>(
  settings: Settings,
  run: (caller: Caller, restart: () => Promise<void>, store: FakeHistoryStore) => Promise<T>,
): Promise<T> {
  const { caller, store, restart, close } = await open(settings);
  try {
    return await run(caller, restart, store);
  } finally {
    await close();
  }
}

/** The value of a call that has to be accepted — a refusal is the failure. */
function accepted<T>(reply: Outcome): T {
  if (!reply.ok) assert.fail(`the call was refused: ${reply.error}`);
  return reply.value as T;
}

/** The error text of a call that has to be refused — an acceptance is the failure. */
function refusal(reply: Outcome): string {
  if (reply.ok) assert.fail(`the call was accepted: ${JSON.stringify(reply.value)}`);
  return reply.error;
}

/** A search provider that answers nothing: the tests below are about the key, not about the search. */
function quietProvider(onSearch: () => void = () => {}): SearchProviderApi {
  return {
    id: 'deepseek-official',
    available: () => true,
    search: async () => {
      onSearch();
      return { sources: [], truncated: false };
    },
  };
}

/** Run with `DEEPSEEK_API_KEY` gone, and put back whatever was there. Every assertion about "no key
 *  anywhere" needs the ambient one out of the way, and the process running this suite may have one. */
async function withoutEnvironmentKey<T>(run: () => Promise<T>): Promise<T> {
  const environment = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    return await run();
  } finally {
    if (environment !== undefined) process.env.DEEPSEEK_API_KEY = environment;
  }
}

test('search routes the DeepSeek provider through WebRuntime', async () => {
  let options: DeepSeekSearchProviderOptions | undefined;
  let receivedRequest: unknown;
  let receivedSignal: AbortSignal | undefined;

  await withSearch(
    {
      options: {
        apiKey: 'test-key',
        baseURL: 'https://search.example/v1',
        model: 'search-model',
        apiVersion: 'test-version',
        maxTokens: 123,
        maxUses: 2,
        maxResults: 1,
        timeoutMs: 5000,
        providerFactory: (resolveOptions) => {
          options = resolveOptions();
          return {
            id: 'deepseek-official',
            available: () => true,
            search: async (request, signal) => {
              receivedRequest = request;
              receivedSignal = signal;
              return {
                sources: [{ url: 'https://one.example', title: 'One' }],
                truncated: true,
              };
            },
          };
        },
      },
    },
    async (caller) => {
      const result = accepted<WebSearchResult>(
        await caller.call('search.search', { query: ' latest Node.js release ', maxResults: 1 }),
      );

      assert.deepEqual(receivedRequest, { query: 'latest Node.js release', maxResults: 1 });
      assert.equal(receivedSignal?.aborted, false);
      assert.deepEqual(result, {
        sources: [{ url: 'https://one.example', title: 'One' }],
        truncated: true,
      });
      assert.equal(options?.apiKey, 'test-key');
      assert.equal(options?.baseURL, 'https://search.example/v1');
      assert.equal(options?.model, 'search-model');
      assert.equal(options?.apiVersion, 'test-version');
      assert.equal(options?.maxTokens, 123);
      assert.equal(options?.maxUses, 2);
    },
  );
});

test('fetch routes the HTTP provider through WebRuntime', async () => {
  let limits: HttpFetchLimits | undefined;
  let receivedRequest: unknown;
  let receivedSignal: AbortSignal | undefined;

  await withSearch(
    {
      options: {
        fetchMaxResponseBytes: 2048,
        fetchMaxBodyChars: 1024,
        fetchTimeoutMs: 5000,
        fetchMaxRedirects: 2,
        fetchUserAgent: 'node-agent-test',
        fetchProviderFactory: (resolvedLimits) => {
          limits = resolvedLimits;
          return {
            id: 'http',
            available: () => true,
            fetch: async (request, signal) => {
              receivedRequest = request;
              receivedSignal = signal;
              return {
                url: request.url,
                statusCode: 200,
                body: { kind: 'html', content: '<h1>Example</h1>' },
                truncated: false,
              };
            },
          };
        },
      },
    },
    async (caller) => {
      const result = accepted<WebFetchResult>(
        await caller.call('search.fetch', { url: ' https://example.com/page ' }),
      );

      assert.deepEqual(receivedRequest, { url: 'https://example.com/page' });
      assert.equal(receivedSignal?.aborted, false);
      assert.deepEqual(result, {
        url: 'https://example.com/page',
        statusCode: 200,
        body: { kind: 'html', content: '<h1>Example</h1>' },
        truncated: false,
      });
      assert.deepEqual(limits, {
        maxResponseBytes: 2048,
        maxBodyChars: 1024,
        timeoutMs: 5000,
        maxRedirects: 2,
        userAgent: 'node-agent-test',
      });
    },
  );
});

test('search forwards provider failures', async () => {
  await withSearch(
    {
      options: {
        apiKey: 'test-key',
        providerFactory: () => ({
          id: 'deepseek-official',
          available: () => true,
          search: async () => {
            throw new Error('search failed');
          },
        }),
      },
    },
    async (caller) => {
      assert.match(
        refusal(await caller.call('search.search', { query: 'query' })),
        /search failed/,
      );
    },
  );
});

test('search rejects invalid queries before calling the provider', async () => {
  let called = false;
  await withSearch(
    {
      options: {
        providerFactory: () => ({
          id: 'deepseek-official',
          available: () => true,
          search: async () => {
            called = true;
            return { sources: [], truncated: false };
          },
        }),
      },
    },
    async (caller) => {
      assert.match(refusal(await caller.call('search.search', { query: '   ' })), /non-empty/);
      assert.equal(called, false);
    },
  );
});

test('fetch rejects an empty URL before calling the provider', async () => {
  let called = false;
  await withSearch(
    {
      options: {
        fetchProviderFactory: () => ({
          id: 'http',
          available: () => true,
          fetch: async () => {
            called = true;
            throw new Error('unexpected fetch');
          },
        }),
      },
    },
    async (caller) => {
      assert.match(refusal(await caller.call('search.fetch', { url: '   ' })), /non-empty URL/);
      assert.equal(called, false);
    },
  );
});

test('a key saved on the page is the one the next search uses, and it survives a restart', async () => {
  await withoutEnvironmentKey(async () => {
    let options: DeepSeekSearchProviderOptions | undefined;
    await withSearch(
      {
        options: {
          providerFactory: (resolveOptions) => {
            options = resolveOptions();
            return quietProvider();
          },
        },
      },
      async (caller, restart) => {
        assert.deepEqual(accepted<KeyState>(await caller.call('search.key', {})), {
          configured: false,
          source: 'none',
          persistent: true,
        });

        const saved = accepted<KeyState>(
          await caller.call('search.key', { action: 'save', api_key: ' sk-page-1 ' }),
        );
        assert.deepEqual(saved, { configured: true, source: 'page', persistent: true });
        assert.equal(
          await options?.resolveApiKey?.(),
          'sk-page-1',
          'the next search goes out with it',
        );

        // A key is only saved if it is still there when the process is not: read back from a node
        // that just joined, over the history node, with nothing else carried over.
        await restart();
        assert.deepEqual(accepted<KeyState>(await caller.call('search.key', {})), {
          configured: true,
          source: 'page',
          persistent: true,
        });
        assert.equal(await options?.resolveApiKey?.(), 'sk-page-1');
      },
    );
  });
});

test('with no key anywhere a search says where to put one', async () => {
  await withoutEnvironmentKey(async () => {
    let searches = 0;
    await withSearch(
      { options: { providerFactory: () => quietProvider(() => (searches += 1)) } },
      async (caller) => {
        assert.equal(
          accepted<KeyState>(await caller.call('search.key', { action: 'status' })).configured,
          false,
        );
        // The sentence a person reads has to name the page: "missing credentials" from the provider
        // underneath leaves them looking at the wrong settings screen.
        assert.match(
          refusal(await caller.call('search.search', { query: 'anything' })),
          /open the search page and save one/,
        );
        assert.equal(searches, 0, 'nothing was sent without a key');
      },
    );
  });
});

test('clearing the saved key falls back to the one in the environment', async () => {
  const environment = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-environment';
  try {
    await withSearch({}, async (caller) => {
      assert.deepEqual(accepted<KeyState>(await caller.call('search.key', {})), {
        configured: true,
        source: 'environment',
        persistent: true,
      });
      assert.deepEqual(
        accepted<KeyState>(await caller.call('search.key', { action: 'save', api_key: 'sk-page' })),
        { configured: true, source: 'page', persistent: true },
      );
      assert.deepEqual(accepted<KeyState>(await caller.call('search.key', { action: 'clear' })), {
        configured: true,
        source: 'environment',
        persistent: true,
      });
    });
  } finally {
    if (environment === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = environment;
  }
});

test('the page and the key status never hand the key back', async () => {
  await withSearch({}, async (caller) => {
    const secret = 'sk-page-secret-1234';
    const state = accepted<KeyState>(
      await caller.call('search.key', { action: 'save', api_key: secret }),
    );
    assert.equal(JSON.stringify(state).includes(secret), false, 'status answers with no key in it');
    assert.equal(state.configured, true);

    const page = accepted<string>(await caller.call('search.ui', {}));
    // The page is a document, not an answer: it carries this node's name and a masked field, and the
    // key it talks about is nowhere in the HTML it gets.
    assert.equal(page.includes(secret), false, 'the saved key is not in the page');
    assert.equal(page.includes('__NODE__'), false);
    assert.match(page, /const INJECTED = "search";/);
    assert.match(
      page,
      /type="password"/,
      'the key is masked while it is typed, never shown plainly',
    );
  });
});

test('a save without a key is refused, and so is an action that does not exist', async () => {
  await withSearch({}, async (caller) => {
    assert.match(refusal(await caller.call('search.key', { action: 'save' })), /wants api_key/);
    assert.match(
      refusal(await caller.call('search.key', { action: 'delete' })),
      /unknown key action "delete" \(status, save, clear\)/,
    );
  });
});

test('a key saved as a number is read as no key, and the node still starts', async () => {
  await withoutEnvironmentKey(async () => {
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      await withSearch(
        { prepare: (store) => store.plant('api-key', { api_key: 1234 }) },
        async (caller) => {
          assert.deepEqual(accepted<KeyState>(await caller.call('search.key', {})), {
            configured: false,
            source: 'none',
            persistent: true,
          });
          // Unconfigured, not broken: the same sentence a node that was never given a key gives.
          assert.match(
            refusal(await caller.call('search.search', { query: 'anything' })),
            /open the search page and save one/,
          );
          const page = accepted<string>(await caller.call('search.ui', {}));
          assert.match(page, /No key yet/, 'the page says the key is not configured');
          assert.equal(
            /damaged|corrupt/i.test(page),
            false,
            'and there is no other state to explain the value',
          );
        },
      );
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(warnings, [], 'a value this node never wrote is not worth a warning');
  });
});

test('a key saved as null or as an empty string is read as no key', async () => {
  await withoutEnvironmentKey(async () => {
    for (const planted of [null, ''] as unknown[]) {
      await withSearch(
        { prepare: (store) => store.plant('api-key', { api_key: planted }) },
        async (caller, _restart, store) => {
          assert.deepEqual(accepted<KeyState>(await caller.call('search.key', {})), {
            configured: false,
            source: 'none',
            persistent: true,
          });
          // The unit is not spoiled: a save on top of an ignored value is a normal save.
          assert.deepEqual(
            accepted<KeyState>(
              await caller.call('search.key', { action: 'save', api_key: 'sk-after' }),
            ),
            { configured: true, source: 'page', persistent: true },
          );
          assert.deepEqual(store.meta('api-key'), { api_key: 'sk-after' });
        },
      );
    }
  });
});

test('a key that is not a non-empty string is refused, and nothing is written', async () => {
  await withoutEnvironmentKey(async () => {
    await withSearch({}, async (caller, _restart, store) => {
      for (const bad of [1234, '', ' '] as unknown[]) {
        const error = refusal(await caller.call('search.key', { action: 'save', api_key: bad }));
        assert.match(error, /wants api_key/);
        assert.equal(
          error.includes('\n'),
          false,
          'one line: the field, the rule, where to get one',
        );
      }
      assert.equal(store.meta('api-key'), null, 'a refused save wrote nothing');
      assert.deepEqual(accepted<KeyState>(await caller.call('search.key', {})), {
        configured: false,
        source: 'none',
        persistent: true,
      });
    });
  });
});

test('a key that is a string is saved trimmed, and read back at the next join', async () => {
  await withoutEnvironmentKey(async () => {
    await withSearch({}, async (caller, restart, store) => {
      assert.deepEqual(
        accepted<KeyState>(
          await caller.call('search.key', { action: 'save', api_key: ' sk-page-2 ' }),
        ),
        { configured: true, source: 'page', persistent: true },
      );
      assert.deepEqual(
        store.meta('api-key'),
        { api_key: 'sk-page-2' },
        'stored without the blanks it was typed with',
      );
      await restart();
      assert.deepEqual(accepted<KeyState>(await caller.call('search.key', {})), {
        configured: true,
        source: 'page',
        persistent: true,
      });
    });
  });
});

test('with no history node a saved key lives in this process, and the page says so', async () => {
  await withoutEnvironmentKey(async () => {
    let options: DeepSeekSearchProviderOptions | undefined;
    let searches = 0;
    await withSearch(
      {
        history: false,
        options: {
          providerFactory: (resolveOptions) => {
            options = resolveOptions();
            return quietProvider(() => (searches += 1));
          },
        },
      },
      async (caller) => {
        assert.deepEqual(accepted<KeyState>(await caller.call('search.key', {})), {
          configured: false,
          source: 'none',
          persistent: false,
        });
        assert.deepEqual(
          accepted<KeyState>(
            await caller.call('search.key', { action: 'save', api_key: 'sk-memory' }),
          ),
          { configured: true, source: 'page', persistent: false },
        );

        // The search is another node instance: the key it sends is the one this process kept.
        await caller.call('search.search', { query: 'anything' });
        assert.equal(searches, 1, 'the search went out with the key saved on the page');
        assert.equal(await options?.resolveApiKey?.(), 'sk-memory');

        assert.deepEqual(accepted<KeyState>(await caller.call('search.key', { action: 'clear' })), {
          configured: false,
          source: 'none',
          persistent: false,
        });
      },
    );
  });
});

test('the served copy is the page in src', (t) => {
  const built = new URL('../dist/ui.html', import.meta.url);
  if (!existsSync(built)) return t.skip('dist/ is only there after `npm run build`');
  assert.equal(
    readFileSync(built, 'utf8'),
    readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8'),
    'run `npm run build`: the page in dist/ is copied from src/, not compiled',
  );
});

/** A resource file as dotted keys: `{ label: { node: 'x' } }` → `label.node`. */
function flattenResource(entries: unknown, prefix = '', into: Record<string, string> = {}) {
  for (const [name, value] of Object.entries((entries ?? {}) as Record<string, unknown>)) {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    if (typeof value === 'string') into[key] = value;
    else if (value !== null && typeof value === 'object') flattenResource(value, key, into);
  }
  return into;
}

test('every word the page shows has a sentence in both languages', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  const read = (locale: string): Record<string, string> =>
    flattenResource(
      JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), 'utf8')),
    );
  const en = read('en');
  const zh = read('zh-CN');
  // What the markup marks (text, placeholder, aria-label) plus what its script builds with t('…').
  const marked = [...html.matchAll(/data-text-(?:placeholder-|label-)?key="([^"]+)"/g)].map((one) =>
    String(one[1]),
  );
  const built = [...html.matchAll(/\bt\('([^']+)'/g)].map((one) => String(one[1]));
  assert.ok(marked.length >= 3, 'the page marks the words it shows');
  assert.ok(built.length >= 3, 'the sentences it builds at run time go through t(...)');
  for (const key of [...marked, ...built]) {
    assert.equal(typeof en[key], 'string', `${key} has English`);
    assert.equal(typeof zh[key], 'string', `${key} has Chinese`);
    assert.notEqual(en[key]?.trim(), '', `${key} is not blank in English`);
    assert.notEqual(zh[key]?.trim(), '', `${key} is not blank in Chinese`);
  }
  // One file per language, the same keys in each: a translator sees exactly what is missing.
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  // The manifest names the node, every capability and every argument it takes, in both languages.
  const labels = [
    'label.node',
    'label.caps.search',
    'label.caps.fetch',
    'label.caps.key',
    'label.caps.ui',
    'label.args.search.query',
    'label.args.search.maxResults',
    'label.args.fetch.url',
    'label.args.key.action',
    'label.args.key.api_key',
  ];
  for (const [locale, file] of [
    ['en', en],
    ['zh-CN', zh],
  ] as const)
    for (const key of labels)
      assert.equal(typeof file[key], 'string', `${key} is named in ${locale}`);
});

test('the page is drawn in the language asked for, and its words arrive with it', async () => {
  await withSearch({}, async (caller) => {
    const english = accepted<string>(await caller.call('search.ui', {}));
    assert.match(english, /<html lang="en">/, 'a page asked for without a language is English');
    assert.match(english, /data-text-key="key\.save">Save</, 'the first paint is already English');
    assert.match(english, /placeholder="DeepSeek API key"/);
    // The slot is filled with this node's resource, its name is in place, and the markers stay so a
    // later change of language is redrawn by the SDK's browser half without a reload.
    assert.doesNotMatch(english, /node-agent:i18n-resource/);
    assert.doesNotMatch(english, /__NODE__/);
    assert.match(english, /src="\/sdk\/i18n-client\.js"/);
    const embedded = /<script type="application\/json" data-i18n-resource>(.*?)<\/script>/.exec(
      english,
    );
    assert.ok(embedded !== null, 'the page carries its resource');
    const resource = JSON.parse(embedded[1] ?? '');
    assert.equal(resource.en['key.clear'], 'Clear');
    assert.equal(resource['zh-CN']['key.clear'], '清除');

    // The shell passes the reader's language with its request; both the text and the attributes the
    // markup carries are drawn in it before the page is sent.
    const chinese = accepted<string>(await caller.call('search.ui', { language: 'zh-CN' }));
    assert.match(chinese, /<html lang="zh-CN">/);
    assert.match(chinese, /<title data-text-key="title">联网搜索 · node_agent<\/title>/);
    assert.match(chinese, /data-text-key="key\.save">保存</);
    assert.match(chinese, /data-text-key="key\.clear">清除</);
    assert.match(
      chinese,
      /placeholder="DeepSeek API 密钥" data-text-placeholder-key="key\.placeholder"/,
    );
    assert.match(chinese, /aria-label="DeepSeek API 密钥" data-text-label-key="key\.placeholder"/);
    assert.equal(
      chinese.includes('>Save<'),
      false,
      'no English is left on a page drawn in Chinese',
    );
  });
});

test('the manifest names this node and its capabilities in both languages', (t) => {
  if (!existsSync(new URL('../dist/i18n/zh-CN.json', import.meta.url)))
    return t.skip('dist/i18n is only there after `npm run build`');
  const manifest = nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(manifest.labels?.node?.en, 'Search');
  assert.equal(manifest.labels?.node?.['zh-CN'], '联网搜索');
  assert.equal(manifest.labels?.caps?.ui?.['zh-CN'], '搜索页面');
  assert.equal(manifest.labels?.args?.search?.maxResults?.en, 'Max results');
});
