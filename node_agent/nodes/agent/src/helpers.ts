// Small shared helpers: the stamps a transcript line carries, the priority argument, and the one
// conversion every tool answer needs (the model reads text, a node may answer with any JSON).
import type { TokenUsage, UsageSummary } from './types.js';

export const QUEUE = 'queue';
export const INTERPRET = 'interpret';
export const PRIORITIES = [QUEUE, INTERPRET] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Lower runs first: an `interpret` line goes in ahead of any `queue` line waiting behind it. */
export const PRIORITY_RANK: Record<Priority, number> = { interpret: 0, queue: 1 };

/** `priority`, defaulted and checked. An unknown word is refused where the caller can read both
 *  spellings, rather than treated as `queue` and silently obeyed. */
export function priorityOf(value: unknown): Priority {
  const priority = String(value ?? 'queue')
    .trim()
    .toLowerCase();
  if (priority !== QUEUE && priority !== INTERPRET) {
    throw new Error(`unknown priority: "${String(value)}" (queue or interpret)`);
  }
  return priority;
}

/** A line that is being committed to the transcript, in the shape the page has to read back:
 *  ISO8601, UTC, milliseconds, `Z` — the same thing the Python twin writes. */
export function utcNow(): string {
  return new Date().toISOString();
}

/** The absolute instant a wait runs out, `seconds` from now. An instant and not a count of
 *  seconds, because a page that was asleep cannot count the seconds it missed. */
export function utcIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** True at a UTF-16 high surrogate: the first half of a pair that must not be cut in two. */
export const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** True at a UTF-16 low surrogate: the second half of a pair that must not be cut in two. */
export const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** `text` as its first `keep` characters, never cut between the two halves of a surrogate pair.
 *
 *  A string is counted in UTF-16 code units, so `slice(0, keep)` may end after the high half of a
 *  character that needs two (an emoji, a rare Han). The lone half that leaves is not valid
 *  Unicode: JSON keeps it, but the server reading the JSON refuses the whole request (`invalid
 *  high surrogate in string`), so the cut gives up one unit instead. */
export function headOf(text: string, keep: number): string {
  let end = Math.max(0, Math.min(keep, text.length));
  if (end > 0 && end < text.length && isHigh(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** `text` as its last `keep` characters, never cut between the two halves of a surrogate pair. */
export function tailOf(text: string, keep: number): string {
  let start = Math.max(0, text.length - Math.max(0, keep));
  if (start > 0 && start < text.length && isLow(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

/** `text` as valid Unicode: a lone half of a pair -- one some other slice cut -- becomes U+FFFD.
 *
 *  The last word on the way out: a string that reached the wire with an unpaired surrogate makes
 *  the model server refuse every message that carries it, and one replacement character in the
 *  text is a far smaller loss than the turn. */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD');
}

/** A high half with no low half after it, or a low half with no high half before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Tool replies may be any JSON value; the model reads text, so strings pass straight through. */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function emptyUsage(): UsageSummary {
  return {
    model_calls: 0,
    reported_calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
}

/** Treat missing or invalid counts as unreported; derive a missing total from both components. */
export function tokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { prompt_tokens, completion_tokens, total_tokens } = value as Record<string, unknown>;
  const isCount = (count: unknown): count is number =>
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  if (!isCount(prompt_tokens) || !isCount(completion_tokens)) return undefined;
  const total = total_tokens ?? prompt_tokens + completion_tokens;
  if (!isCount(total)) return undefined;
  return { prompt_tokens, completion_tokens, total_tokens: total };
}
