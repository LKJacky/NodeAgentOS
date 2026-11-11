// The sort control is the way into the list's order, and it can be broken in three ways nobody sees
// from the source: a control that is drawn somewhere a reader never looks (or not drawn at all under
// the phone block), a menu that opens but cannot be left with a keyboard, and a choice that is not
// remembered - or is remembered at the price of the list. So the page is run the way it is used: the
// BUILT page (dist/ui.html, the one a node serves), in a browser, at a phone's width, with the list
// stubbed so the clock and the hand order disagree on purpose. A build that has not been re-run hands
// these tests the old page: run `npm run build` first.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { chromePath, openPage, startChrome } from '../../webui/tests/browser.mjs';

const BUILT = new URL('../dist/ui.html', import.meta.url);

//: Where the page keeps the reader's choice. A name, not an address: the node knows nothing about it.
const SORT_KEY = 'todo.sort';

/** The stub the page is handed: three open todos whose ids and clocks disagree, so a view sorted by
 *  time is a different order from the hand order - a bug that sorts nothing cannot pass by accident.
 *  The order below is the node's: newest id first, which is what it hands out before anyone moves
 *  anything. */
const TODOS = [
  { id: 3, title: 'review', text: '', done: false, at: '2026-01-02T09:00:00.000Z', doneAt: null },
  { id: 2, title: 'ship', text: '', done: false, at: '2026-01-04T09:00:00.000Z', doneAt: null },
  { id: 1, title: 'plan', text: '', done: false, at: '2026-01-01T09:00:00.000Z', doneAt: null },
];

/** The stub's answers: the three reads the page makes and nothing else. A write reaching here is a
 *  page that invented one, and is answered as a refusal so the test notices. */
const ANSWERS = {
  'todo.list': { ok: true, value: TODOS },
  'todo.today': { ok: true, value: { text: '', buttons: [], updatedAt: null } },
  'todo.presses': { ok: true, value: [] },
};

/** A deployment in miniature: the built page at /, the address it calls and the topic it listens on.
 *  No bus, no store, no clock - the list is a constant, so what the page draws is the whole question. */
async function serve() {
  const page = readFileSync(BUILT, 'utf8').replace('__NODE__', 'todo');
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
        const { tool } = JSON.parse(body === '' ? '{}' : body);
        const answer = ANSWERS[String(tool)] ?? { ok: false, error: `the stub has no ${tool}` };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
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
    // `?? 'null'` keeps a call that answers nothing (a click, a focus) from arriving as the string
    // "undefined", which is not JSON - the test is about what the page did, not what it returned.
    expression: `JSON.stringify(${expression}) ?? 'null'`,
    returnByValue: true,
  });
  return JSON.parse(reply.result.result.value);
}

/** Poll instead of sleeping: fast when the page is already there, honest when it is not. */
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

/** A real key press, dispatched into the page: a synthetic KeyboardEvent would prove nothing, because
 *  a button's Enter and Space are the browser's own activation and untrusted events never run it. */
async function press(page, name) {
  const keys = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    ' ': { code: 'Space', keyCode: 32, text: ' ' },
    Escape: { code: 'Escape', keyCode: 27 },
    Tab: { code: 'Tab', keyCode: 9 },
  };
  const one = keys[name];
  const base = {
    key: name,
    code: one.code,
    windowsVirtualKeyCode: one.keyCode,
    nativeVirtualKeyCode: one.keyCode,
  };
  await page.send('Input.dispatchKeyEvent', {
    type: one.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(one.text ? { text: one.text } : {}),
  });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** One page, one browser, one stub: what every test below needs and none of them wants to spell out. */
async function withPage(t, width, run) {
  if (!existsSync(BUILT)) {
    t.skip('dist/ is only there after `npm run build`');
    return;
  }
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
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.send('Page.navigate', { url: `http://127.0.0.1:${served.port}/` });
    await until(page, "document.querySelectorAll('#list .row').length === 3", 'the stubbed list');
    await run(page);
  } finally {
    page?.close();
    browser.chrome.kill('SIGKILL');
    served.close();
  }
}

/** The sort button as the page draws it: where it is, how big, what it says, and whether the narrow
 *  rules left it alone. */
const BUTTON_SHAPE = `(() => {
  const button = document.getElementById('sortButton');
  if (button === null) return null;
  const box = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  return {
    label: button.getAttribute('aria-label'),
    title: button.title,
    mode: button.dataset.mode,
    expanded: button.getAttribute('aria-expanded'),
    on: button.classList.contains('on'),
    insideHead: document.querySelector('.today-head').contains(button),
    display: style.display,
    visibility: style.visibility,
    opacity: Number(style.opacity),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
})()`;

// Requirement: the control is visible on the card's title row, says what it is, and is a thumb target
// at every width - the phone block included, where the row's arrows also grow to 44px.
test('the sort button sits on the Today title row and a thumb gets 44px of it', async (t) => {
  await withPage(t, 390, async (page) => {
    const phone = await look(page, BUTTON_SHAPE);
    assert.ok(phone !== null, 'the card has a sort button');
    assert.equal(phone.label, '排序', 'and it says what it is, for a reader who cannot see the icon');
    assert.match(phone.title, /按手序排序/, 'the title says which order the list is in right now');
    assert.equal(phone.mode, 'manual', 'the hand order is where a list nobody has sorted starts');
    assert.equal(phone.expanded, 'false', 'the menu starts closed');
    assert.equal(phone.on, false, 'and the button is not lit: this is the order the list was left in');
    assert.equal(phone.insideHead, true, 'it is on the title row, not buried under the card');
    assert.equal(phone.display, 'grid', 'the phone block does not turn it into nothing');
    assert.equal(phone.visibility, 'visible');
    assert.equal(phone.opacity, 1, 'a control that appears on hover is one nobody finds');
    assert.deepEqual(
      [phone.width, phone.height],
      [44, 44],
      'a thumb gets 44x44, which is the smallest target to hit reliably',
    );

    // And the narrowest phone there is: the same button, the same target.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 640,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.send('Page.reload', {});
    await until(page, "document.querySelectorAll('#list .row').length === 3", 'the list after reload');
    const narrow = await look(page, BUTTON_SHAPE);
    assert.deepEqual(
      [narrow.display, narrow.visibility, narrow.opacity, narrow.width, narrow.height],
      ['grid', 'visible', 1, 44, 44],
      'at 320px the button is still there and still a thumb target',
    );
  });
});

// Requirements: the menu offers exactly the two orders, the one in use is ticked, a choice redraws the
// list in it at once, and the choice is written down where the next visit finds it.
test('the menu offers both orders, and a choice is remembered and drawn at once', async (t) => {
  await withPage(t, 390, async (page) => {
    await look(page, "document.getElementById('sortButton').click()");
    await until(page, "!document.getElementById('sortMenu').hidden", 'the menu to open');
    // The card clips its own corner decoration, so the menu has to fit inside it: a dropdown hanging
    // out of the card would lose its last row exactly when the card is short.
    const inside = await look(
      page,
      "(() => {" +
        " const card = document.querySelector('.today').getBoundingClientRect();" +
        " const menu = document.getElementById('sortMenu').getBoundingClientRect();" +
        ' return {' +
        ' cardBottom: Math.round(card.bottom),' +
        ' menuTop: Math.round(menu.top),' +
        ' menuBottom: Math.round(menu.bottom),' +
        ' rows: document.querySelectorAll("#sortMenu .sort-item").length,' +
        ' };' +
        '})()',
    );
    assert.deepEqual(
      [inside.rows, inside.menuTop >= 0 && inside.menuBottom <= inside.cardBottom],
      [2, true],
      `both rows of the menu are inside the card that clips it: ${JSON.stringify(inside)}`,
    );
    const menu = await look(
      page,
      "[...document.querySelectorAll('#sortMenu .sort-item')].map((item) => ({" +
        ' mode: item.dataset.mode,' +
        ' label: item.textContent.trim(),' +
        ' checked: item.getAttribute(\'aria-checked\'),' +
        ' role: item.getAttribute(\'role\'),' +
        ' tick: getComputedStyle(item.querySelector(\'.tick\')).visibility,' +
        ' height: Math.round(item.getBoundingClientRect().height),' +
        '}))',
    );
    assert.deepEqual(
      menu.map((one) => one.label),
      ['按手序（原始顺序）', '按更新时间'],
      'the two ways of reading the list, and nothing else',
    );
    assert.deepEqual(
      menu.map((one) => one.mode),
      ['manual', 'updated'],
      'each row names its mode',
    );
    assert.deepEqual(
      menu.map((one) => one.checked),
      ['true', 'false'],
      'the mode in use is the one marked as chosen',
    );
    assert.deepEqual(
      menu.map((one) => one.tick),
      ['visible', 'hidden'],
      'and it is the one with the tick drawn next to it',
    );
    assert.deepEqual(
      menu.map((one) => one.role),
      ['menuitemradio', 'menuitemradio'],
    );
    assert.deepEqual(
      menu.map((one) => one.height >= 44),
      [true, true],
      'a thumb gets 44px of each row too',
    );

    // The stub hands the list out as 3, 2, 1 (newest id first). By the clock it is 2, 3, 1.
    assert.equal(
      await look(page, "[...document.querySelectorAll('#list .row')].map((r) => r.dataset.id).join()"),
      '3,2,1',
      'the hand order is what the node said, until somebody asks otherwise',
    );
    assert.equal(
      await look(page, "document.querySelectorAll('#list .move').length"),
      6,
      'and it is drawn with the two arrows each row is moved by',
    );

    await look(page, "document.querySelector('.sort-item[data-mode=\"updated\"]').click()");
    await until(
      page,
      "!document.getElementById('sortMenu').hidden === false",
      'the menu to close on a choice',
    );
    assert.equal(
      await look(page, "[...document.querySelectorAll('#list .row')].map((r) => r.dataset.id).join()"),
      '2,3,1',
      'the list is drawn newest write first',
    );
    assert.equal(
      await look(page, "document.querySelectorAll('#list .move').length"),
      0,
      'and no arrows: they move the hand order, which is not what is on screen',
    );
    assert.equal(
      await look(page, 'localStorage.getItem("todo.sort")'),
      'updated',
      'and the choice is written down for the next visit',
    );
    const after = await look(page, BUTTON_SHAPE);
    assert.equal(after.mode, 'updated');
    assert.match(after.title, /按更新时间排序/, 'the button now says what the list is in');
    assert.equal(after.on, true, 'and it is lit: this is not the order the list was left in');
    assert.equal(
      await look(
        page,
        "document.activeElement === document.getElementById('sortButton')",
      ),
      true,
      'the focus comes back to the button that owns the menu',
    );

    // A reload is the next visit: the order is read back from the store, and the list obeys it.
    await page.send('Page.reload', {});
    await until(page, "document.querySelectorAll('#list .row').length === 3", 'the list after reload');
    assert.equal(
      await look(page, "[...document.querySelectorAll('#list .row')].map((r) => r.dataset.id).join()"),
      '2,3,1',
      'the remembered order is the one drawn',
    );
    assert.equal((await look(page, BUTTON_SHAPE)).on, true, 'and the button still says so');
  });
});

// Requirement: a keyboard reaches the button, opens it with Enter and with Space, and Esc closes it
// again - a menu a keyboard cannot leave is a trap.
test('a keyboard opens the menu with Enter and Space, and Escape closes it', async (t) => {
  await withPage(t, 900, async (page) => {
    // The page's own sequence, before anything has been focused by hand: nothing above the card can be
    // tabbed to, so the first Tab lands on the sort button - a control a keyboard cannot reach is a
    // control half the readers do not have. (Done first on purpose: Chrome remembers the last element
    // it focused, and a Tab after a blur would start from there instead of from the top.)
    await press(page, 'Tab');
    assert.equal(
      await look(page, "document.activeElement === document.getElementById('sortButton')"),
      true,
      'the first Tab of the page lands on the sort button',
    );

    await press(page, 'Enter');
    await until(page, "!document.getElementById('sortMenu').hidden", 'Enter to open the menu');
    assert.equal(
      await look(page, "document.activeElement.dataset.mode"),
      'manual',
      'the focus lands on the mode in use',
    );

    await press(page, 'Escape');
    await until(page, "document.getElementById('sortMenu').hidden", 'Escape to close the menu');
    assert.equal(
      await look(page, "document.activeElement === document.getElementById('sortButton')"),
      true,
      'and the focus goes back to the button',
    );

    await press(page, ' ');
    await until(page, "!document.getElementById('sortMenu').hidden", 'Space to open the menu');
    await press(page, 'Escape');
    await until(page, "document.getElementById('sortMenu').hidden", 'Escape to close it again');

    // Escape closes; it never walks off into the page.
    assert.equal(
      await look(page, 'document.getElementById("sortMenu").getAttribute("aria-hidden")'),
      null,
      'the menu is hidden by its own hidden attribute, which is what the stylesheet reads',
    );
  });
});

// Requirement: a store that refuses is silent. A sandboxed frame or a blocked origin throws on
// localStorage, and the page must draw the list it was handed and still obey the choice - the choice
// just does not survive the visit.
test('a store that refuses does not take the list down with it', async (t) => {
  await withPage(t, 900, async (page) => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('the store is blocked'); } });",
    });
    await page.send('Page.reload', {});
    await until(page, "document.querySelectorAll('#list .row').length === 3", 'the list with no store');
    assert.equal(
      await look(page, "[...document.querySelectorAll('#list .row')].map((r) => r.dataset.id).join()"),
      '3,2,1',
      'the page draws the hand order it was handed',
    );

    await look(page, "document.getElementById('sortButton').click()");
    await until(page, "!document.getElementById('sortMenu').hidden", 'the menu to open');
    await look(page, "document.querySelector('.sort-item[data-mode=\"updated\"]').click()");
    await until(
      page,
      "[...document.querySelectorAll('#list .row')].map((r) => r.dataset.id).join() === '2,3,1'",
      'the list sorted by the clock without a store',
    );
  });
});

// Requirement: four thumb-sized row actions must not squeeze the title into a one-character column.
// The phone layout puts the action strip on its own row and gives the title the middle column back.
test('a phone row keeps the title readable beside thumb-sized actions', async (t) => {
  await withPage(t, 390, async (page) => {
    const shape = await look(
      page,
      `(() => {
        const row = document.querySelector('#list .row');
        const main = row?.querySelector('.row-main');
        const actions = row?.querySelector('.row-actions');
        if (!row || !main || !actions) return null;
        const box = (el) => el.getBoundingClientRect();
        return {
          display: getComputedStyle(row).display,
          rowHeight: Math.round(box(row).height),
          mainWidth: Math.round(box(main).width),
          actionsWidth: Math.round(box(actions).width),
        };
      })()`,
    );
    assert.ok(shape !== null, 'a stubbed row is drawn');
    assert.equal(shape.display, 'grid', 'the phone row lays its parts out in a grid');
    assert.ok(shape.mainWidth >= 180, `the title keeps at least 180px, got ${shape.mainWidth}`);
    assert.ok(shape.rowHeight < 180, `the row does not become a one-character tower, got ${shape.rowHeight}`);
    assert.ok(shape.mainWidth >= shape.actionsWidth, 'the title is not narrower than its action strip');
  });
});

// The page and the stylesheet, read as text: a build that has been run is the only page a node serves,
// so the control has to be in the served copy - and no `display: none` may be hiding it on a phone.
test('the served page carries the control, and no narrow rule hides it', () => {
  const html = readFileSync(BUILT, 'utf8');
  assert.match(html, /id="sortButton"/, 'the button is in the page the node hands out');
  assert.match(html, /aria-label="排序"/, 'with its name on it');
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /\.sort-button \{[^}]*width: 44px[^}]*height: 44px/s, '44px is the CSS, not luck');
  assert.match(html, /const SORT_KEY = 'todo\.sort'/, 'the key it remembers the choice under');
  assert.match(
    html,
    /@media \(max-width: 640px\)[\s\S]*?\.sort-button \{[^}]*44px/s,
    'the phone block keeps the target, it does not drop the control',
  );
  assert.doesNotMatch(
    html,
    /\.sort-button[^{]*\{[^}]*display:\s*none/s,
    'nothing hides the one control that leads to the list order',
  );
});
