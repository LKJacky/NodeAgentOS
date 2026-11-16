// The two pure halves of the page, on their own: how much of a transcript one page keeps, and how an
// answer is assembled out of deltas.
//
// They are their own script (`<script id="page-model">`) exactly so this file can exist: the decisions
// about memory and about what a delta means are not written into the DOM, and a test reads them without
// a page, a browser or a node in between. The last test runs the same deltas through the page's
// assembler and through the node's (`src/stream.ts`), because two copies of one rule that disagree are
// worse than one copy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { StreamAssembly } from '../src/stream.ts';

//: The page as it is served: `npm run build` copies `src/ui.html` to `dist/`, and this is the copy.
const HTML = readFileSync(new URL('../dist/ui.html', import.meta.url), 'utf8');
const MODEL = HTML.slice(
  HTML.indexOf('<script id="page-model">') + '<script id="page-model">'.length,
  HTML.indexOf('</script>', HTML.indexOf('<script id="page-model">')),
);

const sandbox = { globalThis: undefined, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(MODEL, sandbox);
const { agentRetention, agentStream } = sandbox;

// ---- the cap ----

test('the page\u2019s own numbers are the ones this behaviour is built on', () => {
  assert.equal(agentRetention.DEFAULT_MAX_MESSAGES, 200, 'a page keeps two hundred lines by default');
  assert.equal(agentRetention.DEFAULT_IDLE_TTL_MS, 5 * 60 * 1000, 'and an unseen one lives five minutes');
});

test('messages under the cap are all kept', () => {
  assert.equal(agentRetention.trimPrefix({ count: 10, cap: 200 }), 0);
  assert.equal(agentRetention.trimPrefix({ count: 200, cap: 200 }), 0);
  assert.equal(agentRetention.trimPrefix({ count: 0, cap: 200 }), 0);
});

test('past the cap the oldest go, exactly as many as are over it', () => {
  assert.equal(agentRetention.trimPrefix({ count: 204, cap: 200 }), 4);
  assert.equal(agentRetention.trimPrefix({ count: 500, cap: 3 }), 497);
  assert.equal(agentRetention.trimPrefix({ count: 3, cap: 0 }), 3, 'a cap of nothing drops the prefix');
});

test('a protected line stops the drop before it', () => {
  // 204 lines, cap 200: four would go - unless one of them is in the viewport or still referenced.
  assert.equal(agentRetention.trimPrefix({ count: 204, cap: 200, protectedAt: [2] }), 2);
  assert.equal(
    agentRetention.trimPrefix({ count: 204, cap: 200, protectedAt: [0] }),
    0,
    'the first one is the wall',
  );
  assert.equal(
    agentRetention.trimPrefix({ count: 204, cap: 200, protectedAt: [9, 3, 1] }),
    1,
    'the nearest protected position wins, unsorted or not',
  );
  assert.equal(
    agentRetention.trimPrefix({ count: 204, cap: 200, protectedAt: [199] }),
    4,
    'a protected line past the drop does not stand in its way',
  );
});

// ---- the TTL ----

test('an idle page is due only when nobody is on it, nothing is writing, and the TTL has passed', () => {
  const base = { now: 10_000, lastSeen: 10_000, ttl: 5_000 };
  assert.equal(agentRetention.releaseDue({ ...base, active: true }), false, 'the page on screen stays');
  assert.equal(agentRetention.releaseDue({ ...base, streaming: true }), false, 'a draft is never let go');
  assert.equal(agentRetention.releaseDue({ ...base, busy: true }), false, 'nor a page whose turn still runs');
  assert.equal(agentRetention.releaseDue(base), false, 'the TTL has not passed');
  assert.equal(agentRetention.releaseDue({ ...base, now: 14_999 }), false, 'not yet');
  assert.equal(agentRetention.releaseDue({ ...base, now: 15_000 }), true, 'at the TTL it is due');
  assert.equal(
    agentRetention.releaseDue({ ...base, lastSeen: Number.NaN, now: 99_999 }),
    false,
    'a page with no last-seen time is left alone',
  );
});

test('one plan says what a page drops and whether it is let go', () => {
  const numbers = { count: 205, cap: 200, protectedAt: [], now: 60_000, lastSeen: 0, ttl: 5_000 };
  // A plan is made inside the page's own realm, so it is read field by field here.
  const plan = (wanted) => ({ ...agentRetention.plan(wanted) });
  assert.deepEqual(plan({ ...numbers, atEnd: true }), { trim: 5, release: true });
  assert.deepEqual(
    plan({ ...numbers, atEnd: false }),
    { trim: 0, release: true },
    'a reader scrolled up keeps the window; the page itself is still due',
  );
  assert.deepEqual(
    plan({ ...numbers, active: true, atEnd: true }),
    { trim: 5, release: false },
    'the page on screen trims but is not let go',
  );
  assert.deepEqual(
    plan({ ...numbers, streaming: true, now: 1, atEnd: true }),
    { trim: 5, release: false },
    'a streaming page trims, and stays',
  );
});

// ---- the delta protocol, page side ----

test('a draft is what the deltas added up to, and what was drawn is never mutated', () => {
  const first = agentStream.draft('assistant');
  const second = agentStream.apply(first, { content: 'one ' });
  const third = agentStream.apply(second, { content: 'two' });
  assert.equal(first.content, '', 'the first draft is untouched');
  assert.equal(second.content, 'one ');
  assert.equal(third.content, 'one two');

  // `start` reads the node's event; it does not rewrite it.
  const event = { id: 's1', messageId: 'm1', role: 'assistant', seq: 0 };
  assert.deepEqual({ ...agentStream.start(event) }, { id: 's1', messageId: 'm1', seq: 0 });
  assert.deepEqual(event, { id: 's1', messageId: 'm1', role: 'assistant', seq: 0 });
});

test('a delta is accepted only when it is the one that follows', () => {
  const state = { id: 's1', messageId: 'm1', seq: 3 };
  const ok = agentStream.accept(state, { id: 's1', messageId: 'm1', seq: 4, content: 'x' });
  assert.equal(ok.apply, true);
  assert.equal(ok.gap, false);
  assert.equal(ok.state.seq, 4, 'the reader moves on with it');
  assert.equal(state.seq, 3, 'what it was given is not mutated');

  for (const delta of [
    { id: 's1', seq: 6 }, // one missing
    { id: 's1', seq: 3 }, // the one already applied
    { id: 's1', seq: 1 }, // the stream started over
    { id: 's2', seq: 4 }, // another stream
    { id: 's1', seq: 'five' },
  ]) {
    const answer = agentStream.accept(state, delta);
    assert.equal(answer.apply, false, `no append for ${JSON.stringify(delta)}`);
    assert.equal(answer.gap, true, 'and it is a gap to resync');
  }
  assert.equal(agentStream.accept(null, { id: 's1', seq: 1 }).gap, true, 'no start, no append');
});

test('a tool call is assembled out of its fragments', () => {
  let line = agentStream.draft('assistant');
  line = agentStream.apply(line, {
    tool_calls: [{ index: 0, id: 'c1', name: 'shell', arguments: '{"comm' }],
  });
  line = agentStream.apply(line, { tool_calls: [{ index: 0, arguments: 'and":"ls"}' }] });
  assert.equal(line.tool_calls.length, 1);
  assert.equal(line.tool_calls[0].id, 'c1');
  assert.equal(line.tool_calls[0].function.name, 'shell');
  assert.equal(line.tool_calls[0].function.arguments, '{"command":"ls"}');
});

test('a resync answer becomes the draft the node has', () => {
  const line = agentStream.adopt({
    role: 'assistant',
    seq: 7,
    content: 'so far',
    reasoning_content: 'because',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
  });
  assert.equal(line.content, 'so far');
  assert.equal(line.reasoning_content, 'because');
  assert.equal(line.tool_calls[0].function.name, 'shell');
});

// ---- one rule, two copies ----
//
// The node assembles with `src/stream.ts` (to answer `stream`) and the page assembles with the script
// above (to draw the tail). They are two copies of one rule, so they are run against the same deltas
// here: a page that disagreed with its node would draw a tail the transcript does not match.
test('the page and the node assemble the same answer out of the same deltas', () => {
  const deltas = [
    { seq: 1, reasoning_content: 'hmm' },
    { seq: 2, content: 'one ' },
    { seq: 3, content: 'two' },
    { seq: 4, tool_calls: [{ index: 0, id: 'c1', name: 'shell', arguments: '{"a"' }] },
    { seq: 5, tool_calls: [{ index: 0, arguments: ':1}' }] },
  ];
  const node = new StreamAssembly('s1', 'agent', 'm1');
  let page = agentStream.draft('assistant');
  let state = agentStream.start({ id: 's1', messageId: 'm1', role: 'assistant', seq: 0 });
  for (const delta of deltas) {
    const event = { type: 'stream_delta', id: 's1', agent: 'agent', messageId: 'm1', ...delta };
    const accepted = agentStream.accept(state, event);
    assert.equal(accepted.apply, true, `the page accepts seq ${delta.seq}`);
    state = accepted.state;
    page = agentStream.apply(page, event);
    node.apply(event);
  }
  node.seq = state.seq;
  // Both sides are read as plain JSON: the page's line comes from the page's own realm.
  assert.deepEqual(
    JSON.parse(JSON.stringify(page)),
    JSON.parse(JSON.stringify(node.message())),
    'the same line, field for field',
  );
  assert.equal(node.state().seq, state.seq, 'and the same seq');
});
