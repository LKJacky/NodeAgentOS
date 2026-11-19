// The two numbers a setting is handed to, on their own: the model's compression pair and the cache's
// cap. Both are built once, so what matters is that a number saved afterwards is what they use from
// then on - the runtime tests for the same thing are in `settings.test.ts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache, DEFAULT_CACHE_SIZE, type CacheHistory } from '../src/cache.ts';
import {
  CachedModel,
  COMPRESSION_THRESHOLD,
  COMPRESSION_TOKENS,
  EMPTY_TOOL,
  FORGET_MESSAGE,
  radicalForget,
  wireTools,
} from '../src/model.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import type { ChatReply, ChatRequest, Provider, StreamEvent, ToolSpec } from '../src/types.ts';

/** A provider that never answers: a model built to be looked at, not run. */
class QuietProvider implements Provider {
  async chat(_request: ChatRequest): Promise<ChatReply> {
    return { content: '' };
  }

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    yield { type: 'content', text: '' };
    yield { type: 'end', previous_response_id: null };
  }
}

/** A history that keeps its units in a map, which is all a cache needs. */
function memoryHistory(): CacheHistory {
  const units = new Map<string, { meta: unknown; revision: number }>();
  let revision = 0;
  return {
    async load(unitId) {
      const unit = units.get(unitId);
      return unit === undefined ? null : { meta: unit.meta, revision: unit.revision };
    },
    async save(unitId, meta) {
      revision += 1;
      units.set(unitId, { meta, revision });
      return revision;
    },
    async remove(unitId) {
      units.delete(unitId);
    },
    async units() {
      return [...units.entries()].map(([unitId, unit]) => ({ unitId, revision: unit.revision }));
    },
  };
}

test('a model keeps the compression numbers it was built with, and takes new ones', () => {
  const model = new CachedModel(new QuietProvider());
  assert.equal(model.compressionThreshold, COMPRESSION_THRESHOLD, 'the package default');
  assert.equal(model.compressionThreshold, 128 * 1024);
  assert.equal(model.compressionTokens, COMPRESSION_TOKENS);
  assert.equal(model.compressionTokens, 32 * 1024);

  const given = new CachedModel(new QuietProvider(), {
    compressionThreshold: 4_096,
    compressionTokens: 1_024,
  });
  assert.equal(given.compressionThreshold, 4_096, 'an option is what a model starts on');
  assert.equal(given.compressionTokens, 1_024);

  given.setCompression(8_192, 2_048);
  assert.equal(given.compressionThreshold, 8_192, 'and a saved pair reaches it afterwards');
  assert.equal(given.compressionTokens, 2_048);
});

test('the compression pair is what decides when the transcript is cut', async () => {
  const model = new CachedModel(new QuietProvider(), {
    compressionThreshold: 10_000,
    compressionTokens: 1_000,
  });
  await model.pushMessages([
    { role: 'user', content: 'a', usage: { total_tokens: 100 } },
    { role: 'assistant', content: 'b', usage: { total_tokens: 100 } },
  ]);
  model.cachedNumTokens = 5_000;
  await model.maybeCompress([]);
  assert.equal(model.messages.length, 2, 'under the threshold nothing is written');

  model.setCompression(1_000, 500);
  await model.maybeCompress([]);
  assert.equal(
    model.messages.length,
    3,
    'over it, the notice that stands in for the cut is written',
  );
  const notice = model.messages.at(model.messages.length - 1);
  assert.equal(notice?.role, 'system', 'and it is the one system line a request gets');
  assert.notEqual(notice?.content, FORGET_MESSAGE.content, 'it is the notice, not the stand-in');
  assert.equal(
    model.activeMessages().filter((message) => message.role === 'system').length,
    1,
    'the request carries the notice and nothing else in front of the transcript',
  );
});

test('a cache keeps the cap it was built with, and a new one lets go of what is past it', async () => {
  const cache = new Cache(3, memoryHistory());
  assert.equal(cache.maxSize, 3);
  await cache.add('one');
  await cache.add('two');
  await cache.add('three');
  assert.deepEqual(await cache.ids(), [1, 2, 3]);

  await cache.setMaxSize(1);
  assert.equal(cache.maxSize, 1, 'the cache that was already built takes the new cap');
  assert.deepEqual(await cache.ids(), [3], 'and the entries past it are gone');
  assert.equal(await cache.read(1), null);
  assert.equal((await cache.read(3))?.text, 'three');

  // The cap an `add` enforces from then on is the new one too.
  await cache.add('four');
  await cache.add('five');
  assert.deepEqual(await cache.ids(), [5]);
});

test('a cache refuses a cap it could not run on', async () => {
  const cache = new Cache(2, memoryHistory());
  await assert.rejects(() => cache.setMaxSize(0), /at least 1/);
  await assert.rejects(() => cache.setMaxSize(1.5), /whole number/);
  assert.equal(cache.maxSize, 2, 'a refused cap changes nothing');
});

test('the settings defaults are the numbers the model and the cache were already built with', () => {
  assert.equal(DEFAULT_SETTINGS.compressionThreshold, COMPRESSION_THRESHOLD);
  assert.equal(DEFAULT_SETTINGS.compressionTokens, COMPRESSION_TOKENS);
  assert.equal(DEFAULT_SETTINGS.cacheSize, DEFAULT_CACHE_SIZE);
  assert.equal(DEFAULT_CACHE_SIZE, 500);
  assert.equal(DEFAULT_SETTINGS.allowSpawn, true, 'a root agent starts allowed to spawn');
  assert.equal(DEFAULT_SETTINGS.allowAskUser, true, 'and allowed to ask');
  assert.deepEqual(
    Object.keys(DEFAULT_SETTINGS).sort(),
    [
      'allowAskUser',
      'allowSpawn',
      'cacheSize',
      'compressionNotice',
      'compressionThreshold',
      'compressionTokens',
      'maxAgents',
      'maxCompletionTokens',
      'maxInputLengthPerTurn',
    ],
    'and no field this release removed is among them',
  );
});

test('radical forget offers one placeholder tool only after a cut', () => {
  const readAll: ToolSpec = {
    type: 'function',
    function: {
      name: 'read_all_tools',
      description: 'Read every tool definition',
      parameters: { type: 'object', properties: {} },
    },
  };
  const real: ToolSpec[] = [
    readAll,
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  assert.equal(radicalForget({ RADICAL_FORGET: 'on' }), true);
  assert.equal(radicalForget({ RADICAL_FORGET: '0' }), false);
  assert.equal(radicalForget({}), false);
  assert.equal(wireTools(real, 0, true), real, 'before a cut the real tools are untouched');
  assert.deepEqual(
    wireTools(real, 1, true),
    [EMPTY_TOOL],
    'after a cut only the placeholder goes, even if read_all_tools was offered',
  );
  assert.equal(wireTools(real, 1, false), real, 'and with the flag off nothing is swapped');
  assert.equal(EMPTY_TOOL.function.name, 'empty_tool');
  assert.match(EMPTY_TOOL.function.description, /cannot be called/);
});
