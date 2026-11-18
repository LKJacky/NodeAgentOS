// The cache's search after the engine moved to RE2 (`re2js`): linear time instead of backtracking,
// with the answers the old `RegExp` gave -- positions, windows, the last empty match -- unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache, type CacheHistory, type CacheMatch } from '../src/cache.ts';

/** A history that keeps units in memory: enough for a cache to hold what it is told to hold. */
function memoryHistory(): CacheHistory {
  const units = new Map<string, { meta: unknown; revision: number }>();
  let revision = 0;
  return {
    async load(unitId) {
      const unit = units.get(unitId);
      return unit === undefined ? null : { meta: unit.meta, revision: unit.revision };
    },
    async save(unitId, meta, expectedRevision) {
      const current = units.get(unitId);
      if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) {
        throw new Error('revision conflict');
      }
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

const HIGH = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const LOW = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;

/** What the search answered before the move: `RegExp` with `g`, `matchAll`, and the same window.
 *  It is the reference the RE2 answer is compared against, so a change of engine shows up as a diff. */
function referenceSearch(text: string, pattern: string, context: number): CacheMatch[] {
  const windowOf = (from: number, to: number): string => {
    let start = Math.max(0, from);
    let end = Math.min(text.length, to);
    if (start > 0 && start < text.length && LOW(text.charCodeAt(start))) start += 1;
    if (end > 0 && end < text.length && HIGH(text.charCodeAt(end - 1))) end -= 1;
    return text.slice(start, end);
  };
  return [...text.matchAll(new RegExp(pattern, 'g'))].map((match) => {
    const at = match.index ?? 0;
    return { entry: 0, position: at, text: windowOf(at - context, at + match[0].length + context) };
  });
}

test('search answers what the backtracking engine answered: same positions, same windows', async () => {
  const cache = new Cache(3, memoryHistory());
  const texts = [
    'alpha beta gamma delta beta',
    'hay\nhay haystack',
    '\u{1f600}abc\u{1f600} abc',
    'a'.repeat(40),
  ];
  const patterns = ['beta', 'h?ay', 'a|b', '\\w+', '\\s', 's+t', 'x*', 'y*', '^alpha'];

  for (const text of texts) {
    const id = await cache.add(text);
    for (const pattern of patterns) {
      for (const context of [0, 1, 100]) {
        const wanted = referenceSearch(text, pattern, context).map((match) => ({
          ...match,
          entry: id,
        }));
        assert.deepEqual(
          await cache.search(id, pattern, context),
          wanted,
          `${pattern} over ${JSON.stringify(text)} with context ${context}`,
        );
      }
    }
  }
});

test('search keeps every match, the trailing empty one included', async () => {
  const cache = new Cache(2, memoryHistory());
  const id = await cache.add('abc');

  // `b*` matches empty, then `b`, then empty at the end: the last empty match is an answer too.
  assert.deepEqual(
    (await cache.search(id, 'b*', 0)).map((match) => [match.position, match.text]),
    [
      [0, ''],
      [1, 'b'],
      [2, ''],
      [3, ''],
    ],
  );
  assert.deepEqual(await cache.search(id, 'absent', 0), []);
  assert.deepEqual(await cache.search(id, '^z', 0), []);
});

test('search refuses a pattern RE2 cannot run, naming the piece it stopped on', async () => {
  const cache = new Cache(2, memoryHistory());
  const id = await cache.add('alpha beta');

  await assert.rejects(
    () => cache.search(id, '('),
    /not a valid regular expression: error parsing regexp: missing closing \)/,
  );
  const refused: Record<string, RegExp> = {
    '(a)\\1': /invalid escape sequence/,
    'alpha(?= beta)': /invalid or unsupported Perl syntax/,
    '(?<=alpha) beta': /invalid named capture/,
    '(?>alpha)': /invalid or unsupported Perl syntax/,
  };
  for (const [pattern, why] of Object.entries(refused)) {
    await assert.rejects(
      () => cache.search(id, pattern),
      (error: Error) => {
        assert.match(error.message, /^pattern is not a valid regular expression: /, pattern);
        assert.match(error.message, why, pattern);
        return true;
      },
    );
  }

  // A refusal is decided before the worker starts, so nothing is left running behind it.
  const started = process.hrtime.bigint();
  await assert.rejects(() => cache.search(id, '(?=x)'), /not a valid regular expression/);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500);
});

test('RE2-only syntax works: inline flags and multiline', async () => {
  const cache = new Cache(2, memoryHistory());
  const id = await cache.add('Alpha\nalpha');

  assert.deepEqual(
    (await cache.search(id, '(?i)alpha', 0)).map((match) => match.position),
    [0, 6],
  );
  assert.deepEqual(
    (await cache.search(id, '(?m)^alpha', 0)).map((match) => match.position),
    [6],
  );
  // A dot still stops at a newline unless `(?s)` says otherwise: `A.pha` finds `Alpha`, and nothing
  // bridges the line break.
  assert.deepEqual(
    (await cache.search(id, 'A.pha', 0)).map((match) => match.position),
    [0],
  );
  assert.deepEqual((await cache.search(id, 'pha.al', 0)).map((match) => match.position), []);
});

test('a catastrophic pattern is linear in the text, and the worker budget is still there', async () => {
  const cache = new Cache(2, memoryHistory());
  const text = `${'a'.repeat(200_000)}!`;
  const id = await cache.add(text);

  const started = process.hrtime.bigint();
  assert.deepEqual(await cache.search(id, '(a+)+$', 10), []);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // 200 000 characters under `(a+)+$`: a backtracking engine would still be going.
  assert.ok(ms < 1500, `search took ${ms}ms on 200 000 characters`);

  // The second line of defence is not gone: a one millisecond budget still kills the thread and
  // comes back as the budget's own error, not as an answer.
  await assert.rejects(
    () => cache.search(id, 'a', 0, 1),
    /took longer than 0\.001s on cache entry \d+/,
  );
});

