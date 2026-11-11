// Send and Stop are the page's whole control surface, and what they show is `agent.status.state` — the
// node's own word for what it is doing (`idle` / `generating` / `tool` / `stopping`) and not what the
// page remembers about a turn. The page used to follow its own flags (a `sending` POST, an announced
// line, a streaming tail), which left Stop on screen for a turn that was already over and offered no
// Stop for one another tab had started. So these tests run the built page against a stand-in DOM and an
// `agent.status` the test answers for, and read the two buttons: what they are drawn from is a word the
// node sends, and the page's own flags are only the first screen's fallback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { loadResource, resourceTexts } from '@node-agent/sdk';

//: The page as it is served: `npm run build` copies `src/ui.html` to `dist/`, and this is the copy.
const HTML = readFileSync(new URL('../dist/ui.html', import.meta.url), 'utf8');

//: The page's own script is the last one on it; before it come the Markdown bundle, MathJax and the
//: formula rules. Those rules are their own script, and they need a `window` and nothing else.
const SCRIPT = HTML.slice(
  HTML.lastIndexOf('<script>') + '<script>'.length,
  HTML.lastIndexOf('</script>'),
);
const MATH_RULES = HTML.slice(
  HTML.indexOf('<script id="math-rules">') + '<script id="math-rules">'.length,
  HTML.indexOf('</script>', HTML.indexOf('<script id="math-rules">')),
);

//: The page's own words, as a real visit has them: the node embeds `dist/i18n` in the page and the
//: SDK's browser half (`/sdk/i18n-client.js`) hands the page `t`. This stand-in supplies that one
//: function, in English — the language an unpainted page is written in — so the sentences a test
//: reads are the ones a reader sees, not the keys they come from.
const TEXTS = resourceTexts(loadResource(new URL('../dist/i18n/', import.meta.url)));
const t = (key, params) => {
  const text = TEXTS[key];
  return text === undefined ? key : text.get('en', params);
};

//: The elements the page looks up by id. `text` is the composer, `send` and `stop` are the controls.
const IDS = [
  'pages',
  'log',
  'older',
  'text',
  'send',
  'stop',
  'queue',
  'provider-switch',
  'agents',
  'favicon',
  'prompt-tokens',
  'completion-tokens',
  'total-tokens',
  // The tab menu and the question a delete asks: a right click on a sub-agent's tab opens one, and
  // the second press is the one that destroys the agent.
  'agent-menu',
  'agent-menu-delete',
  'agent-confirm',
  'agent-confirm-text',
  'agent-confirm-cancel',
  'agent-confirm-ok',
];

//: The one agent a node with no sub-agents runs: the page draws no switch row for it.
const defaultAgents = [{ name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 0 }];

//: Long enough for the page's first status read to land and its paint to run.
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** An element carrying only what this page touches. No layout, no stylesheet: a box is its children, its
 *  attributes and the handlers the page put on it. */
function element(tag, dom) {
  const box = {
    tagName: tag.toUpperCase(),
    children: [],
    parent: null,
    dataset: {},
    style: {},
    listeners: {},
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    open: false,
    isConnected: false,
    scrollHeight: 0,
    clientHeight: 0,
    append(...nodes) {
      for (const child of nodes) box.insertBefore(child, null);
    },
    replaceChildren(...nodes) {
      for (const child of box.children) {
        child.parent = null;
        child.isConnected = false;
      }
      box.children = [];
      box.append(...nodes);
    },
    insertBefore(child, before) {
      const at = before == null ? box.children.length : box.children.indexOf(before);
      box.children.splice(at, 0, child);
      child.parent = box;
      child.isConnected = true;
    },
    remove() {
      if (box.parent === null) return;
      box.parent.children.splice(box.parent.children.indexOf(box), 1);
      box.parent = null;
      box.isConnected = false;
    },
    querySelectorAll: () => [],
    closest: () => null,
    setAttribute: (name, value) => {
      box[name] = String(value);
      // `data-*` is readable both ways in a browser, and the page reads the tab's agent back through
      // `dataset`: an attribute written here is one the page finds there too.
      if (name.startsWith('data-')) box.dataset[name.slice('data-'.length)] = String(value);
    },
    removeAttribute: (name) => {
      delete box[name];
    },
    addEventListener: (name, handler) => {
      (box.listeners[name] ??= []).push(handler);
    },
    dispatchEvent: (event) => {
      for (const handler of box.listeners[event.type] ?? []) {
        handler({ ...event, preventDefault() {}, stopPropagation() {} });
      }
    },
    focus: () => {
      dom.activeElement = box;
    },
    scrollTo: () => {},
    setSelectionRange: () => {},
    select: () => {},
  };
  const classes = () => box.className.split(' ').filter((name) => name !== '');
  // Where the page moved the log to, and whether the browser was allowed to travel there: the log's
  // own scroll is smooth unless `following` says otherwise, so a move made with the class off is the
  // glide a reader sees from the top of a fresh window.
  let top = 0;
  box.scrollMoves = [];
  Object.defineProperty(box, 'scrollTop', {
    get: () => top,
    set: (value) => {
      top = value;
      box.scrollMoves.push({ top: value, instant: box.classList.contains('following') });
    },
  });
  box.classList = {
    contains: (name) => classes().includes(name),
    add: (name) => {
      if (!classes().includes(name)) box.className = [...classes(), name].join(' ');
    },
    remove: (name) => {
      box.className = classes()
        .filter((each) => each !== name)
        .join(' ');
    },
    toggle: (name, on) => {
      if (on) box.classList.add(name);
      else box.classList.remove(name);
    },
  };
  return box;
}

/** Open the built page against a stand-in DOM. `state` is what `agent.status` answers first; the test can
 *  change `page.status.state` afterwards, and the next read — the one a send, a stop, or any event the
 *  node announces asks for — answers with the new word. `history` is what `agent.history` answers. */
async function openPage({
  state = 'idle',
  history = [],
  //: The window one named agent answers with, for a page that has more than one to draw: what the page
  //: keeps per agent is only worth testing when two agents hold different transcripts.
  agentHistory = {},
  agents = defaultAgents,
  //: The state one named agent answers with, for a page that has more than one to draw: a main agent
  //: mid-turn while the sub-agent it is not showing is idle is the case the switch has to survive.
  agentStates = {},
  //: How long one `agent.history` read takes, for the case a snapshot arrives while it is still in
  //: flight: on a bus that read is a round trip, and the page has to land it anyway.
  historyDelayMs = 0,
  hiddenLayout = false,
} = {}) {
  const status = { state };
  const dom = {
    activeElement: null,
    ids: new Map(),
    body: null,
    // The press and the key the page listens for on `document`: there is no bubbling here, so a test
    // hands one to the document itself, the way a browser would after it travelled up.
    listeners: {},
    addEventListener(name, handler) {
      (dom.listeners[name] ??= []).push(handler);
    },
    dispatch(name, event = {}) {
      for (const handler of dom.listeners[name] ?? []) {
        handler({ type: name, preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
    getElementById: (id) => dom.ids.get(id),
    createElement: (tag) => {
      const box = element(tag, dom);
      // Every page has its own transcript box, made at runtime: it says how tall it is from what it
      // holds, the way the one in the markup used to.
      if (tag === 'main') {
        Object.defineProperty(box, 'scrollHeight', {
          get: () => (hiddenLayout && box.parent?.hidden ? 0 : box.children.length * 40),
        });
        Object.defineProperty(box, 'clientHeight', {
          get: () => (hiddenLayout && box.parent?.hidden ? 0 : 100),
        });
      }
      return box;
    },
    // The page looks one row up by class (the usage line it writes a title on); a box with no
    // children of its own is all that read needs.
    querySelector: () => element('div', dom),
    querySelectorAll: () => [],
    // A text node is a box with no children of its own, the way the DOM's walk of #log finds it.
    createTextNode: (text) => ({
      tagName: '#text',
      textContent: text,
      parent: null,
      children: [],
      dataset: {},
      className: '',
      isConnected: false,
      remove: () => {},
    }),
  };
  dom.body = element('body', dom);
  for (const id of IDS) dom.ids.set(id, element('div', dom));
  // The transcript and the line above it belong to a page, and the pages are built by the page
  // script itself: `#log`/`#older` resolve to the boxes of the page on screen, which is what a
  // reader (and a test) sees. `#pages` holds one section per agent.
  const known = dom.ids.get.bind(dom.ids);
  dom.ids.get = (id) => {
    if (id !== 'log' && id !== 'older') return known(id);
    const holder = known('pages');
    const shown = (holder.children ?? []).find((child) => child.hidden !== true);
    const box = (shown?.children ?? []).find((child) =>
      id === 'log' ? child.dataset?.role === 'log' : child.className === 'older-status',
    );
    return box ?? known(id);
  };
  // The one label the page does not write itself: the delete item's text is in the markup, and this
  // stand-in starts empty, so the harness spells it out the way that markup does. The menu and the
  // question are boxes the markup opens hidden, for the same reason.
  dom.ids.get('agent-menu-delete').textContent = t('menu.delete');
  dom.ids.get('agent-menu').hidden = true;
  dom.ids.get('agent-confirm').hidden = true;
  // The log says how tall it is from what it holds: the stand-in has no layout, and "the reader is at
  // the bottom" is the question this page asks before it scrolls.
  const logBox = dom.ids.get('log');
  Object.defineProperty(logBox, 'scrollHeight', { get: () => logBox.children.length * 40 });
  logBox.clientHeight = 100;

  const calls = [];
  const feeds = [];
  const values = {
    // The one read these tests are about: the node's word for what it is doing.
    'agent.status': (args) => ({
      state: agentStates[args?.agent] ?? status.state,
      queued: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
    'agent.history': async (args) => {
      if (historyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, historyDelayMs));
      const held = args?.agent === undefined ? history : (agentHistory[args.agent] ?? history);
      return { from: 0, total: held.length, messages: held };
    },
    'agent.chat_no_wait': () => 'queued',
    'agent.stop': () => 'stopping the running turn',
    'agent.provider': () => ({
      active: 'default',
      providers: [{ name: 'default', active: true }],
      persistent: true,
    }),
    // The agents this node runs: the main agent, and any sub-agent it started. A sub-agent is not a
    // node of its own, so this is how the page learns there is one to switch to.
    'agent.agents': () => ({ agents }),
    // The delete a tab menu asks for: the node stops the agent and deletes what it persisted, and
    // what the page can see of that is the row going away - so the list it reads next no longer
    // carries the name. The answer is the runtime's own sentence about what went.
    'agent.destroy_agent': (args) => {
      const at = agents.findIndex((row) => row.name === args?.name);
      if (at >= 0) agents.splice(at, 1);
      return `destroyed agent "${String(args?.name)}" (its transcript is deleted)`;
    },
  };

  const sandbox = {
    document: dom,
    navigator: {},
    location: { pathname: '/panel/agent' },
    // What `/sdk/i18n-client.js` puts on the page: the node's catalog, in the language it was drawn
    // in, and the one function the page calls to build a sentence of its own.
    nodeAgentI18n: { t, currentLocale: () => 'en' },
    window: {
      addEventListener: () => {},
      markdownit: () => ({ use: () => {}, render: (text) => `<p>${String(text ?? '')}</p>` }),
    },
    // The page talks to its own node through the webui's one POST /call; what it asked for is kept, so a
    // test can see which read asked the node what.
    fetch: async (_url, options) => {
      const { tool, args } = JSON.parse(options.body);
      calls.push({ tool, args });
      const value = values[tool] === undefined ? null : await values[tool](args);
      return { ok: true, json: async () => ({ ok: true, value }) };
    },
    // The node's events: a snapshot or an announced line, delivered by hand.
    EventSource: class {
      constructor(url) {
        this.url = url;
        feeds.push(this);
      }
      send(value, topic = 'agent', node = 'agent') {
        this.onmessage({ data: JSON.stringify({ node, topic, value }) });
      }
      close() {
        this.closed = true;
      }
      open() {
        this.onopen();
      }
    },
    getComputedStyle: () => ({ maxHeight: '140px' }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, Math.min(Number(ms) || 0, 50));
      timer.unref?.();
      return timer;
    },
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    alert: () => {},
    console,
  };

  sandbox.window.NodeAgentEvents = { connect: (url) => new sandbox.EventSource(url) };
  vm.createContext(sandbox);
  vm.runInContext(MATH_RULES, sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await settle();

  return {
    dom,
    calls,
    status,
    feeds,
    agents: dom.ids.get('agents'),
    // What a right click on a sub-agent's tab opens, and the question the delete asks afterwards.
    menu: dom.ids.get('agent-menu'),
    menuDelete: dom.ids.get('agent-menu-delete'),
    confirm: dom.ids.get('agent-confirm'),
    confirmText: dom.ids.get('agent-confirm-text'),
    confirmOk: dom.ids.get('agent-confirm-ok'),
    confirmCancel: dom.ids.get('agent-confirm-cancel'),
    /** A press or a key at the document, which is where the menu is closed from. */
    dispatch: (type, event) => dom.dispatch(type, event),
    get feed() {
      return feeds.at(-1);
    },
    text: dom.ids.get('text'),
    send: dom.ids.get('send'),
    stop: dom.ids.get('stop'),
    /** How many times the page asked the node what it is doing. */
    reads: () => calls.filter(({ tool }) => tool === 'agent.status').length,
  };
}

//: A snapshot from the node: one more piece of the answer being written.
const chunk = (content) => ({ type: 'stream', message: { role: 'assistant', content } });

test('an idle node hides Stop and leaves Send open', async () => {
  const page = await openPage({ state: 'idle' });

  assert.equal(page.stop.hidden, true, 'nothing is running, so there is nothing to stop');
  assert.equal(page.stop.disabled, true, 'and a hidden Stop cannot be pressed');
  assert.equal(page.send.disabled, false, 'Send is what is left between turns');
  assert.equal(page.send.textContent, '↑');
});

// `generating` is a turn the node is in the middle of: only the node can cut it short, so Stop is the
// control that is offered and Send is closed while it runs.
test('a generating node offers Stop and closes Send', async () => {
  const page = await openPage({ state: 'generating' });

  assert.equal(page.stop.hidden, false, 'the node says a turn is running');
  assert.equal(page.stop.disabled, false, 'so Stop is the one control to press');
  assert.equal(page.send.disabled, true, 'and a second turn cannot be started from here');
});

// `tool` is the same turn in its other phase — the loop is running a call — and is drawn the same: the
// reader who wants the turn cut short does not care which half of it is running.
test('a node calling a tool offers Stop and closes Send', async () => {
  const page = await openPage({ state: 'tool' });

  assert.equal(page.stop.hidden, false, 'a tool round is a turn in progress');
  assert.equal(page.stop.disabled, false);
  assert.equal(page.send.disabled, true, 'and Send stays closed until the turn is over');
});

// `stopping` is the turn already being cut: pressing Stop again asks the node for something it is
// already doing, and Send would open a second turn while the first still holds the loop — so the page
// offers neither, and Send comes back only when the node says `idle`.
test('a stopping node hides Stop and keeps Send closed until it is idle', async () => {
  const page = await openPage({ state: 'stopping' });

  assert.equal(page.stop.hidden, true, 'the stop the reader asked for is already under way');
  assert.equal(page.stop.disabled, true);
  assert.equal(page.send.disabled, true, 'and the loop is still holding that turn');

  // The node finishes unwinding and says so: only then is Send offered again.
  page.status.state = 'idle';
  page.feed.send([{ role: 'system', content: '(Stopped by user)' }]);
  await settle();

  assert.equal(page.send.disabled, false, 'an idle node takes a new turn');
  assert.equal(page.stop.hidden, true, 'and there is still nothing to stop');
});

// The state the page holds is the node's, so a snapshot still on screen cannot keep Stop alive for a turn
// the node has already finished: the streaming tail is the page's own guess, and `idle` overrules it.
test('a status that turns idle takes Stop away from a streaming answer', async () => {
  const page = await openPage({ state: 'generating' });
  page.feed.send(chunk('Two nodes'));
  await settle();
  assert.equal(page.stop.hidden, false, 'a turn is streaming, so Stop is offered');

  page.status.state = 'idle';
  page.feed.send(chunk('Two nodes: clock and shell.'));
  await settle();

  assert.equal(page.stop.hidden, true, 'the node says the turn is over, and it is the authority');
  assert.equal(page.send.disabled, false, 'so Send is back');
});

// A turn this page starts is read from the node like any other: the line is queued, the state is read
// after it, and the controls follow the answer — not the `sending` flag.
test('sending a message reads the state the turn starts in', async () => {
  const page = await openPage({ state: 'idle' });
  const before = page.reads();

  page.status.state = 'generating';
  page.text.value = 'which nodes are up?';
  page.send.dispatchEvent({ type: 'click' });
  await settle();

  assert.ok(
    page.calls.some(({ tool }) => tool === 'agent.chat_no_wait'),
    'the sentence went out',
  );
  assert.ok(page.reads() > before, 'and the page asked the node what it is doing');
  assert.equal(page.stop.hidden, false, 'the turn it started is one Stop can cut');
  assert.equal(page.send.disabled, true, 'and Send is closed behind it');
});

// No page call may be the one that waits for a turn: a turn is the node's own work and can be minutes
// long (it may park on `ask_user`, whose default wait is five minutes), so a POST that waited for it
// would need a deadline on the way — and the deadline it used to be given is what cut turns the reader
// was still watching, with `bus request timeout` / `deadline exceeded` on screen. The page queues the
// line (`chat_no_wait`) and follows the turn the way it follows any other: from the node's status and
// its announced lines, which is what the controls are drawn from anyway.
test('a page sends with chat_no_wait, so no POST waits for a whole turn', async () => {
  const page = await openPage({ state: 'idle' });

  page.status.state = 'generating';
  page.text.value = 'read the whole repository and tell me what it does';
  page.send.dispatchEvent({ type: 'click' });
  await settle();

  assert.deepEqual(
    page.calls.filter(({ tool }) => tool === 'agent.chat'),
    [],
    'the capability that answers only when the turn ends is not what a page calls',
  );
  const [sent] = page.calls.filter(({ tool }) => tool.startsWith('agent.chat'));
  assert.equal(sent?.tool, 'agent.chat_no_wait');

  // The turn runs on, long after that POST is done: a snapshot arrives and the page still follows it.
  page.feed.send(chunk('A quarter of the answer'));
  await settle();
  assert.equal(page.stop.hidden, false, 'the turn is still the one Stop can cut');
  assert.equal(page.send.disabled, true, 'and Send is still closed behind it');
});

// Every event the node announces is an invitation to ask again: a line posted or a snapshot means a turn
// changed shape, and the page that stopped asking would keep drawing the shape it had.
test('an announced line and a snapshot both ask the node what it is doing', async () => {
  const page = await openPage({ state: 'generating' });

  page.status.state = 'stopping';
  const afterLine = page.reads();
  page.feed.send([{ role: 'tool', tool_call_id: 'c1', content: 'clock\nshell' }]);
  await settle();
  assert.ok(page.reads() > afterLine, 'the announced line asked for the state');
  assert.equal(page.stop.hidden, true, 'and the node\u2019s `stopping` is what is drawn');
  assert.equal(page.send.disabled, true);

  const afterSnapshot = page.reads();
  page.feed.send(chunk('One moment'));
  await settle();
  assert.ok(page.reads() > afterSnapshot, 'so did the snapshot');
});

// The row of buttons at the top of the page: one per agent the node runs. A node with no sub-agents
// draws none, and nothing about the page changes for it; once there is a second agent, the reader can
// look at it - and the transcript, the state, the messages and Stop all follow what is selected.
test('a node with no sub-agents draws no switch row', async () => {
  const page = await openPage();
  assert.equal(page.agents.hidden, true, 'one agent is nothing to choose between');
  assert.equal(page.agents.children.length, 0);
});

test('the switch row lists the main agent and every sub-agent', async () => {
  const page = await openPage({
    agentStates: { helper: 'generating' },
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1 },
      { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'generating', children: 0 },
    ],
  });
  await settle();

  assert.equal(page.agents.hidden, false, 'there is a choice to make');
  assert.equal(page.agents.children.length, 2, 'the main agent and its sub-agent');
  const [main, helper] = page.agents.children;
  assert.equal(main['data-agent'], 'agent');
  assert.equal(main['aria-pressed'], 'true', 'the page starts on the main agent');
  assert.equal(helper['data-agent'], 'helper');
  assert.equal(helper['aria-pressed'], 'false');
  assert.equal(helper['data-busy'], 'true', 'a sub-agent in a turn of its own says so');
  assert.match(helper.textContent, /helper/);
  assert.ok(!helper.textContent.includes('↳'), 'the tab does not add an arrow');
  assert.equal(main['data-busy'], 'false', 'an idle agent does not breathe');
  assert.equal(helper['data-busy'], 'true', 'a generating agent breathes on its border');
  assert.equal(main['data-state'], 'idle');
  assert.equal(helper['data-state'], 'generating');
  assert.ok(
    !main.children.some((child) => child.className === 'agent-status'),
    'the state is on the tab border, not an extra dot',
  );
});

test('the selected agent icon marks its tab and the page favicon', async () => {
  const mainIcon = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="7"/></svg>';
  const helperIcon = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="14" height="14"/></svg>';
  const page = await openPage({
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1, icon: mainIcon },
      {
        name: 'helper',
        topic: 'agent.helper',
        parent: 'agent',
        state: 'idle',
        children: 0,
        icon: helperIcon,
      },
    ],
  });
  await settle();

  const [main] = page.agents.children;
  const mark = main.children.find((child) => child.className === 'agent-icon');
  assert.ok(mark, 'the tab carries the agent drawing');
  assert.equal(mark.innerHTML, mainIcon);
  assert.equal(
    page.dom.ids.get('favicon').href,
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mainIcon)}`,
    'the page favicon follows the selected agent',
  );

  page.agents.children[1].dispatchEvent({ type: 'click' });
  await settle();
  assert.equal(
    page.dom.ids.get('favicon').href,
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(helperIcon)}`,
    'switching agent switches the drawing',
  );
});

test('unselected agents share the event feed and keep receiving their own events', async () => {
  const page = await openPage({
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1 },
      { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'idle', children: 0 },
    ],
  });
  await settle();
  assert.equal(
    page.feeds.filter((feed) => !feed.closed).length,
    1,
    'one connection for both pages',
  );
  assert.match(page.feed.url, /topic=agent&topic=agent.helper/);

  const before = page.calls.filter(({ tool }) => tool === 'agent.agents').length;
  page.feed.send(chunk('helper moved'), 'agent.helper');
  await settle(120);
  assert.ok(
    page.calls.filter(({ tool }) => tool === 'agent.agents').length > before,
    'a sibling event refreshes the whole agent list',
  );
});

test('many sub-agents leave a connection free for Send and Stop', async () => {
  const agents = [
    { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 8 },
    ...Array.from({ length: 8 }, (_, i) => ({
      name: `helper-${i}`,
      topic: `agent.helper-${i}`,
      parent: 'agent',
      state: 'idle',
      children: 0,
    })),
  ];
  const page = await openPage({ agents });
  await settle();
  assert.equal(page.feeds.filter((feed) => !feed.closed).length, 1);
  for (const agent of agents) assert.ok(page.feed.url.includes(`&topic=${agent.topic}`));

  const shared = page.feed;
  page.agents.children[8].dispatchEvent({ type: 'click' });
  page.text.value = 'hello';
  page.send.dispatchEvent({ type: 'click' });
  await settle();
  page.stop.dispatchEvent({ type: 'click' });
  await settle();
  assert.equal(page.feed, shared, 'switching and sending do not open more connections');
  for (const tool of ['agent.chat_no_wait', 'agent.stop']) {
    assert.ok(page.calls.some((call) => call.tool === tool && call.args.agent === 'helper-7'));
  }
});

test('the shared feed routes snapshots by topic and ignores unrelated events', async () => {
  const page = await openPage({ agents: twoAgents() });
  const { logOf } = pageBoxes(page);
  const before = page.calls.length;
  page.feed.send(chunk('unrelated'), 'agent.unknown');
  page.feed.send(chunk('wrong publisher'), 'agent.helper', 'other');
  await settle();
  assert.equal(page.calls.length, before);

  const mainBoxes = [...logOf(0).children];
  const hiddenPaints = logOf(1).scrollMoves.length;
  page.feed.send(chunk('helper only'), 'agent.helper');
  await settle(120);
  assert.deepEqual(logOf(0).children, mainBoxes, 'the main transcript was not repainted');
  assert.ok(logOf(1).scrollMoves.length > hiddenPaints, 'the hidden helper painted its snapshot');
  assert.notEqual(page.agents.children[0]['data-busy'], 'true', 'the main agent remains idle');
});

test('a feed event refreshes the agent rows', async () => {
  const page = await openPage({
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1 },
      { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'generating', children: 0 },
    ],
  });
  await settle();
  const before = page.calls.filter(({ tool }) => tool === 'agent.agents').length;
  page.feed.send(chunk('a snapshot'));
  await settle(120);
  assert.ok(
    page.calls.filter(({ tool }) => tool === 'agent.agents').length > before,
    'an event asks the node for the current agent list',
  );
});

test('switching agent moves history, status, the feed and what Send posts to', async () => {
  const page = await openPage({
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1 },
      { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'idle', children: 0 },
    ],
  });
  await settle();
  // Each agent was read once, when its page was made - before anyone chose between them.
  assert.ok(
    page.calls.some(({ tool, args }) => tool === 'agent.history' && args.agent === 'helper'),
    'the sub-agent page was read when it was made',
  );
  const reads = page.calls.length;

  page.agents.children[1].dispatchEvent({ type: 'click' });
  await settle();

  // Looking at another agent asks the node nothing: the page it needs is already there.
  assert.equal(page.calls.length, reads, 'the switch itself reads nothing');
  assert.ok(
    page.calls.some(({ tool, args }) => tool === 'agent.history' && args.agent === 'helper'),
    'the transcript is read for the sub-agent',
  );
  assert.ok(
    page.calls.some(({ tool, args }) => tool === 'agent.status' && args.agent === 'helper'),
    'and so is its state',
  );
  assert.match(
    page.feed.url,
    /topic=agent.helper/,
    'the shared stream includes the selected agent topic',
  );
  assert.equal(page.agents.children[1]['aria-pressed'], 'true', 'and the button says where we are');

  // Sending a message and stopping are the selected agent's, not the main one's.
  page.text.value = 'what are you doing?';
  page.send.dispatchEvent({ type: 'click' });
  await settle();
  assert.ok(
    page.calls.some(({ tool, args }) => tool === 'agent.chat_no_wait' && args.agent === 'helper'),
    'the message goes to the agent on screen',
  );
  assert.ok(
    page.calls.some(
      ({ tool, args }) =>
        tool === 'agent.chat_no_wait' && args.msg?.content === 'what are you doing?',
    ),
    'with the line the reader wrote',
  );
});

// First opening lands at the newest line, including pages preloaded with no visible layout.
test('main and sub-agent windows open at their end without travelling down to it', async () => {
  const history = Array.from({ length: 8 }, (_, at) => ({
    role: 'assistant',
    content: `line ${at}`,
  }));
  const page = await openPage({
    history,
    hiddenLayout: true,
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1 },
      { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'idle', children: 0 },
    ],
  });
  await settle(150);
  const log = page.dom.ids.get('log');

  assert.ok(log.scrollHeight > log.clientHeight, 'the transcript is taller than the window');
  assert.equal(log.scrollTop, log.scrollHeight, 'the page opens on the newest line');
  assert.ok(
    log.scrollMoves.some((move) => move.top === log.scrollHeight && move.instant),
    'and it was put there, not travelled to',
  );

  const preloadedLog = pageBoxes(page).logOf(1);
  assert.ok(preloadedLog.children.length > 0);
  assert.equal(preloadedLog.scrollHeight, 0, 'hidden pages have no layout');
  page.agents.children[1].dispatchEvent({ type: 'click' });
  await settle(150);
  const helperLog = page.dom.ids.get('log');
  assert.notEqual(helperLog, log, 'the sub-agent has a box of its own');
  assert.equal(helperLog.scrollTop, helperLog.scrollHeight, 'it opens on its newest line');
  assert.ok(helperLog.scrollMoves.at(-1).instant);

  page.feed.open();
  await settle(150);
  assert.equal(helperLog.scrollTop, helperLog.scrollHeight);

  helperLog.scrollTop = 40;
  page.agents.children[0].dispatchEvent({ type: 'click' });
  page.agents.children[1].dispatchEvent({ type: 'click' });
  await settle();
  assert.equal(helperLog.scrollTop, 40, 'reopening preserves the reader position');

  page.feed.open();
  await settle(150);
  assert.equal(helperLog.scrollTop, 40, 'reconnecting preserves the reader position');
});

test('a sub-agent opened before its history arrives lands at the end when it loads', async () => {
  const history = Array.from({ length: 8 }, (_, at) => ({
    role: 'assistant',
    content: `line ${at}`,
  }));
  const page = await openPage({
    agentHistory: { helper: history },
    agents: [{ name: 'agent' }, { name: 'helper' }],
    historyDelayMs: 180,
    hiddenLayout: true,
  });
  page.agents.children[1].dispatchEvent({ type: 'click' });
  const helperLog = page.dom.ids.get('log');
  assert.ok(helperLog.scrollHeight <= helperLog.clientHeight);
  await settle(250);
  assert.ok(helperLog.children.length > 0);
  assert.equal(helperLog.scrollTop, helperLog.scrollHeight);
  assert.ok(helperLog.scrollMoves.at(-1).instant);
});

// Every switch used to blank the log and read a whole window again, so a reader moving between two
// agents waited on the node each time. What the page has already read of an agent is painted at once,
// and the read that follows asks only for the lines added since.
test('coming back to an agent paints the window the page already has', async () => {
  const main = Array.from({ length: 6 }, (_, at) => ({ role: 'assistant', content: `main ${at}` }));
  const page = await openPage({
    history: main,
    agentHistory: { helper: [{ role: 'assistant', content: 'helper only' }] },
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1 },
      { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'idle', children: 0 },
    ],
  });
  await settle(150);
  const log = page.dom.ids.get('log');
  const mainWindow = log.children.length;
  assert.ok(mainWindow > 2, 'the main agent window is drawn');

  page.agents.children[1].dispatchEvent({ type: 'click' });
  await settle(150);
  assert.ok(
    page.dom.ids.get('log').children.length < mainWindow,
    'the sub-agent has a window of its own',
  );

  // Back to the main agent: its page is still there, with every box it had, in the same task as the
  // click and without asking the node anything.
  page.agents.children[0].dispatchEvent({ type: 'click' });
  const back = page.dom.ids.get('log');
  assert.equal(back, log, 'the main agent page is the box it always was');
  assert.equal(back.children.length, mainWindow, 'the window the page kept is painted at once');
  await settle(150);
  assert.equal(back.children.length, mainWindow, 'and nothing was read to change it');
});

// A turn announces an event per snapshot, and every event asks the node for the agent list again. A
test('a refresh during a turn keeps the same agent tabs', async () => {
  const page = await openPage({
    state: 'generating',
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'generating', children: 1 },
      { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'idle', children: 0 },
    ],
  });
  await settle();
  const [mainTab, helperTab] = page.agents.children;

  for (let half = 0; half < 3; half += 1) {
    page.feed.send(chunk(`part ${half}`));
    await settle(120);
  }
  assert.ok(
    page.calls.filter(({ tool }) => tool === 'agent.agents').length > 1,
    'the list was read again while the answer streamed',
  );
  assert.equal(page.agents.children[0], mainTab, 'the main agent tab is the same button');
  assert.equal(page.agents.children[1], helperTab, 'and so is the sub-agent one');
  assert.equal(mainTab['data-state'], 'generating', 'what it says is redrawn in place');
});

// The other half of it: the switch is the page own doing, so the click lands at once - while the
// main agent is mid-turn - and the main agent turn carries on untouched (the page never stops or
// queues a turn; `agent.stop` is only ever the Stop button).
test('clicking a sub-agent while the main agent generates switches at once', async () => {
  const page = await openPage({
    state: 'generating',
    agentStates: { helper: 'idle' },
    agents: [
      { name: 'agent', topic: 'agent', parent: null, state: 'generating', children: 1 },
      { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'idle', children: 0 },
    ],
  });
  await settle();
  page.feed.send(chunk('half an answer'));
  await settle(120);

  const [, helperTab] = page.agents.children;
  helperTab.dispatchEvent({ type: 'click' });

  // Before any answer comes back: the page is already looking at the sub-agent.
  assert.equal(helperTab['aria-pressed'], 'true', 'the tab says it is selected at once');
  assert.equal(
    page.agents.children[1],
    helperTab,
    'and the button is still the one that was clicked',
  );

  await settle();
  assert.ok(
    page.calls.some(({ tool, args }) => tool === 'agent.history' && args.agent === 'helper'),
    'the sub-agent transcript is read afterwards',
  );
  assert.ok(
    page.calls.some(({ tool, args }) => tool === 'agent.status' && args.agent === 'helper'),
    'so is its state',
  );
  assert.ok(
    page.calls.some(({ tool, args }) => tool === 'agent.provider' && args.agent === 'helper'),
    'and the provider list the switch shows is the sub-agent own',
  );
  assert.match(
    page.feed.url,
    /topic=agent.helper/,
    'the shared stream includes the sub-agent topic',
  );
  assert.deepEqual(
    page.calls.filter(({ tool }) => tool === 'agent.stop'),
    [],
    'switching never stops the turn the main agent is in',
  );
  assert.equal(page.stop.hidden, true, 'an idle sub-agent has no turn for Stop');
});

/** A right click on one tab, with the two calls a `contextmenu` handler makes recorded: the
 *  browser's own menu is either stopped here or it is not, and that is the whole difference between a
 *  tab this page has actions for and one it does not. */
function rightClick(page, tab) {
  const seen = { prevented: false, stopped: false };
  const event = {
    type: 'contextmenu',
    target: tab,
    clientX: 24,
    clientY: 12,
    preventDefault() {
      seen.prevented = true;
    },
    stopPropagation() {
      seen.stopped = true;
    },
  };
  // The listener lives on the row, and a right click on a tab travels up to it: the stand-in DOM does
  // not bubble, so the event carries the tab as its target and is handed to the row directly.
  for (const handler of page.agents.listeners.contextmenu ?? []) handler(event);
  return seen;
}

/** The main agent and one sub-agent it started. */
function twoAgents() {
  return [
    { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1 },
    { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'idle', children: 0 },
  ];
}

// A sub-agent is something this node runs and can stop running: a right click on its tab offers to
// delete it. The main agent is the node itself - there is nothing that could destroy it - so its tab
// keeps the browser's own menu and the page draws no actions of its own over it.
test('only a sub-agent tab offers a menu on a right click', async () => {
  const page = await openPage({ agents: twoAgents() });
  await settle();
  const [mainTab, helperTab] = page.agents.children;

  assert.equal(page.menu.hidden, true, 'nothing is open to begin with');

  const onMain = rightClick(page, mainTab);
  assert.equal(onMain.prevented, false, "the browser's menu is left alone on the main agent");
  assert.equal(page.menu.hidden, true, 'and no agent menu is drawn for it');

  const onHelper = rightClick(page, helperTab);
  assert.equal(onHelper.prevented, true, "the browser's own menu does not open over the tab");
  assert.equal(page.menu.hidden, false, 'the sub-agent tab has a menu');
  assert.equal(page.menu.dataset.agent, 'helper', 'and it is about the agent that was pressed');
  assert.match(page.menuDelete.textContent, /Delete agent/, 'the delete is the action it offers');
});

// A delete is asked twice. The first press opens the question with the agent's name in it; only the
// second calls the node, and nothing is destroyed before it.
test('the tab menu asks a second time before it destroys the agent', async () => {
  const agents = twoAgents();
  const page = await openPage({ agents });
  await settle();

  rightClick(page, page.agents.children[1]);
  page.menuDelete.dispatchEvent({ type: 'click' });

  assert.equal(page.menu.hidden, true, 'the menu closes behind the press');
  assert.equal(page.confirm.hidden, false, 'and the question it asks is on screen');
  assert.match(page.confirmText.textContent, /helper/, 'with the agent it is about named in it');
  assert.deepEqual(
    page.calls.filter(({ tool }) => tool === 'agent.destroy_agent'),
    [],
    'a first press deletes nothing',
  );
  assert.equal(agents.length, 2, 'the agent is still there');

  // Cancel leaves it exactly as it was.
  page.confirmCancel.dispatchEvent({ type: 'click' });
  assert.equal(page.confirm.hidden, true, 'the question goes away');
  assert.equal(agents.length, 2, 'and the agent it was about stays');
});

// The one press that does delete: it asks the node for it, and the page reads the list again rather
// than remembering what it did - the row that is gone is the node's answer, not the page's guess.
test('a confirmed delete calls destroy_agent and redraws the row', async () => {
  const agents = twoAgents();
  const page = await openPage({ agents });
  await settle();

  rightClick(page, page.agents.children[1]);
  page.menuDelete.dispatchEvent({ type: 'click' });
  page.confirmOk.dispatchEvent({ type: 'click' });
  await settle();

  const deleted = page.calls.filter(({ tool }) => tool === 'agent.destroy_agent');
  assert.equal(deleted.length, 1, 'the capability the page calls is the node own');
  assert.equal(deleted[0].args.name, 'helper', 'and it names the agent that was pressed');
  assert.equal(page.confirm.hidden, true, 'the question is gone');
  assert.equal(page.agents.children.length, 0, 'the row of tabs is gone with the agent it held');
  assert.equal(page.agents.hidden, true, 'one agent is nothing to choose between');
  assert.ok(
    page.calls.filter(({ tool }) => tool === 'agent.agents').length > 1,
    'the list the page draws was read again after the delete',
  );
});

// The agent on screen is the one that was deleted: nothing can switch back to it, so the page goes
// back to the main agent and reads what it shows from there - the transcript on screen belonged to
// something that no longer runs.
test('deleting the agent on screen takes the page back to the main agent', async () => {
  const agents = twoAgents();
  const page = await openPage({
    agents,
    history: [{ role: 'assistant', content: 'spoken by the main agent' }],
    agentHistory: { helper: [{ role: 'assistant', content: 'spoken by the helper' }] },
  });
  await settle();

  page.agents.children[1].dispatchEvent({ type: 'click' });
  await settle();
  assert.equal(
    page.agents.children[1]['aria-pressed'],
    'true',
    'the page is looking at the helper',
  );

  rightClick(page, page.agents.children[1]);
  page.menuDelete.dispatchEvent({ type: 'click' });
  page.confirmOk.dispatchEvent({ type: 'click' });
  await settle(120);

  assert.equal(page.agents.hidden, true, 'the helper row is gone, and the row with it');
  // The page it falls back to was on screen a moment ago and is still there: falling back to it reads
  // nothing, exactly as switching by hand does not.
  const shown = page.dom.ids.get('log');
  assert.equal(shown.dataset.role, 'log');
  assert.equal(page.dom.ids.get('pages').children.length, 1, 'only the main agent page is left');
  assert.deepEqual(
    page.calls.filter(({ tool, args }) => tool === 'agent.history' && args.agent === 'helper')
      .length,
    1,
    'the agent that went was read once, when its page was made',
  );
});

// A menu drawn over the page has to go away the way a menu does: Escape, or a press anywhere else.
// A row the reader can no longer see must not be pressable.
test('Escape and a press elsewhere close the tab menu', async () => {
  const page = await openPage({ agents: twoAgents() });
  await settle();

  rightClick(page, page.agents.children[1]);
  assert.equal(page.menu.hidden, false, 'the menu is open');
  page.dispatch('keydown', { key: 'Escape' });
  assert.equal(page.menu.hidden, true, 'Escape closes it');

  rightClick(page, page.agents.children[1]);
  assert.equal(page.menu.hidden, false, 'it opens again');
  page.dispatch('click', {});
  assert.equal(page.menu.hidden, true, 'and a press anywhere else closes it');

  rightClick(page, page.agents.children[1]);
  page.dispatch('keydown', { key: 'a' });
  assert.equal(page.menu.hidden, false, 'another key leaves it open');
});

/** The page container of the main agent and its sub-agent, and the boxes each page owns. */
function pageBoxes(page) {
  const holder = page.dom.ids.get('pages');
  const logOf = (at) => holder.children[at].children.find((child) => child.dataset?.role === 'log');
  return { holder, logOf };
}

// Every agent the node runs gets a page of its own, made before anyone chooses between them. Looking
// at another agent hides the one on screen and shows the other - it does not read, rebuild or reset
// anything, so the page the reader comes back to is the page they left.
test('switching between agents only hides and shows their pages', async () => {
  const page = await openPage({ agents: twoAgents() });
  await settle(120);
  const { holder } = pageBoxes(page);

  assert.equal(holder.children.length, 2, 'one page per agent, built at load');
  const [mainPage, helperPage] = holder.children;
  assert.equal(mainPage.dataset.agent, 'agent');
  assert.equal(helperPage.dataset.agent, 'helper');
  assert.equal(mainPage.hidden, false, 'the page the reader started on is the one shown');
  assert.equal(helperPage.hidden, true, 'and the sub-agent is not on screen');

  page.agents.children[1].dispatchEvent({ type: 'click' });
  assert.equal(mainPage.hidden, true, 'the page that was on screen is hidden');
  assert.equal(helperPage.hidden, false, 'and the one asked for is shown');
  assert.equal(page.dom.ids.get('log'), pageBoxes(page).logOf(1), '#log is the box of that page');

  // Back and forth: the same two boxes, hidden and shown in turn, never rebuilt.
  page.agents.children[0].dispatchEvent({ type: 'click' });
  assert.equal(holder.children[0], mainPage, 'the main agent page is the element it was');
  assert.equal(holder.children[1], helperPage, 'and so is the sub-agent one');
});

// A switch is not a read: both agents were read once, when their pages were made, and moving between
// them asks the node nothing at all - however often the reader moves.
test('moving between two agents reads neither transcript again', async () => {
  const page = await openPage({
    agents: twoAgents(),
    history: [{ role: 'assistant', content: 'spoken by the main agent' }],
    agentHistory: { helper: [{ role: 'assistant', content: 'spoken by the helper' }] },
  });
  await settle(150);
  const reads = () => page.calls.filter(({ tool }) => tool === 'agent.history').length;
  assert.equal(reads(), 2, 'one window per agent, read when its page was made');
  const before = reads();

  for (let turn = 0; turn < 3; turn += 1) {
    page.agents.children[1].dispatchEvent({ type: 'click' });
    await settle(60);
    page.agents.children[0].dispatchEvent({ type: 'click' });
    await settle(60);
  }
  assert.equal(reads(), before, 'six switches asked for no transcript at all');
});

// A turn belongs to its agent, not to the screen: a snapshot of the agent that is not on screen keeps
// arriving in that agent's own page, and coming back to it shows the answer as it stands.
test('a turn keeps streaming into the page of the agent nobody is looking at', async () => {
  const page = await openPage({
    state: 'generating',
    agentStates: { helper: 'idle' },
    agents: twoAgents(),
  });
  await settle(150);
  const { logOf } = pageBoxes(page);

  page.feed.send(chunk('half an answer'));
  await settle(150);
  const paintedWhileShown = logOf(0).scrollMoves.length;
  assert.ok(paintedWhileShown > 0, 'the snapshot was painted while the main agent was on screen');

  // Off to the sub-agent, and the main agent keeps writing.
  page.agents.children[1].dispatchEvent({ type: 'click' });
  await settle(120);
  const helperBoxes = logOf(1).children.length;
  page.feed.send(chunk('half an answer, and the rest of it'));
  await settle(150);

  assert.ok(
    logOf(0).scrollMoves.length > paintedWhileShown,
    'the hidden page kept painting its snapshots from the shared stream',
  );
  assert.equal(
    logOf(1).children.length,
    helperBoxes,
    'the snapshot did not land in the agent on screen',
  );
  assert.equal(page.agents.children[0]['data-busy'], 'true', 'the main agent is still in its turn');

  // Back to it: the page is the one that was painting, and the tail is still there.
  page.agents.children[0].dispatchEvent({ type: 'click' });
  await settle(80);
  assert.equal(page.dom.ids.get('log'), logOf(0), 'the main agent page is the one that was hidden');
  assert.ok(logOf(0).children.length >= 1, 'and it still holds what it was painting');
  assert.equal(
    page.agents.children[0]['data-busy'],
    'true',
    'its turn did not end with the switch',
  );
});

// Removing an agent drops its page and topic from the shared subscription.
test('destroying an agent removes its page and updates the shared subscription', async () => {
  const page = await openPage({ agents: twoAgents() });
  await settle(150);
  const { holder } = pageBoxes(page);
  assert.equal(holder.children.length, 2, 'a page for each agent');
  assert.equal(page.feeds.filter((feed) => !feed.closed).length, 1, 'both pages share one stream');
  const helperPage = holder.children[1];
  const previousFeed = page.feed;

  rightClick(page, page.agents.children[1]);
  page.menuDelete.dispatchEvent({ type: 'click' });
  page.confirmOk.dispatchEvent({ type: 'click' });
  await settle(200);

  assert.equal(holder.children.length, 1, 'the page of the agent that went is gone');
  assert.equal(holder.children[0].dataset.agent, 'agent', 'the main agent page is what is left');
  assert.equal(helperPage.isConnected, false, 'and the removed page is detached');
  assert.equal(previousFeed.closed, true, 'the old subscription was closed');
  assert.equal(page.feeds.filter((feed) => !feed.closed).length, 1, 'only one stream remains');
  assert.doesNotMatch(
    page.feed.url,
    /topic=agent.helper/,
    'the deleted topic is no longer watched',
  );
});

// New agents get a hidden page and join the shared subscription before anyone clicks their tab.
test('an agent that appears gets a page of its own, unshown', async () => {
  const agents = twoAgents();
  const page = await openPage({ agents });
  await settle(150);
  const { holder } = pageBoxes(page);
  assert.equal(holder.children.length, 2, 'the two agents the node had at load');

  agents.push({ name: 'later', topic: 'agent.later', parent: 'agent', state: 'idle', children: 0 });
  // The node announces something - any event is the invitation to read the list again.
  page.feed.send(chunk('a line'));
  await settle(200);

  assert.equal(holder.children.length, 3, 'the new agent page was built when the list named it');
  const later = holder.children[2];
  assert.equal(later.dataset.agent, 'later');
  assert.equal(later.hidden, true, 'and it is not the page on screen');
  assert.match(page.feed.url, /topic=agent.later/, 'its topic joins the shared stream');
  assert.equal(
    page.dom.ids.get('log'),
    pageBoxes(page).logOf(0),
    'the page on screen did not move',
  );
});

// A snapshot is the answer being written, not news that the transcript changed: the page draws the tail
// from it and reads nothing. It used to fall through to the reload every other event does, which put a
// `history` call (and a `status` one) between the node and its own answer for every token - the cost that
// froze the node while it generated - and cleared the snapshot on the way, so the tail never survived a
// read: the reader saw a state line and no answer until the turn committed it.
test('a snapshot draws the tail and reads nothing', async () => {
  const page = await openPage({ state: 'generating', history: [{ role: 'user', content: 'hi' }] });
  await settle(120);
  const { logOf } = pageBoxes(page);
  const reads = () => page.calls.filter(({ tool }) => tool === 'agent.history').length;
  const before = reads();

  page.feed.send(chunk('one'));
  page.feed.send(chunk('one two'));
  page.feed.send(chunk('one two three'));
  await settle(250);

  assert.equal(reads(), before, 'three snapshots are not three reads of the transcript');
  const groups = logOf(0)
    .children.map((child) => child.dataset?.group)
    .filter(Boolean);
  assert.deepEqual(
    groups,
    ['m0', 'm1'],
    'the committed line and the tail being streamed, and nothing else in the transcript',
  );
  assert.equal(page.stop.hidden, false, 'and the turn is still the one Stop is offered for');
});

// A page that is refreshed mid-turn has no transcript of its own yet: it asks for the window and follows
// the snapshots that keep arriving while that read is in flight. The two have to meet - a snapshot is not
// a reason to cancel the read - or a reader who reloads watches a state line with no messages under it
// until the turn ends.
test('a refresh during a turn keeps the window it asked for', async () => {
  const page = await openPage({
    state: 'generating',
    history: [
      { role: 'user', content: 'a question' },
      { role: 'assistant', content: 'an earlier answer' },
    ],
    historyDelayMs: 60,
  });
  // The page comes back: the browser reopens the stream, and the turn is still writing.
  const reads = () => page.calls.filter(({ tool }) => tool === 'agent.history').length;
  const before = reads();
  page.feed.open();
  for (let index = 0; index < 8; index += 1) {
    await settle(15);
    page.feed.send(chunk('the answer being written'));
  }
  await settle(250);

  const groups = pageBoxes(page)
    .logOf(0)
    .children.map((child) => child.dataset?.group)
    .filter(Boolean);
  assert.deepEqual(
    groups,
    ['m0', 'm1', 'm2'],
    'the window the page asked for is on screen, with the tail after it',
  );
  assert.ok(
    reads() - before <= 1,
    `the eight snapshots did not re-read the window (${reads() - before} reads)`,
  );
  assert.equal(page.status.state, 'generating', 'while the node is still generating');
});

// The same thing at the speed a real provider writes: a long answer is hundreds of snapshots. What the
// page asks the node for must not grow with them - that flood is what made the node stop answering
// while it was generating.
test('a burst of snapshots is not a burst of calls', async () => {
  const page = await openPage({ state: 'generating', history: [{ role: 'user', content: 'hi' }] });
  await settle(120);
  const count = (tool) => page.calls.filter((call) => call.tool === tool).length;
  const historyBefore = count('agent.history');
  const statusBefore = count('agent.status');

  let text = '';
  for (let index = 0; index < 60; index += 1) {
    text += `token${index} `;
    page.feed.send(chunk(text));
    await settle(2);
  }
  await settle(250);

  assert.equal(count('agent.history'), historyBefore, 'sixty snapshots read no transcript');
  // The node's word for the state is still read - the controls follow it - but it is one short read in
  // flight, not a window of the transcript per token.
  assert.ok(
    count('agent.status') - statusBefore <= 62,
    `status reads stay one per snapshot at worst (${count('agent.status') - statusBefore})`,
  );
  const groups = pageBoxes(page)
    .logOf(0)
    .children.map((child) => child.dataset?.group)
    .filter(Boolean);
  assert.deepEqual(groups, ['m0', 'm1'], 'and the last snapshot is the tail on screen');
});
