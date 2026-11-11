// The WebSocket decoder: one message is one complete JSON envelope. There is no newline framing
// left, so a malformed message is dropped and the next message still arrives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dec } from '../dist/index.js';

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

test('decoder handles consecutive JSON messages', () => {
  const frames = [];
  const decode = dec((frame) => frames.push(frame));
  decode('{"id":1}');
  decode(Buffer.from('{"id":2}'));
  assert.deepEqual(frames, [{ id: 1 }, { id: 2 }]);
});

test('decoder drops malformed and oversized messages without losing the next one', () => {
  const frames = [];
  const decode = dec((frame) => frames.push(frame));
  const logged = captured(() => {
    decode('{"id":1');
    decode('x'.repeat(2_000_000));
  });
  decode('{"next":true}');
  assert.deepEqual(frames, [{ next: true }]);
  assert.match(logged, /dropped a frame that did not parse/);
  assert.ok(logged.length > 0);
});
