import { serveEventAssets } from './browser.mjs';
// The main area's bar opens on a launcher — the way a desktop's Launchpad is one — and a node's page
// becomes a tab only when a reader picks its card. Six things are easy to lose in that and impossible
// to notice by reading the page: that nothing opens by itself, that a card picked twice is one page and
// not two, that the x closes a page and leaves a sensible one chosen, that the launcher is the one tab
// no reader can close, and that a node joining the bus gets a card rather than a tab.
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
const ROOT = new URL('../../../../', import.meta.url);

//: The page as served, and the page as written.
const BUILT = 'node_agent/nodes/webui/dist/webui.html';
const SOURCE = 'node_agent/nodes/webui/src/webui.html';

//: The resident node — the one name the shell knows — and three pages beside it: enough that a tab can
//: be closed with a neighbour on either side of it.
const RESIDENT = 'agent';
const NAMES = ['search', 'notes', 'timer'];

//: The drawing every node hands over, so a card and a tab have something to show. Deliberately the
//: same for all three: nothing here is about which node draws what.
const ICON =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='9'/></svg>";

/** The build product, checked to be the page as written: a stale dist/ would be yesterday's bar. */
function built() {
  const dist = readFileSync(new URL(BUILT, ROOT), 'utf8');
  assert.equal(
    dist,
    readFileSync(new URL(SOURCE, ROOT), 'utf8'),
    'dist/webui.html is not src/webui.html: run `npm run build` before the tests',
  );
  return dist;
}

/** A stub bus: the shell at /, its page list at /panels, one page per node at /panel/<node>, and an
 *  open event stream at /events. It counts the pages it was asked for — the shell fetches a page when a
 *  card is picked and at no other time — and `announce` is the bus saying "the node list changed", the
 *  one path by which a card may appear while the reader does nothing. */
async function stubBus(html, names) {
  let listed = names;
  const pages = []; // every /panel/<node> the browser asked for, in order
  const streams = new Set();
  const server = createServer((req, res) => {
    if (serveEventAssets(req, res)) return;
    const url = req.url ?? '/';
    if (url === '/panels') {
      const panels = listed.map((entry) => {
        const node = typeof entry === 'string' ? entry : entry.node;
        return {
          node,
          desc: `a page about ${node}`,
          // A page that still asks for a column: the shell is supposed to ignore it. `notes` asks for
          // the left one and has to end up a card and a right-hand tab like every other page.
          slot: node === 'notes' ? 'left' : 'right',
          icon: ICON,
          // A node that publishes display names, as a manifest's `labels.node` arrives here.
          ...(typeof entry === 'string' || entry.names === undefined ? {} : { names: entry.names }),
        };
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ panels }));
      return;
    }
    if (url.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': open\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (url.startsWith('/panel/')) {
      const node = decodeURIComponent(url.slice('/panel/'.length));
      pages.push(node);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${node}</title><p>the ${node} page</p>`);
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
  return {
    server,
    port: server.address().port,
    pages,
    use: (list) => (listed = list),
    /** The bus saying the node list changed: one data line on every open stream. */
    announce: () => {
      for (const stream of streams) stream.write('data: {"node":"bus","topic":"nodes","from":"bus","value":{}}\n\n');
    },
  };
}

/** The page as the browser has it: the bar's tabs (the launcher included), the launcher's cards, and
 *  what the main area is showing. `frame.src` is the attribute the shell wrote, which is what says
 *  whether a page was asked for at all. */
const READ = `JSON.stringify((() => {
  const frame = document.getElementById('view');
  const launcher = document.getElementById('launcher');
  return {
    tabs: [...document.querySelectorAll('#nav .tab')].map((tab) => ({
      node: tab.dataset.node || 'launcher',
      text: tab.querySelector('.label')?.textContent.trim() ?? '',
      label: tab.getAttribute('aria-label') ?? null,
      glyph: !!tab.querySelector('.ico'),
      selected: tab.getAttribute('aria-selected'),
      on: tab.classList.contains('on'),
      role: tab.getAttribute('role'),
      tabIndex: tab.tabIndex,
      closable: !!tab.querySelector('.close'),
      closeLabel: tab.querySelector('.close')?.getAttribute('aria-label') ?? null,
    })),
    cards: [...document.querySelectorAll('.launcher .card')].map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        node: card.dataset.node,
        open: card.classList.contains('on'),
        tag: card.tagName,
        name: card.querySelector('.name')?.textContent.trim() ?? '',
        tile: !!card.querySelector('.tile'),
        icon: !!card.querySelector('.tile .ico img'),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }),
    page: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    },
    launcher: { hidden: launcher.hidden, laidOut: launcher.getClientRects().length > 0 },
    // The bar's third part: a fixed tab outside the scroller, at the right edge of the bar.
    launcherTab: (() => {
      const tab = document.getElementById('launcher-tab');
      const rect = tab.getBoundingClientRect();
      const bar = document.getElementById('tabs').getBoundingClientRect();
      return {
        text: tab.querySelector('.label')?.textContent.trim() ?? '',
        label: tab.getAttribute('aria-label'),
        glyph: !!tab.querySelector('.ico'),
        selected: tab.getAttribute('aria-selected'),
        on: tab.classList.contains('on'),
        role: tab.getAttribute('role'),
        tabIndex: tab.tabIndex,
        closable: !!tab.querySelector('.close'),
        childOfTabs: tab.parentElement?.id === 'tabs',
        right: Math.round(rect.right),
        left: Math.round(rect.left),
        barRight: Math.round(bar.right),
      };
    })(),
    // The bar's three parts, in order, and the scroller the first two live in.
    parts: [...document.getElementById('tabs').children].map((el) => el.id || el.className),
    strips: {
      inStrips: [
        document.getElementById('pinned-nav').parentElement?.id ?? '',
        document.getElementById('nav').parentElement?.id ?? '',
      ],
      overflowX: getComputedStyle(document.getElementById('strips')).overflowX,
      scrollLeft: Math.round(document.getElementById('strips').scrollLeft),
      scrollWidth: document.getElementById('strips').scrollWidth,
      clientWidth: document.getElementById('strips').clientWidth,
    },
    frame: {
      hidden: frame.hidden,
      laidOut: frame.getClientRects().length > 0,
      src: frame.getAttribute('src'),
    },
    // The left column: the resident page's tab, and the frame it is in.
    left: [...document.querySelectorAll('#pinned-nav .tab')].map((tab) => ({
      node: tab.dataset.node,
      text: tab.querySelector('.label')?.textContent.trim() ?? '',
      selected: tab.getAttribute('aria-selected'),
      on: tab.classList.contains('on'),
      closable: !!tab.querySelector('.close'),
    })),
    pinned: {
      off: document.getElementById('pinned').classList.contains('off'),
      laidOut: document.getElementById('pinned-view').getClientRects().length > 0,
      src: document.getElementById('pinned-view').getAttribute('src'),
    },
    empty: document.getElementById('launcher-empty').hidden,
  };
})())`;

/** One browser, one page, however many looks `body` asks for — and everything shut down after, pass or
 *  fail. Without a browser the test is skipped by name (never silently green). */
async function measure(t, body, options = {}) {
  const chrome = chromePath();
  if (!chrome) {
    t.skip('no chrome to measure with: set CHROME to a chromium binary');
    return;
  }
  const bus = await stubBus(options.html ?? built(), options.listed ?? [RESIDENT, ...NAMES]);
  const browser = await startChrome(chrome);
  const { send, close } = await openPage(browser.page.webSocketDebuggerUrl);
  const url = `http://127.0.0.1:${bus.port}/`;

  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (reply.result?.exceptionDetails) {
      throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 600));
    }
    return JSON.parse(reply.result.result.value);
  };

  const pause = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The page at one viewport, painted from /panels. */
  const look = async (width = 1100, height = 800) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 640,
    });
    await send('Page.navigate', { url });
    // The page asks /panels and paints the launcher from the answer, so one moment has to pass.
    await pause(800);
    return evaluate(READ);
  };

  /** Picking a card, the way a reader does: the click is the card's own. */
  const card = async (node) => {
    const clicked = await evaluate(`JSON.stringify((() => {
      const card = [...document.querySelectorAll('.launcher .card')].find((c) => c.dataset.node === ${JSON.stringify(node)});
      if (!card) return { clicked: false };
      card.click();
      return { clicked: true };
    })())`);
    assert.ok(clicked.clicked, `there is a card for "${node}"`);
    await pause();
    return evaluate(READ);
  };

  /** Clicking a tab on the bar: a node's tab in the strips, or the launcher's own tab at the end. */
  const tab = async (node) => {
    const clicked = await evaluate(`JSON.stringify((() => {
      const tab = ${JSON.stringify(node)} === 'launcher'
        ? document.getElementById('launcher-tab')
        : [...document.querySelectorAll('#nav .tab')].find((t) => t.dataset.node === ${JSON.stringify(node)});
      if (!tab) return { clicked: false };
      tab.click();
      return { clicked: true };
    })())`);
    assert.ok(clicked.clicked, `there is a tab for "${node}"`);
    await pause();
    return evaluate(READ);
  };

  /** The x on a tab, by the node's name. */
  const closeTab = async (node) => {
    const clicked = await evaluate(`JSON.stringify((() => {
      const tab = [...document.querySelectorAll('#nav .tab')].find((t) => t.dataset.node === ${JSON.stringify(node)});
      const close = tab?.querySelector('.close');
      if (!close) return { clicked: false };
      close.click();
      return { clicked: true };
    })())`);
    assert.ok(clicked.clicked, `"${node}" has an x to click`);
    await pause();
    return evaluate(READ);
  };

  try {
    await body({ look, card, tab, closeTab, evaluate, pause, bus });
  } finally {
    close();
    browser.chrome.kill('SIGKILL');
    bus.server.closeAllConnections();
    bus.server.close();
  }
}

/** The bar's tabs, in order, as `launcher` and node names: the one place the order is read from. */
const order = (seen) => seen.tabs.map((tab) => tab.node);

/** Exactly one tab says it is the chosen one, and it is the one that is drawn as chosen. */
function assertOneChosen(seen, node) {
  // The launcher lives outside the strips (it is the bar's fixed third part), so it is checked on its
  // own; every node tab must then be off, and only one of them may be on when a page is chosen.
  if (node === 'launcher') {
    assert.equal(seen.launcherTab.selected, 'true', 'the launcher tab says it is chosen');
    assert.equal(seen.launcherTab.on, true, 'and is drawn as chosen');
    for (const tab of seen.tabs) {
      assert.equal(tab.on, false, `"${tab.node}" is not drawn as chosen`);
      assert.equal(tab.selected, 'false', `"${tab.node}" does not claim to be chosen`);
    }
    return;
  }
  assert.equal(seen.launcherTab.on, false, 'the launcher is not drawn as chosen');
  assert.equal(seen.launcherTab.selected, 'false', 'and does not claim to be');
  const chosen = seen.tabs.filter((tab) => tab.selected === 'true');
  assert.equal(
    chosen.length,
    1,
    `one tab is chosen, not ${chosen.length}: ${order(seen).join(', ')}`,
  );
  assert.equal(chosen[0].node, node, `"${node}" is the chosen tab`);
  assert.equal(chosen[0].on, true, 'and the one the border is drawn on');
  for (const tab of seen.tabs) {
    assert.equal(tab.role, 'tab', `"${tab.node}" is a tab to a reader`);
    assert.ok(tab.tabIndex >= 0, `"${tab.node}" stays in the tab order`);
    if (tab.node !== node) assert.equal(tab.on, false, `"${tab.node}" is not drawn as chosen`);
  }
}

// ---- ① nothing opens by itself ---------------------------------------------------------------
test('a card shows the display name its node publishes, in the language of the visit', async (t) => {
  // webui writes the language of the visit into the shell; the card reads its node's label from
  // /panels. The canonical name never changes: the card is found, clicked and opened by it.
  const shell = built().replace(
    '<!-- node-agent:i18n -->',
    '<script>window.__NODE_AGENT_LANGUAGE__ = "zh-CN";</script>',
  );
  await measure(
    t,
    async ({ look, card, bus }) => {
      const seen = await look(1100, 800);
      const before = seen.cards.find((one) => one.node === 'notes');
      assert.equal(before.name, '笔记', 'the card says what the manifest says, in this language');

      const opened = await card('notes');
      assert.deepEqual(
        bus.pages,
        [RESIDENT, 'notes'],
        'the page is still opened by the canonical name',
      );
      assert.equal(opened.tabs.find((one) => one.node === 'notes').text, '笔记');
    },
    {
      html: shell,
      listed: [RESIDENT, { node: 'notes', names: { en: 'Notes', 'zh-CN': '笔记' } }],
    },
  );
});

test(
  'test_the_shell_opens_on_the_launcher_and_no_page_is_opened_for_it',
  { timeout: 90000 },
  async (t) => {
    await measure(t, async ({ look, bus }) => {
      const seen = await look();

      // One page's worth of bar and none open: the launcher is the third part of the bar, not a tab in
      // the strips, and a shell that has just started has no page open at all.
      assert.deepEqual(order(seen), [], 'the main bar opens with no page on it');
      const home = seen.launcherTab;
      assert.equal(home.text, '', 'the launcher tab is a glyph, not a word');
      assert.ok(home.glyph, 'and the glyph is there to be seen');
      assert.equal(home.label, 'launcher', 'with its name kept for a reader who cannot see it');
      assert.equal(home.closable, false, 'the launcher tab has no x');
      assert.equal(home.role, 'tab', 'it is a tab to a reader');
      assert.ok(home.tabIndex >= 0, 'and stays in the tab order');
      assert.equal(home.childOfTabs, true, 'it is the bar’s own third part, outside the strips');
      assert.ok(
        Math.abs(home.right - home.barRight) <= 8,
        `the launcher sits at the right edge of the bar: ${home.right} vs ${home.barRight}`,
      );
      assertOneChosen(seen, 'launcher');

      // THREE parts, left to right: the agent's strip, the other pages' strip, the launcher. The first
      // two are inside the scroller; the launcher is beside it, so nothing can scroll it away.
      assert.deepEqual(
        seen.parts,
        ['strips', 'launcher-tab'],
        'the bar is the strips and the launcher',
      );
      assert.deepEqual(
        seen.strips.inStrips,
        ['strips', 'strips'],
        'both tab strips live in that scroller',
      );
      assert.equal(
        seen.strips.overflowX,
        'visible',
        'which on a wide screen scrolls nothing itself',
      );

      // The left column is the resident node's page: there without anybody opening it, and with no x.
      assert.deepEqual(
        seen.left.map((tab) => tab.node),
        [RESIDENT],
        'the left column is the resident page, and only it',
      );
      assert.equal(seen.left[0].closable, false, 'and that tab carries no x');
      assert.equal(
        seen.left[0].selected,
        'true',
        'it is the left column’s one page, always chosen',
      );
      assert.equal(seen.pinned.off, false, 'the left column is on screen');
      assert.ok(seen.pinned.laidOut, 'with its frame laid out');
      assert.equal(seen.pinned.src, `/panel/${RESIDENT}`, 'showing the resident node’s page');

      // Under the launcher, one card per node that has a page AND is not the resident one: the agent is
      // not a card, because it is already on screen. A picture and a name, like a Launchpad's tiles.
      assert.deepEqual(
        seen.cards.map((card) => card.node),
        NAMES,
        'the launcher shows every node with a page except the resident one',
      );
      for (const card of seen.cards) {
        assert.equal(card.tag, 'BUTTON', 'a card does one thing, so it is a button');
        assert.equal(card.name, card.node, 'and it carries the node’s name');
        assert.ok(card.tile, 'a card leads with a tile');
        assert.ok(card.icon, 'and the drawing the node handed over is on it');
        assert.equal(card.open, false, 'no card is open: no page is');
      }

      // The launcher is what is on screen, and the frame under it is not — and asked for no page.
      assert.equal(seen.launcher.hidden, false, 'the launcher is on screen');
      assert.ok(seen.launcher.laidOut, 'and it is laid out');
      assert.equal(seen.frame.hidden, true, 'the frame is hidden');
      assert.equal(seen.frame.laidOut, false, 'and takes no room');
      assert.equal(seen.frame.src, null, 'the frame was given no page to fetch');
      assert.deepEqual(bus.pages, [RESIDENT], 'the resident page, and no opened page at all');
    });
  },
);

// ---- ② a card is what opens a page ------------------------------------------------------------
test('test_a_card_opens_a_tab_and_chooses_it', { timeout: 90000 }, async (t) => {
  await measure(t, async ({ look, card, bus }) => {
    let seen = await look();

    seen = await card('notes');
    assert.deepEqual(order(seen), ['notes'], 'the page joins the bar after the launcher');
    assertOneChosen(seen, 'notes');
    assert.equal(seen.tabs[0].closable, true, 'a node’s tab carries an x');
    assert.equal(seen.tabs[0].closeLabel, 'Close notes', 'and says what that x closes');
    assert.equal(seen.launcher.hidden, true, 'the launcher gives up the screen');
    assert.equal(seen.frame.hidden, false, 'and the frame takes it');
    assert.ok(seen.frame.laidOut, 'the frame is on screen');
    assert.equal(seen.frame.src, '/panel/notes', 'with that node’s page');
    assert.deepEqual(
      bus.pages,
      [RESIDENT, 'notes'],
      'which was asked for once, when it was picked',
    );
    assert.equal(
      seen.cards.find((c) => c.node === 'notes').open,
      true,
      'the card says its page is open',
    );

    // A second card is a second tab, still one bar, still one chosen.
    seen = await card('timer');
    assert.deepEqual(
      order(seen),
      ['notes', 'timer'],
      'tabs sit in the order the reader opened them',
    );
    assertOneChosen(seen, 'timer');
    assert.equal(seen.frame.src, '/panel/timer', 'the frame follows the chosen tab');

    // Picking a page that is already open is a move, not a second tab.
    seen = await card('notes');
    assert.deepEqual(order(seen), ['notes', 'timer'], 'an open card adds no tab');
    assertOneChosen(seen, 'notes');
    assert.equal(seen.frame.src, '/panel/notes', 'and the frame comes back to it');
  });
});

// ---- ③ a card picked twice is one page, not two -----------------------------------------------
test(
  'test_a_card_already_open_is_brought_forward_and_not_opened_twice',
  { timeout: 90000 },
  async (t) => {
    await measure(t, async ({ look, card, tab, bus }) => {
      let seen = await look();

      seen = await card('search');
      seen = await card('search');
      assert.deepEqual(order(seen), ['search'], 'the second pick adds no second tab');
      assertOneChosen(seen, 'search');
      assert.deepEqual(
        bus.pages,
        [RESIDENT, 'search'],
        'and the page it had was not fetched again',
      );

      // Away to the launcher and back: the tab was never lost, and its page was not reloaded.
      seen = await tab('launcher');
      assert.deepEqual(order(seen), ['search'], 'the launcher is a view, not a cleanup');
      assert.equal(seen.frame.hidden, true, 'the frame steps aside');
      assertOneChosen(seen, 'launcher');

      seen = await card('search');
      assert.deepEqual(order(seen), ['search'], 'the card brings the same tab forward');
      assertOneChosen(seen, 'search');
      assert.deepEqual(
        bus.pages,
        [RESIDENT, 'search'],
        'the page it still held is not fetched again',
      );

      // Two pages, two tabs, and one chosen at a time: the bar never grows a second copy of a node.
      seen = await card('notes');
      seen = await tab('search');
      assert.deepEqual(order(seen), ['search', 'notes'], 'one tab per node, in opening order');
      assertOneChosen(seen, 'search');
      seen = await tab('notes');
      assertOneChosen(seen, 'notes');
    });
  },
);

// ---- ④ the x, and what is chosen once the chosen page is gone ---------------------------------
test(
  'test_the_x_closes_a_tab_and_the_chosen_one_falls_back_to_its_neighbour',
  { timeout: 90000 },
  async (t) => {
    await measure(t, async ({ look, card, closeTab }) => {
      let seen = await look();

      await card('search');
      await card('notes');
      seen = await card('timer');
      assert.deepEqual(order(seen), ['search', 'notes', 'timer'], 'three pages, three tabs');

      // Closing a page the reader is NOT looking at leaves the screen exactly as it was.
      seen = await closeTab('search');
      assert.deepEqual(order(seen), ['notes', 'timer'], 'the x takes its tab away');
      assertOneChosen(seen, 'timer');
      assert.equal(seen.frame.src, '/panel/timer', 'and what is on screen is untouched');

      // Closing the chosen page hands the screen to the tab that took its place — the one to its right.
      seen = await closeTab('timer');
      assert.deepEqual(order(seen), ['notes'], 'one tab fewer');
      assertOneChosen(seen, 'notes');
      assert.equal(seen.frame.src, '/panel/notes', 'the page on screen is the neighbour’s');

      // With nothing open to the right, the tab to the left takes over.
      await card('timer');
      await card('search');
      seen = await closeTab('search');
      assert.deepEqual(order(seen), ['notes', 'timer'], 'the last tab was the one closed');
      assertOneChosen(seen, 'timer');

      // And with no node tab left, the launcher is what is left — and the closed page is not still running.
      await closeTab('timer');
      seen = await closeTab('notes');
      assert.deepEqual(order(seen), [], 'the last node tab closed back to the launcher');
      assertOneChosen(seen, 'launcher');
      assert.equal(seen.launcher.hidden, false, 'the launcher is on screen again');
      assert.equal(seen.frame.hidden, true, 'and no page is');
      assert.equal(seen.frame.src, 'about:blank', 'the closed page is unloaded, not left running');
      for (const card of seen.cards) assert.equal(card.open, false, 'no card claims an open page');
    });
  },
);

// ---- ⑤ the launcher is the one tab no reader can close ----------------------------------------
test(
  'test_the_launcher_tab_is_fixed_at_the_right_and_cannot_be_closed',
  { timeout: 90000 },
  async (t) => {
    await measure(t, async ({ look, card, tab }) => {
      let seen = await look();

      seen = await card('notes');
      seen = await card('timer');
      // However many pages the reader opens, the launcher keeps its one place: the bar's third part,
      // after the strips and at the right edge, and the strips hold the pages alone.
      assert.deepEqual(
        order(seen),
        ['notes', 'timer'],
        'the pages are in the strips, in opening order',
      );
      const home = seen.launcherTab;
      assert.equal(home.childOfTabs, true, 'the launcher stays outside the strips');
      assert.ok(
        Math.abs(home.right - home.barRight) <= 8,
        `the launcher stays at the right edge: ${home.right} vs ${home.barRight}`,
      );
      assert.equal(home.closable, false, 'and it still has no x');
      for (const node of ['notes', 'timer']) {
        const found = seen.tabs.find((tab) => tab.node === node);
        assert.equal(found.closable, true, `"${node}" can be closed`);
      }

      // The launcher's tab is a way back, not a toggle: choosing it closes nothing.
      seen = await tab('launcher');
      assert.deepEqual(order(seen), ['notes', 'timer'], 'going home closes no page');
      assertOneChosen(seen, 'launcher');
      assert.equal(seen.frame.hidden, true, 'the frame steps aside for the launcher');

      // And choosing a page again brings its tab forward rather than a new one.
      seen = await tab('timer');
      assert.deepEqual(order(seen), ['notes', 'timer'], 'the same tabs');
      assertOneChosen(seen, 'timer');
    });
  },
);

// ---- ⑥ a node joining the bus gets a card, never a tab -----------------------------------------
test('test_a_node_that_joins_gets_a_card_and_opens_nothing', { timeout: 90000 }, async (t) => {
  await measure(t, async ({ look, card, evaluate, pause, bus }) => {
    let seen = await look();
    seen = await card('notes');

    // The bus says the list changed; a node that has just arrived has a page nobody has picked.
    bus.use([RESIDENT, ...NAMES, 'mindmap']);
    bus.announce();
    await pause(800);
    seen = await evaluate(READ);

    assert.deepEqual(
      seen.cards.map((card) => card.node),
      [...NAMES, 'mindmap'],
      'the new node is on the launcher',
    );
    assert.deepEqual(order(seen), ['notes'], 'and it did not open itself a tab');
    assertOneChosen(seen, 'notes');
    assert.deepEqual(bus.pages, [RESIDENT, 'notes'], 'no page was fetched for it');

    // A node that leaves takes its card with it — and its tab, if it had one. (The cards that stay
    // keep their place on the grid: a launcher whose tiles jump about is one nobody can learn.)
    bus.use([RESIDENT, 'mindmap', 'timer']);
    bus.announce();
    await pause(800);
    seen = await evaluate(READ);
    assert.deepEqual(
      seen.cards.map((card) => card.node).sort(),
      ['mindmap', 'timer'],
      'the two that are left',
    );
    assert.deepEqual(order(seen), [], 'the tab of a node that left went with it');
    assertOneChosen(seen, 'launcher');
    assert.equal(seen.frame.src, 'about:blank', 'and its page was unloaded');
  });
});

// ---- ⑦ a phone: still one column, and the launcher's own grid ------------------------------------
test(
  'test_a_phone_shows_the_launcher_as_a_grid_and_still_opens_pages',
  { timeout: 90000 },
  async (t) => {
    await measure(t, async ({ look, card, tab }) => {
      let seen = await look(360, 740);

      // A phone opens on the resident page — it is the one with an input waiting — and the launcher is
      // one tab away: the right panel still starts with nothing open.
      assert.equal(seen.launcher.laidOut, false, 'a phone opens on the resident page');
      assert.ok(seen.pinned.laidOut, 'and the left column is what is on screen');
      assert.deepEqual(order(seen), [], 'the main bar holds no page yet');

      // The launcher tab brings the grid: more than one column, cards a thumb can hit, and a page that
      // never scrolls sideways.
      seen = await tab('launcher');
      assert.equal(seen.launcher.hidden, false, 'the launcher takes the screen it is given');
      const columns = new Set(seen.cards.map((card) => card.left));
      assert.ok(columns.size >= 2, `the cards sit in ${columns.size} column(s), not a grid`);
      for (const card of seen.cards) {
        assert.ok(card.width > 0, `“${card.node}” has a box`);
        assert.ok(
          card.height >= 44,
          `“${card.node}” is smaller than a thumb target: ${card.height}px`,
        );
      }
      assert.ok(
        seen.page.scrollWidth <= seen.page.clientWidth,
        `the launcher scrolls the page sideways: ${seen.page.scrollWidth} > ${seen.page.clientWidth}`,
      );

      // Picking a card on a phone puts the page in the one frame, as it always did.
      seen = await card('notes');
      assert.deepEqual(order(seen), ['notes'], 'the page joins the single bar');
      assertOneChosen(seen, 'notes');
      assert.equal(seen.launcher.hidden, true, 'the launcher steps aside for the page');
      assert.equal(seen.frame.hidden, false, 'and the one frame is showing it');
      assert.equal(seen.frame.src, '/panel/notes', 'the page the card stands for');
    });
  },
);

// ---- 8) the resident page owns the left column, and no page chooses its own column ---------------
test(
  'test_the_resident_page_is_the_left_column_and_no_page_chooses_its_side',
  { timeout: 90000 },
  async (t) => {
    await measure(t, async ({ look, card }) => {
      let seen = await look();

      // A page that asked for `slot: left` (the stub makes `notes` ask) is a card and a right-hand tab
      // like every other page: the shell decides the columns now, not the page.
      assert.ok(
        seen.cards.some((card) => card.node === 'notes'),
        'a page asking for the left column is still just a card',
      );
      seen = await card('notes');
      assert.deepEqual(order(seen), ['notes'], 'and its tab is on the main bar');
      assertOneChosen(seen, 'notes');
      assert.deepEqual(
        seen.left.map((tab) => tab.node),
        [RESIDENT],
        'the left column never gained a second tab',
      );
      assert.equal(seen.pinned.src, `/panel/${RESIDENT}`, 'and still shows the resident page');

      // The resident tab cannot be closed, and it is not a card: it is the column, not a page in it.
      assert.equal(seen.left[0].closable, false, 'the resident tab has no x to remove it');
      assert.ok(
        !seen.cards.some((card) => card.node === RESIDENT),
        'and the launcher does not offer it as something to open',
      );
    });
  },
);

// ---- 9) the column is the resident's presence on the bus, nothing else ---------------------------
test(
  'test_the_left_column_follows_the_resident_node_on_and_off_the_bus',
  { timeout: 90000 },
  async (t) => {
    await measure(t, async ({ look, evaluate, pause, bus }) => {
      let seen = await look();
      assert.deepEqual(
        seen.left.map((tab) => tab.node),
        [RESIDENT],
        'the resident is on the left',
      );

      // The resident leaves the bus: the left column goes with it, and the bar is the launcher alone.
      bus.use([...NAMES]);
      bus.announce();
      await pause(800);
      seen = await evaluate(READ);
      assert.deepEqual(seen.left, [], 'no resident, no left-column tab');
      assert.equal(seen.pinned.off, true, 'and the column is not on screen');
      assert.equal(seen.pinned.laidOut, false, 'taking no room at all');
      assert.deepEqual(order(seen), [], 'the main bar is unaffected');

      // It comes back: the column comes back with it, showing its page again.
      bus.use([RESIDENT, ...NAMES]);
      bus.announce();
      await pause(800);
      seen = await evaluate(READ);
      assert.deepEqual(
        seen.left.map((tab) => tab.node),
        [RESIDENT],
        'the resident is back on the left',
      );
      assert.equal(seen.pinned.off, false, 'with its column');
      assert.equal(seen.pinned.src, `/panel/${RESIDENT}`, 'and its page');
      assert.equal(seen.left[0].selected, 'true', 'chosen, as the only page the column has');
    });
  },
);

// ---- 10) the strips scroll with the wheel, and the launcher never moves ---------------------------
test(
  'test_a_wheel_scrolls_the_strips_and_leaves_the_launcher_where_it_is',
  { timeout: 90000 },
  async (t) => {
    await measure(t, async ({ look, card, evaluate }) => {
      let seen = await look(360, 740);
      for (const node of NAMES) seen = await card(node);

      // A phone cannot hold five tabs: the strips are the scroller, and the bar around them is not.
      assert.ok(
        seen.strips.scrollWidth > seen.strips.clientWidth + 1,
        `the strips hold more than a phone shows: ${seen.strips.scrollWidth} > ${seen.strips.clientWidth}`,
      );
      assert.equal(seen.strips.overflowX, 'auto', 'and are the thing that scrolls');
      assert.equal(seen.launcherTab.childOfTabs, true, 'the launcher is still outside them');

      // A wheel over the strips scrolls them sideways — a mouse wheel is vertical, the bar is not.
      const wheel = await evaluate(`JSON.stringify((() => {
      const strips = document.getElementById('strips');
      // Opening a tab reveals it, so the strips may already have moved: start from the left edge.
      strips.scrollLeft = 0;
      const before = strips.scrollLeft;
      const launcherRight = Math.round(document.getElementById('launcher-tab').getBoundingClientRect().right);
      document.getElementById('nav').dispatchEvent(
        new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }),
      );
      return {
        before: Math.round(before),
        after: Math.round(strips.scrollLeft),
        launcherRight,
        barRight: Math.round(document.getElementById('tabs').getBoundingClientRect().right),
        pageScrollY: window.scrollY,
      };
    })())`);
      assert.equal(wheel.before, 0, 'the strips start at their left edge');
      assert.ok(wheel.after > 0, 'a vertical wheel moves them sideways');
      assert.equal(wheel.pageScrollY, 0, 'the page itself does not move');
      assert.equal(
        wheel.launcherRight,
        seen.launcherTab.right,
        'the launcher does not move with them',
      );
      assert.ok(
        Math.abs(wheel.barRight - wheel.launcherRight) <= 8,
        `and is still at the right edge: ${wheel.launcherRight} vs ${wheel.barRight}`,
      );

      // A wheel over the launcher itself scrolls nothing: it is not in the scroller.
      const home = await evaluate(`JSON.stringify((() => {
      const strips = document.getElementById('strips');
      const before = Math.round(strips.scrollLeft);
      document.getElementById('launcher-tab').dispatchEvent(
        new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }),
      );
      return { before, after: Math.round(strips.scrollLeft) };
    })())`);
      assert.equal(home.after, home.before, 'the launcher keeps its place, and moves nothing else');
    });
  },
);
