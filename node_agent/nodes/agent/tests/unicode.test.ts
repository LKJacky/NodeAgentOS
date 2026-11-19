// Half a surrogate pair is not valid Unicode: JSON carries it, and a strict reader (the model
// server) refuses the whole request over it. These are the places this package cuts text.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { charCount, headOf, tailOf, wellFormed } from '../src/helpers.ts';
import { Cache, type CacheHistory } from '../src/cache.ts';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when `text` holds no half of a pair that had its other half cut away. */
const whole = (text: string): boolean => !LONE.test(text);

const EMOJI = '\u{1F600}'; // two code units: D83D DE00

function memoryHistory(): CacheHistory {
  const units = new Map<string, unknown>();
  return {
    async load(unitId) {
      return units.has(unitId) ? { meta: units.get(unitId), revision: 1 } : null;
    },
    async save(unitId, meta) {
      units.set(unitId, meta);
      return 1;
    },
    async remove(unitId) {
      units.delete(unitId);
    },
  } as CacheHistory;
}

test('a head cut never ends between the two halves of a pair', () => {
  const text = EMOJI.repeat(6);
  for (let keep = 1; keep <= text.length; keep += 1) {
    const cut = headOf(text, keep);
    assert.ok(whole(cut), `keep ${keep} left a lone surrogate: ${JSON.stringify(cut)}`);
    assert.ok(Array.from(cut).length <= keep, 'a head cut keeps at most keep characters');
  }
  assert.equal(headOf(text, 2), EMOJI.repeat(2), 'two characters, two whole pairs');
  assert.equal(headOf(text, 1), EMOJI, 'one character is one whole pair');
  assert.equal(headOf(text, 0), '', 'nothing asked for, nothing cut');
});

test('a tail cut never begins between the two halves of a pair', () => {
  const text = EMOJI.repeat(6);
  for (let keep = 1; keep <= text.length; keep += 1) {
    const cut = tailOf(text, keep);
    assert.ok(whole(cut), `keep ${keep} left a lone surrogate: ${JSON.stringify(cut)}`);
    assert.ok(Array.from(cut).length <= keep, 'a tail cut keeps at most keep characters');
  }
  assert.equal(tailOf(text, 2), EMOJI.repeat(2), 'two characters, two whole pairs');
  assert.equal(tailOf(text, 1), EMOJI, 'one character is one whole pair');
  assert.equal(tailOf(text, 0), '', 'nothing asked for, nothing cut');
});

test('a budget counted in characters is spent in characters', () => {
  const text = EMOJI.repeat(10);
  assert.equal(charCount(text), 10, 'ten pairs are ten characters');
  assert.equal(charCount(text), EMOJI.repeat(10).length / 2, 'not the twenty code units');
  assert.equal(headOf(text, charCount(text)), text, 'a whole budget keeps the whole text');
  assert.equal(tailOf(text, charCount(text)), text, 'in both directions');
  const cut = headOf(text, 4);
  assert.equal(charCount(cut), 4, 'the cut spends exactly the budget it was given');
});

test('a string that already carries half a pair is made valid on the way out', () => {
  assert.equal(wellFormed('a\uD83Db'), 'a\uFFFDb', 'a lone high half becomes U+FFFD');
  assert.equal(wellFormed('a\uDE00b'), 'a\uFFFDb', 'a lone low half becomes U+FFFD');
  assert.equal(wellFormed('a\uD83D\uDE00b'), 'a\uD83D\uDE00b', 'a whole pair is left alone');
});

test('a cache search window never cuts a pair in two', async () => {
  const cache = new Cache(4, memoryHistory());
  await cache.add(`start ${EMOJI}${EMOJI}${EMOJI} end`);
  // A character of context on each side lands inside the pairs either way.
  for (const context of [0, 1, 2, 3]) {
    for (const match of await cache.search(0, 'start|end', { context })) {
      assert.ok(whole(match.text), `context ${context} cut a pair: ${JSON.stringify(match.text)}`);
    }
  }
});
