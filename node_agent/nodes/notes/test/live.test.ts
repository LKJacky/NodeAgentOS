// The notes page is an HTML asset, not a module, so it is exercised the way a browser gets it:
// the page the node hands out is read, its script runs against a stand-in DOM, and the node's
// answers are delivered by hand. What these tests pin down is the live part — a pause in the typing
// is one write, a document that moved on is a question rather than an overwrite, a change from
// elsewhere waits while the reader is mid-sentence, a write that did not land costs nothing, and a
// reader who leaves mid-sentence finds their words where they left them.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import MarkdownIt from 'markdown-it';
import { pageOf } from './support.ts';

const HTML = await pageOf();
const SCRIPT = HTML.slice(
  HTML.lastIndexOf('<script>') + '<script>'.length,
  HTML.lastIndexOf('</script>'),
);

/** Every id the page looks up: a stand-in box is made for each, so the page's own `$()` works. */
const IDS = [
  'workspace',
  'toast',
  'count',
  'list',
  'query',
  'clear',
  'tagFilter',
  'tagNames',
  'title',
  'tag',
  'text',
  'preview',
  'previewToggle',
  'charCount',
  'editorTitle',
  'editorMeta',
  'del',
  'save',
  'saveLabel',
  'cancel',
  'add',
  'newMemo',
  'back',
  'tab-library',
  'tab-editor',
  'sync',
  'syncLabel',
  'state',
  'stateLabel',
  'notice',
  'noticeText',
  'noticeActions',
];

type Box = ReturnType<typeof element>;
type Click = (event: { type: string }) => void;

/** An element carrying only what the page touches: children, a value, the classes it toggles and the
 *  listeners it attaches. No layout, no selectors — the page uses neither. */
function element(tag: string, dom: { active: Box | null }) {
  const box = {
    tagName: tag.toUpperCase(),
    children: [] as Box[],
    listeners: {} as Record<string, Click[]>,
    dataset: {} as Record<string, string>,
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    type: '',
    title: '',
    hidden: false,
    disabled: false,
    selectionStart: 0,
    append(...nodes: Box[]) {
      box.children.push(...nodes);
    },
    replaceChildren(...nodes: Box[]) {
      box.children = [...nodes];
    },
    addEventListener(name: string, handler: Click) {
      (box.listeners[name] ??= []).push(handler);
    },
    dispatchEvent(event: { type: string }) {
      for (const handler of box.listeners[event.type] ?? []) handler(event);
    },
    setAttribute(name: string, value: unknown) {
      (box as unknown as Record<string, unknown>)[name] = String(value);
    },
    removeAttribute(name: string) {
      delete (box as unknown as Record<string, unknown>)[name];
    },
    focus() {
      dom.active = box;
    },
    setSelectionRange(start: number) {
      box.selectionStart = start;
    },
    // No selectors in this stand-in (the page uses none for anything else): the preview asks for the
    // links it would point at a new tab, and an empty list is the honest answer.
    querySelectorAll: () => [] as { target: string; rel: string }[],
    remove() {},
  };

  const classes = () => box.className.split(' ').filter((name) => name !== '');
  const classList = {
    contains: (name: string) => classes().includes(name),
    add: (name: string) => {
      if (!classes().includes(name)) box.className = [...classes(), name].join(' ');
    },
    remove: (name: string) => {
      box.className = classes()
        .filter((each) => each !== name)
        .join(' ');
    },
    toggle: (name: string, on?: boolean) => {
      if (on === true) classList.add(name);
      else if (on === false) classList.remove(name);
      else if (classList.contains(name)) classList.remove(name);
      else classList.add(name);
    },
  };

  return Object.assign(box, { classList });
}

/** One document as the node would hold it. `revision` is the number the page keeps and sends back. */
type Kept = { id: number; title: string; text: string; tag: string; revision: number };

const doc = (id: number, title: string, text: string, revision: number): Kept => ({
  id,
  title,
  text,
  tag: '',
  revision,
});

/** What `list` and the event carry: the same document without its body. */
const summary = (entry: Kept) => ({
  id: entry.id,
  title: entry.title,
  tag: entry.tag,
  bytes: entry.text.length,
  lines: entry.text === '' ? 0 : entry.text.split('\n').length,
  at: '2026-01-01T00:00:00.000Z',
  revision: entry.revision,
});

/** How one capability is answered: a value, a refusal (`{error}`), or a thrown connection. */
type Answer = (args: Record<string, unknown>) => unknown;

/** Open the page against a stand-in DOM. `memos` is what the node holds, `storage` is carried from
 *  one opening to the next (which is what a browser does), and `answers` replaces the node's
 *  behaviour call by call — a conflict, a refusal, or nothing at all. */
async function openPage(
  options: {
    memos?: Kept[];
    storage?: Map<string, string>;
    answers?: Record<string, Answer>;
  } = {},
) {
  const memos = options.memos ?? [];
  const storage = options.storage ?? new Map<string, string>();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const timers: { id: number; at: number; run: () => void; done: boolean }[] = [];
  const feeds: { send: (value: unknown) => void; open: () => void }[] = [];
  const made: Kept[] = [];
  const answers: Record<string, Answer> = { ...options.answers };
  let seq = 0;
  let clock = 0;
  let online = true;

  const held = () => [...made, ...memos];
  const find = (wanted: unknown) => held().find((entry) => entry.id === Number(wanted));

  answers['notes.get'] ??= (args) => {
    const entry = find(args.id);
    if (entry === undefined) return { error: `no memo with id=${String(args.id)}` };
    return { ...entry, at: '2026-01-01T00:00:00.000Z' };
  };
  answers['notes.list'] ??= () => held().map(summary);
  answers['notes.search'] ??= () => ({ docs: 0, totalDocs: 0, more: false, hits: [] });
  answers['notes.tags'] ??= () => [];
  answers['notes.add'] ??= (args) => {
    const entry: Kept = {
      id: 9,
      title: String(args.title),
      text: String(args.text ?? ''),
      tag: String(args.tag ?? ''),
      revision: 1,
    };
    made.push(entry);
    return `added id=${entry.id} rev=1: ${entry.title}`;
  };
  answers['notes.update'] ??= (args) => {
    const entry = find(args.id);
    if (entry === undefined) return { error: `no memo with id=${String(args.id)}` };
    entry.revision += 1;
    if (typeof args.title === 'string') entry.title = args.title;
    if (typeof args.text === 'string') entry.text = args.text;
    if (typeof args.tag === 'string') entry.tag = args.tag;
    return `updated id=${entry.id} rev=${entry.revision}: ${entry.title}`;
  };
  answers['notes.delete'] ??= (args) => `deleted id=${String(args.id)}: t`;

  const dom = {
    active: null as Box | null,
    ids: new Map<string, Box>(),
    listeners: {} as Record<string, Click[]>,
    getElementById: (id: string) => dom.ids.get(id),
    createElement: (tag: string) => element(tag, dom),
    createTextNode: (text: string) => ({ tagName: '#text', textContent: text }),
    addEventListener: (name: string, handler: Click) => {
      (dom.listeners[name] ??= []).push(handler);
    },
  };
  for (const id of IDS) dom.ids.set(id, element('div', dom));
  // The markup puts the preview away (`<div ... id="preview" hidden>`), and the switch beside
  // "Note" is what brings it on screen. A stand-in box is a div, so it starts as one.
  dom.ids.get('preview')!.hidden = true;
  // A `<select>` shows its first option until something else is chosen: the page's tag filter asks
  // for its value before anything was set, and "All tags" is the answer a browser gives.
  const select = element('select', dom);
  let chosen: string | undefined;
  Object.defineProperty(select, 'value', {
    get: () => chosen ?? select.children[0]?.value ?? '',
    set: (value: string) => {
      chosen = String(value);
    },
  });
  dom.ids.set('tagFilter', select);

  const windowListeners: Record<string, Click[]> = {};
  const sandbox = {
    document: dom,
    location: { pathname: '/panel/notes' },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, String(value));
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    window: {
      addEventListener: (name: string, handler: Click) => {
        (windowListeners[name] ??= []).push(handler);
      },
      // The node inlines markdown-it into the page; here the same library is handed to the
      // stand-in window, so the preview is drawn by the real renderer rather than by a fake.
      markdownit: MarkdownIt,
    },
    confirm: () => true,
    // The node answers JSON over the wire, so the page always sees a fresh object; a connection that
    // is not there throws the way `fetch` does.
    fetch: async (_url: string, init: { body: string }) => {
      const { tool, args } = JSON.parse(init.body) as {
        tool: string;
        args: Record<string, unknown>;
      };
      calls.push({ tool, args });
      if (!online) throw new Error('the bus is away');
      const answer = answers[tool];
      const value = answer === undefined ? null : answer(args);
      const failed =
        value !== null &&
        typeof value === 'object' &&
        'error' in (value as Record<string, unknown>);
      const body = failed
        ? { ok: false, error: String((value as { error: string }).error) }
        : { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
      return { ok: true, json: async () => body };
    },
    EventSource: class {
      onmessage: (event: { data: string }) => void = () => {};
      onopen: () => void = () => {};
      onerror: () => void = () => {};
      constructor() {
        feeds.push({
          send: (value: unknown) => this.onmessage({ data: JSON.stringify({ value }) }),
          open: () => this.onopen(),
        });
      }
    },
    // The clock is the test's, and so are the timers: fired by hand, never left to a real second
    // passing. `advance` runs whatever is due, in order, and lets the page's promises settle.
    setTimeout: (run: () => void, ms = 0) => {
      const timer = { id: ++seq, at: clock + Math.max(0, Number(ms) || 0), run, done: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id: number) => {
      const timer = timers.find((each) => each.id === id);
      if (timer !== undefined) timer.done = true;
    },
  };

  (sandbox.window as typeof sandbox.window & { NodeAgentEvents: unknown }).NodeAgentEvents = {
    connect: (url: string) => new sandbox.EventSource(url),
  };
  vm.runInContext(SCRIPT, vm.createContext(sandbox), { filename: 'notes-ui.js' });

  //: One macrotask: every promise the page chained off the last answer has run by then.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms: number) => {
    const target = clock + ms;
    for (;;) {
      const due = timers
        .filter((timer) => !timer.done && timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      clock = due.at;
      due.done = true;
      due.run();
      await settle();
    }
    clock = target;
    await settle();
  };

  const box = (id: string) => {
    const found = dom.ids.get(id);
    assert.ok(found, `the page has no #${id}`);
    return found;
  };

  const page = {
    dom,
    calls,
    storage,
    get feed() {
      const feed = feeds.at(-1);
      assert.ok(feed, 'the page opened no event feed');
      return feed;
    },
    advance,
    settle,
    box,
    /** What the page shows in a label. */
    text: (id: string) => box(id).textContent,
    /** What a field holds. */
    value: (id: string) => box(id).value,
    state: () => box('state').dataset.state,
    noticeButtons: () => box('noticeActions').children.map((child) => child.textContent),
    /** Type into a field the way a reader does: one `input` event per keystroke. */
    type: (id: string, value: string) => {
      box(id).value = value;
      box(id).dispatchEvent({ type: 'input' });
    },
    /** Tap the memo in the library, which is what opens the editor on it. */
    open: async (id: number) => {
      const card = box('list').children.find((each) =>
        each.children.some((child) => String(child.textContent).includes(`#${id}`)),
      );
      assert.ok(card, `the library shows no card for #${id}`);
      card.dispatchEvent({ type: 'click' });
      await settle();
    },
    click: async (label: string) => {
      const button = box('noticeActions').children.find((each) => each.textContent === label);
      assert.ok(button, `the bar offers no "${label}"`);
      button.dispatchEvent({ type: 'click' });
      await settle();
    },
    offline: () => {
      online = false;
    },
    online: () => {
      online = true;
    },
    writes: () => calls.filter(({ tool }) => tool === 'notes.add' || tool === 'notes.update'),
  };

  await settle();
  return page;
}

test('a pause in the typing is one write, and the page says which state it is in', async () => {
  const page = await openPage();

  page.type('text', 'milk');
  await page.advance(300);
  page.type('text', 'milk, bread');
  await page.advance(300);
  page.type('text', 'milk, bread, eggs');

  assert.equal(page.writes().length, 0, 'nothing is sent while the reader is still typing');
  assert.equal(page.text('stateLabel'), 'Unsaved changes…', 'the page says the text is not stored');
  assert.equal(page.state(), 'editing');

  await page.advance(600);
  assert.equal(page.writes().length, 1, 'one write for the pause, not one per keystroke');
  assert.equal(page.writes()[0]?.tool, 'notes.add');
  assert.equal(page.writes()[0]?.args.text, 'milk, bread, eggs');
  assert.match(page.text('stateLabel'), /^Saved/, 'and then it says the text is stored');
  assert.equal(page.state(), 'saved');

  // Nothing keeps writing on its own once what is on screen is what the node has.
  await page.advance(5000);
  assert.equal(page.writes().length, 1);
});

test('the preview draws the note as Markdown, and never as HTML the reader typed', async () => {
  const page = await openPage();

  assert.equal(page.box('preview').hidden, true, 'a note starts as the text the reader types');
  page.type('text', '# Pancakes\n\n**two** eggs\n\n<img src=x onerror=alert(1)>');
  page.box('previewToggle').dispatchEvent({ type: 'click' });
  await page.settle();

  assert.equal(page.box('preview').hidden, false, 'the preview is what is on screen');
  assert.equal(page.box('text').hidden, true, 'the textarea steps aside instead of overlapping it');
  assert.equal(
    page.text('previewToggle'),
    'Edit',
    'the switch now offers the way back to the text',
  );
  assert.equal(
    String((page.box('previewToggle') as unknown as Record<string, unknown>)['aria-pressed']),
    'true',
    'and that it is on',
  );

  // The note is drawn by a real Markdown renderer, and it is drawn from what the textarea holds.
  const drawn = page.box('preview').innerHTML;
  assert.match(drawn, /<h1>Pancakes<\/h1>/);
  assert.match(drawn, /<strong>two<\/strong>/);
  // Raw HTML is disabled: a note is text, never markup this page runs.
  assert.match(drawn, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(drawn, /<img/);

  // The preview is the same text: what is typed while it is on screen shows up there too.
  page.type('text', '- one\n- *two*');
  await page.settle();
  const again = page.box('preview').innerHTML;
  assert.match(again, /<li>one<\/li>/);
  assert.match(again, /<em>two<\/em>/);

  page.box('previewToggle').dispatchEvent({ type: 'click' });
  await page.settle();
  assert.equal(page.box('preview').hidden, true, 'the way back hides the preview');
  assert.equal(page.box('text').hidden, false, 'and the textarea holds the same words');
  assert.equal(page.value('text'), '- one\n- *two*');
});

test('a document that moved on is a conflict, not an overwrite', async () => {
  const page = await openPage({
    memos: [doc(3, 'groceries', 'milk', 2)],
    answers: {
      // The node is at revision 3: the write names 2, so it is refused instead of landing.
      'notes.update': () => ({
        error:
          'conflict: memo id=3 has changed (expected revision 2, found 3); reload it, or send expectedRevision=3 to overwrite',
      }),
    },
  });

  await page.open(3);
  assert.equal(page.value('text'), 'milk');

  page.type('text', 'milk and bread');
  await page.advance(600);

  const update = page.writes().find(({ tool }) => tool === 'notes.update');
  assert.ok(update, 'the page wrote');
  assert.equal(update.args.expectedRevision, 2, 'the write named the revision it read');
  assert.equal(page.value('text'), 'milk and bread', "the reader's text was not replaced");
  assert.equal(page.state(), 'conflict');
  assert.equal(page.box('notice').hidden, false, 'the reader is offered the two ways out');
  assert.deepEqual(page.noticeButtons(), ['Reload', 'Keep mine']);

  // Nothing is retried behind the reader's back: a conflict waits for the decision.
  await page.advance(10_000);
  assert.equal(page.writes().length, 1);
});

test('the two ways out of a conflict: keep mine, or reload the node copy', async () => {
  const conflict = () => ({
    error:
      'conflict: memo id=3 has changed (expected revision 2, found 3); reload it, or send expectedRevision=3 to overwrite',
  });
  const mine = await openPage({
    memos: [doc(3, 'groceries', 'milk', 2)],
    answers: { 'notes.update': conflict },
  });
  await mine.open(3);
  mine.type('text', 'mine');
  await mine.advance(600);
  assert.equal(mine.state(), 'conflict');

  // "Keep mine" sends the same text again, now naming the revision the conflict reported.
  await mine.click('Keep mine');
  const again = mine
    .writes()
    .filter(({ tool }) => tool === 'notes.update')
    .at(-1);
  assert.equal(mine.writes().length, 2, 'keeping mine writes a second time');
  assert.equal(again?.args.expectedRevision, 3, 'overwriting names the revision it was told about');
  assert.equal(again?.args.text, 'mine');

  // "Reload" takes the node's copy, and the editor follows it.
  const theirs = await openPage({
    memos: [doc(3, 'groceries', 'milk, bread', 3)],
    answers: { 'notes.update': conflict },
  });
  await theirs.open(3);
  theirs.type('text', 'mine');
  await theirs.advance(600);
  assert.equal(theirs.state(), 'conflict');

  await theirs.click('Reload');
  assert.equal(theirs.value('text'), 'milk, bread', "the node's copy is what the editor shows");
  assert.equal(theirs.state(), 'saved');
  assert.equal(theirs.box('notice').hidden, true, 'the bar closes when a choice is made');
});

test('a change from elsewhere waits while the reader is mid-sentence', async () => {
  const entry = doc(3, 'groceries', 'milk', 2);
  const page = await openPage({ memos: [entry] });
  await page.open(3);

  page.type('text', 'milk and'); // the reader is in the middle of a sentence
  await page.advance(100); // …and the pause has not come yet

  // Someone else saved the memo in the meantime. The event says which revision it is at now.
  entry.text = 'milk, bread';
  entry.revision = 3;
  page.feed.send([summary(entry)]);
  await page.settle();

  assert.equal(page.value('text'), 'milk and', 'the text under the cursor is untouched');
  assert.equal(page.state(), 'held', 'and the page says why it is holding it back');
  assert.deepEqual(page.noticeButtons(), ['Reload', 'Keep mine']);

  // Reloading is the reader's call, and then the editor shows what the node has.
  await page.click('Reload');
  assert.equal(page.value('text'), 'milk, bread');
  assert.equal(page.state(), 'saved');

  // A change nobody is typing through simply arrives: no bar, no decision to make.
  entry.text = 'milk, bread, eggs';
  entry.revision = 4;
  page.feed.send([summary(entry)]);
  await page.settle();
  assert.equal(page.value('text'), 'milk, bread, eggs', 'the editor follows the document');
  assert.equal(page.box('notice').hidden, true);
});

test('a write that did not land keeps the text, and is tried again', async () => {
  const page = await openPage({ memos: [doc(3, 'groceries', 'milk', 1)] });
  await page.open(3);

  page.offline();
  page.type('text', 'milk and bread');
  await page.advance(600);

  assert.equal(page.state(), 'failed');
  assert.match(page.text('stateLabel'), /^Not saved/);
  assert.equal(page.value('text'), 'milk and bread', 'the text stays where the reader put it');
  assert.ok(page.storage.get('notes.draft.notes.3'), 'the draft is on disk too');

  // The connection comes back: the retry saves what is still on screen, with nobody's help.
  page.online();
  await page.advance(4200);
  assert.equal(page.state(), 'saved', 'the retry landed');
  const update = page
    .writes()
    .filter(({ tool }) => tool === 'notes.update')
    .at(-1);
  assert.equal(update?.args.text, 'milk and bread');
  assert.equal(update?.args.expectedRevision, 1);
});

test('leaving mid-sentence and coming back finds the words, unsaved and whole', async () => {
  const storage = new Map<string, string>();
  const first = await openPage({ memos: [doc(3, 'groceries', 'milk', 2)], storage });
  await first.open(3);

  first.type('text', 'milk, bread, eggs');
  await first.advance(200); // the tab is closed before the pause: nothing was written
  assert.equal(first.writes().length, 0, 'the debounce had not fired yet');
  assert.ok(storage.get('notes.draft.notes.3'), 'the draft is already on disk');

  // A new page in the same browser: same storage, so the memo and its unsaved text come back.
  const second = await openPage({ memos: [doc(3, 'groceries', 'milk', 2)], storage });
  assert.equal(second.value('text'), 'milk, bread, eggs', 'the words are back where they were');
  assert.equal(second.text('editorTitle'), 'Edit memo', 'and so is the memo they belong to');
  assert.equal(second.state(), 'editing', 'and the page says they are not stored yet');

  // …and they land without the reader having to retype anything.
  await second.advance(600);
  const update = second
    .writes()
    .filter(({ tool }) => tool === 'notes.update')
    .at(-1);
  assert.ok(update, 'the restored draft was saved');
  assert.equal(update.args.text, 'milk, bread, eggs');
  assert.equal(update.args.expectedRevision, 2, 'against the revision the draft was written on');
  assert.equal(second.state(), 'saved');
  assert.equal(storage.get('notes.draft.notes.3'), undefined, 'the draft is gone once it landed');
});

test('a draft and an open memo left by the old memory page are still the reader’s', async () => {
  // The page kept its drafts under `memory.draft.<node>` until the node was renamed: what a reader
  // typed there before the rename is not something the rename may cost them.
  const storage = new Map<string, string>([
    ['memory.open.memory', '3'],
    [
      'memory.draft.memory.3',
      JSON.stringify({
        id: 3,
        revision: 2,
        title: 'groceries',
        text: 'milk, bread',
        tag: '',
        at: '2026-01-01T00:00:00.000Z',
      }),
    ],
  ]);
  const page = await openPage({ memos: [doc(3, 'groceries', 'milk', 2)], storage });
  await page.settle();

  assert.equal(page.value('text'), 'milk, bread', 'the unsaved text came back');
  assert.equal(page.text('editorTitle'), 'Edit memo', 'on the memo it was written on');
  assert.equal(page.state(), 'editing', 'and the page still says it is not stored');
  assert.equal(storage.get('memory.draft.memory.3'), undefined, 'the old draft moved, not copied');
  assert.ok(storage.get('notes.draft.notes.3'), 'to the key this page writes itself');

  // …and the words land without anyone retyping them.
  await page.advance(600);
  const update = page.writes().find(({ tool }) => tool === 'notes.update');
  assert.ok(update, 'the restored draft was saved');
  assert.equal(update.args.text, 'milk, bread');
  assert.equal(update.args.expectedRevision, 2, 'against the revision it was written on');
  assert.equal(storage.get('notes.draft.notes.3'), undefined, 'the draft is gone once it landed');
});

test('a narrow page opens a memo as its own page and back returns to the list', async () => {
  const page = await openPage({
    memos: [{ id: 1, title: 'One', text: 'body', tag: '', revision: 1 }],
  });

  await page.open(1);
  assert.equal(page.box('workspace').dataset.panel, 'editor', 'the memo replaced the list');

  page.box('back').dispatchEvent({ type: 'click' });
  await page.settle();
  assert.equal(page.box('workspace').dataset.panel, 'library', 'back returns to the index');
});
