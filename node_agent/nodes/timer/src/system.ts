// timer backed by the privileged system node. The scheduler, persistence and restart recovery live
// in system; this node owns the user-facing vocabulary (alarm/countdown/repeat) and the wake call.
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

type Priority = 'queue' | 'interpret';
type TimerMode = 'alarm' | 'countdown';
type TimerKind = 'delay' | 'alarm';
type RepeatRule = 'once' | 'daily' | 'weekdays' | 'weekly' | `every:${number}`;

type ScheduledWake = {
  id: number;
  name: string;
  target: string;
  priority: Priority;
  message: string;
  mode: TimerMode;
  kind: TimerKind;
  repeat: RepeatRule;
  next_at: string;
  in_seconds: number;
  phrase: string;
};

type RemoteTimer = { id: string; at: string; callpayload: { cap: string; args?: ToolArgs } };
type RemoteWake = {
  id: number;
  name: string;
  target: string;
  priority: Priority;
  message: string;
  mode: TimerMode;
  repeat: RepeatRule;
  firesAt: number;
};

const NODE_ID = 'timer';
const WAKE_CAP = 'wake';
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
/** The page's words, read from next to the compiled JS (the same copy the page comes from). */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = 86_400_000;

function text(value: unknown, what: string, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new Error(`${what} wants a string`);
  return value.trim();
}

function timerId(args: ToolArgs): number {
  const value = args.id;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('id wants an integer');
  return value;
}

function afterSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('after_seconds wants a number of seconds greater than 0');
  }
  return value;
}

function priorityOf(value: unknown): Priority {
  if (value === undefined) return 'queue';
  if (value !== 'queue' && value !== 'interpret') {
    throw new Error(`unknown priority: ${JSON.stringify(value)} (queue or interpret)`);
  }
  return value;
}

function modeOf(value: unknown): TimerMode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'alarm' && value !== 'countdown') {
    throw new Error(`unknown mode: ${JSON.stringify(value)} (alarm or countdown)`);
  }
  return value;
}

function repeatOf(value: unknown, mode: TimerMode): RepeatRule {
  if (value === undefined) return 'once';
  const rule = text(value, 'repeat').toLowerCase();
  if (mode === 'alarm') {
    if (rule === 'once' || rule === 'daily' || rule === 'weekdays' || rule === 'weekly')
      return rule;
    throw new Error('an alarm repeats once, daily, weekdays or weekly');
  }
  if (rule === 'once') return 'once';
  if (rule.startsWith('every:')) {
    const seconds = Number(rule.slice(6));
    if (Number.isSafeInteger(seconds) && seconds >= 60) return `every:${seconds}`;
  }
  throw new Error('a countdown repeats once or every:<seconds> (>= 60)');
}

function kindOf(mode: TimerMode): TimerKind {
  return mode === 'alarm' ? 'alarm' : 'delay';
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  FORMATTERS.set(timeZone, formatter);
  return formatter;
}

function zonedParts(moment: number, timeZone: string): ZonedParts {
  const values: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(moment))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const weekday = WEEKDAYS[values.weekday ?? ''];
  if (weekday === undefined) throw new Error(`cannot read the weekday in ${timeZone}`);
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday,
  };
}

function wallClockAsUtc(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetAt(moment: number, timeZone: string): number {
  return wallClockAsUtc(zonedParts(moment, timeZone)) - Math.floor(moment / 1000) * 1000;
}

/** The instant whose wall clock in `timeZone` is `parts`. For an ambiguous time choose the earlier
 *  occurrence; for a missing time choose the instant just after the gap. */
function utcFromZoned(parts: ZonedParts, timeZone: string): number {
  const target = wallClockAsUtc(parts);
  // `Date.UTC` normalises an overflowing day (for example day 32) into the next month.
  const wanted = new Date(target);
  const wall = {
    year: wanted.getUTCFullYear(),
    month: wanted.getUTCMonth() + 1,
    day: wanted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
  const before = offsetAt(target - DAY, timeZone);
  const after = offsetAt(target + DAY, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => target - offset)
    .filter((moment) => {
      const actual = zonedParts(moment, timeZone);
      return (
        actual.year === wall.year &&
        actual.month === wall.month &&
        actual.day === wall.day &&
        actual.hour === wall.hour &&
        actual.minute === wall.minute
      );
    });
  if (candidates.length > 0) return Math.min(...candidates);
  return target - before;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function clockText(moment: number, timeZone: string): string {
  const at = zonedParts(moment, timeZone);
  return `${pad2(at.hour)}:${pad2(at.minute)}`;
}

function phraseText(seconds: number): string {
  if (seconds < 60) return `in ${Math.max(1, Math.ceil(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
}

// Calendar alarms keep the wall-clock time of the system profile's timezone across DST; countdowns
// use elapsed seconds. The process timezone is deliberately not consulted: a cloud process usually
// runs in UTC while the person's configured timezone lives in `system.settings`.
function addCalendarDays(moment: number, days: number, timeZone: string): number {
  const at = zonedParts(moment, timeZone);
  return utcFromZoned({ ...at, day: at.day + days }, timeZone);
}

function alarmTime(value: string, now: number, timeZone: string): number {
  const clock = CLOCK_TIME.exec(value);
  if (clock !== null) {
    const today = zonedParts(now, timeZone);
    const target: ZonedParts = {
      ...today,
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      second: 0,
    };
    let moment = utcFromZoned(target, timeZone);
    if (moment <= now) moment = utcFromZoned({ ...target, day: target.day + 1 }, timeZone);
    return moment;
  }
  const moment = Date.parse(value);
  if (!Number.isFinite(moment)) throw new Error('at must be HH:MM or an ISO-8601 timestamp');
  return moment;
}

function nextFireAt(rule: RepeatRule, from: number, timeZone: string): number {
  if (rule === 'daily') return addCalendarDays(from, 1, timeZone);
  if (rule === 'weekly') return addCalendarDays(from, 7, timeZone);
  if (rule.startsWith('every:')) return from + Number(rule.slice(6)) * 1000;
  let next = addCalendarDays(from, 1, timeZone);
  while ([0, 6].includes(zonedParts(next, timeZone).weekday))
    next = addCalendarDays(next, 1, timeZone);
  return next;
}

function forwardToWeekday(moment: number, timeZone: string): number {
  return [0, 6].includes(zonedParts(moment, timeZone).weekday)
    ? nextFireAt('weekdays', moment, timeZone)
    : moment;
}

function dayGap(moment: number, now: number, timeZone: string): number {
  const day = (at: number): number => {
    const date = zonedParts(at, timeZone);
    return Date.UTC(date.year, date.month - 1, date.day);
  };
  return Math.round((day(moment) - day(now)) / DAY);
}

function alarmPhrase(moment: number, now: number, timeZone: string): string {
  const days = dayGap(moment, now, timeZone);
  const at = zonedParts(moment, timeZone);
  const clock = clockText(moment, timeZone);
  if (days <= 0) return `${clock} today`;
  if (days === 1) return `${clock} tomorrow`;
  if (days <= 6) return `${clock} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.weekday]}`;
  return `${clock} on ${at.year}-${pad2(at.month)}-${pad2(at.day)}`;
}

function remoteId(wake: RemoteWake): string {
  return `timer:${wake.id}:${wake.firesAt}`;
}

function remoteWakeOf(timer: RemoteTimer): RemoteWake | null {
  if (timer.callpayload.cap !== WAKE_CAP) return null;
  const args = timer.callpayload.args ?? {};
  const id = Number(args.id);
  const firesAt = Date.parse(timer.at);
  const mode = args.mode === 'alarm' ? 'alarm' : args.mode === 'countdown' ? 'countdown' : null;
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isFinite(firesAt) || mode === null)
    return null;
  try {
    return {
      id,
      name: typeof args.name === 'string' ? args.name : '',
      target: text(args.target, 'target'),
      priority: priorityOf(args.priority),
      message: text(args.message, 'message'),
      mode,
      repeat: repeatOf(args.repeat, mode),
      firesAt,
    };
  } catch {
    return null;
  }
}

function remoteRow(wake: RemoteWake, now: number, timeZone: string): ScheduledWake {
  const inSeconds = Number(Math.max(0, (wake.firesAt - now) / 1000).toFixed(1));
  return {
    id: wake.id,
    name: wake.name,
    target: wake.target,
    priority: wake.priority,
    message: wake.message,
    mode: wake.mode,
    kind: kindOf(wake.mode),
    repeat: wake.repeat,
    next_at: new Date(wake.firesAt).toISOString(),
    in_seconds: inSeconds,
    phrase:
      wake.mode === 'alarm' ? alarmPhrase(wake.firesAt, now, timeZone) : phraseText(inSeconds),
  };
}

class TimerNode extends Node {
  readonly handlers: NodeHandlers;

  constructor(ctx: NodeContext) {
    super(ctx);
    this.handlers = {
      set: (args) => this.set(args),
      cancel: (args) => this.cancel(args),
      list: () => this.list(),
      wake: (args) => this.wake(args),
      // The page is drawn in the language the visit asked for (the shell sends it as `language`):
      // every marked sentence and the resource the browser half reads are written in before the page
      // leaves the node, so the first paint is already right.
      ui: async (args) => {
        const page = paintPage(PAGE, RESOURCE, args).replace('__NODE__', () =>
          JSON.stringify(NODE_ID).slice(1, -1),
        );
        const timeZone = await this.timeZone();
        return page.replace('"__TIMEZONE__"', () => JSON.stringify(timeZone));
      },
    };
  }

  private async remoteTimers(): Promise<RemoteTimer[]> {
    return await this.ctx.call<RemoteTimer[]>('system', 'timers', {});
  }

  private async rows(): Promise<ScheduledWake[]> {
    const now = Date.now();
    const timeZone = await this.timeZone();
    return (await this.remoteTimers())
      .map(remoteWakeOf)
      .filter((wake): wake is RemoteWake => wake !== null)
      .sort((a, b) => a.firesAt - b.firesAt)
      .map((wake) => remoteRow(wake, now, timeZone));
  }

  private async timeZone(): Promise<string> {
    return await this.ctx.call<string>('system', 'timezone', {});
  }

  private async set(args: ToolArgs): Promise<string> {
    const message = text(args.message, 'message');
    if (message === '')
      throw new Error('timer.set wants a message: it is what the target wakes up to');
    const target = args.node === undefined ? this.ctx.from : text(args.node, 'node');
    if (target === '')
      throw new Error(
        'timer.set has no target: the call carried no caller id, so name one in "node"',
      );

    const now = Date.now();
    const timeZone = await this.timeZone();
    const { mode, firesAt: requested } = this.firstMoment(args, modeOf(args.mode), now, timeZone);
    const repeat = repeatOf(args.repeat, mode);
    const firesAt = repeat === 'weekdays' ? forwardToWeekday(requested, timeZone) : requested;
    const pending = (await this.remoteTimers())
      .map(remoteWakeOf)
      .filter((wake): wake is RemoteWake => wake !== null);
    const id = Math.max(0, ...pending.map((wake) => wake.id)) + 1;
    const wake: RemoteWake = {
      id,
      name: text(args.name, 'name', false),
      target,
      priority: priorityOf(args.priority),
      message,
      mode,
      repeat,
      firesAt,
    };
    await this.ctx.call('system', 'add_timer', {
      id: remoteId(wake),
      at: new Date(firesAt).toISOString(),
      callpayload: { cap: WAKE_CAP, args: { ...wake } },
    });
    const row = remoteRow(wake, now, timeZone);
    this.ctx.publish(NODE_ID, { type: 'set', ...row });
    const when = mode === 'alarm' ? `at ${row.phrase}` : row.phrase;
    return `set timer id=${id}: ${mode} wakes ${target} ${when}${repeat === 'once' ? '' : `, ${repeat}`}`;
  }

  private async cancel(args: ToolArgs): Promise<string> {
    const id = timerId(args);
    const timer = (await this.remoteTimers()).find(
      (candidate) => remoteWakeOf(candidate)?.id === id,
    );
    if (timer === undefined) throw new Error(`no pending timer id=${id}`);
    const wake = remoteWakeOf(timer);
    if (wake === null) throw new Error(`no pending timer id=${id}`);
    await this.ctx.call('system', 'cancel_timer', { id: timer.id });
    this.ctx.publish(NODE_ID, {
      type: 'cancel',
      id,
      target: wake.target,
      in_seconds: Number(Math.max(0, (wake.firesAt - Date.now()) / 1000).toFixed(1)),
    });
    return `cancelled timer id=${id}: ${wake.target} will not be woken`;
  }

  private async list(): Promise<ScheduledWake[]> {
    return await this.rows();
  }

  private async wake(args: ToolArgs): Promise<{ woke: boolean; error: string }> {
    const mode: TimerMode = args.mode === 'alarm' ? 'alarm' : 'countdown';
    const wake: RemoteWake = {
      id: Number(args.id),
      name: typeof args.name === 'string' ? args.name : '',
      target: text(args.target, 'target'),
      priority: priorityOf(args.priority),
      message: text(args.message, 'message'),
      mode,
      repeat: repeatOf(args.repeat, mode),
      firesAt: Number(args.firesAt),
    };
    if (!Number.isSafeInteger(wake.id) || !Number.isFinite(wake.firesAt)) {
      throw new Error('invalid system timer wake payload');
    }

    const timeZone = await this.timeZone();
    let woke = false;
    let error = '';
    try {
      await this.ctx.call(wake.target, 'chat_no_wait', {
        msg: { role: 'system', content: this.wakeContent(wake, timeZone) },
        priority: wake.priority,
      });
      woke = true;
    } catch (failure: unknown) {
      error = failure instanceof Error ? failure.message : String(failure);
    }

    let next: number | null = null;
    if (wake.repeat !== 'once') {
      next = nextFireAt(wake.repeat, wake.firesAt, timeZone);
      while (next <= Date.now()) next = nextFireAt(wake.repeat, next, timeZone);
      try {
        const following: RemoteWake = { ...wake, firesAt: next };
        await this.ctx.call('system', 'add_timer', {
          id: remoteId(following),
          at: new Date(next).toISOString(),
          callpayload: { cap: WAKE_CAP, args: { ...following } },
        });
      } catch (failure: unknown) {
        error = `${error}${error === '' ? '' : '; '}reschedule: ${failure instanceof Error ? failure.message : String(failure)}`;
        next = null;
      }
    }

    this.ctx.publish(NODE_ID, {
      type: 'fire',
      id: wake.id,
      name: wake.name,
      target: wake.target,
      priority: wake.priority,
      message: wake.message,
      mode: wake.mode,
      kind: kindOf(wake.mode),
      repeat: wake.repeat,
      woke,
      error,
      next_at: next === null ? '' : new Date(next).toISOString(),
    });
    return { woke, error };
  }

  private firstMoment(
    args: ToolArgs,
    mode: TimerMode | undefined,
    now: number,
    timeZone: string,
  ): { mode: TimerMode; firesAt: number } {
    const hasAlarm = args.at !== undefined;
    const hasCountdown = args.after_seconds !== undefined;
    if (hasAlarm && hasCountdown)
      throw new Error('an alarm wants `at` and a countdown wants `after_seconds` — not both');
    const resolved = mode ?? (hasAlarm ? 'alarm' : 'countdown');
    if (resolved === 'alarm' ? !hasAlarm : !hasCountdown) {
      throw new Error(
        'an alarm needs `at` (HH:MM or an ISO stamp); a countdown needs `after_seconds`',
      );
    }
    return resolved === 'alarm'
      ? { mode: resolved, firesAt: alarmTime(text(args.at, 'at'), now, timeZone) }
      : { mode: resolved, firesAt: now + afterSeconds(args.after_seconds) * 1000 };
  }

  private wakeContent(wake: RemoteWake, timeZone: string): string {
    const rule = wake.repeat === 'once' ? '' : ` ${wake.repeat}`;
    return `[timer ${wake.id} ${clockText(wake.firesAt, timeZone)} ${timeZone}${rule}] ${wake.message}`;
  }
}

export default TimerNode;
