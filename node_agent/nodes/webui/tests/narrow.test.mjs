import { serveEventAssets } from './browser.mjs';
// A narrow screen is ONE column, not two stacked ones. The shell used to answer a narrow window by
// turning its two columns into two piles — the left column's strip of tabs, its frame, then the main
// area's strip and its frame — so a phone showed a page in a 150px sliver and a reader had to work out
// which strip a row of tabs belonged to. Now a phone gets one row of tabs (group, hairline, group) and
// the pages behind them share ONE frame, which a tab puts a page into — while a wide screen keeps the two
// strips it always had, one over each column (tabs.test.mjs measures that other shape).
//
// None of that is visible in the stylesheet: a rule can say `display: none` and still leave a frame
// laid out, and a bar can be one row of boxes that overflows the screen. So this file measures the real
// page in a real browser — at 360px (a phone) and at 900px (a desktop, where the two columns must stay
// apart and each strip sits over its own column). It reads src/ on purpose: `npm run build` copies the page to
// dist/. (The bar's own scroll container, the seam and scrollIntoView are measured from dist/ in
// tabs.test.mjs.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { chromePath, openPage, startChrome } from './browser.mjs';

//: The repository root, three levels up from webui/tests/.
const ROOT = new URL('../../../', import.meta.url);

//: The shell's own page.
const PAGE = 'node_agent/nodes/webui/src/webui.html';

//: The agent, and two pages named longer than half a phone: a long name is what breaks a bar, and
//: short ones would let a regression through. The agent is first because it is the resident page — the
//: one the left column always shows.
const LONG_NAMES = ['agent', 'node-agent-deepseek-search', 'conversation-with-the-agent'];

//: 44px is the smallest target a thumb hits reliably.
const TOUCH_TARGET = 44;

/** The narrow block as written: everything between its `@media` line and the phone block that follows
 *  it. The declarations that matter are the ones inside it, so they are read from there rather than
 *  from the page at large. */
function narrowBlock(html) {
  const start = html.indexOf('@media (max-width: 760px), (orientation: landscape) and (max-height: 480px)');
  assert.ok(start > 0, 'the shell needs its own narrow block');
  const end = html.indexOf('@media (max-width: 640px)', start);
  assert.ok(end > start, 'the phone block comes after the narrow block');
  return html.slice(start, end);
}

/** A stub bus: the page itself at /, the pages named by `names()` at /panels (the first of them the
 *  agent, which the shell keeps in the left column), and /events left open (the shell keeps one). Only
 *  the shape matters — nothing here follows a page into its frame. */
async function stubBus(html) {
  let names = LONG_NAMES;
  const server = createServer((req, res) => {
    if (serveEventAssets(req, res)) return;
    const url = req.url ?? '/';
    if (url === '/panels') {
      const panels = names.map((node, index) => ({
        node,
        desc: `a page about ${node}`,
      }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ panels }));
      return;
    }
    if (url.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': open\n\n');
      return;
    }
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end('');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, use: (list) => (names = list) };
}

// The cheap half: the shape a reader sees is decided by a handful of declarations, and a stylesheet
// edit that drops one should say so by name instead of only as a number.
test('test_the_shell_has_no_title_row_and_no_stacked_column_left', () => {
  const html = readFileSync(new URL(PAGE, ROOT), 'utf8');

  // ① The title and the sentence about how the shell works are not in the page at all, so no rule has
  // to remember to hide them on a phone. (They were the top of every narrow screen.)
  assert.doesNotMatch(html, /<header[\s>]/, 'the shell has no title row to spend a phone’s first inches on');
  assert.doesNotMatch(html, /node_agent<\/b>/, 'and no title left to hide');

  // ② One bar holds both groups on every screen, and the seam is a hairline drawn in it on a phone —
  // the only thing down there that says "these pages are the left column's, those are the main area's".
  assert.match(html, /<span class="sep" aria-hidden="true"><\/span>/, 'the seam between the two groups is one element');
  // The bar is three parts at every width: the strips (both groups) and the launcher beside
  // them. Only the strips scroll, and on a phone they are the one row both groups share.
  const bar = /\.tabs \{([^}]*)\}/.exec(html);
  assert.ok(bar, 'both groups live in one bar');
  assert.match(bar[1], /display:\s*grid/, 'the bar is a grid: the strips, then the launcher');
  assert.match(
    bar[1],
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    'everything that can scroll, then the launcher at its own width',
  );
  assert.doesNotMatch(bar[1], /overflow/, 'and the wide bar does not scroll');
  const strips = /\.strips \{([^}]*)\}/.exec(html);
  assert.ok(strips, 'the part that scrolls has its own rule');
  assert.match(strips[1], /display:\s*grid/, 'a wide screen puts each group over its own column');
  assert.match(
    strips[1],
    /grid-template-columns:\s*var\(--left\)\s+1px\s+minmax\(0,\s*1fr\)/,
    'the left strip is as wide as the left column, then the seam track, then the rest',
  );
  assert.doesNotMatch(strips[1], /overflow/, 'and the wide strips do not scroll of their own accord');

  // ③ Narrow: the split keeps its row and the two columns SHARE it — the stack is gone for good. The bar
  // becomes the one row it is down here: one scroller holding both groups, a hairline between them.
  const narrow = narrowBlock(html);
  assert.doesNotMatch(narrow, /flex-direction:\s*column/, 'a narrow screen must not stack the columns again');
  assert.match(
    narrow,
    /\.strips \{[^}]*overflow-x:\s*auto/s,
    'a narrow screen turns the strips into the one sideways scroller',
  );
  assert.match(narrow, /\.strips \{[^}]*flex-wrap:\s*nowrap/s, 'a row that never folds');
  assert.match(narrow, /\.sep \{[^}]*display:\s*block/s, 'and draws the hairline at the seam');
  assert.doesNotMatch(narrow, /white-space:\s*normal/, 'a phone may not wrap a tab’s name');
  assert.doesNotMatch(narrow, /flex:\s*1 1 0/, 'nor halve the bar between the two groups');
  assert.match(narrow, /aside \{[^}]*flex:\s*1 1 auto/s, 'the shown column fills the one area');
  assert.match(
    narrow,
    /\.split\[data-view='right'\] aside,\s*\.split\[data-view='left'\] \.side \{\s*display:\s*none;/,
    'and exactly one of the two columns is laid out at a time',
  );
  const tab = /\.tabs \.tab \{([^}]*)\}/.exec(narrow);
  assert.ok(tab, 'a phone still gets a thumb-sized tab');
  assert.match(tab[1], /min-height:\s*44px/, 'a tab is a 44px target');
  assert.match(tab[1], /flex:\s*none/, 'and keeps its own width');
});

// The measurement. One browser, two viewports: a phone, where there has to be exactly one column and
// one row of tabs, and a desktop, where the two strips have to stay apart over their own columns.
test('test_the_narrow_shell_is_one_column_switched_by_one_tab_row', { timeout: 90000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome) {
    t.skip('no chrome to measure with: set CHROME to a chromium binary');
    return;
  }

  const bus = await stubBus(readFileSync(new URL(PAGE, ROOT), 'utf8'));
  const browser = await startChrome(chrome);
  const { send, close } = await openPage(browser.page.webSocketDebuggerUrl);
  const url = `http://127.0.0.1:${bus.port}/`;

  /** What the page looks like from inside: the bar, its two groups, the seam, the frames that are
   *  actually laid out, and the shell's own scroll box. */
  const read = async () => {
    const expression = `JSON.stringify((() => {
      const root = document.documentElement;
      const box = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: style.display,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      };
      const tabs = (element) => [...element.querySelectorAll('.tab')];
      const left = document.getElementById('pinned-nav');
      const right = document.getElementById('nav');
      const sep = document.querySelector('.sep');
      return {
        bar: box(document.querySelector('.tabs')),
        strips: box(document.getElementById('strips')),
        launcher: box(document.getElementById('launcher-tab')),
        header: document.querySelector('header') === null ? null : box(document.querySelector('header')),
        text: document.body.innerText,
        sep: { ...box(sep), text: sep === null ? '' : sep.textContent },
        left: { ...box(left), tabs: tabs(left).map(box) },
        right: { ...box(right), tabs: tabs(right).map(box) },
        frames: [...document.querySelectorAll('iframe')]
          .filter((frame) => frame.getClientRects().length > 0)
          .map((frame) => ({ id: frame.id, ...box(frame) })),
        aside: box(document.querySelector('aside')),
        side: box(document.querySelector('.side')),
        page: {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          scrollHeight: root.scrollHeight,
          clientHeight: root.clientHeight,
        },
      };
    })())`;
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 400));
    return JSON.parse(reply.result.result.value);
  };

  /** The page at one viewport, painted from /panels. Nothing is clicked on a phone: the resident page
   *  is already the left column, which is the one this file measures there. A wide screen shows BOTH
   *  columns, so the main one is given a page too — a page reaches the bar only when a reader picks its
   *  card, and there is no other way for a right-hand frame to exist. */
  const look = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 640,
    });
    await send('Page.navigate', { url });
    // The page asks /panels and paints the launcher from the answer, so one moment has to pass.
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (width > 760) {
      await send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('.launcher .card')].at(-1).click()`,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return read();
  };

  try {
    // ---- a phone ------------------------------------------------------------------------------
    const phone = await look(360, 740);
    // A page reaches the bar only when its card is picked, so every card is picked — and then the
    // resident's tab, which is where a phone starts. What this section measures is the bar holding
    // every page, and the frame under it being the left column's.
    await send('Runtime.evaluate', {
      expression: `(() => {
        for (const card of document.querySelectorAll('.launcher .card')) card.click();
        document.querySelector('#pinned-nav .tab').click();
      })()`,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const full = await read();
    assert.ok(phone.bar, 'the shell has one tab bar');
    // ② Nothing named node_agent sits at the top: no title row, and no band above the bar either.
    assert.equal(phone.header, null, 'the shell draws no title row');
    assert.doesNotMatch(phone.text, /node_agent/i, 'and no node_agent word is on the page');
    assert.equal(phone.bar.top, 0, 'the tab bar is the first thing on the phone');

    // ① One area: exactly one frame, and it is the whole of what is left under the bar. `aside` and
    // `.side` are the same box — one fills it, the other is not laid out — never one under the other.
    assert.equal(phone.frames.length, 1, `a phone shows one frame, not ${phone.frames.length}`);
    const frame = phone.frames[0];
    assert.equal(frame.top, phone.bar.bottom, 'the frame starts where the bar ends');
    assert.equal(frame.height, phone.page.clientHeight - phone.bar.bottom, 'and takes the rest of the screen');
    assert.equal(phone.side.display, 'none', 'the column that was not chosen is not laid out');
    assert.equal(phone.aside.top, frame.top, 'the chosen column is the frame’s own box');
    // One scroll region: the shell itself has nothing to scroll — the page in the frame is the only
    // thing that moves under a thumb.
    assert.ok(
      phone.page.scrollHeight <= phone.page.clientHeight,
      `the shell scrolls instead of its frame: ${phone.page.scrollHeight} > ${phone.page.clientHeight}`,
    );

    // ③ One row of tabs, with the seam at the boundary between the two groups. The bar is a single
    //   sideways scroller (narrow.test does not count the scrollers; tabs.test does): a long name
    //   widens it instead of wrapping, and the page under it never scrolls sideways.
    assert.equal(
      full.left.tabs.length + full.right.tabs.length,
      3,
      'every page is on the strips; the launcher is the bar third part',
    );
    assert.equal(full.left.top, full.right.top, 'the two groups share one row');
    assert.equal(full.left.bottom, full.right.bottom, 'and one height');
    assert.equal(full.sep.text, '', 'the seam is a line, not a word');
    assert.ok(full.sep.width <= 2, `the seam is a hairline: ${full.sep.width}px wide`);
    assert.ok(full.sep.left >= full.left.tabs.at(-1).right - 1, 'the seam is right of the left column’s tabs');
    assert.ok(full.sep.right <= full.right.tabs[0].left + 1, 'and left of the main area’s tabs');
    assert.ok(full.sep.top >= full.bar.top && full.sep.bottom <= full.bar.bottom, 'inside the bar');

    // A tab keeps its own width and one line: the bar scrolls instead of squeezing or folding. The
    // groups are not scrollers themselves, and nothing on the phone scrolls the page.
    for (const [name, group] of [
      ['left', full.left],
      ['right', full.right],
    ]) {
      for (const tab of group.tabs)
        assert.ok(tab.right <= group.right + 1, `the ${name} group’s tab sticks out: ${tab.right} > ${group.right}`);
      assert.ok(group.scrollWidth <= group.clientWidth, `the ${name} group scrolls sideways of its own accord`);
      for (const tab of group.tabs)
        assert.ok(tab.height >= TOUCH_TARGET, `a ${name} tab is smaller than a thumb target: ${tab.height}px`);
    }
    assert.ok(full.page.scrollWidth <= full.page.clientWidth, 'the phone does not scroll sideways');
    assert.ok(full.strips.scrollWidth > full.strips.clientWidth, 'two long names overflow the strips: they scroll, the page does not');
    assert.ok(
      full.bar.scrollWidth <= full.bar.clientWidth + 1,
      'and the bar around them holds the launcher without scrolling',
    );
    assert.ok(
      Math.abs(full.launcher.right - full.bar.right) <= 8,
      `the launcher is at the right edge: ${full.launcher.right} vs ${full.bar.right}`,
    );

    // A tab is what puts a page in that one area: picking a card on the launcher puts the main area's
    // page in the SAME box and hides the other column — which is the single column — and the resident's
    // tab brings that column back.
    await send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('.launcher .card')].at(-1).click()`,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const switched = await read();
    assert.equal(switched.frames.length, 1, 'still one frame after a page in the other group');
    assert.equal(switched.frames[0].id, 'view', 'and it is the main area’s frame');
    assert.equal(switched.frames[0].top, frame.top, 'the frame swapped in the same place');
    assert.equal(switched.frames[0].height, frame.height, 'at the same size');
    assert.equal(switched.aside.display, 'none', 'the left column steps out of the way');

    await send('Runtime.evaluate', {
      expression: `document.querySelector('#pinned-nav .tab').click()`,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const back = await read();
    assert.equal(back.frames.length, 1, 'and one frame after the resident’s tab');
    assert.equal(back.frames[0].id, 'pinned-view', 'which is the left column’s');
    assert.equal(back.side.display, 'none', 'with the main area out of the way');

    // ---- a bar with more pages than fit ------------------------------------------------------------
    // Six pages cannot all fit on a phone. The bar must not answer by squeezing each tab into a column
    // of single letters (a 27px tab, 152px tall, was what one draft did): a tab keeps its own width,
    // one line, and the bar scrolls sideways.
    bus.use(['agent', 'notes', 'shell', 'todo', 'timer', 'mindmap']);
    await look(360, 740);
    // Every card picked: a page reaches the bar when a reader picks its card, so the bar holding all six
    // is exactly what six picks make of it (and the launcher, which is always there).
    await send('Runtime.evaluate', {
      expression: `(() => { for (const card of document.querySelectorAll('.launcher .card')) card.click(); })()`,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const many = await read();
    assert.equal(
      many.left.tabs.length + many.right.tabs.length,
      6,
      'every page is in the strips; the launcher is the bar third part',
    );
    for (const tab of [...many.left.tabs, ...many.right.tabs]) {
      assert.ok(tab.height >= TOUCH_TARGET, `a tab is smaller than a thumb target: ${tab.height}px`);
      assert.ok(tab.height <= 52, `a tab was squeezed into a column of letters: ${tab.height}px tall`);
    }
    assert.ok(many.strips.scrollWidth > many.strips.clientWidth, 'six tabs overflow the strips, which is where they scroll');
    assert.ok(
      Math.abs(many.launcher.right - many.bar.right) <= 8,
      'and the launcher keeps the right edge while they scroll',
    );
    assert.ok(many.page.scrollWidth <= many.page.clientWidth, 'and the phone still does not scroll sideways');

    // ---- a desktop ----------------------------------------------------------------------------
    const desktop = await look(900, 700);
    assert.equal(desktop.header, null, 'no title row on a wide screen either');
    assert.equal(desktop.frames.length, 2, 'a desktop shows both columns');
    assert.ok(desktop.aside.right <= desktop.side.left, 'the two columns sit side by side, not stacked');
    assert.equal(desktop.aside.top, desktop.side.top, 'and share the top');
    // The bar's other shape: two strips, each over its own column, and no seam — the columns already
    // say where one group's pages end. (tabs.test.mjs measures that shape in full.)
    assert.equal(desktop.bar.display, 'grid', 'a wide screen puts each group over its own column');
    assert.equal(desktop.strips.display, 'grid', 'inside the bar, the strips are the grid over the columns');
    assert.equal(desktop.sep.display, 'none', 'and draws no seam between them');
    assert.equal(desktop.left.top, desktop.right.top, 'both groups on one row');
    assert.ok(desktop.left.right <= desktop.right.left, 'the left group ends where the main group begins');
    assert.ok(desktop.left.right <= desktop.aside.right + 1, 'the left group sits over the aside');
    assert.ok(desktop.right.left >= desktop.side.left - 1, 'and the main group over the frame');
    assert.ok(desktop.bar.scrollWidth <= desktop.bar.clientWidth, 'the wide bar still fits its tabs');
    assert.ok(
      Math.abs(desktop.launcher.right - desktop.bar.right) <= 8,
      'with the launcher on its right edge',
    );
    assert.ok(desktop.page.scrollWidth <= desktop.page.clientWidth, 'the page is no wider than the window');
  } finally {
    close();
    browser.chrome.kill('SIGKILL');
    bus.server.closeAllConnections();
    bus.server.close();
  }
});
