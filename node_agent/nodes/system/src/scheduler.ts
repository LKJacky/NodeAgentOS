// The privileged part of the system node: a long-lived scheduler that owns the bus connection and
// the durable timer queue. It is deliberately not a NodeContext consumer: a timer fires after the
// add_timer invocation has long returned, so every outbound call gets a fresh deadline here.
import { randomUUID } from 'node:crypto';
// "Which language is this" has one implementation, in the SDK: the profile stores a tag, and this
// file must read it exactly the way a page or a node does (see @node-agent/sdk i18n).
import {
  normalizeLocale,
  resolveAcceptLanguage,
  resolveLocale,
  type Locale,
  type OutboundCallEnvelope,
  type ResultEnvelope,
  type ToolArgs,
} from '@node-agent/sdk';

export const TIMER_UNIT = 'system.timers';
export const PROFILE_UNIT = 'system.profile';
export const PERMISSION_UNIT = 'system.permissions';

/** The bus's service tenant: the control connection lives here. */
const SERVICE_TENANT = '0'.repeat(64);

/** The part of the system this scheduler needs from the bus. */
export interface SchedulerBus {
  call(call: OutboundCallEnvelope): Promise<ResultEnvelope>;
}

export interface CallPayload {
  readonly cap: string;
  readonly args?: ToolArgs;
}

export interface PermissionRule {
  readonly target: string;
  readonly cap: string;
  readonly callers: readonly string[];
}

interface PermissionsState {
  readonly rules: readonly PermissionRule[];
}

export interface PermissionView extends PermissionRule {
  /** The callers in force now: the override when there is one, else the default. */
  readonly source: 'default' | 'override';
  /** What the cap declares, or the bus default when it declares no `callers`. */
  readonly defaultCallers: readonly string[];
  /** The saved override, when one exists. */
  readonly overrideCallers?: readonly string[];
  /** False when the manifest reserves this permission from the editor. */
  readonly editable: boolean;
  /** False when ordinary sibling nodes may not call the cap. */
  readonly exposed: boolean;
  /** The target node's display name in the language in force, when its manifest carries one. */
  readonly nodeLabel?: string;
  /** The capability's display name in the language in force, when it carries one. */
  readonly capLabel?: string;
  /** Argument display names in the language in force, keyed by the canonical argument name. */
  readonly argLabels?: Readonly<Record<string, string>>;
}

export interface TimerView {
  readonly id: string;
  readonly target: string;
  readonly at: string;
  readonly callpayload: CallPayload;
  readonly attempts: number;
  readonly lastError?: string;
}

export interface StoredTimer {
  readonly id: string;
  readonly target: string;
  readonly tenantId: string;
  readonly at: string;
  readonly callpayload: CallPayload;
  readonly createdAt: string;
  readonly attempts?: number;
  readonly lastError?: string;
}

interface TimersState {
  readonly timers: readonly StoredTimer[];
}

/**
 * The user's profile: the two facts every page needs and no page owns.
 *
 * `language` is null until the user's browser has visited once (or the page has chosen one). That is
 * not a missing value: it means "nobody has chosen yet", and the first visit is what decides — see
 * `ensureLanguage`. `timezone` is still detected from the environment, because a machine can tell
 * you that much and a browser cannot easily.
 */
export interface Profile {
  readonly language: Locale | null;
  readonly timezone: string;
}

/** What a caller of `locale`/`ensure_language` sees: what is stored, and what to draw with. */
export interface LocaleView {
  /** The stored language; null while nobody has chosen one. */
  readonly language: Locale | null;
  /** The language in force: the stored one, or the default when nothing is stored yet. */
  readonly resolved: Locale;
}

/** What `ensureLanguage` did: the same view, plus whether this call is the one that chose. */
export interface EnsuredLocale extends LocaleView {
  readonly language: Locale;
  readonly changed: boolean;
}

interface Unit<T> {
  readonly meta: T;
  readonly revision: number;
}

interface HistoryAnswer<T> {
  readonly unit: Unit<T> | null;
}

const HISTORY_TIMEOUT_MS = 30_000;
const WAKE_TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 5_000;
const MAX_ATTEMPTS = 3;
const MAX_TIMEOUT_MS = 2_147_000_000;

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${field} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} is longer than ${max} characters`);
  return trimmed;
}

function timerAt(value: unknown): string {
  const raw = text(value, 'at', 200);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) throw new Error('at must be an ISO-8601 instant');
  return new Date(at).toISOString();
}

function callPayload(value: unknown): CallPayload {
  const payload = object(value, 'callpayload');
  const cap = text(payload.cap, 'callpayload.cap');
  const args = payload.args === undefined ? {} : object(payload.args, 'callpayload.args');
  return { cap, args };
}

function callersFrom(value: unknown, field: string): string[] {
  // An empty list is meaningful: nobody may call the capability. `*` is the wildcard caller.
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of node names`);
  const names = value.map((item, index) => text(item, `${field}[${index}]`, 120));
  return [...new Set(names)];
}

function permissionsFrom(meta: unknown): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  if (meta === undefined || meta === null) return rules;
  const state = object(meta, 'permission state');
  if (!Array.isArray(state.rules)) throw new Error('permission state has no rules array');
  for (const [index, raw] of state.rules.entries()) {
    const rule = object(raw, `rule[${index}]`);
    const target = text(rule.target, `rule[${index}].target`, 120);
    const cap = text(rule.cap, `rule[${index}].cap`, 120);
    rules.set(`${target}\u0000${cap}`, callersFrom(rule.callers, `rule[${index}].callers`));
  }
  return rules;
}

function permissionKey(target: string, cap: string): string {
  return `${target}\u0000${cap}`;
}

function timersFrom(meta: unknown): StoredTimer[] {
  if (meta === undefined || meta === null) return [];
  const state = object(meta, 'timer state');
  if (!Array.isArray(state.timers)) throw new Error('timer state has no timers array');
  return state.timers.map((raw, index) => {
    const timer = object(raw, `timer[${index}]`);
    const payload = object(timer.callpayload, `timer[${index}].callpayload`);
    return {
      id: text(timer.id, `timer[${index}].id`),
      target: text(timer.target, `timer[${index}].target`),
      tenantId: text(timer.tenantId, `timer[${index}].tenantId`),
      at: timerAt(timer.at),
      callpayload: {
        cap: text(payload.cap, `timer[${index}].callpayload.cap`),
        args:
          payload.args === undefined
            ? {}
            : object(payload.args, `timer[${index}].callpayload.args`),
      },
      createdAt:
        timer.createdAt === undefined
          ? new Date().toISOString()
          : text(timer.createdAt, `timer[${index}].createdAt`),
      attempts: timer.attempts === undefined ? 0 : Number(timer.attempts),
      lastError: timer.lastError === undefined ? undefined : String(timer.lastError),
    };
  });
}

/** The timezone the environment can tell us, used once and then kept in history. Override with
 *  NODE_AGENT_TIMEZONE (or the usual TZ) before first start. */
function detectedTimezone(): string {
  return (
    process.env.NODE_AGENT_TIMEZONE?.trim() ||
    process.env.TZ?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  );
}

/** A language to write into the profile: one of ours, or a refusal. */
function languageValue(value: unknown): Locale {
  const language = normalizeLocale(value);
  if (language === null) throw new Error('language must be zh-CN or en');
  return language;
}

function timezoneValue(value: unknown): string {
  const timezone = text(value, 'timezone');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('timezone must be a valid IANA timezone');
  }
  return timezone;
}

/**
 * The profile a brand-new install starts with.
 *
 * The language is deliberately null rather than detected: the first browser to open the shell knows
 * what the user reads, and a machine's locale usually does not. `ensureLanguage` fills it in once.
 */
function detectedProfile(): Profile {
  return { language: null, timezone: detectedTimezone() };
}

/**
 * A stored profile, in whatever shape an older version wrote it.
 *
 * Compatibility is the point of this function: `language` may be absent, null, an old `zh`, or a tag
 * this build has no catalog for, and all of those read as "not chosen yet" (or, for `zh`/`en-US`, as
 * the language they obviously meant) instead of failing the whole scheduler load.
 */
function profileFrom(meta: unknown): Profile {
  const profile = object(meta, 'profile');
  return {
    language: normalizeLocale(profile.language),
    timezone: profile.timezone === undefined ? detectedTimezone() : timezoneValue(profile.timezone),
  };
}

export class SystemScheduler {
  readonly #bus: SchedulerBus;
  readonly #tenantId: string;
  readonly #pending = new Map<string, StoredTimer>();
  readonly #handles = new Map<string, NodeJS.Timeout>();
  #timersRevision: number | null = null;
  #profile: Profile | null = null;
  #profileRevision: number | null = null;
  #permissionRules = new Map<string, string[]>();
  #permissionsRevision: number | null = null;
  /** Profile writes mutate and persist as one serial unit; two first visits queue here. */
  #profileQueue: Promise<void> = Promise.resolve();
  /** Permission edits mutate and persist as one serial unit; concurrent callers queue here. */
  #permissionQueue: Promise<void> = Promise.resolve();
  #ready: Promise<void> | null = null;
  #loaded = false;
  #saveQueue: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(bus: SchedulerBus, tenantId = 'default') {
    this.#bus = bus;
    this.#tenantId = tenantId;
  }

  start(): Promise<void> {
    if (this.#loaded) return Promise.resolve();
    this.#ready ??= this.#load().finally(() => {
      // A failed first load (history not started yet) must not become a permanently rejected
      // promise: the next call retries, and authorization keeps working on defaults meanwhile.
      this.#ready = null;
    });
    return this.#ready;
  }

  /**
   * The user's language as a tag to draw with, never null.
   *
   * This is the capability the agent prompt has always read, so its shape does not change: a profile
   * with no language yet answers with the default instead of an empty string.
   */
  async language(): Promise<string> {
    await this.start();
    return resolveLocale(this.#requireProfile().language);
  }

  /** What is stored and what is in force: the two facts `ensure_language` and a page both need. */
  async locale(): Promise<LocaleView> {
    await this.start();
    const { language } = this.#requireProfile();
    return { language, resolved: resolveLocale(language) };
  }

  /**
   * Set the language from the browser's Accept-Language — but only when nobody has chosen yet.
   *
   * This is the one write a first visit is allowed: the profile starts with `language: null`, a
   * browser says what its user reads, and the choice is persisted (and reported as `changed: true`)
   * exactly once. Every later call answers with what is already stored and writes nothing.
   */
  async ensureLanguage(browser?: unknown): Promise<EnsuredLocale> {
    await this.start();
    if (this.#stopped) throw new Error('system scheduler is stopped');
    const stored = this.#requireProfile().language;
    if (stored !== null)
      return { language: stored, resolved: resolveLocale(stored), changed: false };
    // Serialised with every other profile write: two browsers opening at once must decide once.
    return await this.#queueProfileWrite(async () => {
      const current = this.#requireProfile().language;
      if (current !== null)
        return { language: current, resolved: resolveLocale(current), changed: false };
      const language = resolveAcceptLanguage(typeof browser === 'string' ? browser : '');
      const next: Profile = { language, timezone: this.#requireProfile().timezone };
      this.#profileRevision = await this.#saveUnit(PROFILE_UNIT, next, this.#profileRevision);
      this.#profile = next;
      return { language, resolved: language, changed: true };
    });
  }

  async timezone(): Promise<string> {
    await this.start();
    return this.#requireProfile().timezone;
  }

  async profile(): Promise<Profile> {
    await this.start();
    return { ...this.#requireProfile() };
  }

  async updateProfile(args: ToolArgs): Promise<Profile> {
    await this.start();
    if (this.#stopped) throw new Error('system scheduler is stopped');
    return await this.#queueProfileWrite(async () => {
      const current = this.#requireProfile();
      const language =
        args.language === undefined ? current.language : languageValue(args.language);
      const timezone =
        args.timezone === undefined ? current.timezone : timezoneValue(args.timezone);
      const next: Profile = { language, timezone };
      if (next.language === current.language && next.timezone === current.timezone) return next;
      this.#profileRevision = await this.#saveUnit(PROFILE_UNIT, next, this.#profileRevision);
      this.#profile = next;
      return { ...next };
    });
  }

  /** The profile is one history unit: two writes racing on one revision is a 409, so they queue. */
  async #queueProfileWrite<T>(run: () => Promise<T>): Promise<T> {
    const queued = this.#profileQueue.then(run);
    this.#profileQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  /** Decide one call from the current override, or the cap's declared default. */
  async authorize(args: ToolArgs): Promise<{ allow: boolean; reason?: string }> {
    // Authorization must not wait for history: the bus needs a verdict while the runtime is still
    // starting the history/system pair. Defaults are safe here; overrides load on a later retry.
    if (!this.#loaded && this.#ready === null) void this.start();
    const caller = text(args.caller, 'caller', 120);
    const target = text(args.target, 'target', 120);
    const cap = text(args.cap, 'cap', 120);
    // A node always reaches its own capabilities; the manifest only lists *other* callers.
    if (caller === target) return { allow: true };
    // The browser shell is the human's own front end; its per-panel routing is enforced by webui.
    if (caller === 'webui') return { allow: true };
    // `expose: false` is enforced before the editable table: only the owner, its page, and the
    // trusted service control plane may call. The latter configures nodes that are deliberately
    // hidden from ordinary business nodes (for example userpage.configure).
    const serviceControl = caller === 'runtime-control' && args.tenant === SERVICE_TENANT;
    if (serviceControl) return { allow: true };
    if (args.expose === false)
      return {
        allow: false,
        reason: `${target}.${cap} is not exposed to other nodes`,
      };
    // Private nodes are the user's own. They are managed here only so the bus has one decision
    // point; their manifest callers and any old override do not apply. The default is allow.
    if (args.private === true) return { allow: true };
    // The manifest is the source of truth. An absent list means everyone; an explicitly empty
    // list means nobody. The bus supplies the former as `['*']`.
    const declared = Array.isArray(args.defaultCallers) ? args.defaultCallers : ['*'];
    const fallback = callersFrom(declared, 'defaultCallers');
    const override = this.#permissionRules.get(permissionKey(target, cap));
    const callers = override ?? fallback;
    // `*` as the caller asks about the wildcard itself; a `*` in the list allows everyone.
    const allow = caller === '*' || callers.includes('*') || callers.includes(caller);
    if (allow) return { allow: true };
    const policy = override === undefined ? 'default' : 'override';
    const allowed = callers.join(', ') || 'nobody';
    return {
      allow: false,
      reason: `${caller} is not allowed to call ${target}.${cap} (${policy} policy: ${allowed})`,
    };
  }

  /** The effective caller list for one cap, without the bus asking for every policy up front. */
  async permission(
    target: string,
    cap: string,
    defaults: readonly string[],
    editable = true,
    exposed = true,
    ignoreOverride = false,
  ): Promise<PermissionView> {
    await this.start();
    const override = ignoreOverride
      ? undefined
      : this.#permissionRules.get(permissionKey(target, cap));
    const defaultCallers = [...defaults];
    return {
      target,
      cap,
      callers: override === undefined ? defaultCallers : [...override],
      source: override === undefined ? 'default' : 'override',
      defaultCallers,
      editable,
      exposed,
      ...(override === undefined ? {} : { overrideCallers: [...override] }),
    };
  }

  /** Saved overrides, including caps no node currently advertises. */
  async overrides(): Promise<PermissionRule[]> {
    await this.start();
    return [...this.#permissionRules.entries()].map(([key, callers]) => {
      const [target = '', cap = ''] = key.split('\u0000');
      return { target, cap, callers };
    });
  }

  async setPermission(
    targetValue: unknown,
    capValue: unknown,
    callersValue: unknown,
  ): Promise<PermissionView> {
    await this.start();
    const target = text(targetValue, 'target', 120);
    const cap = text(capValue, 'cap', 120);
    const callers = callersFrom(callersValue, 'callers');
    const run = this.#permissionQueue.then(async () => {
      if (this.#stopped) throw new Error('system scheduler is stopped');
      const key = permissionKey(target, cap);
      const previous = this.#permissionRules.get(key);
      this.#permissionRules.set(key, callers);
      try {
        await this.#persistPermissions();
      } catch (error) {
        if (previous === undefined) this.#permissionRules.delete(key);
        else this.#permissionRules.set(key, previous);
        throw error;
      }
      return {
        target,
        cap,
        callers,
        source: 'override' as const,
        defaultCallers: [],
        editable: true,
        exposed: true,
        overrideCallers: callers,
      };
    });
    this.#permissionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async clearPermission(targetValue: unknown, capValue: unknown): Promise<boolean> {
    await this.start();
    const target = text(targetValue, 'target', 120);
    const cap = text(capValue, 'cap', 120);
    const run = this.#permissionQueue.then(async () => {
      if (this.#stopped) throw new Error('system scheduler is stopped');
      const key = permissionKey(target, cap);
      const previous = this.#permissionRules.get(key);
      if (previous === undefined) return false;
      this.#permissionRules.delete(key);
      try {
        await this.#persistPermissions();
      } catch (error) {
        this.#permissionRules.set(key, previous);
        throw error;
      }
      return true;
    });
    this.#permissionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async cancel(idValue: unknown): Promise<string> {
    await this.start();
    const id = text(idValue, 'id');
    const timer = this.#pending.get(id);
    if (timer === undefined) throw new Error(`no pending timer id=${id}`);
    this.#pending.delete(id);
    const handle = this.#handles.get(id);
    if (handle !== undefined) clearTimeout(handle);
    this.#handles.delete(id);
    await this.#persistTimers();
    return `cancelled timer id=${id}`;
  }

  async timers(): Promise<TimerView[]> {
    await this.start();
    return [...this.#pending.values()]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((timer) => ({
        id: timer.id,
        target: timer.target,
        at: timer.at,
        callpayload: timer.callpayload,
        attempts: timer.attempts ?? 0,
        lastError: timer.lastError,
      }));
  }

  async add(tenantId: string, target: string, args: ToolArgs): Promise<{ id: string; at: string }> {
    await this.start();
    if (this.#stopped) throw new Error('system scheduler is stopped');
    const id = text(args.id, 'id');
    if (this.#pending.has(id)) throw new Error(`a timer with id "${id}" is already pending`);
    const at = timerAt(args.at);
    if (Date.parse(at) <= Date.now()) throw new Error('at must be in the future');
    const timer: StoredTimer = {
      id,
      target: text(target, 'caller'),
      tenantId: text(tenantId, 'tenantId'),
      at,
      callpayload: callPayload(args.callpayload),
      createdAt: new Date().toISOString(),
      attempts: 0,
    };
    this.#pending.set(id, timer);
    try {
      await this.#persistTimers();
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    this.#arm(timer);
    return { id, at };
  }

  stop(): void {
    this.#stopped = true;
    for (const handle of this.#handles.values()) clearTimeout(handle);
    this.#handles.clear();
  }

  async #load(): Promise<void> {
    try {
      await this.#loadFromHistory();
      this.#loaded = true;
    } catch (error) {
      // History may not have joined yet during a cold start. Keep the detected profile and the
      // empty override table, and retry on the next start() instead of poisoning every call.
      if (this.#profile === null) this.#profile = detectedProfile();
      console.error(
        `system: history is not ready; using default permissions: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async #loadFromHistory(): Promise<void> {
    const profileAnswer = await this.#loadUnit<Profile>(PROFILE_UNIT);
    if (profileAnswer === null) {
      this.#profile = detectedProfile();
      this.#profileRevision = await this.#saveUnit(PROFILE_UNIT, this.#profile, null);
    } else {
      // A profile written by an older version (language absent, or an old `zh`) loads as one of ours.
      this.#profile = profileFrom(profileAnswer.meta);
      this.#profileRevision = profileAnswer.revision;
    }

    const timersAnswer = await this.#loadUnit<TimersState>(TIMER_UNIT);
    if (timersAnswer !== null) {
      this.#timersRevision = timersAnswer.revision;
      for (const timer of timersFrom(timersAnswer.meta)) this.#pending.set(timer.id, timer);
    }
    const permissionsAnswer = await this.#loadUnit<PermissionsState>(PERMISSION_UNIT);
    if (permissionsAnswer !== null) {
      this.#permissionsRevision = permissionsAnswer.revision;
      this.#permissionRules = permissionsFrom(permissionsAnswer.meta);
    }
    for (const timer of this.#pending.values()) this.#arm(timer);
  }

  #requireProfile(): Profile {
    this.#profile ??= detectedProfile();
    return this.#profile;
  }

  async #arm(timer: StoredTimer): Promise<void> {
    if (this.#stopped) return;
    const existing = this.#handles.get(timer.id);
    if (existing !== undefined) clearTimeout(existing);
    const delay = Math.max(0, Date.parse(timer.at) - Date.now());
    const handle = setTimeout(
      () => {
        void this.#fire(timer.id);
      },
      Math.min(delay, MAX_TIMEOUT_MS),
    );
    handle.unref?.();
    this.#handles.set(timer.id, handle);
  }

  async #fire(id: string): Promise<void> {
    if (this.#stopped) return;
    const timer = this.#pending.get(id);
    if (timer === undefined) return;
    this.#handles.delete(id);
    if (Date.parse(timer.at) > Date.now()) {
      await this.#arm(timer);
      return;
    }

    try {
      await this.#call(timer.target, timer.callpayload.cap, timer.callpayload.args ?? {});
      this.#pending.delete(id);
      await this.#persistTimers();
    } catch (error) {
      // A stop while a callback was in flight closes the bus; there is no queue left to persist.
      if (this.#stopped) return;
      const attempts = (timer.attempts ?? 0) + 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`system timer ${id} failed (attempt ${attempts}): ${message}`);
      if (attempts >= MAX_ATTEMPTS) {
        this.#pending.delete(id);
        await this.#persistTimers();
        return;
      }
      const retry: StoredTimer = {
        ...timer,
        attempts,
        lastError: message,
        at: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
      };
      this.#pending.set(id, retry);
      await this.#persistTimers();
      await this.#arm(retry);
    }
  }

  #persistTimers(): Promise<void> {
    const run = this.#saveQueue.then(async () => {
      const state: TimersState = { timers: [...this.#pending.values()] };
      this.#timersRevision = await this.#saveUnit(TIMER_UNIT, state, this.#timersRevision);
    });
    this.#saveQueue = run.catch(() => undefined);
    return run;
  }

  #persistPermissions(): Promise<void> {
    const run = this.#saveQueue.then(async () => {
      const rules = [...this.#permissionRules.entries()].map(([key, callers]) => {
        const [target = '', cap = ''] = key.split('\u0000');
        return { target, cap, callers };
      });
      const state: PermissionsState = { rules };
      this.#permissionsRevision = await this.#saveUnit(
        PERMISSION_UNIT,
        state,
        this.#permissionsRevision,
      );
    });
    this.#saveQueue = run.catch(() => undefined);
    return run;
  }

  async #loadUnit<T>(unitId: string): Promise<Unit<T> | null> {
    const answer = await this.#call<HistoryAnswer<T>>('history', 'load', { unitId });
    return answer.unit;
  }

  async #saveUnit<T>(unitId: string, meta: T, expected: number | null): Promise<number> {
    const args: ToolArgs = { unitId, meta };
    if (expected !== null) args.expectedRevision = expected;
    const answer = await this.#call<{ unit: Unit<T> }>('history', 'save', args);
    if (answer.unit === undefined)
      throw new Error(`history did not return the saved unit ${unitId}`);
    return answer.unit.revision;
  }

  async #call<T>(node: string, cap: string, args: ToolArgs): Promise<T> {
    const result = await this.#bus.call({
      id: randomUUID(),
      type: 'call',
      to: node,
      tenantId: this.#tenantId,
      deadline: Date.now() + WAKE_TIMEOUT_MS,
      payload: { cap, args },
    });
    if (!result.payload.ok) throw new Error(result.payload.error);
    return result.payload.value as T;
  }
}
