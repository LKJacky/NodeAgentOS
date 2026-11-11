import assert from 'node:assert/strict';
import { Assembler, MAX_FRAME_BYTES, parts } from './dist/chunks.js';

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const big = (value) => `${JSON.stringify({ value })}\n`;

function roundtrip(value) {
  const text = big(value);
  const pieces = parts(text);
  assert.ok(pieces.every((piece) => bytes(piece) <= MAX_FRAME_BYTES));
  const out = [];
  const assembler = new Assembler((frame) => out.push(frame));
  for (const piece of pieces) assembler.feed(JSON.parse(piece));
  assert.deepEqual(out, [{ value }]);
}

roundtrip('x'.repeat(3 * MAX_FRAME_BYTES));
roundtrip('中'.repeat(3 * MAX_FRAME_BYTES));
roundtrip('😀'.repeat(400_000));

// A gap is a broken frame, not a shorter one.
{
  const pieces = parts(big('a'.repeat(2 * MAX_FRAME_BYTES))).map((piece) => JSON.parse(piece));
  const out = [];
  const assembler = new Assembler((frame) => out.push(frame));
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    for (const piece of pieces.filter((_, index) => index !== 2)) assembler.feed(piece);
  } finally {
    console.error = original;
  }
  assert.deepEqual(out, []);
  assert.match(logged.join('\n'), /part gap/);
}

console.log('chunks ok');
