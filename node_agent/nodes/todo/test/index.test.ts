import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Outcome } from '@node-agent/sdk';
import type { PressReceipt, Today, Todo } from '../src/index.ts';
import { Caller, Fixture, startFakeAgent, startHistory, startTodo, userOf } from './support.ts';

/** The todo node, a history node and a caller on one bus, all in the user of `database`, so a second
 *  round over the same file is a restart and a different file is a different user. */
async function withTodo<T>(
  database: string,
  run: (caller: Caller, history: Awaited<ReturnType<typeof startHistory>>) => Promise<T>,
  target?: string,
): Promise<T> {
  const fixture = await Fixture.open(userOf(database));
  const history = await startHistory(fixture, database);
  const todo = await startTodo(fixture, target);
  const caller = await Caller.join(fixture);
  try {
    return await run(caller, history);
  } finally {
    await caller.close();
    await todo.stop();
    await history.stop();
    await fixture.close();
  }
}

/** The three todos and the two-button card the tests below work on, written the way a model writes
 *  them: `todo.add` three times, then `todo.set-today`.
 *
 *  The node itself starts empty -- it invents no content, so a stack without setup shows an empty
 *  list and an empty card -- which is why a test that is about arranging or pressing lays its own
 *  fixture out first, with the same calls a model makes. */
async function furnish(caller: Caller): Promise<void> {
  const seeds = [
    {
      title: 'Review the Today card',
      text: 'Today is free text; the buttons under it are written by the model.',
    },
    {
      title: 'Check something off',
      text: 'Checked items stay in the list, struck through, so the day keeps its record.',
    },
    { title: 'Add your own item', text: 'Type in the add field above the list and press Enter.' },
  ];
  for (const seed of seeds) {
    const added = await caller.call('todo.add', seed);
    assert.equal(added.ok, true, added.ok ? '' : added.error);
  }
  const wrote = await caller.call('todo.set-today', {
    text: 'Free space for the day. Write anything here; the model can put buttons on it.',
    buttons: [
      {
        label: 'What is left today?',
        message: 'What is left on my todo list? Show me the open items.',
      },
      {
        label: 'Plan my day',
        message: 'Look at my todo list and write a plan for today into todo today.',
      },
    ],
  });
  assert.equal(wrote.ok, true, wrote.ok ? '' : wrote.error);
}

/** Poll instead of sleeping a fixed time: fast when the event is already there, honest when not. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((ok) => setTimeout(ok, 5));
  }
  throw new Error('timed out waiting for the event');
}

/** The error text of a call that has to be refused — a call that was accepted is the failure. */
function refusal(reply: Outcome): string {
  if (reply.ok) assert.fail(`the call was accepted: ${JSON.stringify(reply.value)}`);
  return reply.error;
}

function accepted<T>(reply: Outcome): T {
  if (!reply.ok) assert.fail(`the call was refused: ${reply.error}`);
  return reply.value as T;
}

function listed(reply: Outcome): Todo[] {
  return accepted<Todo[]>(reply);
}

test('Today is free text and buttons, independent of the list', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    const before = accepted<Today>(await caller.call('todo.today', {}));
    assert.equal(typeof before.text, 'string');
    assert.equal(before.updatedAt, null); // the shape the node starts with has never been written

    const wrote = await caller.call('todo.set-today', {
      text: '  lunch with Lin, then the todo app  ',
      buttons: [{ label: 'What is left?', message: 'What is left on my todo list?' }],
    });
    assert.equal(wrote.ok, true, wrote.ok ? '' : wrote.error);

    const card = accepted<Today>(await caller.call('todo.today', {}));
    assert.equal(card.text, 'lunch with Lin, then the todo app'); // trimmed on the way in
    assert.deepEqual(card.buttons, [
      { label: 'What is left?', message: 'What is left on my todo list?' },
    ]);
    assert.ok((card.updatedAt ?? '').startsWith('20'));

    // The list is not Today: writing a todo and ticking one off leaves the card exactly as it was.
    assert.equal((await caller.call('todo.add', { title: 'a todo' })).ok, true);
    const first = listed(await caller.call('todo.list', {}))[0];
    assert.equal((await caller.call('todo.toggle', { id: first?.id, done: true })).ok, true);
    assert.deepEqual(accepted<Today>(await caller.call('todo.today', {})), card);

    // And Today is not the list: no todo carries a `today` field any more.
    assert.equal(Object.hasOwn(first as Todo, 'today'), false);
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('Today survives a restart through history, and the list around it does too', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-todo-'));
  const database = join(directory, 'history', 'sqlite');
  try {
    await withTodo(database, async (caller, history) => {
      await furnish(caller);
      // The fixture is written once, the index has no `todayId` in it any more, and Today is a unit of
      // its own — so a plain title edit never rewrites either one.
      // `todayId: null` and `v` are what an older reader (one that requires todayId to be null-or-an-id)
      // needs to parse this unit; a reader that does not know `v` ignores it.
      assert.deepEqual(history.load('todos')?.meta, {
        ids: [1, 2, 3],
        nextId: 4,
        todayId: null,
        v: 2,
      });
      assert.equal(history.load('today')?.revision, 2);

      assert.equal(
        (await caller.call('todo.add', { title: 'durable', text: 'saved notes' })).ok,
        true,
      );
      assert.equal(history.load('todos')?.revision, 5);
      assert.equal((await caller.call('todo.set-today', { text: 'ship the todo node' })).ok, true);
      assert.equal(history.load('todos')?.revision, 5); // Today is elsewhere
      const stored = history.load('today')?.meta as Today;
      assert.equal(stored.text, 'ship the todo node');
      assert.equal(stored.buttons.length, 2); // buttons that were not sent stay as they were
      assert.ok((stored.updatedAt ?? '').startsWith('20'));
    });

    // A second node on the same bus and history is the proof: list and Today both come back.
    await withTodo(database, async (caller) => {
      const card = accepted<Today>(await caller.call('todo.today', {}));
      assert.equal(card.text, 'ship the todo node');
      assert.equal(card.buttons.length, 2);

      const todos = listed(await caller.call('todo.list', {}));
      assert.deepEqual(
        todos.map((todo) => [todo.id, todo.title]),
        [
          [4, 'durable'],
          [3, 'Add your own item'],
          [2, 'Check something off'],
          [1, 'Review the Today card'],
        ],
      );
      assert.equal(todos[0]?.text, 'saved notes');
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a list stored without a Today focus comes back, without one', async () => {
  // The shape a store written before free-text Today may be found in: an index with no `todayId` at
  // all. It loads, and the index is rewritten in the current shape (null pointer, version marker).
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-todo-'));
  const database = join(directory, 'history', 'sqlite');
  try {
    await withTodo(database, async (caller) => {
      assert.equal((await caller.call('todo.add', { title: 'kept through the rewrite' })).ok, true);
      const saved = await caller.call('history.save', {
        unitId: 'todos',
        meta: { ids: [1], nextId: 2 },
      });
      assert.equal(saved.ok, true, saved.ok ? '' : saved.error);
    });

    await withTodo(database, async (caller, history) => {
      const todos = listed(await caller.call('todo.list', {}));
      assert.deepEqual(
        todos.map((todo) => todo.id),
        [1],
      );
      // A todo stored before `order` existed has no place — and that is a legible list, not a zero.
      for (const one of todos) assert.equal(Object.hasOwn(one, 'order'), false);
      assert.deepEqual(history.load('todos')?.meta, {
        ids: [1],
        nextId: 2,
        todayId: null,
        v: 2,
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an index written before Today was free text still loads, and is migrated', async () => {
  // The old shape: the same index, plus `todayId` — a pointer at the item the card used to show. The
  // item stays (nothing is lost), the pointer goes, and the unit is rewritten in the current shape.
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-todo-'));
  const database = join(directory, 'history', 'sqlite');
  try {
    await withTodo(database, async (caller) => {
      assert.equal(
        (await caller.call('todo.add', { title: 'the item the card used to point at' })).ok,
        true,
      );
      const saved = await caller.call('history.save', {
        unitId: 'todos',
        meta: { ids: [1], nextId: 2, todayId: 1 },
      });
      assert.equal(saved.ok, true, saved.ok ? '' : saved.error);
    });

    await withTodo(database, async (caller, history) => {
      assert.deepEqual(
        listed(await caller.call('todo.list', {})).map((todo) => todo.id),
        [1],
      );
      assert.equal(
        listed(await caller.call('todo.list', {})).some((todo) => todo.id === 1),
        true,
      );
      assert.deepEqual(history.load('todos')?.meta, {
        ids: [1],
        nextId: 2,
        todayId: null,
        v: 2,
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('set-today refuses junk with a sentence that names it', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    assert.match(refusal(await caller.call('todo.set-today', {})), /set-today wants text/);
    assert.match(refusal(await caller.call('todo.set-today', { text: 4 })), /text wants a string/);
    assert.match(
      refusal(await caller.call('todo.set-today', { text: 'x', buttons: 'hi' })),
      /buttons wants an array/,
    );
    assert.match(
      refusal(await caller.call('todo.set-today', { text: 'x', buttons: [null] })),
      /buttons\[0\] wants an object/,
    );
    assert.match(
      refusal(await caller.call('todo.set-today', { text: 'x', buttons: [{ label: 'a' }] })),
      /buttons\[0\]\.message wants a string/,
    );
    assert.match(
      refusal(
        await caller.call('todo.set-today', {
          text: 'x',
          buttons: [{ label: '  ', message: 'm' }],
        }),
      ),
      /buttons\[0\]\.label cannot be empty/,
    );
    assert.match(
      refusal(
        await caller.call('todo.set-today', {
          text: 'x',
          buttons: [{ label: 'a', message: '   ' }],
        }),
      ),
      /buttons\[0\]\.message cannot be empty/,
    );
    assert.match(
      refusal(
        await caller.call('todo.set-today', {
          text: 'x',
          buttons: [{ label: 'a'.repeat(41), message: 'b' }],
        }),
      ),
      /label is longer than 40 characters/,
    );
    assert.match(
      refusal(
        await caller.call('todo.set-today', {
          text: 'x',
          buttons: [{ label: 'a', message: 'b'.repeat(501) }],
        }),
      ),
      /message is longer than 500 characters/,
    );
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `b${i}`, message: `m${i}` }));
    assert.match(
      refusal(await caller.call('todo.set-today', { text: 'x', buttons: many })),
      /buttons wants at most 8 entries \(got 9\)/,
    );

    // A refused write leaves Today alone — the seed card is still what a reader gets.
    assert.deepEqual(accepted<Today>(await caller.call('todo.today', {})).buttons.length, 2);
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('pressing a button sends exactly one message carrying its text', async () => {
  const fixture = await Fixture.open();
  const agent = await startFakeAgent(fixture);
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    const receipt = accepted<PressReceipt>(await caller.call('todo.press', { index: 2 }));
    assert.deepEqual(
      { ...receipt, at: undefined },
      { index: 2, label: 'Plan my day', target: 'agent', sent: true, at: undefined },
    );
    assert.ok(receipt.at.startsWith('20'));
    assert.deepEqual(agent.said, [
      'User clicked  button:\"Look at my todo list and write a plan for today into todo today.\"' +
        ' in today card of todo node',
    ]);

    // The page reads the presses back: newest first, one entry per press.
    assert.deepEqual(
      accepted<PressReceipt[]>(await caller.call('todo.presses', {})).map((one) => one.index),
      [2],
    );
  } finally {
    await caller.close();
    await todo.stop();
    await agent.stop();
    await fixture.close();
  }
});

test('a press goes to the configured target, and the last ten presses are kept', async () => {
  const fixture = await Fixture.open();
  const helper = await startFakeAgent(fixture, 'helper');
  const todo = await startTodo(fixture, 'helper');
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    for (let i = 0; i < 11; i += 1) await caller.call('todo.press', { index: 1 });

    assert.equal(helper.said.length, 11);
    assert.equal(
      helper.said[0],
      'User clicked  button:\"What is left on my todo list? Show me the open items.\"' +
        ' in today card of todo node',
    );
    const kept = accepted<PressReceipt[]>(await caller.call('todo.presses', {}));
    assert.equal(kept.length, 10);
    assert.equal(kept[0]?.target, 'helper');
  } finally {
    await caller.close();
    await todo.stop();
    await helper.stop();
    await fixture.close();
  }
});

test('a press that cannot be delivered says so instead of pretending', async () => {
  const fixture = await Fixture.open();
  // The demo's own agent is exactly this case today: it chats, but it has no chat_no_wait yet.
  const agent = await startFakeAgent(fixture, 'agent', ['chat']);
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    const receipt = accepted<PressReceipt>(await caller.call('todo.press', { index: 1 }));
    assert.equal(receipt.sent, false);
    assert.equal(receipt.target, 'agent');
    assert.equal(receipt.reason, 'no node provides the capability "agent.chat_no_wait"');
    assert.deepEqual(accepted<PressReceipt[]>(await caller.call('todo.presses', {}))[0], receipt);
  } finally {
    await caller.close();
    await todo.stop();
    await agent.stop();
    await fixture.close();
  }
});

test('press refuses an index Today does not have', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    assert.match(
      refusal(await caller.call('todo.press', { index: 3 })),
      /no button 3: today has 2 \(1…2\)/,
    );
    assert.match(
      refusal(await caller.call('todo.press', { index: '1' })),
      /index wants a positive integer/,
    );
    assert.match(
      refusal(await caller.call('todo.press', { index: 0 })),
      /index wants a positive integer/,
    );

    assert.equal(
      (await caller.call('todo.set-today', { text: 'nothing to press', buttons: [] })).ok,
      true,
    );
    assert.match(refusal(await caller.call('todo.press', { index: 1 })), /today has no buttons/);
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('the list can be asked what is left and what is done, and "today" is no longer a filter', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    assert.equal((await caller.call('todo.toggle', { id: 3, done: true })).ok, true);

    const all = listed(await caller.call('todo.list', {}));
    // What is still open first, then what is done, newest first inside each group.
    assert.deepEqual(
      all.map((todo) => todo.id),
      [2, 1, 3],
    );
    assert.deepEqual(
      listed(await caller.call('todo.list', { filter: 'open' })).map((todo) => todo.id),
      [2, 1],
    );
    assert.deepEqual(
      listed(await caller.call('todo.list', { filter: 'done' })).map((todo) => todo.id),
      [3],
    );
    assert.match(
      refusal(await caller.call('todo.list', { filter: 'today' })),
      /unknown filter: "today" \(all, open or done\)/,
    );
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('a list nobody has arranged carries no order and reads as it always did', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    const todos = listed(await caller.call('todo.list', {}));
    assert.deepEqual(
      todos.map((one) => one.id),
      [3, 2, 1],
    );
    // The field is absent, not zero and not null: nothing has been arranged, and a store written
    // before `order` existed reads exactly like this one.
    for (const one of todos) assert.equal(Object.hasOwn(one, 'order'), false);
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('move puts a todo before or after another, and a restart keeps the arrangement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-agent-todo-'));
  const database = join(directory, 'history', 'sqlite');
  try {
    await withTodo(database, async (caller, history) => {
      await furnish(caller);
      const indexRevision = history.load('todos')?.revision;
      const moved = await caller.call('todo.move', { id: 2, before: 3 });
      assert.equal(moved.ok, true, moved.ok ? '' : moved.error);
      assert.equal(accepted<string>(moved), 'moved id=2 before id=3: Check something off');

      const todos = listed(await caller.call('todo.list', {}));
      assert.deepEqual(
        todos.map((one) => one.id),
        [2, 3, 1],
      );
      assert.ok(todos.every((one) => typeof one.order === 'number'));
      assert.ok(todos[0]!.order! < todos[1]!.order!);
      // A move changes places, never the set of todos: the root index is not rewritten.
      assert.equal(history.load('todos')?.revision, indexRevision);
      for (const id of [1, 2, 3]) {
        const unit = history.load(`todos.${id}`)?.meta as Todo;
        assert.equal(typeof unit.order, 'number', `id=${id} was given a place`);
      }

      // The other direction, and a place at the very top: both are numbers, nothing is reshuffled.
      await caller.call('todo.move', { id: 1, before: 2 });
      assert.deepEqual(
        listed(await caller.call('todo.list', {})).map((one) => one.id),
        [1, 2, 3],
      );
    });

    // A second node on the same bus and history is the proof that the arrangement was stored.
    await withTodo(database, async (caller) => {
      const todos = listed(await caller.call('todo.list', {}));
      assert.deepEqual(
        todos.map((one) => one.id),
        [1, 2, 3],
      );
      assert.ok(todos.every((one) => typeof one.order === 'number'));
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a long run of moves between the same pair renumbers instead of running out of room', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    // Seeds read [3, 2, 1]. Putting id=1 behind id=3 over and over asks for the same place again and
    // again, so every call halves the same gap until there is nothing left to halve.
    for (let i = 0; i < 12; i += 1) {
      const reply = await caller.call('todo.move', { id: 1, after: 3 });
      assert.equal(reply.ok, true, reply.ok ? '' : reply.error);
    }
    const todos = listed(await caller.call('todo.list', {}));
    assert.deepEqual(
      todos.map((one) => one.id),
      [3, 1, 2],
    );
    const places = todos.map((one) => one.order);
    assert.equal(new Set(places).size, places.length, 'two todos cannot share a place');
    assert.ok(places.every((place) => Number.isFinite(place)));
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('move refuses what it cannot do, with a sentence that names it', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    assert.match(
      refusal(await caller.call('todo.move', { id: 2 })),
      /move wants one of before or after/,
    );
    assert.match(
      refusal(await caller.call('todo.move', { id: 2, before: 3, after: 1 })),
      /move wants one of before or after/,
    );
    assert.match(
      refusal(await caller.call('todo.move', { id: '2', before: 3 })),
      /id wants an integer/,
    );
    assert.match(
      refusal(await caller.call('todo.move', { id: 2, before: '3' })),
      /before wants an integer \(the id of the todo to sit next to\)/,
    );
    assert.match(
      refusal(await caller.call('todo.move', { id: 2, after: 1.5 })),
      /after wants an integer/,
    );
    assert.match(
      refusal(await caller.call('todo.move', { id: 2, before: 2 })),
      /a todo cannot move before itself \(id=2\)/,
    );
    assert.match(
      refusal(await caller.call('todo.move', { id: 2, before: 99 })),
      /no todo with id=99/,
    );

    // Open ones before done ones is the list's rule, so a done todo does not move up among them.
    assert.equal((await caller.call('todo.toggle', { id: 1, done: true })).ok, true);
    assert.match(
      refusal(await caller.call('todo.move', { id: 1, before: 3 })),
      /id=1 is done and id=3 is open: a todo moves inside its own group/,
    );
    // A refused move is no write at all — not even the one-time placing of the list.
    const todos = listed(await caller.call('todo.list', {}));
    assert.deepEqual(
      todos.map((one) => one.id),
      [3, 2, 1],
    );
    assert.ok(todos.every((one) => Object.hasOwn(one, 'order') === false));
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('a new todo joins the end of the open ones once the list is arranged', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    // Nothing arranged: the default rule keeps the newest on top, and the new todo has no place.
    assert.equal(
      accepted<string>(await caller.call('todo.add', { title: 'first' })),
      'added id=4: first',
    );
    const fresh = listed(await caller.call('todo.list', {}));
    assert.deepEqual(
      fresh.map((one) => one.id),
      [4, 3, 2, 1],
    );
    assert.equal(Object.hasOwn(fresh[0]!, 'order'), false);

    // Arranged: it must not shove the arrangement down, so it goes last of the open ones.
    assert.equal((await caller.call('todo.move', { id: 4, after: 1 })).ok, true);
    assert.equal(
      accepted<string>(await caller.call('todo.add', { title: 'second' })),
      'added id=5: second',
    );
    const todos = listed(await caller.call('todo.list', {}));
    assert.deepEqual(
      todos.map((one) => one.id),
      [3, 2, 1, 4, 5],
    );
    assert.equal(typeof todos[4]?.order, 'number');
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('a write publishes list, Today and the presses as one snapshot', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const watcher = await Caller.join(fixture, 'watcher');
  const seen: { todos: Todo[]; today: Today }[] = [];
  watcher.onEvent((_topic, value) => seen.push(value as { todos: Todo[]; today: Today }));
  try {
    const card = accepted<Today>(await watcher.call('todo.today', {}));
    await watcher.subscribe('todo');
    assert.equal((await watcher.call('todo.add', { title: 'watched' })).ok, true);

    await until(() => seen.length > 0);
    assert.ok(seen[0]?.todos.some((one) => one.title === 'watched'));
    assert.deepEqual(seen[0]?.today, card);
  } finally {
    await watcher.close();
    await todo.stop();
    await fixture.close();
  }
});

test('todo remains usable without history', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    assert.equal((await caller.call('todo.add', { title: 'local' })).ok, true);
    assert.equal((await caller.call('todo.set-today', { text: 'still here' })).ok, true);
    assert.ok(listed(await caller.call('todo.list', {})).some((one) => one.title === 'local'));
    assert.equal(accepted<Today>(await caller.call('todo.today', {})).text, 'still here');
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('malformed arguments are refused with a readable error', async () => {
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    await furnish(caller);
    // A missing argument is the wire's business, an empty one the app's — both are named.
    assert.match(refusal(await caller.call('todo.add', {})), /title wants a string/);
    assert.match(
      refusal(await caller.call('todo.add', { title: '   ' })),
      /todo\.add wants a title/,
    );
    assert.match(refusal(await caller.call('todo.toggle', { id: '3' })), /id wants an integer/);
    assert.match(
      refusal(await caller.call('todo.toggle', { id: 1, done: 'yes' })),
      /done wants true/,
    );
    assert.match(
      refusal(await caller.call('todo.update', { id: 99, title: 'x' })),
      /no todo with id=99/,
    );
    assert.match(refusal(await caller.call('todo.remove', {})), /id wants an integer/);
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('the page is handed out with the node name filled in', async () => {
  // The webui serves this string as the tab's page, so the placeholder has to be gone: a page that
  // still carries `__NODE__` would fall back to the URL path and call the wrong address.
  const fixture = await Fixture.open();
  const todo = await startTodo(fixture);
  const caller = await Caller.join(fixture);
  try {
    const page = accepted<string>(await caller.call('todo.ui', {}));
    assert.match(page, /const INJECTED = "todo";/);
    assert.equal(page.includes('__NODE__'), false);
    assert.match(
      page,
      /window\.NodeAgentEvents\.connect\('\/events\?topic=' \+ encodeURIComponent\(NODE\)\)/,
    );
  } finally {
    await caller.close();
    await todo.stop();
    await fixture.close();
  }
});

test('the Today card is read-only for the human: the page never writes it', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /id="todayText"/, 'the card still shows what the model wrote');
  assert.doesNotMatch(html, /<textarea[^>]*id="todayText"/, 'no box to type in');
  assert.doesNotMatch(html, /todaySave|todayForm|card-save/, 'nothing to save with');
  assert.doesNotMatch(html, /set-today/, 'the page never calls the writer: only the model does');
});

// The card carries the one time the page knows without asking the model anything: when Today was last
// written. A card nobody has written must show no line at all — a made-up time is worse than none.
test('the Today card says when it was last written, and nothing before that', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  assert.match(
    html,
    /<p class="card-updated" id="todayUpdated" hidden><\/p>/,
    'the line starts hidden',
  );
  assert.match(html, /\$\('todayUpdated'\)\.hidden = written === null/, 'null means no line');
  assert.match(html, /Updated \$\{at\}/, 'the time is formatted for the reader');
  assert.match(
    html,
    /t\('today\.updated', `Updated \$\{at\}`/,
    "and the sentence around it is the page's words, one key for both languages",
  );
  assert.match(html, /\.card-updated\[hidden\]\s*\{[^}]*display:\s*none/s);
});

// Manual order is a pair of arrows on every row. They are the page's only reorder control, so they are
// the two things a finger needs to hit: 44px in a hand, and no arrow where there is nothing to swap
// with (the first open todo has nothing above it; a done one never passes an open one).
test('every row offers up and down, and a thumb gets 44px of them', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  assert.match(
    html,
    /mover\(todo, before !== null/,
    'the row places the up arrow from its neighbour',
  );
  assert.match(html, /mover\(todo, after !== null/, 'and the down arrow from the other one');
  assert.match(html, /up \? 'Move up' : 'Move down'/, 'each arrow says what it does');
  // The page asks the node to move the todo; it never fakes an order out of a timestamp.
  assert.match(html, /write\('move'/, 'the arrows call the move capability');
  assert.doesNotMatch(
    html,
    /order\s*=\s*Date\.now|updatedAt\s*=\s*Date\.now/,
    'no clock as a sort key',
  );
  assert.match(
    html,
    /\.row-actions \.move\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s,
    'a 44px target',
  );
  assert.match(
    html,
    /\.icon\.move:disabled\s*\{[^}]*opacity/s,
    'a disabled arrow is dimmed, not gone',
  );
});

// The page is handed out twice — raw as /panel/todo and inside the webui shell's iframe — and it has
// to scroll in both. It scrolls as ONE page: the Today card and the list are a column, and the column
// scrolls inside the workspace. A second scroller nested in there is what broke it before: the list
// used to be `flex: 1 1 auto; min-height: 0` inside a panel that was itself a flex item of a
// frame-height column, so a long card squeezed it to a seam (10px in the shell's frame, with 2810px of
// rows in it) and a wheel over anything but that seam moved nothing. The checks below are the same
// shape as the ones in packages/node-agent-webui/tests/mobile.test.mjs.
test('the page scrolls as one column, with the card and the list together', () => {
  const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');

  // The framed shape: 100% follows the frame's box rather than the window, and `min-height: 0` keeps
  // the page from growing past it. `.app` needs it too, because the phone block below sets
  // `height: auto` on it and a frame in the shell's left column is always inside that block.
  assert.match(html, /:root\.framed [^{]+\{[^}]*height:\s*100%[^}]*min-height:\s*0/s);
  assert.match(html, /:root\.framed[^{]*\.app[^{]*\{[^}]*height:\s*100%/s);

  // The one scroller: the workspace under the top bar, holding the whole column.
  assert.match(html, /\.workspace\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  // The column is centred by its own margins. A flex parent would stretch it to the frame's height,
  // and a column exactly as tall as its frame has nothing to scroll whatever it holds.
  assert.match(html, /\.column\s*\{[^}]*margin:\s*0 auto/s);
  assert.doesNotMatch(
    html,
    /\.workspace\s*\{[^}]*display:\s*flex/s,
    'a stretched column cannot scroll',
  );

  // Nothing inside the page is a scroll box or a clip of its own: the panel is the list's frame and
  // the list is every row at its natural height. This is the pair that was squeezing the rows.
  assert.doesNotMatch(
    html,
    /\.panel\s*\{[^}]*overflow:\s*hidden/s,
    'a clip hides the rows it cannot fit',
  );
  assert.doesNotMatch(
    html,
    /\.panel\s*\{[^}]*min-height:\s*0/s,
    'the panel takes its height from the rows',
  );
  assert.doesNotMatch(
    html,
    /\.list\s*\{[^}]*overflow-y:\s*(?:auto|scroll)/s,
    'the page scrolls, not the list',
  );
  assert.doesNotMatch(html, /\.list\s*\{[^}]*flex:\s*1/s, 'a shrinking list is what became a seam');

  // The framed rules sit after the phone block on purpose, so at 760px and under — inside a frame —
  // the phone block's `height: auto` cannot win again.
  assert.ok(
    html.indexOf(':root.framed') > html.indexOf('@media (max-width: 760px)'),
    'the framed rules have to override the phone block',
  );
});

// `index.ts` reads `./ui.html` next to its own file, so a running node serves dist/ui.html while this
// suite reads src/: a build that has not been re-run hands the browser the old page.
test('the served copy is the page in src', (t) => {
  const built = new URL('../dist/ui.html', import.meta.url);
  if (!existsSync(built)) return t.skip('dist/ is only there after `npm run build`');
  assert.equal(
    readFileSync(built, 'utf8'),
    readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8'),
    'run `npm run build`: the page in dist/ is copied from src/, not compiled',
  );
});
