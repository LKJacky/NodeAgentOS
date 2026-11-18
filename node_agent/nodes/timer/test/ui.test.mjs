// The two forms' target is a choice, not a text box. A timer wakes an agent, and which agents there
// are is the `agent` node's own answer (`agent.agents`: its main agent, then every sub-agent it
// started), so these tests run the built page against a stand-in DOM and an `agents` the test answers
// for, and read the two `<select>`s: what they offer, which row they start on, what happens to a
// target the list no longer carries, what a failed read leaves behind, and what the form submits.
//
// Nothing here is a browser: a box is its children, its attributes and the handlers the page put on
// it, and `/call` is answered by the test — the same shape a stand-in has elsewhere in this repo.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadResource, resourceTexts } from '@node-agent/sdk';

//: The page as it is served: `npm run build` copies `src/ui.html` to `dist/`, and this is that copy.
const HTML = readFileSync(new URL('../dist/ui.html', import.meta.url), 'utf8');

//: The page's own script. The head carries `<script type="module" src="/sdk/i18n-client.js">`, which
//: is not this one, so the last inline module is the page itself.
const SCRIPT = (() => {
  const start = HTML.lastIndexOf('<script type="module">') + '<script type="module">'.length;
  return HTML.slice(start, HTML.indexOf('</script>', start));
})();

//: The same script without its one import. `/sdk/i18n-client.js` is the SDK's browser half, and this
//: harness hands the sandbox the three bindings it exports — the way a visit that loaded that file
//: would have them — so the page's own code is what runs here, unchanged.
const BODY = SCRIPT.replace(/\bimport\s*\{[^}]*\}\s*from\s*'[^']*';/, '');

//: The page's words, as a real visit has them: the node embeds `dist/i18n` in the page and the SDK's
//: browser half hands the page `t`. This stand-in supplies the same catalog in English, so the
//: sentences a test reads are the ones a reader sees.
const TEXTS = resourceTexts(loadResource(new URL('../dist/i18n/', import.meta.url)));
const t = (key, params) => {
  const text = TEXTS[key];
  return text === undefined ? key : text.get('en', params);
};

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** The main agent of a family, and what a node that ran one sub-agent answers with. */
const MAIN = { name: 'agent', topic: 'agent', parent: null, state: 'idle', children: 1 };
const HELPER = { name: 'helper', topic: 'agent.helper', parent: 'agent', state: 'generating', children: 0 };

/** An element carrying only what this page touches: its children, its attributes and its handlers. */
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
    hidden: false,
    disabled: false,
    title: '',
    id: '',
    append(...nodes) {
      for (const child of nodes) box.insertBefore(child, null);
    },
    replaceChildren(...nodes) {
      for (const child of box.children) child.parent = null;
      box.children = [];
      box.append(...nodes);
      // A `<select>` whose options were just replaced has no selection of its own; the page sets one
      // right after, which is what a browser does with `select.value = …` too.
      if (box.tagName === 'SELECT') selected = undefined;
    },
    insertBefore(child, before) {
      const at = before == null ? box.children.length : box.children.indexOf(before);
      box.children.splice(at, 0, child);
      child.parent = box;
      return child;
    },
    remove() {
      if (box.parent === null) return;
      box.parent.children.splice(box.parent.children.indexOf(box), 1);
      box.parent = null;
    },
    setAttribute(name, value) {
      box[name] = String(value);
    },
    removeAttribute(name) {
      delete box[name];
    },
    addEventListener(name, handler) {
      (box.listeners[name] ??= []).push(handler);
    },
    dispatchEvent(event) {
      for (const handler of box.listeners[event.type] ?? []) {
        handler({ ...event, preventDefault() {}, stopPropagation() {} });
      }
    },
    focus() {
      dom.activeElement = box;
    },
    // The page's forms are reset after a save or a cancel; the fields themselves are boxes the test
    // fills, so a reset is only the selection going back to its default - which the page redraws.
    reset() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setSelectionRange() {},
  };
  let selected;
  if (tag.toLowerCase() === 'select') {
    // A select's value is the option it has selected, exactly as a browser reads it: set it to a
    // value no option carries and it keeps none.
    Object.defineProperty(box, 'value', {
      get() {
        const found = box.children.find((option) => option.value === selected);
        if (found !== undefined) return found.value;
        return box.children[0]?.value ?? '';
      },
      set(value) {
        selected = box.children.some((option) => option.value === value) ? value : undefined;
      },
    });
  } else {
    box.value = '';
  }
  const classes = () => box.className.split(' ').filter((name) => name !== '');
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
      if (on === true) box.classList.add(name);
      else box.classList.remove(name);
    },
  };
  return box;
}

/**
 * Open the built page against a stand-in DOM. `answers.agents` is the family the `agent` node reports
 * (`rows`), or the failure it answers with (`error`); a test may change either between reads.
 */
async function open({ rows = [MAIN], error = null } = {}) {
  const calls = [];
  const answer = { rows, error };
  const dom = {
    activeElement: null,
    ids: new Map(),
    body: null,
    title: '',
    listeners: {},
    addEventListener(name, handler) {
      (dom.listeners[name] ??= []).push(handler);
    },
    dispatch(name, event = {}) {
      for (const handler of dom.listeners[name] ?? []) {
        handler({ type: name, preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
    getElementById(id) {
      if (!dom.ids.has(id)) dom.ids.set(id, element(id.endsWith('Target') ? 'select' : 'div', dom));
      return dom.ids.get(id);
    },
    createElement: (tag) => element(tag, dom),
    createTextNode: (text) => element('#text', dom),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  dom.body = element('body', dom);

  const values = {
    'timer.list': () => ({ ok: true, value: [] }),
    // The one read these tests are about: the family the `agent` node runs.
    'agent.agents': () =>
      answer.error === null
        ? { ok: true, value: { agents: answer.rows } }
        : { ok: false, error: answer.error },
    'timer.set': () => ({ ok: true, value: 'set timer id=1: ok' }),
    'timer.cancel': () => ({ ok: true, value: 'cancelled' }),
  };

  const sandbox = {
    document: dom,
    navigator: {},
    location: { pathname: '/panel/timer', hash: '' },
    history: {
      replaceState: (_state, _title, hash) => {
        sandbox.location.hash = hash;
      },
    },
    // What `/sdk/i18n-client.js` puts on the page: the node's catalog, and the one binding the page
    // builds its own sentences with.
    resourceFromDocument: () => 'resource',
    resourceTexts: () => TEXTS,
    currentLocale: () => 'en',
    window: {
      addEventListener(name, handler) {
        (windowListeners[name] ??= []).push(handler);
      },
      NodeAgentEvents: {
        connect: (url) => ({ url, readyState: 0 }),
      },
    },
    fetch: async (_url, options) => {
      const { tool, args } = JSON.parse(options.body);
      calls.push({ tool, args });
      const answerOf = values[tool];
      const reply = answerOf === undefined ? { ok: false, error: `no such tool: ${tool}` } : answerOf(args);
      return { json: async () => reply };
    },
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, Math.min(Number(ms) || 0, 50));
      timer.unref?.();
      return timer;
    },
    clearTimeout,
    setInterval: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearInterval,
    console,
  };
  const windowListeners = {};
  sandbox.window.dispatchEvent = (name) => {
    for (const handler of windowListeners[name] ?? []) handler({ type: name, preventDefault() {} });
  };

  vm.createContext(sandbox);
  vm.runInContext(BODY, sandbox);
  await settle();

  /** The options a select offers, in the order the page drew them. */
  const options = (select) => select.children.filter((child) => child.tagName === 'OPTION');

  return {
    dom,
    calls,
    answer,
    options,
    /** One more read of the family, the way the page's own timer or a reopened form asks for one. */
    readAgents: () => sandbox.refreshAgents(),
    /** Open a form the way its button does: the hash the shell would move to, then the event. */
    openView: async (view) => {
      sandbox.location.hash = `#/${view}`;
      sandbox.window.dispatchEvent('hashchange');
      await settle();
    },
    alarmTarget: dom.getElementById('alarmTarget'),
    alarmNote: dom.getElementById('alarmTargetNote'),
    alarmForm: dom.getElementById('alarmForm'),
    alarmMessage: dom.getElementById('alarmMessage'),
    alarmAt: dom.getElementById('alarmAt'),
    countdownTarget: dom.getElementById('countdownTarget'),
    countdownNote: dom.getElementById('countdownTargetNote'),
    countdownForm: dom.getElementById('countdownForm'),
    countdownMessage: dom.getElementById('countdownMessage'),
    countdownMinutes: dom.getElementById('countdownMinutes'),
  };
}

test('both forms offer every agent the family runs, with the state it is in', async () => {
  const page = await open({ rows: [MAIN, HELPER] });
  assert.deepEqual(
    page.options(page.alarmTarget).map((option) => option.textContent),
    ['agent · idle', '↳ helper · generating…'],
  );
  assert.deepEqual(
    page.options(page.countdownTarget).map((option) => option.value),
    ['agent', 'helper'],
  );
});

test('a form starts on `agent`, and on the first agent a family without one runs', async () => {
  const withAgent = await open({ rows: [HELPER, MAIN] });
  assert.equal(withAgent.alarmTarget.value, 'agent');
  assert.equal(withAgent.countdownTarget.value, 'agent');

  const renamed = await open({
    rows: [{ ...MAIN, name: 'main' }, { ...HELPER, parent: 'main' }],
  });
  assert.equal(renamed.alarmTarget.value, 'main');
  assert.equal(renamed.countdownTarget.value, 'main');
});

test('a target the list no longer carries is kept, not replaced by another agent', async () => {
  const page = await open({ rows: [MAIN, HELPER] });
  // The reader picks the sub-agent on the alarm form.
  page.alarmTarget.value = 'helper';
  page.alarmTarget.dispatchEvent({ type: 'change' });
  // …and it is destroyed before the form is submitted: the next answer no longer lists it.
  page.answer.rows = [MAIN];
  await page.readAgents();

  assert.deepEqual(
    page.options(page.alarmTarget).map((option) => option.value),
    ['agent', 'helper'],
  );
  assert.equal(page.alarmTarget.value, 'helper');
  assert.equal(
    page.options(page.alarmTarget)[1].textContent,
    `helper · ${t('agent.kept')}`,
    'the kept row says it is not in the list',
  );
  // The countdown form was on the default, so it follows the list rather than keeping a row.
  assert.deepEqual(
    page.options(page.countdownTarget).map((option) => option.value),
    ['agent'],
  );
});

test('a failed read keeps the choice and says why, beside the field', async () => {
  const page = await open({ rows: [MAIN, HELPER] });
  page.alarmTarget.value = 'helper';
  page.alarmTarget.dispatchEvent({ type: 'change' });

  page.answer.error = 'no such node for user: agent';
  await page.readAgents();

  assert.equal(page.alarmTarget.value, 'helper', 'the target the form held is still the target');
  assert.deepEqual(
    page.options(page.alarmTarget).map((option) => option.value),
    ['agent', 'helper'],
  );
  assert.equal(page.alarmNote.hidden, false);
  assert.equal(
    page.alarmNote.textContent,
    t('agent.unavailable', { error: 'no such node for user: agent' }),
  );
  assert.equal(page.countdownNote.hidden, false, 'both forms say the same thing');

  // A read that works again takes the note away, and a target that is back in the list is a row of
  // the list again rather than a kept one.
  page.answer.error = null;
  page.answer.rows = [MAIN, HELPER];
  await page.readAgents();
  assert.equal(page.alarmNote.hidden, true);
  assert.equal(page.alarmNote.textContent, '');
  assert.deepEqual(
    page.options(page.alarmTarget).map((option) => option.textContent),
    ['agent · idle', '↳ helper · generating…'],
  );
});

test('opening a form reads the family again, so an agent it gained is offered', async () => {
  const page = await open({ rows: [MAIN] });
  assert.deepEqual(
    page.options(page.countdownTarget).map((option) => option.value),
    ['agent'],
  );
  page.answer.rows = [MAIN, HELPER];
  await page.openView('countdown');
  assert.deepEqual(
    page.options(page.countdownTarget).map((option) => option.value),
    ['agent', 'helper'],
  );
});

test('an alarm and a countdown both submit the agent the form is showing', async () => {
  const page = await open({ rows: [MAIN, HELPER] });

  page.alarmMessage.value = 'the oven';
  page.alarmAt.value = '07:30';
  page.alarmTarget.value = 'helper';
  page.alarmTarget.dispatchEvent({ type: 'change' });
  page.alarmForm.dispatchEvent({ type: 'submit' });
  await settle();

  const alarm = page.calls.filter((call) => call.tool === 'timer.set').at(-1);
  assert.equal(alarm.args.agent, 'helper');
  assert.equal(alarm.args.mode, 'alarm');
  assert.equal(alarm.args.at, '07:30');

  page.countdownMessage.value = 'the tea';
  page.countdownMinutes.value = '5';
  page.countdownTarget.value = 'agent';
  page.countdownTarget.dispatchEvent({ type: 'change' });
  page.countdownForm.dispatchEvent({ type: 'submit' });
  await settle();

  const countdown = page.calls.filter((call) => call.tool === 'timer.set').at(-1);
  assert.equal(countdown.args.agent, 'agent');
  assert.equal(countdown.args.mode, 'countdown');
  assert.equal(countdown.args.after_seconds, 300);
});
