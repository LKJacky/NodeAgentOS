// The chunk layer: every piece fits the wire, the pieces rebuild the frame, and a frame that cannot
// be rebuilt is dropped *and said so* — a truncated frame must never look like a valid shorter one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Assembler, MAX_FRAME_CHARS, parts } from '../dist/wire.js';

const bytes = (text) => Buffer.byteLength(text, 'utf8');

/** Run `fn` with console.error captured; returns what it printed. */
function captured(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

function roundtrip(text) {
  const pieces = parts(text);
  assert.ok(pieces.every((piece) => bytes(piece) <= MAX_FRAME_CHARS));
  const out = [];
  const assembler = new Assembler((frame) => out.push(frame));
  for (const piece of pieces) assembler.feed(JSON.parse(piece));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], JSON.parse(text));
}

test('a frame that needs parts rebuilds exactly, whatever the text', () => {
  roundtrip(JSON.stringify({ v: 'x'.repeat(3 * MAX_FRAME_CHARS) }));
  roundtrip(JSON.stringify({ v: '中'.repeat(3 * MAX_FRAME_CHARS) }));
  roundtrip(JSON.stringify({ v: '😀'.repeat(400_000) }));
  roundtrip(JSON.stringify({ v: '"\\\n'.repeat(300_000) }));
});

test('a frame that fits one message is not cut up', () => {
  assert.deepEqual(parts(JSON.stringify({ v: 'hi' })), [JSON.stringify({ v: 'hi' })]);
});

test('a missing piece drops the frame and says which sequence was expected', () => {
  const pieces = parts(JSON.stringify({ v: 'a'.repeat(2 * MAX_FRAME_CHARS) })).map((piece) => JSON.parse(piece));
  const out = [];
  const assembler = new Assembler((frame) => out.push(frame));
  const logged = captured(() => {
    for (const piece of pieces.filter((_, index) => index !== 2)) assembler.feed(piece);
  });
  assert.deepEqual(out, []);
  assert.match(logged, /part gap for .*: got seq 3, want 2/);
});

test('a half-arrived frame that grows too big is dropped and said so', () => {
  const out = [];
  const assembler = new Assembler((frame) => out.push(frame), 1_000);
  const logged = captured(() => {
    for (let seq = 0; seq < 5; seq += 1) {
      assembler.feed({ op: 'part', id: 'x', seq, value: 'z'.repeat(400), last: false });
    }
  });
  assert.deepEqual(out, []);
  assert.match(logged, /more than 1000 characters held/);
});

test('a multi-part frame that does not parse is dropped and said so', () => {
  const out = [];
  const assembler = new Assembler((frame) => out.push(frame));
  const logged = captured(() => {
    assembler.feed({ op: 'part', id: 'y', seq: 0, value: '{"v":"', last: false });
    assembler.feed({ op: 'part', id: 'y', seq: 1, value: 'oops', last: false });
    assembler.feed({ op: 'part', id: 'y', seq: 2, value: '', last: true });
  });
  assert.deepEqual(out, []);
  assert.match(logged, /3-part frame did not parse/);
});
