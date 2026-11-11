import { serveEventAssets } from './browser.mjs';
// The todo page is where the model's writes and a human's thumb meet, so it is run the way it is used:
// the real node behind a /call, the real page in a browser, at a phone's width. Two things there break
// silently and are impossible to notice until the page is in a hand — the "Updated …" line on the Today
// card (the time the card was written, and nothing at all before it ever was) and the up/down arrows
// (44px under a thumb, and no arrow where there is nothing to swap with). The node's own ordering rules
// are pinned in node-agent-todo/test/index.test.ts; this file is only about what a browser is
// handed and what a finger can reach.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { Bus, Node } from 'node-agent-bus';
import { TodoNode } from '../../todo/src/index.ts';
import { chromePath, openPage, startChrome } from './browser.mjs';

const TOKEN = 'todo-page-token';

//: The smallest target a thumb hits reliably.
const TOUCH_TARGET = 44;

/** A deployment in miniature: the page at /, the two addresses it talks to, and the bus behind them.
 *  `/call` goes through the node's own `handle`, so the page is driven by the code that will run it, and
 *  a write made anywhere on the bus reaches the page over `/events` the way it does in the shell. */
async function serve() {
  const bus = await new Bus(TOKEN).listen();
  const todo = await new TodoNode().join(bus.url, TOKEN);
  const watcher = await new Node('watcher', [], 'forwards the todo topic to the page').join(
    bus.url,
    TOKEN,
  );
  // A new stack starts empty; this page test still needs three rows to exercise ordering and arrows.
  for (const [title, text] of [
    ['first', 'the page is handed a real list'],
    ['second', 'the node owns the order'],
    ['third', 'the arrows are thumb-sized'],
  ]) await todo.handle('add', { title, text });

  const feeds = new Set();
  await watcher.subscribe('todo');
  watcher.onEvent = (_topic, value) => {
    for (const reply of feeds) reply.write(`data: ${JSON.stringify(value)}\n\n`);
  };

  const server = createServer((req, res) => {
    if (serveEventAssets(req, res)) return;
    const url = req.url ?? '/';
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
      req.on('end', async () => {
        const { tool, args } = JSON.parse(body === '' ? '{}' : body);
        const cap = String(tool).split('.')[1];
        let answer;
        try {
          answer = { ok: true, value: await todo.handle(cap, args ?? {}) };
        } catch (error) {
          // The bus answers a refusal the same way: a call that did not happen is `ok: false`.
          answer = { ok: false, error: error.message };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(todo.handle('ui', {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    todo,
    close: () => {
      server.closeAllConnections();
      server.close();
      watcher.close();
      todo.close();
      bus.close();
    },
  };
}

/** What a page says from the inside: the expression is evaluated in the page and its value comes back
 *  as data, never as a live object — one socket, one answer. */
async function look(page, expression) {
  const reply = await page.send('Runtime.evaluate', {
    expression: `JSON.stringify(${expression})`,
    returnByValue: true,
  });
  return JSON.parse(reply.result.result.value);
}

/** Poll instead of sleeping a fixed time: fast when the page is already there, honest when it is not. */
async function until(page, expression, what) {
  for (let i = 0; i < 100; i += 1) {
    const reply = await page.send('Runtime.evaluate', {
      expression: `!!(${expression})`,
      returnByValue: true,
    });
    if (reply.result?.result?.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the page never showed: ${what}`);
}

test(
  'test_the_todo_page_shows_when_today_was_written_and_arrows_a_thumb_can_hit',
  { timeout: 90000 },
  async (t) => {
    const chrome = chromePath();
    if (!chrome) {
      t.skip('no chrome to measure with: set CHROME to a chromium binary');
      return;
    }

    const served = await serve();
    const browser = await startChrome(chrome);
    let page;
    try {
      page = await openPage(browser.page.webSocketDebuggerUrl);
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await page.send('Page.navigate', { url: `http://127.0.0.1:${served.port}/` });
      await until(page, "document.querySelectorAll('#list .row').length === 3", 'the seeded list');

      // A Today nobody has written has no time: the line is there, and hidden.
      assert.deepEqual(
        await look(
          page,
          "(() => { const p = document.getElementById('todayUpdated'); return { hidden: p.hidden, text: p.textContent }; })()",
        ),
        { hidden: true, text: '' },
        'a card that has never been written shows no time',
      );

      // The model writes the card — not the page, which never calls the writer — and the page hears
      // about it over the topic it listens on.
      await served.todo.handle('set_today', { text: 'ship the todo node' });
      await until(
        page,
        "!document.getElementById('todayUpdated').hidden",
        'the time Today was written',
      );
      const written = await look(page, "document.getElementById('todayUpdated').textContent");
      assert.match(written, /^Updated \S/, `the line says what it is: ${written}`);
      assert.equal(
        await look(page, "document.getElementById('todayText').textContent"),
        'ship the todo node',
        'and it arrived with the card it belongs to',
      );

      // The arrows: one pair per row, 44px each, and none where there is nothing to swap with.
      const rows = await look(
        page,
        "[...document.querySelectorAll('#list .row')].map((row) => ({" +
          ' id: Number(row.dataset.id),' +
          " arrows: [...row.querySelectorAll('.move')].map((button) => {" +
          ' const box = button.getBoundingClientRect();' +
          ' return { dir: button.dataset.dir, width: Math.round(box.width), height: Math.round(box.height), disabled: button.disabled };' +
          ' }),' +
          ' }))',
      );
      assert.deepEqual(
        rows.map((row) => row.id),
        [3, 2, 1],
        "the list is the node's list: open rows, newest id first until somebody arranges it",
      );
      for (const row of rows) {
        assert.deepEqual(
          row.arrows.map((arrow) => arrow.dir),
          ['up', 'down'],
          'every row offers both directions',
        );
        for (const arrow of row.arrows) {
          assert.ok(
            arrow.width >= TOUCH_TARGET && arrow.height >= TOUCH_TARGET,
            `an arrow is smaller than a thumb target: ${arrow.width}x${arrow.height}`,
          );
        }
      }
      assert.equal(rows[0].arrows[0].disabled, true, 'the first row has nothing above it');
      assert.equal(rows[0].arrows[1].disabled, false, 'but it can still go down');
      assert.equal(rows[2].arrows[1].disabled, true, 'the last row has nothing below it');

      // One press of the second row's up arrow: the page moves it and the node stores where it went.
      await page.send('Runtime.evaluate', {
        expression: 'document.querySelector(\'.row[data-id="2"] .move[data-dir="up"]\').click()',
      });
      await until(
        page,
        "[...document.querySelectorAll('#list .row')].map((row) => row.dataset.id).join() === '2,3,1'",
        'the second row to move up',
      );
      const stored = await served.todo.handle('list', {});
      assert.deepEqual(
        stored.map((one) => [one.id, typeof one.order]),
        [
          [2, 'number'],
          [3, 'number'],
          [1, 'number'],
        ],
        'the node arranged the list, and hands the places back',
      );

      // Reaching the top dims the arrow instead of removing it, so the row does not jump under the
      // finger; the page read that back from the node.
      const after = await look(
        page,
        '(() => { const row = document.querySelector(\'.row[data-id="2"]\'); return { up: row.querySelector(\'.move[data-dir="up"]\').disabled, down: row.querySelector(\'.move[data-dir="down"]\').disabled }; })()',
      );
      assert.deepEqual(after, { up: true, down: false });
    } finally {
      page?.close();
      browser.chrome.kill('SIGKILL');
      served.close();
    }
  },
);
