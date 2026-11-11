// The transcript as the reader sees it (a bounded window), and as history keeps it (one unit per
// line, one count that moves atomically).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HISTORY_MAX, historyCount, historyFrom, type HistoryWindow } from '../src/runtime.ts';
import { ScriptedProvider } from './scripted_model.ts';
import type { Message } from '../src/types.ts';
import { FakeNet, startAgent } from './harness.ts';

test('a window defaults to the newest lines and is clamped to the transcript', () => {
  assert.equal(historyCount(undefined), HISTORY_MAX);
  assert.equal(historyCount(0), 0);
  assert.equal(historyCount(5), 5);
  assert.equal(historyCount(9999), HISTORY_MAX);
  assert.equal(historyCount(-3), 0);
  assert.equal(historyFrom(undefined, 10), 0);
  assert.equal(historyFrom(4, 10), 4);
  assert.equal(historyFrom(40, 10), 10);
  assert.equal(historyFrom(-2, 10), 0);
});

test('history answers with where the window sits in the transcript', async () => {
  const agent = await startAgent({ provider: new ScriptedProvider() });
  try {
    await agent.call('chat', { msg: { content: 'hello' } });
    const all = (await agent.call('history', {})) as HistoryWindow;
    assert.equal(all.total, all.messages.length);
    assert.equal(all.from, 0);
    const tail = (await agent.call('history', { from: 2, count: 3 })) as HistoryWindow;
    assert.equal(tail.from, 2);
    assert.deepEqual(
      tail.messages.map((line: Message) => line.content),
      all.messages.slice(2, 5).map((line: Message) => line.content),
    );
    const past = (await agent.call('history', { from: 999 })) as HistoryWindow;
    assert.equal(past.from, all.total, 'an index past the end reads as the end');
    assert.deepEqual(past.messages, []);
  } finally {
    await agent.stop();
  }
});

test('a transcript is written one unit per line and read back after a restart', async () => {
  const net = new FakeNet().withHistory();
  const first = await startAgent({ net, provider: new ScriptedProvider(), tenantId: 't1' });
  let lines = 0;
  try {
    await first.call('chat', { msg: { content: 'hello' } });
    const window = (await first.call('history', {})) as HistoryWindow;
    lines = window.total;
    assert.ok(lines >= 2, `the turn wrote ${lines} lines`);
    const state = net.unit('conversation', 't1') as { messages: number };
    assert.equal(state.messages, lines);
    assert.ok(net.unit('conversation.0', 't1') !== undefined);
  } finally {
    await first.stop();
  }

  const second = await startAgent({ net, provider: new ScriptedProvider(), tenantId: 't1' });
  try {
    const window = (await second.call('history', {})) as HistoryWindow;
    assert.equal(window.total, lines, 'the restart continued the same transcript');
    assert.equal(window.messages[0]?.role, 'user');
  } finally {
    await second.stop();
  }
});

test('a turn that ends with an unanswered tool call is closed on the next start', async () => {
  const net = new FakeNet().withHistory();
  const call = {
    id: 'call_1',
    type: 'function',
    function: { name: 'list_nodes', arguments: '{}' },
  };
  net.putUnit('conversation', { messages: 2, usage: {} }, 't1');
  net.putUnit(
    'conversation.0',
    { role: 'user', content: 'hi', at: '2026-01-01T00:00:00.000Z' },
    't1',
  );
  net.putUnit(
    'conversation.1',
    { role: 'assistant', content: '', tool_calls: [call], at: '2026-01-01T00:00:01.000Z' },
    't1',
  );
  const agent = await startAgent({ net, provider: new ScriptedProvider(), tenantId: 't1' });
  try {
    // Reading the transcript builds the model, which is where the repair happens.
    await agent.call('chat_no_wait', { msg: { content: 'again' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const window = (await agent.call('history', {})) as HistoryWindow;
    const repaired = window.messages.find((line) => line.tool_call_id === 'call_1');
    assert.equal(repaired?.content, 'unexpected exit');
  } finally {
    await agent.stop();
  }
});
