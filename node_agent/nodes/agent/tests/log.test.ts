// A log is a field of a line, not a line of its own: the transcript keeps every index it had, the
// model is never handed the note, and the page draws it under the line it belongs to.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CachedModel, wellFormedMessage } from '../src/model.ts';
import type { ChatReply, ChatRequest, Message, Provider, StreamEvent } from '../src/model.ts';

/** Answers with nothing, and remembers what it was handed. */
class RecordingProvider implements Provider {
  readonly seen: ChatRequest[] = [];

  async chat(request: ChatRequest): Promise<ChatReply> {
    this.seen.push(request);
    return { content: '', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.seen.push(request);
    yield { type: 'content', text: 'ok' };
    yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    yield { type: 'end', previous_response_id: null };
  }
}

const lines = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `line ${index}`,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));

test('a cut is written onto the next line, and takes no index of its own', async () => {
  const model = new CachedModel(new RecordingProvider(), {
    compressionThreshold: 1_000,
    compressionTokens: 100,
  });
  await model.pushMessages(lines(8));
  model.cachedNumTokens = 1_500;
  await model.maybeCompress([]); // the notice
  const before = model.messages.total;
  await model.maybeCompress([]); // the cut
  assert.equal(model.messages.total, before, 'a cut adds no line');

  await model.pushMessages([{ role: 'assistant', content: 'after the cut' }]);
  const last = model.messages.at(model.messages.length - 1);
  assert.equal(last?.role, 'assistant');
  assert.match(String(last?.log), /^forgot \d+ messages? \(through index \d+\)/);
  assert.equal(
    model.activeMessages().filter((message) => message.log !== undefined).length > 0,
    true,
    'the line the note rides on is part of the transcript',
  );
});

test('the message built for the provider carries no note, and no lone half', () => {
  const wire = wellFormedMessage({
    role: 'user',
    content: 'a\uD83Db',
    log: 'forgot 2 messages (through index 1)',
  });
  assert.equal('log' in wire, false, 'a note is for the page, not the model');
  assert.equal(wire.content, 'a\uFFFDb', 'and what is left is valid Unicode');
  assert.equal(wire.role, 'user', 'the turn itself is untouched');
});

test('a second note on the same line joins the first rather than replacing it', async () => {
  const model = new CachedModel(new RecordingProvider(), {
    compressionThreshold: 1_000,
    compressionTokens: 100,
  });
  await model.pushMessages([{ role: 'user', content: 'a', log: 'first' }]);
  await model.pushMessages([{ role: 'assistant', content: 'b', log: 'second' }]);
  assert.equal(model.messages.at(0)?.log, 'first', 'the older line keeps its own note');
  assert.equal(model.messages.at(1)?.log, 'second');
});
