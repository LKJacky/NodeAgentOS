// The request body as the model server reads it.
//
// The bug this file is here for: a lone UTF-16 surrogate reached the wire inside a message, the
// server answered 400 "no low surrogate in string", and the provider retried the same broken body
// eight times before the sample died. Neither the transcript on disk nor the dataset had one, so
// the half was made somewhere between the messages and JSON.stringify - which is why the scrub
// lives at the very end, where it cannot miss a string it does not know about.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scrubSurrogates, wellFormedText } from '../src/providers/wellformed.ts';

const HIGH = '\uD83D'; // first half of an emoji, alone
const LOW = '\uDE00';

test('a lone high half becomes U+FFFD', () => {
  assert.equal(wellFormedText(`a${HIGH}b`), 'a\uFFFDb');
});

test('a lone low half becomes U+FFFD', () => {
  assert.equal(wellFormedText(`a${LOW}b`), 'a\uFFFDb');
});

test('a whole pair is left alone', () => {
  const emoji = '\uD83D\uDE00';
  assert.equal(wellFormedText(`a${emoji}b`), `a${emoji}b`);
});

test('every string of the body is cleaned, and the body keeps its shape', () => {
  const body = {
    model: 'm',
    messages: [
      { role: 'system', content: 'ok' },
      { role: 'tool', content: `found${HIGH}` },
    ],
    tools: [{ type: 'function', function: { name: 'x', description: `d${LOW}` } }],
    max_tokens: 32,
  };
  const lines: string[] = [];
  const cleaned = scrubSurrogates(body, (line) => lines.push(line));
  assert.equal(cleaned.messages[1].content, 'found\uFFFD');
  assert.equal(cleaned.tools[0].function.description, 'd\uFFFD');
  assert.equal(cleaned.messages[0].content, 'ok');
  assert.equal(cleaned.max_tokens, 32);
  assert.ok(lines.some((line) => line.includes('body.messages[1].content')));
  assert.ok(lines.some((line) => line.includes('body.tools[0].function.description')));
});

test('a clean body is returned unchanged and logs nothing', () => {
  const body = { messages: [{ role: 'user', content: 'no halves here' }] };
  const lines: string[] = [];
  assert.deepEqual(scrubSurrogates(body, (line) => lines.push(line)), body);
  assert.equal(lines.length, 0);
});
