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
