// node-agent-introduce (node id: introduce): the stack's own setup, as a node -- and the page that says what this stack is.
//
// A stack is new when its own history says so. The setup claims one marker unit -- `setup`, in this
// node's own namespace -- *before* it writes anything, and every later start finds that unit and
// leaves the documents, the timer and the transcript alone. The claim is also the concurrency rule:
// `history.save` with `expectedRevision: 0` creates the unit or is refused, so of two starts racing
// on one new stack exactly one files the setup and the other stays out of it.
//
// The marker used to be the instruction document itself (`notes.list({ tag: 'instruction' })` and
// the title 服务指南): a guess at "new" made from a document a user may also write, and one that
// could only be made after the first document had been filed already. A stack that version set up is
// adopted -- marked as it stands -- rather than set up a second time, so an upgrade files nothing
// twice.
//
// The texts and the titles the setup files are words, not data, so they live in a resource of their
// own beside the page's -- `src/setup-i18n`, keys `setup.introduction`, `setup.heartbeat` and the five
// `setup.*Title` / `setup.*Text` of the notes -- and are chosen in
// the language the system node resolved -- what the user chose, or what the runtime settled from the
// deployment's own locale before this node was called -- read through the same `resourceValue` every
// page of this build reads its sentences with.
//
// The setup is still a startup step, not a service: `runSetup` runs once and answers what it did. But
// the node it runs in stays on the bus like any other (see src/serve.ts), because it has something to
// offer afterwards -- one capability, `ui`, which renders this package's `ui.html`: the introduction
// and the connection details a reader needs to put another node (the shell, first of all) on the
// bus. The page reads only the bus URL and the user's private join token this process was started
// with; it runs no shell and asks no other node anything.
//
// Ported from the Python init node (node_agent/nodes/introduce/python, now removed): same order of calls, same
// titles, same timer -- and the same rule that a setup which fails is a line in the log, not a dead
// stack. The difference is that the process no longer leaves the bus when the setup is done.
import { readFileSync } from 'node:fs';
import {
  DEFAULT_LOCALE,
  loadResource,
  Node,
  resolveLocale,
  pageLanguage,
  paintPage,
  resourceValue,
  type NodeHandlers,
  type Resource,
  type ToolArgs,
} from '@node-agent/sdk';

/** The introduction and connect page, as one self-contained document: no font and no image from
 *  anywhere but itself. `copy-assets.mjs` puts it beside the build, because tsc does not. */
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

/** The first visit has its own page: one language choice, no introduction behind it. */
const ONBOARDING_PAGE = readFileSync(new URL('./onboarding.html', import.meta.url), 'utf8');

/** The first-visit animation, standalone: the onboarding page embeds it in an iframe. */
const INTRO_ANIMATION = readFileSync(new URL('./intro-animation.html', import.meta.url), 'utf8');

/** The page's words: one file per language, copied beside the build the same way (`node.i18n`). */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

/** The two texts the setup files, one file per language, in a resource of their own: the page's
 *  resource is embedded in `ui.html` whole (see `paintPage`), and the instruction is not one of the
 *  page's sentences. */
const TEXTS: Resource = loadResource(new URL('./setup-i18n/', import.meta.url));

/** What a value becomes in the document: no bus token can close a tag or open a script. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#x27;';
    }
  });
}

/** True when the bus is only reachable from this machine. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

/** Fill the page once, in the language the shell asked for. `token` is the user's private join
 *  token, never the bus token. A value that itself contains `{{token}}` is never substituted again.
 *
 *  The slots go in first, because a value comes from the environment and not from a translator;
 *  `paintPage` then writes the words of the visit's language into the `data-text-key` markers and
 *  puts the resource in the head. The page that leaves this node is already readable with no script
 *  involved, and `/sdk/i18n-client.js` redraws it only when the language changes later. The loopback
 *  warning is a slot holding a *key*, not a sentence, so it follows the same language as the rest. */
export function renderOnboardingPage(args: unknown = {}): string {
  return paintPage(
    ONBOARDING_PAGE.replace('{{animation}}', escapeHtml(INTRO_ANIMATION)),
    RESOURCE,
    args,
  );
}

export function renderPage(busUrl: string, token: string, args: unknown = {}): string {
  const values: Record<string, string> = {
    busUrl: escapeHtml(busUrl),
    token: escapeHtml(token || resourceValue(RESOURCE, 'connect.noToken', pageLanguage(args))),
    loopbackKey: isLoopback(busUrl) ? 'connect.loopback.local' : 'connect.loopback.remote',
  };
  const slots = /\{\{(\w+)\}\}/g;
  return paintPage(
    PAGE.replace(slots, (slot, name: string) => values[name] ?? slot),
    RESOURCE,
    args,
  );
}

/** One capability call on another node: the value it answered with, or the error it came back with. */
export interface IntroduceCaller {
  call<T = unknown>(node: string, cap: string, args: ToolArgs): Promise<T>;
}

export interface SetupOptions {
  /** The words this stack starts with: the package's own `setup-i18n/` unless a test names
   *  another. */
  readonly resource?: Resource;
  /** Where the one line about the outcome goes; silent by default, for tests. */
  readonly log?: (line: string) => void;
}

/** `ran`: a new stack, set up now. `skipped`: it was set up before, or another start is setting it
 *  up right now. `failed`: see the log line. */
export type SetupOutcome = 'ran' | 'skipped' | 'failed';

/** The title the guide had when it was a constant of this file. A stack set up by that version has
 *  no marker, and its guide is filed under this title: it is recognised, and adopted, and never
 *  filed a second time. */
export const LEGACY_INSTRUCTION_TITLE = '服务指南';

/**
 * The history unit that is the initialization marker.
 *
 * History files a unit under (user, calling node, unitId), and the calling node is this one
 * (`introduce`), so `setup` is this node's own name inside its own namespace: it collides neither
 * with a user's notes nor with a sibling's units. The agent's `conversation` units are the same
 * convention one node over.
 */
export const SETUP_UNIT = 'setup';

/** The words a new stack is filed with, as keys of this package's i18n resource: two sentences and
 *  the five words a note is made of, so that every title and every text follows the language. */
export const INTRODUCTION_KEY = 'setup.introduction';
export const HEARTBEAT_KEY = 'setup.heartbeat';
export const INSTRUCTION_TITLE_KEY = 'setup.instructionTitle';
export const PROFILE_TITLE_KEY = 'setup.profileTitle';
export const DIARY_TITLE_KEY = 'setup.diaryTitle';
export const PROFILE_TEXT_KEY = 'setup.profileText';
export const DIARY_TEXT_KEY = 'setup.diaryText';

/** What the marker holds. `initialized: false` is a claim that stopped half way; a later start
 *  leaves it alone all the same, because repeating the setup would file the documents twice. */
export interface SetupMarker {
  readonly initialized: boolean;
  /** Set on a stack this version found already set up, and then marked rather than set up twice. */
  readonly adopted?: true;
  /** The language the two texts were written in, as the tag the system node answers with. */
  readonly language: string;
  /** When the claim, or the finish, was written: ISO-8601. */
  readonly at: string;
  /** Why it stopped, when it did. */
  readonly error?: string;
}

/** What `history.load` and `history.save` answer with: the unit, or null for a unit nobody wrote. */
interface UnitAnswer {
  readonly unit?: { readonly revision?: number; readonly meta?: unknown } | null;
}

/**
 * The language in force for the user, as the system node resolved it: the tag the profile stores,
 * or the SDK's default while nothing has been chosen.
 *
 * The runtime settles that choice once, at startup, before this node is called (`ensureLanguage` in
 * `node-agent/src/serve.ts` reads the environment there and stores it). This node reads the answer
 * and survives a system node that cannot give one: a missing answer must not become a text nobody
 * can read.
 */
async function languageInForce(caller: IntroduceCaller): Promise<string> {
  try {
    const answer = await caller.call<unknown>('system', 'language', {});
    const tag =
      typeof answer === 'string' ? answer : (answer as { language?: unknown } | null)?.language;
    return resolveLocale(tag);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** One word of the resource in that language, or undefined when the resource has none: a key left
 *  to itself is a missing word, never the key written into a user's notes. */
function textOf(resource: Resource, key: string, language: string): string | undefined {
  const text = resourceValue(resource, key, language).trim();
  return text === '' || text === key ? undefined : text;
}

/** One word of the resource in that language; a word the resource does not have is a failure. */
function sentence(resource: Resource, key: string, language: string): string {
  const text = textOf(resource, key, language);
  if (text === undefined)
    throw new Error(`the i18n resource has no words for "${key}" (${language})`);
  return text;
}

/** Mark a stack that an older version set up: the unit is written if this start is the one that
 *  gets there first, and a start that does not is no worse off -- the marker is there either way. */
async function adoptMarker(
  caller: IntroduceCaller,
  language: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await caller.call('history', 'save', {
      unitId: SETUP_UNIT,
      meta: {
        initialized: true,
        adopted: true,
        language,
        at: new Date().toISOString(),
      } satisfies SetupMarker,
      expectedRevision: 0,
    });
  } catch {
    log('introduce: another start already marked this stack, leaving it alone');
  }
}

/**
 * A setup that failed leaves the marker in one of two states, and neither is allowed to become the
 * error itself.
 *
 * Nothing filed yet: the claim is released (`history.delete` at its revision), so a later start may
 * try the whole setup again -- which is what the old one-question setup did.
 *
 * Something filed: the marker stays, saying that it stopped. A repeat would file the instruction,
 * the two documents and the heartbeat a second time, and there is no way to tell from the notes
 * what was already there.
 */
async function settleMarker(
  caller: IntroduceCaller,
  claim: number | undefined,
  filed: boolean,
  language: string,
  message: string,
  log: (line: string) => void,
): Promise<void> {
  if (claim === undefined) return;
  try {
    if (!filed) {
      await caller.call('history', 'delete', { unitId: SETUP_UNIT, expectedRevision: claim });
    } else {
      await caller.call('history', 'save', {
        unitId: SETUP_UNIT,
        meta: {
          initialized: false,
          language,
          at: new Date().toISOString(),
          error: message,
        } satisfies SetupMarker,
        expectedRevision: claim,
      });
    }
  } catch (error) {
    log(
      'introduce: the setup marker could not be settled: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * The setup, once: claim the marker in history, and only if the claim is this start's, file the
 * instruction in the notes node, file the two documents the reader's stack starts with, schedule
 * the hourly heartbeat, and hand the agent its system line -- all of it in the one language the
 * system node resolved.
 *
 * It never throws: a setup that cannot finish is one line in the log, and the stack keeps going.
 *
 * It is startup, not a service: it runs once, in the one process that stays up, and what it leaves
 * behind (the marker, the documents, the timer, the system line) is what the stack lives on.
 */
export async function runSetup(
  caller: IntroduceCaller,
  options: SetupOptions = {},
): Promise<SetupOutcome> {
  const log = options.log ?? (() => {});
  const resource = options.resource ?? TEXTS;
  /** The revision of the marker this start owns, once it has one. */
  let claim: number | undefined;
  /** Whether any document has been written: from then on a repeat would file it twice. */
  let filed = false;
  let language: string = DEFAULT_LOCALE;
  try {
    const existing = (await caller.call<UnitAnswer>('history', 'load', { unitId: SETUP_UNIT }))
      ?.unit;
    if (existing !== null && existing !== undefined) {
      const done = (existing.meta as { initialized?: unknown } | null)?.initialized === true;
      log(
        done
          ? 'introduce: this stack was set up already, leaving it alone'
          : 'introduce: an earlier setup stopped half way, leaving what it filed alone',
      );
      return 'skipped';
    }

    language = await languageInForce(caller);

    // A stack the version before this one set up has no marker: its marker was the instruction
    // document itself. Adopt it -- and write the unit it is missing -- instead of filing the
    // documents, the heartbeat and the system line a second time.
    const documents = await caller.call<{ title?: string }[]>('notes', 'list', {
      tag: 'instruction',
    });
    const instructionTitle = textOf(resource, INSTRUCTION_TITLE_KEY, language);
    if (
      Array.isArray(documents) &&
      documents.some(
        (one) =>
          one.title === LEGACY_INSTRUCTION_TITLE ||
          (instructionTitle !== undefined && one.title === instructionTitle),
      )
    ) {
      await adoptMarker(caller, language, log);
      log('introduce: this stack was set up before the marker existed, adopting it');
      return 'skipped';
    }

    try {
      // Create only: the unit becomes this start's, or it already belongs to another start.
      const claimed = await caller.call<UnitAnswer>('history', 'save', {
        unitId: SETUP_UNIT,
        meta: { initialized: false, language, at: new Date().toISOString() } satisfies SetupMarker,
        expectedRevision: 0,
      });
      claim = claimed?.unit?.revision;
    } catch {
      // Another start claimed the stack between the read and the write: its setup is the setup.
      log('introduce: another start claimed the setup first, leaving it alone');
      return 'skipped';
    }

    const instruction = sentence(resource, INTRODUCTION_KEY, language);
    const heartbeat = sentence(resource, HEARTBEAT_KEY, language);

    filed = true;
    await caller.call('notes', 'add', {
      title: sentence(resource, INSTRUCTION_TITLE_KEY, language),
      text: instruction,
      tag: 'instruction',
    });
    await caller.call('notes', 'add', {
      title: sentence(resource, PROFILE_TITLE_KEY, language),
      text: sentence(resource, PROFILE_TEXT_KEY, language),
      tag: 'profile',
    });
    await caller.call('notes', 'add', {
      title: sentence(resource, DIARY_TITLE_KEY, language),
      text: sentence(resource, DIARY_TEXT_KEY, language),
      tag: 'profile',
    });
    await caller.call('timer', 'set', {
      mode: 'countdown',
      after_seconds: 3600,
      repeat: 'every:3600',
      name: 'heartbeat',
      node: 'agent',
      message: heartbeat,
    });
    await caller.call('agent', 'chat_no_wait', {
      msg: { role: 'system', content: instruction },
      priority: 'queue',
    });

    // The setup is filed: the marker says so, at the revision this start claimed.
    await caller.call('history', 'save', {
      unitId: SETUP_UNIT,
      meta: { initialized: true, language, at: new Date().toISOString() } satisfies SetupMarker,
      ...(claim === undefined ? {} : { expectedRevision: claim }),
    });

    log(`introduce: this stack is set up (${language})`);
    return 'ran';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`introduce: the setup did not finish: ${message}`);
    await settleMarker(caller, claim, filed, language, message, log);
    return 'failed';
  }
}

/** What the page asks before it offers the setup: whether this stack has been set up, and the
 *  language the record holds (`null` while nothing is recorded). */
export interface IntroduceStatus {
  readonly initialized: boolean;
  readonly language: string | null;
}

/**
 * Whether this stack has been set up, and the language it recorded.
 *
 * It only reads: the marker in history, and -- for a stack set up before the marker existed -- the
 * instruction document in notes, under the legacy title or the title this build files it with. A
 * history or notes failure is thrown, not swallowed, so the page can say what went wrong instead of
 * offering a setup it cannot vouch for.
 */
export async function readStatus(
  caller: IntroduceCaller,
  options: SetupOptions = {},
): Promise<IntroduceStatus> {
  const unit = (await caller.call<UnitAnswer>('history', 'load', { unitId: SETUP_UNIT }))?.unit;
  if (unit !== null && unit !== undefined) {
    const meta = unit.meta as { initialized?: unknown; language?: unknown } | null;
    if (meta?.initialized === true)
      return {
        initialized: true,
        language: typeof meta.language === 'string' ? meta.language : null,
      };
    return { initialized: false, language: null };
  }

  // No marker: an older stack's marker was the instruction document itself.
  const resource = options.resource ?? TEXTS;
  const language = await languageInForce(caller);
  const instructionTitle = textOf(resource, INSTRUCTION_TITLE_KEY, language);
  const documents = await caller.call<{ title?: string }[]>('notes', 'list', {
    tag: 'instruction',
  });
  const legacy =
    Array.isArray(documents) &&
    documents.some(
      (one) =>
        one.title === LEGACY_INSTRUCTION_TITLE ||
        (instructionTitle !== undefined && one.title === instructionTitle),
    );
  return { initialized: legacy, language: null };
}

/** The stack's setup as a node: the page calls `setup` once its reader has chosen a language; the
 *  node stays on the bus with the page capability, and `status` says whether the setup has run. */
export class IntroduceNode extends Node {
  readonly handlers: NodeHandlers = {
    // The page calls this, after the reader chose a language and wrote it to the profile. It is
    // idempotent: a stack that is already set up answers `skipped` instead of filing twice.
    // `ctx.call` is the host's own bus identity, so setup needs no scope of its own.
    setup: () => runSetup(this.ctx, { log: (line) => console.log(line) }),
    // The page asks this on load, to decide between the language gate and the introduction.
    status: () => readStatus(this.ctx),
    // The page is rendered from `ui.html` with the bus this worker joined. No other node is asked
    // anything; the only argument read is the language the shell sends with its visit.
    ui: (args: ToolArgs) =>
      args.onboarding === true || args.onboarding === '1'
        ? renderOnboardingPage(args)
        : renderPage(
            process.env.NODE_AGENT_BUS_URL?.trim() || 'ws://127.0.0.1:8788',
            process.env.NODE_AGENT_JOIN_TOKEN?.trim() || '',
            args,
          ),
  };
}

export default IntroduceNode;
