import { serveEventAssets } from './browser.mjs';
// The timer page is where a thumb sets what a model would otherwise have to say out loud, so it is
// run the way it is used: the real TimerNode behind a /call, the real page in a browser, at a phone's
// width. Two decisions in this page are invisible until it is in a hand, and both are checked here —
// the list is the page and each of the two forms is a page of its own (Back, Cancel, Save and the
// browser's own Back all land where they say), and the list keeps the height of the screen while
// everything a thumb presses is at least 44px. The node's own scheduling rules are pinned in
// node-agent-timer/test/index.test.ts; this file is only about what a browser is handed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { Bus } from 'node-agent-bus';
import { TimerNode } from '../../timer/src/index.ts';
import { chromePath, openPage, startChrome } from './browser.mjs';

const TOKEN = 'timer-page-token';

//: The smallest target a thumb hits reliably.
const TOUCH_TARGET = 44;

/** The one shape a saved timer has, and has to keep having: the page may not invent or drop a field. */
const WAKE_SHAPE = [
  'id',
  'in_seconds',
  'kind',
  'message',
  'mode',
  'name',
  'next_at',
  'phrase',
  'priority',
  'repeat',
  'target',
];

/** A deployment in miniature: the page at /, the two addresses it talks to, and the bus behind them.
 *  `/call` goes through the node's own `handle`, so the page is driven by the code that will run it.
 *  `/events` is written straight into, which is how a test says "a timer changed elsewhere" without
 *  going round the bus for it. */
async function serve({ seed = [] } = {}) {
  const bus = await new Bus(TOKEN).listen();
  const timer = await new TimerNode().join(bus.url, TOKEN);
  // Timers that were already there when the page opens, set the way a model would set them.
  for (const args of seed) await timer.handle('set', args, 'agent');

  const feeds = new Set();
  let listFails = false;

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
      req.on('end', () => {
        const { tool, args } = JSON.parse(body === '' ? '{}' : body);
        const cap = String(tool).split('.')[1];
        let answer;
        try {
          if (cap === 'list' && listFails) throw new Error('the bus is away');
          answer = { ok: true, value: timer.handle(cap, args ?? {}, 'agent') };
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
    res.end(timer.handle('ui', {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    timer,
    /** One frame on every open feed, in the shape the bus publishes. */
    emit(value) {
      for (const reply of feeds) reply.write(`data: ${JSON.stringify({ value })}\n\n`);
    },
    failList(yes) {
      listFails = yes;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
      timer.close();
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

/** One press, the way a thumb does it: a real click on the element the page drew. */
async function press(page, selector) {
  await page.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)}).click()`,
  });
}

/** A clock time a few hours ahead, as an `<input type="time">` reads it. An `at` that has already
 *  gone by today means tomorrow to the node, so any HH:MM would do; this one is easy to reason about. */
function laterClock(hoursAhead) {
  const at = new Date(Date.now() + hoursAhead * 3600 * 1000);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** Open a page at a phone's width, the one the page is designed for first. */
async function phone(port) {
  const browser = await startChrome(chromePath());
  const page = await openPage(browser.page.webSocketDebuggerUrl);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  return { browser, page };
}

test(
  'test_the_timer_list_is_the_page_and_each_form_is_a_page_of_its_own',
  { timeout: 90000 },
  async (t) => {
    const chrome = chromePath();
    if (!chrome) {
      t.skip('no chrome to measure with: set CHROME to a chromium binary');
      return;
    }

    const served = await serve();
    const opened = await phone(served.port);
    const page = opened.page;
    try {
      // The list is the page: no form is on it, the two ways in are buttons, and an empty queue says
      // so where the rows would be rather than showing a form nobody asked for.
      await until(
        page,
        "document.querySelector('#summary').textContent === 'no timer is waiting'",
        'the empty list',
      );
      assert.deepEqual(
        await look(
          page,
          '(() => ({' +
            " list: !document.getElementById('view-list').hidden," +
            " alarm: !document.getElementById('view-alarm').hidden," +
            " countdown: !document.getElementById('view-countdown').hidden," +
            " back: !document.getElementById('back').hidden," +
            " empty: document.querySelector('#list .empty strong')?.textContent ?? ''," +
            " title: document.getElementById('title').textContent," +
            ' hash: location.hash }))()',
        ),
        {
          list: true,
          alarm: false,
          countdown: false,
          back: false,
          empty: 'Nothing scheduled',
          title: 'Timers',
          hash: '#/list',
        },
        'the main page is the timer list, with no form on it',
      );

      // A button opens the alarm form, on a page of its own: the list steps out of the way and Back
      // appears. The fields are the alarm's (a time of day), which is the point of two pages.
      await press(page, '#newAlarm');
      await until(
        page,
        "location.hash === '#/alarm' && !document.getElementById('view-alarm').hidden",
        'the alarm page',
      );
      assert.deepEqual(
        await look(
          page,
          '(() => ({' +
            " list: !document.getElementById('view-list').hidden," +
            " alarm: !document.getElementById('view-alarm').hidden," +
            " countdown: !document.getElementById('view-countdown').hidden," +
            " back: !document.getElementById('back').hidden," +
            " title: document.getElementById('title').textContent," +
            " at: !!document.getElementById('alarmAt')," +
            " hms: !!document.getElementById('countdownHours') }))()",
        ),
        {
          list: false,
          alarm: true,
          countdown: false,
          back: true,
          title: 'New alarm',
          at: true,
          hms: true,
        },
        'the alarm form is a page of its own, reached by a button',
      );

      // Save with nothing in it: the page stays where it is, says what is missing, and puts the
      // cursor in the field that needs it. Nothing was created.
      await press(page, '#alarmSave');
      await until(page, "!document.getElementById('alarmError').hidden", 'the empty-message error');
      assert.deepEqual(
        await look(
          page,
          '(() => ({' +
            " error: document.getElementById('alarmError').textContent," +
            " focus: document.activeElement.id," +
            " alarm: !document.getElementById('view-alarm').hidden }))()",
        ),
        {
          error: 'Say what the alarm should say first.',
          focus: 'alarmMessage',
          alarm: true,
        },
        'an error is said on the form, with the focus in the field that caused it',
      );
      assert.deepEqual(served.timer.handle('list', {}), [], 'a refused form saved nothing');

      // Save a real alarm: it goes back to the list, and the timer that is stored is the timer the
      // form said, in the one shape a saved timer has always had.
      await page.send('Runtime.evaluate', {
        expression:
          "document.getElementById('alarmMessage').value = 'water the plants';" +
          `document.getElementById('alarmAt').value = '${laterClock(3)}';` +
          "document.getElementById('alarmRepeat').value = 'daily';" +
          "document.getElementById('alarmSave').click()",
      });
      await until(page, "document.querySelectorAll('#list .wake').length === 1", 'the saved alarm');
      assert.equal(
        await look(
          page,
          "location.hash === '#/list' && !document.getElementById('view-list').hidden",
        ),
        true,
        'saving returns to the list',
      );
      assert.equal(
        await look(page, "document.getElementById('alarmMessage').value"),
        '',
        'a saved form is empty the next time it is opened',
      );
      const [alarm] = served.timer.handle('list', {});
      assert.deepEqual(Object.keys(alarm).sort(), WAKE_SHAPE, 'the saved timer keeps its shape');
      assert.equal(alarm.mode, 'alarm');
      assert.equal(alarm.kind, 'alarm');
      assert.equal(alarm.message, 'water the plants');
      assert.equal(alarm.repeat, 'daily');
      assert.equal(alarm.target, 'agent');

      // The other button opens the countdown page, whose fields are hours/minutes/seconds — and the
      // alarm page is not on screen under it.
      await press(page, '#newCountdown');
      await until(
        page,
        "location.hash === '#/countdown' && !document.getElementById('view-countdown').hidden",
        'the countdown page',
      );
      assert.deepEqual(
        await look(
          page,
          '(() => ({' +
            " alarm: !document.getElementById('view-alarm').hidden," +
            " countdown: !document.getElementById('view-countdown').hidden," +
            " title: document.getElementById('title').textContent," +
            " hms: !!document.getElementById('countdownHours') && !!document.getElementById('countdownSeconds')," +
            " atHidden: document.getElementById('view-alarm').hidden }))()",
        ),
        { alarm: false, countdown: true, title: 'New countdown', hms: true, atHidden: true },
        'the countdown is set on its own page, not in a mixed form',
      );

      // Save a two-minute countdown from its own fields.
      await page.send('Runtime.evaluate', {
        expression:
          "document.getElementById('countdownMessage').value = 'stretch';" +
          "document.getElementById('countdownHours').value = '0';" +
          "document.getElementById('countdownMinutes').value = '2';" +
          "document.getElementById('countdownSeconds').value = '0';" +
          "document.getElementById('countdownSave').click()",
      });
      await until(
        page,
        "document.querySelectorAll('#list .wake').length === 2",
        'the saved countdown',
      );
      const countdown = served.timer.handle('list', {}).find((one) => one.mode === 'countdown');
      assert.ok(countdown, 'the countdown was stored as a countdown');
      assert.equal(countdown.kind, 'delay');
      assert.equal(countdown.message, 'stretch');
      assert.ok(
        countdown.in_seconds > 110 && countdown.in_seconds <= 120,
        `two minutes means two minutes (got ${countdown.in_seconds})`,
      );
      assert.deepEqual(
        await look(
          page,
          "[...document.querySelectorAll('#list .wake')].map((row) => row.dataset.mode)",
        ),
        ['countdown', 'alarm'],
        'the soonest timer is first, and both modes are in the one list',
      );

      // Back keeps what was typed (a look at the list must not cost the sentence); Cancel throws it
      // away. Neither ever creates a timer.
      await press(page, '#newAlarm');
      await until(page, "!document.getElementById('view-alarm').hidden", 'the alarm page again');
      await page.send('Runtime.evaluate', {
        expression: "document.getElementById('alarmMessage').value = 'half a thought'",
      });
      await press(page, '#back');
      await until(
        page,
        "location.hash === '#/list' && !document.getElementById('view-list').hidden",
        'the list from Back',
      );
      await press(page, '#newAlarm');
      await until(page, "!document.getElementById('view-alarm').hidden", 'the alarm page again');
      assert.equal(
        await look(page, "document.getElementById('alarmMessage').value"),
        'half a thought',
        'Back leaves the draft in place',
      );
      await press(page, '#alarmCancel');
      await until(
        page,
        "location.hash === '#/list' && !document.getElementById('view-list').hidden",
        'the list from Cancel',
      );
      await press(page, '#newAlarm');
      await until(page, "!document.getElementById('view-alarm').hidden", 'the alarm page once more');
      assert.equal(
        await look(page, "document.getElementById('alarmMessage').value"),
        '',
        'Cancel throws the draft away',
      );
      await press(page, '#back');
      await until(page, "location.hash === '#/list'", 'the list once more');
      assert.equal(
        served.timer.handle('list', {}).length,
        2,
        'neither Back nor Cancel created a timer',
      );

      // A row's Cancel still cancels that one timer, repeats included, and the row goes.
      const cancelledId = countdown.id;
      await press(page, `.wake[data-id="${cancelledId}"] .cancel`);
      await until(page, "document.querySelectorAll('#list .wake').length === 1", 'the cancelled row');
      assert.deepEqual(
        served.timer.handle('list', {}).map((one) => one.id),
        [alarm.id],
        'the list is the list the node holds',
      );

      // A read that fails is said where the list is, with the one action that can fix it; the page
      // keeps working, and trying again brings the rows back.
      served.failList(true);
      served.emit({ type: 'cancel', id: 999 });
      await until(page, "document.getElementById('listError') !== null", 'the list error');
      assert.deepEqual(
        await look(
          page,
          '(() => ({' +
            " role: document.getElementById('listError').getAttribute('role')," +
            " error: document.querySelector('#listError p').textContent," +
            " retry: !!document.getElementById('retry')," +
            " summary: document.getElementById('summary').textContent," +
            " addStillWorks: !document.getElementById('newAlarm').disabled }))()",
        ),
        {
          role: 'alert',
          error: 'the bus is away',
          retry: true,
          summary: 'could not read the timers',
          addStillWorks: true,
        },
        'a list that cannot be read says so, and offers to try again',
      );
      served.failList(false);
      await press(page, '#retry');
      await until(
        page,
        "document.querySelectorAll('#list .wake').length === 1",
        'the list after retry',
      );
      assert.equal(
        await look(page, "document.getElementById('listError')"),
        null,
        'the error card goes when the list comes back',
      );
    } finally {
      opened.page.close();
      opened.browser.chrome.kill('SIGKILL');
      served.close();
    }
  },
);

test(
  'test_the_timer_page_gives_a_phone_the_list_and_thumb_targets',
  { timeout: 90000 },
  async (t) => {
    const chrome = chromePath();
    if (!chrome) {
      t.skip('no chrome to measure with: set CHROME to a chromium binary');
      return;
    }

    // A countdown short enough that its reading moves within a second, and an alarm beside it.
    const served = await serve({
      seed: [
        { mode: 'countdown', after_seconds: 55, message: 'stretch' },
        { mode: 'alarm', at: laterClock(4), message: 'water the plants', repeat: 'daily' },
      ],
    });
    const opened = await phone(served.port);
    const page = opened.page;
    try {
      await until(page, "document.querySelectorAll('#list .wake').length === 2", 'the seeded list');

      // The countdown keeps ticking on its own, without another call to the bus: 55s, then less.
      const countdownId = served.timer.handle('list', {})[0].id;
      const before = await look(
        page,
        `document.querySelector('.wake[data-id="${countdownId}"] .count b').textContent`,
      );
      assert.match(before, /^5[0-5]s$/, `a countdown reads seconds under a minute: ${before}`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const after = await look(
        page,
        `document.querySelector('.wake[data-id="${countdownId}"] .count b').textContent`,
      );
      assert.notEqual(after, before, 'the countdown ticks without asking the bus again');

      // The list is the page, and it gets the height: at 390x844 the rows have more than half the
      // screen, and they end above the two buttons rather than being pushed off by a form.
      const geometry = await look(
        page,
        '(() => {' +
          " const list = document.getElementById('list').getBoundingClientRect();" +
          " const bar = document.querySelector('.actions').getBoundingClientRect();" +
          " const buttons = [...document.querySelectorAll('.actions .new')].map((button) => {" +
          '   const box = button.getBoundingClientRect();' +
          '   return { width: Math.round(box.width), height: Math.round(box.height),' +
          '     bottom: Math.round(box.bottom) }; });' +
          " const rowCancel = [...document.querySelectorAll('#list .wake .cancel')].map((button) => {" +
          '   const box = button.getBoundingClientRect();' +
          '   return { width: Math.round(box.width), height: Math.round(box.height) }; });' +
          ' return { viewport: { width: innerWidth, height: innerHeight },' +
          '   list: { height: Math.round(list.height), bottom: Math.round(list.bottom) },' +
          '   barTop: Math.round(bar.top), buttons, rowCancel,' +
          '   pageWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }' +
          ' })()',
      );
      assert.equal(geometry.pageWidth, geometry.viewport.width, 'the page never grows sideways');
      assert.equal(geometry.bodyWidth, geometry.viewport.width, 'nothing overflows the body either');
      assert.ok(
        geometry.list.height >= geometry.viewport.height / 2,
        `the list gets the height of the page (${geometry.list.height} of ${geometry.viewport.height})`,
      );
      assert.ok(
        geometry.list.bottom <= geometry.barTop,
        'the rows end above the two buttons, not behind them',
      );
      assert.equal(geometry.buttons.length, 2, 'one button for each of the two forms');
      for (const button of geometry.buttons) {
        assert.ok(
          button.height >= TOUCH_TARGET && button.width >= 150,
          `a way into a form is smaller than a thumb: ${button.width}x${button.height}`,
        );
        assert.ok(button.bottom <= geometry.viewport.height, 'both buttons are on the screen');
      }
      assert.equal(geometry.rowCancel.length, 2, 'every row has its own Cancel');
      for (const cancel of geometry.rowCancel) {
        assert.ok(
          cancel.height >= TOUCH_TARGET && cancel.width >= 250,
          `a row's Cancel is smaller than a thumb: ${cancel.width}x${cancel.height}`,
        );
      }

      // Every field and both form buttons are thumb-sized at 390px, and the form does not widen the
      // page. 16px fields are what keeps iOS Safari from zooming the page in on focus.
      await press(page, '#newAlarm');
      await until(
        page,
        "!document.getElementById('view-alarm').hidden",
        'the alarm page on a phone',
      );
      const form = await look(
        page,
        '(() => {' +
          " const form = document.getElementById('alarmForm');" +
          " const controls = [...form.querySelectorAll('input, select')].map((field) => {" +
          '   const box = field.getBoundingClientRect();' +
          '   return { id: field.id, height: Math.round(box.height), width: Math.round(box.width),' +
          '     font: getComputedStyle(field).fontSize }; });' +
          " const actions = [...form.querySelectorAll('.form-actions button')].map((button) => {" +
          '   const box = button.getBoundingClientRect();' +
          '   return { id: button.id, height: Math.round(box.height), width: Math.round(box.width) }; });' +
          " const back = document.getElementById('back').getBoundingClientRect();" +
          ' return { controls, actions, back: { height: Math.round(back.height) },' +
          '   width: document.documentElement.scrollWidth } })()',
      );
      assert.equal(form.width, 390, 'the form page stays inside the phone');
      assert.ok(form.back.height >= TOUCH_TARGET, 'Back is a thumb target too');
      assert.ok(form.controls.length >= 4, 'the alarm page has the fields it needs');
      for (const control of form.controls) {
        assert.ok(
          control.height >= TOUCH_TARGET,
          `${control.id} is smaller than a thumb: ${control.height}px`,
        );
        assert.equal(control.font, '16px', `${control.id} would zoom iOS Safari on focus`);
      }
      assert.deepEqual(
        form.actions.map((one) => one.id),
        ['alarmCancel', 'alarmSave'],
        'the form is left by one of two named buttons',
      );
      for (const action of form.actions) {
        assert.ok(
          action.height >= TOUCH_TARGET,
          `${action.id} is smaller than a thumb: ${action.height}px`,
        );
      }
    } finally {
      opened.page.close();
      opened.browser.chrome.kill('SIGKILL');
      served.close();
    }
  },
);
