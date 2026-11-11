import { serveEventAssets } from './browser.mjs';
// The tab bar has TWO shapes, and ONE markup. A wide screen keeps the shape this page always had:
// two strips, each one over its own column — the left column's pages (the sub-agents) over the aside,
// the main area's pages (the nodes) over the frame. A narrow screen has one column, so the same two
// groups become ONE row: a single sideways scroller, group │ group, with a hairline at the seam.
//
// Which shape is on screen is the media query that stacks the columns — there is no second breakpoint
// and no second copy of the tabs. This file checks that claim by name (in the stylesheet) and then by
// measurement, in a real browser, at 360px (a phone) and at 1100px (a desktop).
//
// It reads the BUILD PRODUCT on purpose (`npm run build` copies src/ to dist/): the task is about what
// the browser is actually served, and the assertion that dist/ and src/ are the same page is the one
// that keeps a stale build from passing here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { chromePath, openPage, startChrome } from './browser.mjs';

//: The repository root, three levels up from webui/tests/.
const ROOT = new URL('../../../', import.meta.url);

//: The page as built, and the page as written.
const BUILT = 'node_agent/nodes/webui/dist/webui.html';
const SOURCE = 'node_agent/nodes/webui/src/webui.html';

//: The breakpoint, spelled once: the query that puts the two columns in one box. The bar has to switch
//: with the columns, so this is the only width either of them may name.
const NARROW = '@media (max-width: 760px), (orientation: landscape) and (max-height: 480px)';

//: Six pages, the first of them the agent — which the shell keeps in the left column whatever the list
//: says: enough that a phone cannot show them all at once, which is the state the narrow shape is
//: about, and few enough that the main strip (the launcher's tab plus five pages) still fits a 1100px
//: screen without scrolling. Short names here so nothing passes by wrapping.
const NAMES = ['agent', 'search', 'notes', 'shell', 'todo', 'timer'];

//: Names too long for the column they sit over: on a wide screen each strip has to keep its column's
//: width and scroll sideways to the rest instead of widening the column or wrapping.
const LONG_NAMES = [
  'agent',
  'node-agent-search-with-an-absurdly-long-name-no-column-can-hold',
  'conversation-with-the-agent-about-everything-that-happened-today',
];

//: More pages than one column can hold, each with a name that will not shrink to fit: the state the
//: wide strips have to scroll out of.
const MANY_NAMES = Array.from({ length: 18 }, (_, i) => `node-agent-page-with-a-long-name-${i}`);

//: 44px is the smallest target a thumb hits reliably.
const TOUCH_TARGET = 44;

/** The build product, checked to be the page as written: a stale dist/ would measure yesterday's bar. */
function built() {
  const dist = readFileSync(new URL(BUILT, ROOT), 'utf8');
  assert.equal(
    dist,
    readFileSync(new URL(SOURCE, ROOT), 'utf8'),
    'dist/webui.html is not src/webui.html: run `npm run build` before the tests',
  );
  return dist;
}

/** A stub bus: the page at /, its tabs at /panels and /events left open. `use` swaps the page list
 *  between looks, so one browser can measure a short list and a long name. */
async function stubBus(html) {
  let names = NAMES;
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
    if (url.startsWith('/panel/')) {
      // A node's page: the shell only asks for one when a card is picked, and here it is only ever shown
      // in the frame, so an empty page is enough.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><p>a page</p>');
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

/** The page as the browser lays it out: both groups, the seam, the columns under them, and — for every
 *  tab — every box it can be clipped or scrolled by, found by walking up from the tab rather than by
 *  name. `containers` is any box that clips or scrolls (`overflow-x` other than visible); `scrollers`
 *  is the subset a reader can actually scroll sideways.
 */
const READ = `JSON.stringify((() => {
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: Math.round(rect.top), bottom: Math.round(rect.bottom),
      left: Math.round(rect.left), right: Math.round(rect.right),
      width: Math.round(rect.width), height: Math.round(rect.height),
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      scrollLeft: Math.round(element.scrollLeft),
      overflowX: style.overflowX, overflowY: style.overflowY,
      flexWrap: style.flexWrap, whiteSpace: style.whiteSpace, display: style.display,
      laidOut: element.getClientRects().length > 0,
    };
  };
  const tabs = [...document.querySelectorAll('.tabs .tab')];
  const containers = (tab) => {
    const seen = [];
    for (let element = tab.parentElement; element; element = element.parentElement) {
      const overflow = getComputedStyle(element).overflowX;
      if (overflow !== 'visible') seen.push(element.id || element.className);
    }
    return seen;
  };
  const scrollers = (tab) =>
    containers(tab).filter((name) => {
      const element = document.getElementById(name) || document.querySelector('.' + name);
      const overflow = getComputedStyle(element).overflowX;
      return overflow === 'auto' || overflow === 'scroll';
    });
  return {
    bars: document.querySelectorAll('.tabs').length,
    navs: document.querySelectorAll('.tabs nav').length,
    bar: box(document.querySelector('.tabs')),
    strips: box(document.getElementById('strips')),
    launcher: box(document.getElementById('launcher-tab')),
    // The bar's parts, in order: the scroller (both strips) and then the launcher beside it.
    parts: [...document.querySelectorAll('.tabs > *')].map((element) => element.id || element.className),
    groups: {
      left: box(document.getElementById('pinned-nav')),
      right: box(document.getElementById('nav')),
    },
    columns: { aside: box(document.querySelector('aside')), side: box(document.querySelector('.side')) },
    sep: box(document.querySelector('.sep')),
    tabs: tabs.map((tab) => ({
      text: (tab.querySelector('.label')?.textContent.trim() || tab.getAttribute('aria-label')) ?? '',
      selected: tab.getAttribute('aria-selected'),
      role: tab.getAttribute('role'),
      tabIndex: tab.tabIndex,
      containers: containers(tab),
      scrollers: scrollers(tab),
      ...box(tab),
    })),
    // Tabs on one row are within a few pixels of each other (the launcher is centred in the bar, a
    // strip with a scrollbar sits a hair higher), so a row is a bucket rather than one exact top.
    rows: [...new Set(tabs.filter((tab) => tab.id !== 'launcher-tab').map((tab) => Math.round(tab.getBoundingClientRect().top / 8)))],
    page: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      scrollY: window.scrollY,
    },
  };
})())`;

/** One browser, one page, however many viewports `body` asks for — and everything shut down after,
 *  pass or fail. Without a browser the test is skipped by name (never silently green). */
async function measure(t, body) {
  const chrome = chromePath();
  if (!chrome) {
    t.skip('no chrome to measure with: set CHROME to a chromium binary');
    return;
  }
  const bus = await stubBus(built());
  const browser = await startChrome(chrome);
  const { send, close } = await openPage(browser.page.webSocketDebuggerUrl);
  const url = `http://127.0.0.1:${bus.port}/`;

  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (reply.result?.exceptionDetails) {
      throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 400));
    }
    return JSON.parse(reply.result.result.value);
  };

  /** The page at one viewport, painted from /panels — and every card on the launcher picked, because a
   *  page reaches the bar only when a reader picks its card, and what this file measures is the bar with
   *  all of them on it. The launcher's own tab is always the first of the main group. */
  const look = async (width, height = 740) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 640,
    });
    await send('Page.navigate', { url });
    // The page asks /panels and paints the launcher from the answer, so one moment has to pass.
    await new Promise((resolve) => setTimeout(resolve, 800));
    await evaluate(`JSON.stringify((() => {
      for (const card of document.querySelectorAll('.launcher .card')) card.click();
      return { tabs: document.querySelectorAll('#nav .tab').length };
    })())`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return evaluate(READ);
  };

  try {
    await body({ look, evaluate, bus });
  } finally {
    close();
    browser.chrome.kill('SIGKILL');
    bus.server.closeAllConnections();
    bus.server.close();
  }
}

/** One tab per page, and no page twice: a duplicated tab is a page that cannot be picked from the one
 *  place a reader looks. The bar reads: the resident page (the agent, and the only tab the left column
 *  ever has), the seam, then `launcher` and the main area's pages — the launcher first in its group,
 *  whatever the reader has opened since. Checked at both widths, because the two shapes share the markup. */
function assertOneTabPerPage(seen, names) {
  const bar = [names[0], ...names.slice(1), 'launcher'];
  assert.equal(seen.tabs.length, bar.length, `the bar has ${seen.tabs.length} tabs for ${bar.length} pages`);
  assert.deepEqual(seen.tabs.map((tab) => tab.text), bar, 'and one each, in the order they were opened');
  assert.equal(new Set(seen.tabs.map((tab) => tab.text)).size, bar.length, 'no page is on the bar twice');
}

/** aria-selected says what the `on` class draws, and every tab stays in the tab order — a tab taken out
 *  of it cannot be reached with a keyboard. */
function assertTabsAreTabs(seen) {
  for (const tab of seen.tabs) {
    assert.equal(tab.role, 'tab', 'a tab is a tab');
    assert.ok(tab.tabIndex >= 0, `“${tab.text}” left the tab order`);
    assert.ok(tab.selected === 'true' || tab.selected === 'false', 'and says whether it is chosen');
  }
  assert.equal(seen.tabs.filter((tab) => tab.selected === 'true').length, seen.navs, 'one chosen tab per group');
}

// ---- the stylesheet: two shapes, one breakpoint, one markup -------------------------------------
test('test_the_bar_has_two_shapes_over_one_breakpoint', () => {
  const html = built();

  // ONE bar, ONE seam, TWO groups: the two shapes are the same DOM under another media query.
  assert.equal((html.match(/class="tabs"/g) ?? []).length, 1, 'the page carries one bar');
  assert.equal((html.match(/<nav id="pinned-nav"/g) ?? []).length, 1, 'and one left group');
  assert.equal((html.match(/<nav id="nav"/g) ?? []).length, 1, 'and one right group');
  assert.equal((html.match(/class="sep"/g) ?? []).length, 1, 'and one seam');
  const markup = /<div class="tabs"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(markup, 'the bar is one container');
  const order = markup[1].indexOf('id="pinned-nav"');
  const seam = markup[1].indexOf('class="sep"');
  const rest = markup[1].indexOf('id="nav"');
  assert.ok(order >= 0 && seam > order && rest > seam, 'pinned-nav, then the seam, then nav');

  // The bar is THREE parts: the strips (the agent's and the pages'), which scroll, and the launcher,
  // which is beside them and never scrolls. Two tracks at every width, and only the first one moves.
  const bar = /\.tabs \{([^}]*)\}/.exec(html);
  assert.ok(bar, 'the bar needs its own rule');
  assert.match(bar[1], /display:\s*grid/, 'the bar is a grid of two tracks');
  assert.match(
    bar[1],
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    'everything that can scroll, then the launcher at its own width',
  );
  assert.doesNotMatch(bar[1], /overflow/, 'the bar itself is never a scroller');

  // The WIDE shape of the part that scrolls: the left strip is the width of the column under it, a
  // 1px track for the seam (so the right strip starts exactly where the main area's frame starts).
  const strips = /\.strips \{([^}]*)\}/.exec(html);
  assert.ok(strips, 'the strips need their own rule');
  assert.match(strips[1], /display:\s*grid/, 'a wide screen puts each group over its own column');
  assert.match(
    strips[1],
    /grid-template-columns:\s*var\(--left\)\s+1px\s+minmax\(0,\s*1fr\)/,
    'the left strip is as wide as the left column, then a hairline track, then the rest',
  );
  assert.doesNotMatch(strips[1], /overflow/, 'the wide strips are not a scroller themselves');
  assert.match(html, /#pinned-nav \{\s*grid-column:\s*1;/, 'the left group sits in the first track');
  assert.match(html, /#nav \{\s*grid-column:\s*3;/, 'and the right group past the seam’s track');
  assert.match(
    html,
    /\.tabs > \.tab\.launcher \{[^}]*grid-column:\s*2;/,
    'the launcher is the bar’s second track, outside the strips',
  );

  // Each group on a wide screen is a container AND a scroller of its own: a strip holding more tabs
  // than its column has room for scrolls in place, so the last tab is reachable without moving the
  // other column or the page.
  const group = /\.tabs nav \{([^}]*)\}/.exec(html);
  assert.ok(group, 'a group of tabs needs its own rule');
  assert.match(group[1], /min-width:\s*0/, 'a group may be narrower than its longest name');
  assert.match(group[1], /overflow-x:\s*auto/, 'and scrolls sideways when its tabs do not fit');
  assert.match(group[1], /overflow-y:\s*hidden/, 'never vertically: a strip is one row tall');
  assert.match(group[1], /scrollbar-width:\s*thin/, 'with a thin scroller, not a second row');

  // The seam belongs to the one-row shape, so on a wide screen it is not drawn at all.
  const sep = /^ {6}\.sep \{([^}]*)\}/m.exec(html);
  assert.ok(sep, 'the seam needs its own rule');
  assert.match(sep[1], /display:\s*none/, 'the wide shape draws no seam');
  assert.match(sep[1], /width:\s*1px/, 'and the narrow one draws a hairline, not a tab-sized box');

  // ONE breakpoint in the page, and it is the one the two columns already use: the bar turns into the
  // single scroller inside the same block that puts the columns in one box.
  assert.equal((html.match(/@media/g) ?? []).length, 2, 'the page names two media queries: narrow and phone');
  const start = html.indexOf(NARROW);
  assert.ok(start > 0, 'the bar switches on the query the columns use');
  assert.equal(html.indexOf('@media'), start, 'and it is the first of them: the bar cannot switch later than the columns');
  const narrow = html.slice(start, html.indexOf('@media (max-width: 640px)', start));
  const barNarrow = /\.strips \{([^}]*)\}/.exec(narrow);
  assert.ok(barNarrow, 'the narrow block re-lays the SAME strips out');
  assert.match(barNarrow[1], /display:\s*flex/, 'one row of tabs');
  assert.match(barNarrow[1], /flex-wrap:\s*nowrap/, 'that never folds onto a second row');
  assert.match(barNarrow[1], /overflow-x:\s*auto/, 'and is the one thing that scrolls sideways');
  assert.match(barNarrow[1], /overflow-y:\s*hidden/, 'never vertically: a bar is one row tall');
  assert.match(barNarrow[1], /-webkit-overflow-scrolling:\s*touch/, 'a phone scrolls it with a thumb');
  const groupNarrow = /\.tabs nav \{([^}]*)\}/.exec(narrow);
  assert.ok(groupNarrow, 'the narrow block says what a group is');
  assert.match(groupNarrow[1], /overflow:\s*visible/, 'a group is not a container of its own on a phone');
  assert.match(groupNarrow[1], /flex:\s*none/, 'a group keeps its width so a long name widens the bar');
  const sepNarrow = /^ {8}\.sep \{([^}]*)\}/m.exec(narrow);
  assert.match(sepNarrow[1], /display:\s*block/, 'and the seam is drawn between the two groups');

  // Exactly two rules scroll sideways: a wide strip (its own tabs) and the narrow bar (both groups).
  const sideways = [...html.matchAll(/overflow-x:\s*(auto|scroll)/g)];
  assert.equal(sideways.length, 2, `two rules may scroll sideways, found ${sideways.length}`);
  assert.ok(sideways[0].index < start, 'the first is a wide strip’s own scroller');
  assert.ok(narrow.includes(sideways[1][0]), 'the second is the one-row shape’s');

  // Every tab keeps its own width and one line, in both shapes.
  const button = /.tab \{([^}]*)\}/.exec(html);
  assert.ok(button, 'a tab needs its own rule');
  assert.match(button[1], /flex:\s*none/, 'a tab is as wide as its name, never narrower');
  assert.match(button[1], /white-space:\s*nowrap/, 'a name is one line');
});
// ---- ① a phone: ONE scroller, the seam drawn, and the chosen tab in view ------------------------
test('test_a_phone_has_one_scrolling_row_a_seam_and_the_chosen_tab_in_view', { timeout: 90000 }, async (t) => {
  await measure(t, async ({ look, evaluate }) => {
    const phone = await look(360, 740);

    // ① ONE row, and ONE box that scrolls: every strip tab reaches sideways through `.strips` and
    // nothing else. The bar around it is the fixed third part's frame and does not scroll at all.
    assert.equal(phone.bars, 1, 'the shell has one bar');
    assert.equal(phone.navs, 2, 'holding the two groups of tabs');
    assert.deepEqual(phone.parts, ['strips', 'launcher-tab'], 'the bar is the strips and the launcher');
    assert.equal(phone.strips.display, 'flex', 'the strips are one row of tabs');
    assert.equal(phone.strips.flexWrap, 'nowrap', 'and never fold onto a second row');
    assert.equal(phone.strips.overflowX, 'auto', 'the strips are the thing that scrolls sideways');
    assert.equal(phone.strips.overflowY, 'hidden', 'and never vertically: a bar is one row tall');
    assert.equal(phone.bar.overflowX, 'visible', 'the bar itself does not scroll');
    assert.ok(
      phone.bar.scrollWidth <= phone.bar.clientWidth + 1,
      `the bar holds everything it shows: ${phone.bar.scrollWidth} > ${phone.bar.clientWidth}`,
    );
    for (const tab of phone.tabs.filter((tab) => tab.text !== 'launcher'))
      assert.deepEqual(
        tab.scrollers,
        ['strips'],
        `“${tab.text}” must scroll through the strips and nothing else: ${tab.scrollers}`,
      );
    // The launcher is not in that scroller at all: no wheel, no drag and no key can move it.
    assert.deepEqual(phone.launcher && [phone.launcher.left >= 0], [true], 'the launcher has its own box');
    assert.ok(phone.strips.scrollWidth > phone.strips.clientWidth, 'five tabs must overflow a phone, or nothing here is tested');
    assert.ok(phone.page.scrollWidth <= phone.page.clientWidth, 'the page itself does not scroll sideways');

    // The seam IS drawn here, and it sits between the two groups — an element between the last left tab
    // and the first right tab, not a second row.
    assert.ok(phone.sep, 'a phone has a seam');
    assert.ok(phone.sep.laidOut, 'and it is laid out');
    assert.equal(phone.sep.display, 'block', 'as a line, not a tab');
    assert.ok(phone.sep.width <= 2 && phone.sep.height > 0, `the seam is a hairline: ${phone.sep.width}x${phone.sep.height}`);
    assert.ok(phone.sep.height < phone.bar.height, 'the seam is shorter than the bar: it is not a second row');
    assert.ok(phone.sep.left >= phone.groups.left.right - 1, 'the seam is right of the left column’s tab');
    assert.ok(phone.sep.right <= phone.groups.right.left + 1, 'and left of the main area’s tabs');

    // One row, every tab a thumb target with one line, nothing squeezed into a column of letters.
    assert.equal(phone.rows.length, 1, `the tabs sit on ${phone.rows.length} rows`);
    for (const tab of phone.tabs) {
      assert.equal(tab.whiteSpace, 'nowrap', `“${tab.text}” may not wrap`);
      assert.ok(tab.height >= TOUCH_TARGET, `“${tab.text}” is smaller than a thumb target: ${tab.height}px`);
      assert.ok(tab.height <= 60, `“${tab.text}” was squeezed into a column: ${tab.height}px tall`);
    }

    // ③ The chosen tab is brought into view: the strips move to reach it, and only they move.
    const scrolled = await look(360, 740);
    const moved = await evaluate(`JSON.stringify((() => {
      const bar = document.getElementById('strips');
      const last = [...document.querySelectorAll('#nav .tab')].at(-1);
      last.click();
      const b = bar.getBoundingClientRect();
      const r = last.getBoundingClientRect();
      return {
        name: last.querySelector('.label')?.textContent.trim() ?? '',
        selected: last.getAttribute('aria-selected'),
        barLeft: Math.round(bar.scrollLeft),
        visible: r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
        pageScrollY: window.scrollY,
      };
    })())`);
    assert.equal(moved.name, NAMES.at(-1), 'the last tab was chosen');
    assert.equal(moved.selected, 'true', 'and it is the chosen one');
    assert.ok(moved.barLeft > 0, 'the bar scrolled to reach it');
    assert.ok(moved.visible, 'the chosen tab is inside the bar’s box');
    assert.equal(moved.pageScrollY, 0, 'and the shell itself did not move');

    // ④ One tab per page on this narrow bar too, and the tab order is the bar’s order.
    assertOneTabPerPage(scrolled, NAMES);
    assertTabsAreTabs(scrolled);
  });
});

// ---- ② a desktop: TWO strips, one over each column, scrolling only inside a strip ---------------
test('test_a_wide_screen_has_one_strip_over_each_column_and_each_strip_scrolls', { timeout: 90000 }, async (t) => {
  await measure(t, async ({ look, evaluate }) => {
    const desktop = await look(1100, 800);

    // Same markup, other shape: one bar in the DOM, two groups in it.
    assert.equal(desktop.bars, 1, 'a wide screen has the same ONE bar');
    assert.equal(desktop.navs, 2, 'with the same two groups of tabs');
    assert.equal(desktop.bar.display, 'grid', 'each group in its own track, over its own column');
    assert.equal(desktop.bar.overflowX, 'visible', 'the wide bar is not a scroller');

    // ② TWO containers, one per group: every tab belongs to its own strip, and to nothing else. The
    // left strip holds one tab and always will — the resident page — so the split is after the first.
    const left = desktop.tabs.slice(0, 1);
    const right = desktop.tabs.slice(1).filter((tab) => tab.text !== 'launcher');
    const home = desktop.tabs.find((tab) => tab.text === 'launcher');
    assert.ok(home, 'the launcher is on the bar');
    assert.deepEqual(home.containers, [], 'and outside every strip: it is the bar’s own third part');
    assert.ok(home.left >= desktop.groups.right.right - 1, 'to the right of the last strip');
    for (const tab of left) {
      assert.deepEqual(tab.containers, ['pinned-nav'], `the left group is not its own container for “${tab.text}”`);
      assert.deepEqual(tab.scrollers, ['pinned-nav'], `the left strip is not its own scroller for “${tab.text}”`);
    }
    for (const tab of right) {
      assert.deepEqual(tab.containers, ['nav'], `the main group is not its own container for “${tab.text}”`);
      assert.deepEqual(tab.scrollers, ['nav'], `the main strip is not its own scroller for “${tab.text}”`);
    }
    assert.notDeepEqual(left[0].containers, right[0].containers, 'the two groups do not share a container');

    // Each strip is over its own column, and no wider or narrower than it.
    const { aside, side } = desktop.columns;
    const groups = desktop.groups;
    assert.equal(groups.left.top, groups.right.top, 'both strips on the same row');
    assert.ok(groups.left.right <= groups.right.left, 'the left strip ends where the main strip begins');
    assert.ok(
      Math.abs(groups.left.left - aside.left) <= 1 && Math.abs(groups.left.right - aside.right) <= 1,
      `the left strip (${groups.left.left}–${groups.left.right}) is not over its column (${aside.left}–${aside.right})`,
    );
    // The main strip starts where its column starts, as it always did; it ends where the launcher
    // begins — the bar’s third part takes its width out of the strip, never out of the column.
    assert.ok(
      Math.abs(groups.right.left - side.left) <= 1 && groups.right.right <= side.right,
      `the main strip (${groups.right.left}–${groups.right.right}) is not over its column (${side.left}–${side.right})`,
    );
    assert.ok(home.left >= groups.right.right - 1, 'the launcher takes the rest of the bar');
    assert.equal(desktop.rows.length, 1, `the strips put the tabs on ${desktop.rows.length} rows`);
    for (const tab of desktop.tabs) assert.equal(tab.whiteSpace, 'nowrap', `“${tab.text}” may not wrap`);

    // The seam is NOT drawn: the two columns already say where one group's pages end.
    assert.equal(desktop.sep.display, 'none', 'a wide screen draws no seam');
    assert.equal(desktop.sep.laidOut, false, 'and the seam takes no room at all');

    // The bar itself never scrolls (the strips do), and the page is exactly as wide as the window.
    assert.ok(desktop.page.scrollWidth <= desktop.page.clientWidth, 'the page is no wider than the window');
    assert.ok(desktop.bar.scrollWidth <= desktop.bar.clientWidth, 'the bar fits its tabs');

    // ③ With eight short names everything fits, so nothing is revealed and nothing moves.
    const calls = await evaluate(`JSON.stringify((() => {
      window.__revealed = [];
      Element.prototype.scrollIntoView = function (options) {
        window.__revealed.push({ text: this.querySelector('.label')?.textContent.trim() ?? '', options: options || null });
      };
      const last = [...document.querySelectorAll('#nav .tab')].at(-1);
      last.click();
      return { clicked: last.querySelector('.label')?.textContent.trim() ?? '', calls: window.__revealed };
    })())`);
    assert.equal(calls.clicked, NAMES.at(-1), 'the last tab was chosen');
    assert.deepEqual(calls.calls, [], 'when the strips fit, there is nothing to scroll into view');

    const scrolled = await look(1100, 800);
    const after = await evaluate(`JSON.stringify((() => {
      const bar = document.getElementById('strips');
      const last = [...document.querySelectorAll('#nav .tab')].at(-1);
      last.click();
      const group = last.closest('nav');
      const b = group.getBoundingClientRect();
      const r = last.getBoundingClientRect();
      return {
        name: last.querySelector('.label')?.textContent.trim() ?? '',
        selected: last.getAttribute('aria-selected'),
        barLeft: Math.round(bar.scrollLeft),
        groupLeft: Math.round(group.scrollLeft),
        visible: r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
        pageScrollY: window.scrollY,
      };
    })())`);
    assert.equal(after.selected, 'true', 'the chosen tab says so');
    assert.ok(after.visible, 'the chosen tab is inside its strip without anything scrolling');
    assert.equal(after.barLeft, 0, 'the bar did not scroll');
    assert.equal(after.groupLeft, 0, 'and neither did the strip');
    assert.equal(after.pageScrollY, 0, 'nor the shell');

    // ④ One tab per page, in two groups, all of them still in the tab order.
    assertOneTabPerPage(scrolled, NAMES);
    assertTabsAreTabs(scrolled);
  });
});

// ---- many tabs in one column: the strip scrolls to the last one, without moving the page ----------
test('test_a_wide_strip_scrolls_to_its_last_tab', { timeout: 90000 }, async (t) => {
  await measure(t, async ({ look, bus, evaluate }) => {
    bus.use(MANY_NAMES);
    await look(1100, 800);
    const result = await evaluate(`JSON.stringify((() => {
      const group = document.querySelector('#nav');
      const last = [...group.querySelectorAll('.tab')].at(-1);
      last.click();
      const b = group.getBoundingClientRect();
      const r = last.getBoundingClientRect();
      return {
        name: last.querySelector('.label')?.textContent.trim() ?? '',
        selected: last.getAttribute('aria-selected'),
        groupLeft: Math.round(group.scrollLeft),
        barLeft: Math.round(document.querySelector('.tabs').scrollLeft),
        pageScrollY: window.scrollY,
        visible: r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
      };
    })())`);
    assert.equal(result.name, MANY_NAMES.at(-1), 'the last tab of the main column was chosen');
    assert.equal(result.selected, 'true', 'and it says it is chosen');
    assert.ok(result.visible, 'the chosen tab is inside its own strip');
    assert.ok(result.groupLeft > 0, 'and the strip itself scrolled to reach it');
    assert.equal(result.pageScrollY, 0, 'the page itself did not move');
    assert.equal(result.barLeft, 0, 'the other column did not move');
  });
});

// ---- a name too long for its column: one row, reachable by scrolling that strip -------------------
test('test_a_long_name_keeps_one_row_and_is_reachable_in_its_strip', { timeout: 90000 }, async (t) => {
  await measure(t, async ({ look, bus }) => {
    bus.use(LONG_NAMES);
    const wide = await look(1100, 800);

    assert.equal(wide.bars, 1, 'still one bar');
    assert.equal(wide.bar.display, 'grid', 'still two strips');
    // A long name may not widen its column: each strip is still exactly the width of the column under it.
    assert.ok(
      Math.abs(wide.groups.left.width - wide.columns.aside.width) <= 1,
      `the left strip widened to ${wide.groups.left.width} over a ${wide.columns.aside.width}px column`,
    );
    // The main strip starts where its column starts and ends where the launcher begins: the bar's
    // third part takes its width out of the strip, never out of the column or the frame.
    assert.ok(
      Math.abs(wide.groups.right.left - wide.columns.side.left) <= 1 &&
        wide.groups.right.right <= wide.columns.side.right,
      `the main strip (${wide.groups.right.left}–${wide.groups.right.right}) left its column (${wide.columns.side.left}–${wide.columns.side.right})`,
    );
    assert.ok(wide.page.scrollWidth <= wide.page.clientWidth, 'the page is no wider than the window');
    assert.equal(wide.rows.length, 1, 'and no name started a second row');
    for (const tab of wide.tabs) {
      assert.equal(tab.whiteSpace, 'nowrap', `“${tab.text}” may not wrap`);
      assert.ok(tab.height <= 60, `“${tab.text}” wrapped onto a second line: ${tab.height}px tall`);
    }

    // The long ones really are longer than their column, and the strip SCROLLS to them: one row,
    // reachable. (They are the main area's: the left strip holds the resident page's short name.)
    assert.ok(
      wide.groups.right.scrollWidth > wide.groups.right.clientWidth,
      'the long names have to overflow their column, or nothing here is tested',
    );
    assert.equal(wide.groups.right.overflowX, 'auto', 'the strip scrolls what does not fit');
    for (const tab of wide.tabs.filter((tab) => tab.text !== 'launcher'))
      assert.deepEqual(tab.scrollers, [tab.containers[0]], `“${tab.text}” is not in its strip scroller: ${tab.scrollers}`);
    // The launcher is in no scroller at all: no strip, and no bar, can move it.
    const home = wide.tabs.find((tab) => tab.text === 'launcher');
    assert.deepEqual(home.scrollers, [], 'the launcher has no scroller above it');
  });
});

// ---- the same DOM at both widths: one tab per page, no page twice ---------------------------------
test('test_the_bar_is_the_same_markup_at_both_widths', { timeout: 90000 }, async (t) => {
  await measure(t, async ({ look }) => {
    const phone = await look(360, 740);
    const desktop = await look(1100, 800);

    for (const [name, seen] of [
      ['phone', phone],
      ['desktop', desktop],
    ]) {
      assert.equal(seen.bars, 1, `${name}: one bar`);
      assert.equal(seen.navs, 2, `${name}: two groups`);
      // ④ The same pages, each exactly once — no page is on the bar twice in either shape.
      assertOneTabPerPage(seen, NAMES);
      assertTabsAreTabs(seen);
    }
    assert.deepEqual(
      phone.tabs.map((tab) => tab.text),
      desktop.tabs.map((tab) => tab.text),
      'both widths show the same tabs in the same order',
    );
    assert.deepEqual(
      phone.tabs.map((tab) => tab.role),
      desktop.tabs.map((tab) => tab.role),
      'and the same roles',
    );
  });
});
