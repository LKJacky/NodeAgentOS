// A drop is one move, and it is drawn once: where the hand let the row go. The bug this file is about
// was the opposite - letting go drew nothing, the transforms came off in the same turn, so the row was
// painted back where it was taken from, and only the node's answer put it where the hand had left it.
// Every drop then read as two moves. So the page is run the way it is used: the BUILT page
// (dist/ui.html, the one a node serves), in a browser, with a `move` stub that answers LATE - what a
// test reads in the same task as the `pointerup` is the frame the reader is looking at while the node
// is still silent, which is exactly where the old page showed the old order. Run `npm run build`
// first: a stale dist hands these the old page.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { chromePath, openPage, startChrome } from '../../webui/tests/browser.mjs';

const BUILT = new URL('../dist/ui.html', import.meta.url);

//: How long the stub holds a `move` before answering: long enough that the synchronous half of a drop
//: is read while the answer is still on its way, short enough not to slow a run down.
const LATE = 150;

/** The three rows the stub hands out, in the node's own order (newest id first). A drop that moves
 *  anything has to move these. */
const TODOS = [
  { id: 3, title: 'review', text: '', done: false, at: '2026-01-02T09:00:00.000Z', doneAt: null },
  { id: 2, title: 'ship', text: '', done: false, at: '2026-01-04T09:00:00.000Z', doneAt: null },
  { id: 1, title: 'plan', text: '', done: false, at: '2026-01-01T09:00:00.000Z', doneAt: null },
];

/** A deployment in miniature that keeps the list: `move` is applied the way the node applies it (take
 *  the row out, put it next to the neighbour named) and is written down - the count is the question.
 *  The answer is held back by `LATE`, and `refuse` makes the next move fail the way a node that cannot
 *  write fails. */
async function serve() {
  const page = readFileSync(BUILT, 'utf8').replace('__NODE__', 'todo');
  let todos = TODOS.map((one) => ({ ...one }));
  const moves = [];
  let refuse = false;
  const feeds = new Set();

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/webui/events-client.js' || url === '/webui/events-broker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(readFileSync(new URL('../../webui/src/' + url.slice('/webui/'.length), import.meta.url), 'utf8'));
      return;
    }
    if (url === '/events/subscriptions') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (url.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': open\n\n');
      feeds.add(res);
      req.on('close', () => feeds.delete(res));
      return;
    }
    if (url === '/call') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const { tool, args } = JSON.parse(body === '' ? '{}' : body);
        let answer;
        let late = 0;
        if (tool === 'todo.list') answer = { ok: true, value: todos.map((one) => ({ ...one })) };
        else if (tool === 'todo.today')
          answer = { ok: true, value: { text: '', buttons: [], updatedAt: null } };
        else if (tool === 'todo.presses') answer = { ok: true, value: [] };
        else if (tool === 'todo.move') {
          moves.push(args);
          late = LATE;
          if (refuse) answer = { ok: false, error: 'the store is not writable' };
          else {
            const one = todos.find((todo) => todo.id === args.id);
            const rest = todos.filter((todo) => todo !== one);
            const at = rest.findIndex((todo) => todo.id === (args.before ?? args.after));
            rest.splice(args.before !== undefined ? at : at + 1, 0, one);
            todos = rest;
            answer = { ok: true, value: `moved id=${one.id}` };
          }
        } else answer = { ok: false, error: `the stub has no ${tool}` };
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(answer));
        }, late);
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    moves,
    refuse: (on) => {
      refuse = on;
    },
    close: () => {
      for (const feed of feeds) feed.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}

/** What a page says from the inside: the expression is evaluated in the page and its value comes back
 *  as data, never as a live object. */
async function look(page, expression) {
  const reply = await page.send('Runtime.evaluate', {
    expression: `JSON.stringify(${expression}) ?? 'null'`,
    returnByValue: true,
  });
  return JSON.parse(reply.result.result.value);
}

/** Poll instead of sleeping: fast when the page is already there, honest when it is not. */
async function until(page, expression, what) {
  for (let i = 0; i < 120; i += 1) {
    const reply = await page.send('Runtime.evaluate', {
      expression: `!!(${expression})`,
      returnByValue: true,
    });
    if (reply.result?.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the page never showed: ${what}`);
}

/** One page, one browser, one stub: what every test below needs and none of them wants to spell out. */
async function withPage(t, run) {
  if (!existsSync(BUILT)) {
    t.skip('dist/ is only there after `npm run build`');
    return;
  }
  const chrome = chromePath();
  if (!chrome) {
    t.skip('no chrome to drag with: set CHROME to a chromium binary');
    return;
  }
  const served = await serve();
  const browser = await startChrome(chrome);
  let page;
  try {
    page = await openPage(browser.page.webSocketDebuggerUrl);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Page.navigate', { url: `http://127.0.0.1:${served.port}/` });
    await until(page, "document.querySelectorAll('#list .row').length === 3", 'the stubbed list');
    await run(page, served);
  } finally {
    page?.close();
    browser.chrome.kill('SIGKILL');
    served.close();
  }
}

/** A whole drag, taken and let go INSIDE the page and read back in the SAME task: the three pointer
 *  events are dispatched one after another, so `dropDrag` runs its synchronous half - the new order is
 *  written to the list, the transforms come off - before its first await. What comes back is therefore
 *  the frame the reader sees the instant the finger lifts, with the node still silent. It also starts
 *  recording every redraw of the list (`window.__frames`), which is how a frame of the OLD order after
 *  the drop would be caught. `from` is dragged one place down, past the middle of `to`. */
async function drop(page, from, to) {
  return look(
    page,
    '(() => {' +
      " const list = document.getElementById('list');" +
      " const ids = () => [...list.querySelectorAll('.row')].map((one) => Number(one.dataset.id));" +
      ' const frames = (window.__frames = []);' +
      " new MutationObserver(() => frames.push(ids().join())).observe(list, { childList: true });" +
      ` const grip = list.querySelector('.row[data-id="${from}"] .grip');` +
      ` const there = list.querySelector('.row[data-id="${to}"]');` +
      ' const held = grip.getBoundingClientRect();' +
      ' const other = there.getBoundingClientRect();' +
      ' const x = Math.round(held.left + held.width / 2);' +
      ' const y = Math.round(held.top + held.height / 2);' +
      ' const down = Math.round(other.top + other.height / 2 + 2);' +
      ' const base = { pointerId: 7, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true };' +
      " grip.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));" +
      " grip.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: down }));" +
      " grip.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x, clientY: down }));" +
      ` const row = list.querySelector('.row[data-id="${from}"]');` +
      ' return {' +
      ' order: ids().join(),' +
      ' lifted: row === null ? null : row.classList.contains("dragging"),' +
      ' shadow: row === null ? null : getComputedStyle(row).boxShadow,' +
      ' inline: [...list.querySelectorAll(".row")].map((one) => one.style.transform),' +
      ' dropping: list.classList.contains("dropping"),' +
      ' transition: row === null ? null : getComputedStyle(row).transitionDuration,' +
      ' holding: document.body.classList.contains("dragging"),' +
      ' answered: document.getElementById("toast").classList.contains("on") || document.getElementById("todayResult").textContent !== "",' +
      ' };' +
      ' })()',
  );
}

/** What every redraw of the list drew, in the order it drew them: the record a frame of the old order
 *  after the drop would show up in. The observer hands its records over as a task ends, so this is read
 *  after the drop has been answered, not in the instant it was made. */
async function frames(page) {
  return look(page, 'window.__frames ?? []');
}

/** Let the page finish what the stub held back: the toast says a move landed, the note says one did
 *  not. Either way the drop is over and every render it caused has been recorded. */
async function answered(page) {
  await until(
    page,
    "document.getElementById('toast').classList.contains('on') || document.getElementById('todayResult').textContent !== ''",
    'the node to answer the drop',
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
}

// Requirement: letting go must leave the row where the hand left it, at once. This is the test that
// fails on a page which waits for the node before drawing the drop: it reads the list in the same task
// as the pointerup, before the `move` has been answered.
test('a drop is drawn in the new order before the node answers', async (t) => {
  await withPage(t, async (page, served) => {
    const seen = await drop(page, 3, 2);
    assert.equal(seen.order, '2,3,1', 'the row is already where the hand let it go');
    assert.equal(seen.answered, false, 'and the node has not answered yet: the list is the page\'s own');
    assert.equal(served.moves.length <= 1, true, 'at most the one move is on its way');
  });
});

// Requirement: no frame of the old order after the drop. The row used to be drawn home, then moved by
// the answer - a sequence of 3,2,1 then 2,3,1, which is the "it goes back first" every reader saw.
test('no redraw after a drop ever shows the old order again', async (t) => {
  await withPage(t, async (page, served) => {
    const seen = await drop(page, 3, 2);
    assert.equal(seen.order, '2,3,1', 'the drop frame is the new order');
    await answered(page);
    assert.equal(await look(page, "document.querySelectorAll('#list .row').length"), 3);
    const drawn = await frames(page);
    assert.deepEqual(drawn, ['2,3,1'], 'the list was drawn once, in the new order, and never back');
    assert.equal(await look(page, "[...document.querySelectorAll('#list .row')].map((one) => Number(one.dataset.id)).join()"), '2,3,1', 'and it is still there when the answer arrives');
    assert.deepEqual(served.moves, [{ id: 3, before: 1 }], 'one move, naming the row it went in front of');
  });
});

// Requirement: a drop asks the node once. Not once per frame, not once at the lift and once at the
// drop, and not a second time because the local order changed before the answer came back.
test('a drop is exactly one move, even when the answer is slow', async (t) => {
  await withPage(t, async (page, served) => {
    await drop(page, 3, 2);
    await answered(page);
    assert.deepEqual(served.moves, [{ id: 3, before: 1 }], 'one move per drop');
    assert.equal(await look(page, "document.getElementById('toast').textContent"), 'Moved');
  });
});

// Requirement: a drop the node refuses goes back to where the row came from, in ONE redraw, and says
// so. It must not travel there twice - once as a jump and once as a rollback.
test('a refused drop comes back in one redraw and says why', async (t) => {
  await withPage(t, async (page, served) => {
    served.refuse(true);
    const seen = await drop(page, 3, 2);
    assert.equal(seen.order, '2,3,1', 'the drop is drawn where the hand let it go, refused or not');
    await answered(page);
    const drawn = await frames(page);
    assert.deepEqual(drawn, ['2,3,1', '3,2,1'], 'one redraw back, and no frame in between');
    assert.equal(
      await look(page, "[...document.querySelectorAll('#list .row')].map((one) => Number(one.dataset.id)).join()"),
      '3,2,1',
      'the list is the order the row was taken from',
    );
    assert.equal(
      await look(page, "document.getElementById('todayResult').textContent"),
      'could not move: the store is not writable',
      'and the refusal is said out loud',
    );
    assert.equal(served.moves.length, 1, 'the refusal is not retried on its own');
  });
});

// Requirement: the marks of a drag come off in the frame the drop is drawn - the lifted row, its
// shadow, the transforms that made way - and the transition that let the rows make way does not drag
// the drop out over .14s after the redraw. It is back on the next frame, for the next drag.
test('the drop frame is flat, and transitions are off for it and on again after', async (t) => {
  await withPage(t, async (page, served) => {
    const seen = await drop(page, 3, 2);
    assert.equal(seen.lifted, false, 'the row is on the floor again');
    assert.equal(seen.holding, false, 'and the page is not holding anything');
    assert.equal(seen.shadow, 'none', 'the lift shadow is gone');
    assert.deepEqual(seen.inline, ['', '', ''], 'no row is left translated');
    assert.equal(seen.dropping, true, 'the drop frame has the transitions shut');
    assert.equal(seen.transition, '0s', 'so a row drawn in the new order does not slide there');
    await answered(page);
    await until(
      page,
      "!document.getElementById('list').classList.contains('dropping')",
      'the transitions to come back',
    );
    const after = await look(
      page,
      "getComputedStyle(document.querySelector('#list .row')).transitionProperty",
    );
    assert.match(after, /transform/, 'the way-making transition is back for the next drag');
  });
});
