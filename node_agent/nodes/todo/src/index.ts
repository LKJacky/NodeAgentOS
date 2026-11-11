// todo: a todo app living on the bus. It holds two things — a tickable list and a Today card — and
// both are stored through the history node when one is available, staying process-local when it is not.
//
// The list is six capabilities: list / add / update / toggle / remove / move. `list` takes an optional
// filter, because the questions worth asking about a todo list are "everything", "what is left" and
// "what is done".
//
// The order of the list is two rules and no clock: the open ones come before the done ones, and inside a
// group the todos somebody has moved come in the order they were put there (`order`), the rest by the
// default rule — the newest id first. `order` is absent until a move happens, so a store written before
// it existed loads and reads exactly as it did; the first move hands every todo a place (1000, 2000, …)
// in the order the list already had, and a later move only splits the gap between two neighbours.
// Nothing here sorts by a timestamp: an edit or a check-off must not reshuffle a list a human arranged,
// and "when did I last touch this" is not the same question as "where did I put it". Today is *not* a view of that list: it is free text the human or the model writes, plus the
// buttons the model puts on it (`today` / `set-today` / `press` / `presses`). Nothing outside knows how
// any of it is stored, and the node does not know who is asking — the model may be checking your
// shopping item off through run_on_node, the page may be doing it through /call.
//
// A button is `{label, message}`: the page shows the label, and pressing it makes *this node* send the
// message to the target's `chat_no_wait` as one user chat turn — so the model can leave one-tap actions
// on Today ('look at what is left today') without the page knowing anything about the agent. The target
// is `agent` unless a deployment names another one (`NODE_AGENT_TODO_TARGET`). When the target cannot
// take a message the press still succeeds as a *call* and answers honestly: `{sent: false, reason}` says
// exactly which capability was missing, instead of pretending the message went somewhere.
//
// Every write also publishes one snapshot of what this node holds (list, Today, the last presses) on the
// topic "todo" (its own id). The capabilities answer whoever called; the event reaches whoever is
// listening, which is how a page learns about a write it did not make itself. Both paths run through the
// same methods below, so there is no way to change anything here without the page hearing about it —
// model, curl and page all end up in the same place.
import { readFileSync } from 'node:fs';
import {
  Node,
  loadResource,
  paintPage,
  type NodeContext,
  type NodeHandlers,
  type Resource,
  type ToolArgs,
} from '@node-agent/sdk';

/** This node's bus address: the namespace of its capabilities (`todo.add`) and the topic its writes
 *  are published on. The host gives a node no id of its own -- it builds one instance per call -- so
 *  the package's name is the constant every instance answers to. */
const NODE_ID = 'todo';

/** The page's capability: the one capability whose name is also its row in the directory. */
const PANEL = 'ui';

/** Every capability this node exposes, in the order the directory has always listed them. The schemas
 *  themselves live in package.json (`node.caps`), where the host reads them. */
const CAPABILITIES = [
  'today',
  'set-today',
  'press',
  'presses',
  'list',
  'add',
  'update',
  'toggle',
  'remove',
  'move',
  PANEL,
] as const;

/** The unit the capability probe reads: nothing ever writes it, so "it loaded" is the whole answer. */
const PROBE_UNIT = '__todo_probe__';

/** What a failed probe says when there is no history node to ask -- the bus's own words for a
 *  target nobody registered in this user (`no such node for user: history`) and for a capability a
 *  registered node does not answer, and the ones a node without `load` answers with. */
const NO_HISTORY =
  /no node provides|no such node|unknown node|not registered|has no handler|does not implement/i;

/** Who a pressed button talks to unless the deployment names another one. */
const DEFAULT_TARGET = process.env.NODE_AGENT_TODO_TARGET?.trim() || 'agent';

/** One todo. `at` is when it was last written, `doneAt` when it was checked off (null while it is
 *  open) — the list is the whole record, so a done item stays in it. `order` is where a human put it:
 *  absent until somebody moves it, and only ever compared with the todos of its own group (the open
 *  ones before the done ones). */
export type Todo = {
  id: number;
  title: string;
  text: string;
  done: boolean;
  at: string;
  doneAt: string | null;
  order?: number;
};

/** One button on Today: `label` is what the page shows, `message` is the user chat turn a press sends
 *  to the target. */
export type TodayButton = { label: string; message: string };

/** Today: free text (no todo behind it) and the buttons the model put on it. `updatedAt` is when the
 *  last write arrived, `null` for the shape the node starts with. */
export type Today = { text: string; buttons: TodayButton[]; updatedAt: string | null };

/** What one press of a Today button did — and the log entry kept for it. `sent` is whether the message
 *  reached the target's `chat_no_wait`; `reason` is why it did not, in the words of whoever refused. */
export type PressReceipt = {
  index: number;
  label: string;
  target: string;
  sent: boolean;
  reason?: string;
  at: string;
};

type TodoIndex = {
  ids: number[];
  nextId: number;
  /** Always null here. It is written only so that a reader which predates free-text Today (it checks
   *  this field against "null or an id in the list") can still parse the unit; Today lives in the
   *  `today` unit and names no item. */
  todayId: null;
  /** The shape marker. A reader that does not know it ignores it; one that does can tell a migrated
   *  store from a fresh one. */
  v: number;
};
type HistoryUnit = { revision: number; meta: unknown };
type LoadedHistory = { unit: HistoryUnit | null };
type SavedHistory = { unit: HistoryUnit };
const HISTORY_UNIT = 'todos';
const TODAY_UNIT = 'today';
const todoUnit = (id: number): string => `${HISTORY_UNIT}.${id}`;

/** The shape both units carry: 2 is "the list index has no focus, and Today is free text in its own
 *  unit". Anything a reader does not know is ignored, so a store written here stays readable to code
 *  that predates it — the rule being that a writer must not make the store unreadable to an older
 *  reader, because one store is shared by every tree on this machine. */
const STORE_VERSION = 2;

/** The filters `list` understands. An unknown one is an error, not "everything". */
const FILTERS = ['all', 'open', 'done'];

/** What the wire may send for one button. A press sends a whole chat turn, so both ends are bounded —
 *  a button is a label and a sentence, not a page of text. */
const BUTTONS_MAX = 8;
const LABEL_MAX = 40;
const MESSAGE_MAX = 500;

/** How many presses the node remembers. A press is a moment, not state: the page shows the last few so
 *  you can see one fired, and a restart starts clean. */
const PRESSES_KEPT = 10;

/** The step between two hand-placed todos. Renumbering uses it, and a move between two neighbours
 *  halves the gap — so one step is room for about ten moves before the gap runs out and the list is
 *  renumbered again ("about", because a gap shrinks by half each time: 1000, 500, 250, … 1). */
const ORDER_STEP = 1000;

/** The node's own page: the Today card and the list under it, drawn for the browser. Content, not
 *  code. */
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

/** The page's words, read from the same place: `npm run build` copies src/i18n beside the page, and
 *  `node.i18n` in package.json points the directory at it. */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

/** The tab's glyph: this node's own drawing, next to the page it belongs to. Content, not code —
 *  the shell renders the `<svg>` it is handed and knows no node's name. */
const ICON = readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');

/** Todos the list starts with. Empty on purpose: what a reader sees here is the stack's setup, not
 *  this module's opinion — todo files what it is given and invents nothing. A seed added here is a
 *  todo every new stack starts with. */
const SEEDS: { title: string; text: string }[] = [];

/** Today as a node that has never been written starts. The text and the buttons are the setup's
 *  business too, so they start empty; built per node, so one node that writes Today cannot rewrite
 *  the card the next node starts with. */
function seedToday(): Today {
  return { text: '', buttons: [], updatedAt: null };
}

/** The one thing worth reading out of a failure: the bus's sentence, not a stack trace. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a node with no history node keeps in this process: the list and the card themselves, because
 *  there is nowhere else for them to live. `started` is false until the first call has worked out
 *  what it holds, so nothing is handed out again on every call. */
type LocalState = { todos: Todo[]; nextId: number; todayCard: Today; started: boolean };

/** What outlives one invocation. The host builds a node per call, so anything that is not in history
 *  is gone by the next one: the presses this node remembers (a press is a moment the page shows, not
 *  a stored unit) and, on a bus with no history node, the list and the card themselves. Keyed per
 *  tenant, because one process can serve more than one. */
type TenantState = { presses: PressReceipt[]; local: LocalState };

const TENANTS = new Map<string, TenantState>();

function tenantState(tenantId: string): TenantState {
  let state = TENANTS.get(tenantId);
  if (state === undefined) {
    state = {
      presses: [],
      local: { todos: [], nextId: 1, todayCard: seedToday(), started: false },
    };
    TENANTS.set(tenantId, state);
  }

  return state;
}

/** The wire carries JSON, not TypeScript: every argument is checked before it is used. */
function text(value: unknown, what: string, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new Error(`${what} wants a string`);

  return value.trim();
}

/** `id` has to be a whole number — a model that sends "3" gets told, instead of a wrong todo. */
function id(args: ToolArgs): number {
  const value = args.id;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('id wants an integer');

  return value;
}

/** The neighbour a move names, checked the same way: a bad one is told apart from a missing one by
 *  the side that asked, so "before wants an integer" says what the caller got wrong. */
function neighbourId(value: unknown, side: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${side} wants an integer (the id of the todo to sit next to)`);
  }

  return value;
}

/** The button a press names. Buttons are numbered from 1, the way a human counts them on the page. */
function buttonIndex(args: ToolArgs): number {
  const value = args.index;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('index wants a positive integer (buttons are numbered from 1)');
  }

  return value;
}

/** A flag is a real boolean: "true" as a string is a caller that has not understood the wire. */
function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what} wants true or false`);

  return value;
}

/** Today's buttons: at most eight, each a `{label, message}` pair of non-empty strings, so a press
 *  always has something to send. An absent array is no buttons, which is a legitimate Today. */
function buttons(value: unknown): TodayButton[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('buttons wants an array');
  if (value.length > BUTTONS_MAX) {
    throw new Error(`buttons wants at most ${BUTTONS_MAX} entries (got ${value.length})`);
  }

  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`buttons[${i}] wants an object with label and message`);
    }
    const { label: shown, message } = entry as Record<string, unknown>;
    const label = text(shown, `buttons[${i}].label`);
    const line = text(message, `buttons[${i}].message`);
    if (label === '') throw new Error(`buttons[${i}].label cannot be empty`);
    if (line === '') throw new Error(`buttons[${i}].message cannot be empty`);
    if (label.length > LABEL_MAX) {
      throw new Error(`buttons[${i}].label is longer than ${LABEL_MAX} characters`);
    }
    if (line.length > MESSAGE_MAX) {
      throw new Error(`buttons[${i}].message is longer than ${MESSAGE_MAX} characters`);
    }

    return { label, message: line };
  });
}

/** Where a todo sits among the hand-placed ones. A todo nobody has moved has no `order`: it sorts
 *  after the placed ones of its group, and among its kind the default rule decides (the caller adds
 *  that as the tie-break, so this answers 0 for "no opinion"). */
function place(a: Todo, b: Todo): number {
  if (a.order === undefined && b.order === undefined) return 0;
  if (a.order === undefined) return 1;
  if (b.order === undefined) return -1;
  return a.order - b.order;
}

/** The place for a todo about to sit between these two neighbours: halfway when both exist, one step
 *  past the edge when only one does, the first place when it is the group's only todo. */
function placement(low: number | null, high: number | null): number {
  if (low === null) return high === null ? ORDER_STEP : high - ORDER_STEP;
  if (high === null) return low + ORDER_STEP;
  return (low + high) / 2;
}

/** todo: keeps one tickable list and one free-form Today card, and answers about both. */
export class TodoNode extends Node {
  readonly handlers: NodeHandlers;
  todos: Todo[] = [];
  nextId = 1;
  todayCard: Today = seedToday();
  private readonly todoRevisions = new Map<number, number>();
  private historyInitialized = false;
  /** The presses this node remembers. They live in the tenant's state, not in this instance: a press
   *  is a moment the page shows and the next call still has to see, while the host builds one
   *  instance per call. */
  private readonly presses: PressReceipt[];
  /** Where the list and the card live when there is no history node; null while they come from the
   *  store, which is then the only copy that outlives an invocation. */
  private local: LocalState | null = null;
  /** Read the store once per invocation, however many capabilities ask for it. */
  private restored: Promise<void> | null = null;

  /** Who a pressed button talks to. A deployment that keeps its agent under another name (or wants
   *  the presses to go somewhere else) says so here. */
  readonly target: string;

  constructor(ctx: NodeContext, target = DEFAULT_TARGET) {
    super(ctx);
    this.target = target;
    this.presses = tenantState(ctx.tenantId).presses;

    // The capability list and the schemas are in package.json (`node.caps`), where the host reads
    // them into the directory, and so is this node's description. These handlers are the whole of
    // what a call can reach, and each one reads this node's units back before it answers.
    this.handlers = Object.fromEntries(
      CAPABILITIES.map((cap) => [
        cap,
        async (args: ToolArgs) => {
          await this.activate();
          return await this.handle(cap, args);
        },
      ]),
    );

    for (const seed of SEEDS) this.addLocal(seed);
  }

  /** Every capability waits for this node's units to be read back: the host builds an instance per
   *  call, so "what this node holds" is a question the store answers, never something an instance
   *  kept from an earlier call. */
  private async activate(): Promise<void> {
    this.restored ??= this.restore();
    await this.restored;
  }

  /** Read this node's private units. History is optional: without that capability the list and Today
   *  live in this process -- keyed by tenant, so every later call finds them -- and stay
   *  process-local. With history, a failed read is an error the caller sees (a node that quietly
   *  started empty would look exactly like data loss), a store with no units yet is simply empty, and
   *  the bootstrap below writes what this node starts with. */
  private async restore(): Promise<void> {
    if (!(await this.hasHistory())) {
      const state = tenantState(this.ctx.tenantId).local;
      this.local = state;
      if (state.started) {
        this.todos = state.todos;
        this.nextId = state.nextId;
        this.todayCard = state.todayCard;
      } else {
        state.started = true;
        this.keepLocal();
      }
      return;
    }

    const loaded = await this.loadUnit(HISTORY_UNIT);
    if (loaded === null) await this.bootstrapHistory();
    else {
      const migrated = this.restoreIndex(loaded.meta);
      await this.loadTodos();
      const today = await this.loadUnit(TODAY_UNIT);
      if (today === null) await this.saveToday();
      else this.todayCard = this.validToday(today.meta);
      this.historyInitialized = true;
      if (migrated) await this.saveIndex();
    }
  }

  /** Hand what this instance holds to the tenant's copy, for the bus that has no history node: that
   *  copy is the only thing the next call will find. */
  private keepLocal(): void {
    if (this.local === null) return;
    this.local.todos = this.todos;
    this.local.nextId = this.nextId;
    this.local.todayCard = this.todayCard;
  }

  /** Reads return what was asked for; writes return confirmation text; `press` returns its receipt.
   *  `ui` returns the page HTML. */
  private async handle(cap: string, args: ToolArgs): Promise<unknown> {
    if (cap === 'today') return this.todayCard;
    if (cap === 'set-today') return this.setToday(args);
    if (cap === 'press') return this.press(args);
    if (cap === 'presses') return this.recent();
    if (cap === 'list') return this.list(args);
    if (cap === 'add') return this.add(args);
    if (cap === 'update') return this.update(args);
    if (cap === 'toggle') return this.toggle(args);
    if (cap === 'remove') return this.remove(args);
    if (cap === 'move') return this.move(args);
    // The page carries this node's own name as a placeholder, filled in here where the node knows
    // what it is called: a name belongs to whoever started it, so the page cannot have it written in.
    // Only the name is substituted — the quotes are the page's, so both the filled and the unfilled
    // page stay valid JavaScript.
    if (cap === PANEL) return paintPage(PAGE, RESOURCE, args).replace('__NODE__', () => NODE_ID);
    throw new Error(
      `todo only provides today / set-today / press / presses / list / add / update / toggle / remove / move / ui (got "${cap}")`,
    );
  }

  /** What is still open first, then what is done; inside a group, the order a human arranged, then
   *  the newest id first. A todo nobody has moved has no `order`, so a list that was never arranged —
   *  including every list stored before `order` existed — reads exactly as it always did. The order
   *  the page shows is the order the model reads. */
  all(): Todo[] {
    return this.sorted().map((todo) => ({ ...todo }));
  }

  /** The same order, over the todos this node holds: what a write rearranges, and what `all` copies. */
  private sorted(): Todo[] {
    const rank = (todo: Todo): number => (todo.done ? 2 : 1);
    return [...this.todos].sort((a, b) => rank(a) - rank(b) || place(a, b) || b.id - a.id);
  }

  /** One group of the list — the open ones or the done ones — as it reads now, minus one todo. */
  private group(done: boolean, exceptId: number): Todo[] {
    return this.sorted().filter((todo) => todo.done === done && todo.id !== exceptId);
  }

  /** Hand every todo a whole place, in the order the list reads now: the one-time step that turns a
   *  list living on the default rule into a hand-placed one, and the repair when two neighbours have
   *  run out of room between them. The list reads the same before and after, so callers keep their
   *  positions. Returns the todos it changed, for the caller to save. */
  private renumber(): Todo[] {
    const changed: Todo[] = [];
    this.sorted().forEach((todo, i) => {
      const order = (i + 1) * ORDER_STEP;
      if (todo.order !== order) {
        todo.order = order;
        changed.push(todo);
      }
    });
    return changed;
  }

  /** The largest place any todo has, for appending: 0 when nobody has one (nothing is arranged). */
  private highestPlace(): number {
    return this.todos.reduce(
      (top, todo) => (todo.order !== undefined && todo.order > top ? todo.order : top),
      0,
    );
  }

  /** The list, filtered. An unknown filter is refused instead of quietly answering with everything —
   *  "all" is what that caller should have said. */
  list(args: ToolArgs): Todo[] {
    const filter = text(args.filter, 'filter', false).toLowerCase() || 'all';
    if (!FILTERS.includes(filter)) {
      throw new Error(`unknown filter: "${filter}" (all, open or done)`);
    }

    const todos = this.all();
    if (filter === 'all') return todos;
    if (filter === 'open') return todos.filter((todo) => !todo.done);

    return todos.filter((todo) => todo.done);
  }

  async add(args: ToolArgs): Promise<string> {
    const todo = this.addLocal(args);
    await this.changed('add', todo);
    return `added id=${todo.id}: ${todo.title}`;
  }

  private addLocal(args: ToolArgs): Todo {
    const title = text(args.title, 'title');
    if (title === '') throw new Error('todo.add wants a title');

    const todo: Todo = {
      id: this.nextId,
      title,
      text: text(args.text, 'text', false),
      done: false,
      at: new Date().toISOString(),
      doneAt: null,
    };
    // In a list a human has arranged, a new todo goes to the end of the open ones — it must not shove
    // the arrangement down by landing on top of it. A list nobody arranged has no places at all, so
    // the new todo gets none and the default rule (newest id first) keeps putting it on top.
    if (this.todos.some((one) => one.order !== undefined)) {
      todo.order = this.highestPlace() + ORDER_STEP;
    }
    this.nextId += 1;
    this.todos.push(todo);
    return todo;
  }

  /** Only the fields that were sent are touched, so a partial update is a normal update. */
  async update(args: ToolArgs): Promise<string> {
    const todo = this.find(id(args));

    if (args.title !== undefined) {
      const title = text(args.title, 'title');
      if (title === '') throw new Error('update title cannot be empty');
      todo.title = title;
    }
    if (args.text !== undefined) todo.text = text(args.text, 'text');

    todo.at = new Date().toISOString();
    await this.changed('update', todo);
    return `updated id=${todo.id}: ${todo.title}`;
  }

  /** Check off / reopen. `done` may be sent explicitly, because a page redrawing from a stale list has
   *  to be able to say which state it wants instead of flipping what it guessed. */
  async toggle(args: ToolArgs): Promise<string> {
    const todo = this.find(id(args));
    const done = args.done === undefined ? !todo.done : flag(args.done, 'done');

    todo.done = done;
    todo.doneAt = done ? new Date().toISOString() : null;
    todo.at = new Date().toISOString();
    await this.changed('toggle', todo);
    return done
      ? `checked off id=${todo.id}: ${todo.title}`
      : `reopened id=${todo.id}: ${todo.title}`;
  }

  async remove(args: ToolArgs): Promise<string> {
    const todo = this.find(id(args));
    this.todos = this.todos.filter((other) => other !== todo);
    await this.changed('remove', todo);
    return `removed id=${todo.id}: ${todo.title}`;
  }

  /** Move a todo next to another one of its own group. `before` / `after` name the neighbour by id:
   *  that is what an up/down button knows, and it stays meaningful when the list moved under the
   *  caller between the click and the call. A neighbour in the other group is refused rather than
   *  clamped — the open ones before the done ones is a rule of the list, not an arrangement, so a move
   *  must never quietly break it. */
  async move(args: ToolArgs): Promise<string> {
    const todo = this.find(id(args));
    const before = args.before !== undefined;
    const after = args.after !== undefined;
    if (before === after) {
      throw new Error('move wants one of before or after (the id of the todo to sit next to)');
    }

    const side = before ? 'before' : 'after';
    const other = this.find(neighbourId(before ? args.before : args.after, side));
    if (other === todo) throw new Error(`a todo cannot move ${side} itself (id=${todo.id})`);
    if (other.done !== todo.done) {
      throw new Error(
        `id=${todo.id} is ${todo.done ? 'done' : 'open'} and id=${other.id} is ${other.done ? 'done' : 'open'}: a todo moves inside its own group (the open ones come before the done ones)`,
      );
    }

    // Every todo this write touches, by id: on the first move that is the whole list.
    const touched = new Map<number, Todo>();
    const keep = (todos: Todo[]): void => todos.forEach((one) => touched.set(one.id, one));
    if (this.todos.some((one) => one.order === undefined)) keep(this.renumber());

    const line = this.group(todo.done, todo.id);
    const pos = line.findIndex((one) => one.id === other.id) + (before ? 0 : 1);
    let prev = line[pos - 1] ?? null;
    let next = line[pos] ?? null;
    if (prev !== null && next !== null) {
      const low = prev.order;
      const high = next.order;
      // No room left between the two neighbours (a long run of halving): renumber and look again. The
      // list reads the same, so `pos` still says where this todo goes.
      if (low !== undefined && high !== undefined && high - low < 2) {
        keep(this.renumber());
        prev = line[pos - 1] ?? null;
        next = line[pos] ?? null;
      }
    }
    todo.order = placement(prev?.order ?? null, next?.order ?? null);
    keep([todo]);

    await this.changed('move', ...touched.values());
    return `moved id=${todo.id} ${side} id=${other.id}: ${todo.title}`;
  }

  /** Write Today: free text, and the buttons when the caller sent them (absent means "leave the
   *  buttons alone", the way `update` treats a todo's fields). An empty text is allowed — Today can be
   *  emptied on purpose — but a missing one is not, because that would clear it by accident. */
  async setToday(args: ToolArgs): Promise<string> {
    if (args.text === undefined) throw new Error('set-today wants text (send "" to empty it)');

    this.todayCard.text = text(args.text, 'text');
    if (args.buttons !== undefined) this.todayCard.buttons = buttons(args.buttons);
    this.todayCard.updatedAt = new Date().toISOString();
    await this.changedToday();
    return `today updated (${this.todayCard.buttons.length} button(s))`;
  }

  /** Press one of Today's buttons: send its message to the target as one user chat turn. The call
   *  itself always succeeds — what the human needs to see is whether the message went anywhere, and
   *  `{sent: false, reason}` says that plainly instead of failing the page's request. */
  async press(args: ToolArgs): Promise<PressReceipt> {
    const index = buttonIndex(args);
    const button = this.buttonAt(index);
    const at = new Date().toISOString();
    const receipt = await this.send(this.target, button, index, at);

    this.presses.unshift(receipt);
    if (this.presses.length > PRESSES_KEPT) this.presses.length = PRESSES_KEPT;
    this.announce();
    return receipt;
  }

  /** The last presses, newest first. A press is not persisted: it happened in this process, and the
   *  page shows it so you can see that it fired. */
  recent(): PressReceipt[] {
    return [...this.presses];
  }

  /** One press: is the capability there at all, and did the target take the message? The call itself
   *  answers both, because that is the difference the human cares about — a target that cannot chat
   *  should be named as such, not reported as an unknown failure. */
  private async send(
    target: string,
    button: TodayButton,
    index: number,
    at: string,
  ): Promise<PressReceipt> {
    const receipt = { index, label: button.label, target, at };

    try {
      await this.ctx.call(target, 'chat_no_wait', {
        msg: {
          role: 'system',
          content: `User clicked  button:"${button.message}" in today card of todo node`,
        },
      });
    } catch (error) {
      // The bus's own words for this ("no node provides the capability ..."), so the sentence is the
      // same wherever it is read: a target that cannot chat is named as such, not as a mystery.
      return { ...receipt, sent: false, reason: message(error) };
    }

    return { ...receipt, sent: true };
  }

  /** The button a press named, numbered from 1. Out of range is answered with what Today has — a
   *  caller that invented an index should hear the size of the row, not a generic refusal. */
  private buttonAt(index: number): TodayButton {
    const button = this.todayCard.buttons[index - 1];
    if (button === undefined) {
      const count = this.todayCard.buttons.length;
      throw new Error(
        count === 0
          ? 'today has no buttons'
          : `no button ${index}: today has ${count} (1…${count})`,
      );
    }

    return button;
  }

  /** Every list write goes through here. The ids and the allocator live in the root index, so only a
   *  write that changed the list itself rewrites it — a title edit writes one todo unit. A move may
   *  write several (the first one places every todo), and none of them changes the index. */
  private async changed(
    kind: 'add' | 'update' | 'toggle' | 'remove' | 'move',
    ...todos: Todo[]
  ): Promise<void> {
    if (await this.hasHistory()) {
      if (!this.historyInitialized) await this.bootstrapHistory();
      else {
        for (const todo of todos) {
          if (kind === 'remove') await this.deleteTodo(todo);
          else await this.saveTodo(todo);
        }
        if (kind === 'add' || kind === 'remove') await this.saveIndex();
      }
    }
    this.keepLocal();
    this.announce();
  }

  /** Today is one unit of its own, so writing it never touches the list's index or its todos. */
  private async changedToday(): Promise<void> {
    if (await this.hasHistory()) {
      if (!this.historyInitialized) await this.bootstrapHistory();
      else await this.saveToday();
    }
    this.keepLocal();
    this.announce();
  }

  /** Is there a history node to store into? The new context has no directory, so a harmless load is
   *  the probe: history answers for a unit it does not have with an empty one. The one failure that
   *  means "serve from memory" is a capability nobody provides; a history that is there and fails a
   *  read is surfaced by the real load, not read as an empty store. */
  private async hasHistory(): Promise<boolean> {
    try {
      await this.ctx.call('history', 'load', { unitId: PROBE_UNIT });
      return true;
    } catch (error) {
      return !NO_HISTORY.test(message(error));
    }
  }

  /** Write each todo once, then Today, then the small root index. Later edits save the one unit they
   *  touched: only a change to the list itself also updates the index. */
  private async bootstrapHistory(): Promise<void> {
    this.todoRevisions.clear();
    for (const todo of this.todos) await this.saveTodo(todo);
    await this.saveToday();
    await this.saveIndex();
    this.historyInitialized = true;
  }

  private async saveTodo(todo: Todo): Promise<void> {
    const revision = await this.saveUnit(todoUnit(todo.id), todo);
    if (revision !== undefined) this.todoRevisions.set(todo.id, revision);
  }

  private async deleteTodo(todo: Todo): Promise<void> {
    const revision = this.todoRevisions.get(todo.id);
    if (revision === undefined) return;
    const unitId = todoUnit(todo.id);
    try {
      await this.ctx.call('history', 'delete', { unitId, expectedRevision: revision });
      this.todoRevisions.delete(todo.id);
    } catch {
      // A refused delete leaves the revision where it was, so the next remove tries again -- what this
      // node did when a delete came back not-ok.
    }
  }

  private async saveToday(): Promise<void> {
    await this.saveUnit(TODAY_UNIT, { ...this.todayCard, v: STORE_VERSION });
  }

  private async saveIndex(): Promise<void> {
    const index: TodoIndex = {
      ids: this.todos.map((todo) => todo.id),
      nextId: this.nextId,
      todayId: null,
      v: STORE_VERSION,
    };
    await this.saveUnit(HISTORY_UNIT, index);
  }

  /** One unit written through history. A refused save is not an error here, exactly as before: the
   *  caller is still answered with what this node holds, and the next write tries again. */
  private async saveUnit(unitId: string, meta: unknown): Promise<number | undefined> {
    try {
      const saved = await this.ctx.call<SavedHistory>('history', 'save', { unitId, meta });
      return saved.unit.revision;
    } catch {
      return undefined;
    }
  }

  /** A unit read back. A history that fails a read is the caller's error, with the bus's own reason. */
  private async loadUnit(unitId: string): Promise<HistoryUnit | null> {
    try {
      const loaded = await this.ctx.call<LoadedHistory>('history', 'load', { unitId });
      return loaded.unit;
    } catch (error) {
      throw new Error(`todo could not load history: ${message(error)}`);
    }
  }

  private async loadTodos(): Promise<void> {
    const todos: Todo[] = [];
    for (const want of this.todos.map((todo) => todo.id)) {
      const loaded = await this.loadUnit(todoUnit(want));
      if (loaded === null) throw new Error(`todo history is missing todo id=${want}`);
      const todo = this.validTodo(loaded.meta);
      if (todo.id !== want) throw new Error(`todo history id mismatch for id=${want}`);
      todos.push(todo);
      this.todoRevisions.set(want, loaded.revision);
    }
    this.todos = todos;
  }

  /** The root index: which todos there are and the next id. Three shapes of it load: no `todayId` at
   *  all (written by the first free-text Today), `todayId: null` (the current shape, kept so older
   *  readers still parse it), and `todayId: <id>` (the pre-free-text pointer at the item the card used
   *  to show — the item stays in the list, so nothing is lost by forgetting the pointer). Anything but
   *  the current shape is rewritten once, and the caller is told so. */
  private restoreIndex(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) throw new Error('invalid todo history index');
    const index = value as Partial<TodoIndex> & { todayId?: unknown };
    if (
      !Array.isArray(index.ids) ||
      index.ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(index.ids).size !== index.ids.length ||
      !Number.isSafeInteger(index.nextId) ||
      index.nextId! < 1 ||
      index.ids.some((id) => id >= index.nextId!)
    ) {
      throw new Error('invalid todo history index');
    }
    this.todos = index.ids.map((id) => ({
      id,
      title: '',
      text: '',
      done: false,
      at: '',
      doneAt: null,
    }));
    this.nextId = index.nextId!;
    return index.todayId !== null || index.v !== STORE_VERSION;
  }

  private validTodo(value: unknown): Todo {
    const order = typeof value === 'object' && value !== null ? (value as Todo).order : undefined;
    if (
      typeof value !== 'object' ||
      value === null ||
      !Number.isSafeInteger((value as Todo).id) ||
      (value as Todo).id < 1 ||
      typeof (value as Todo).title !== 'string' ||
      typeof (value as Todo).text !== 'string' ||
      typeof (value as Todo).done !== 'boolean' ||
      typeof (value as Todo).at !== 'string' ||
      !((value as Todo).doneAt === null || typeof (value as Todo).doneAt === 'string') ||
      // `order` is optional, because a todo stored before it existed has none and must still load; a
      // value that is there has to be a real number, or every comparison below is nonsense.
      !(order === undefined || (typeof order === 'number' && Number.isFinite(order)))
    ) {
      throw new Error('invalid todo in todo history');
    }
    const todo = value as Todo;
    const { id, title, text, done, at, doneAt } = todo;
    return order === undefined
      ? { id, title, text, done, at, doneAt }
      : { id, title, text, done, at, doneAt, order };
  }

  /** Today read back from history, validated the way an incoming set-today is — a corrupt or old-shaped
   *  unit is refused with a sentence instead of becoming a broken card. */
  private validToday(value: unknown): Today {
    if (typeof value !== 'object' || value === null)
      throw new Error('invalid today in todo history');
    const { text: body, buttons: btns, updatedAt } = value as Record<string, unknown>;
    if (typeof body !== 'string' || !(updatedAt === null || typeof updatedAt === 'string')) {
      throw new Error('invalid today in todo history');
    }

    return { text: body, buttons: buttons(btns), updatedAt: updatedAt as string | null };
  }

  private find(want: number): Todo {
    const todo = this.todos.find((other) => other.id === want);
    if (todo === undefined) throw new Error(`no todo with id=${want}`);

    return todo;
  }

  /** Everything this node holds, in one object. A listener never has to guess which doorbell rang, and
   *  the page draws list, card and presses from the same message. */
  snapshot(): { todos: Todo[]; today: Today; presses: PressReceipt[] } {
    return { todos: this.all(), today: this.todayCard, presses: this.recent() };
  }

  /** Tell the bus something changed, under this node's own id as the topic. */
  announce(): void {
    this.ctx.publish(NODE_ID, this.snapshot());
  }
}

export default TodoNode;
