// Reading a transcript without building the agent that wrote it: the units are the source of truth,
// so `history` on a stored sub-agent does not start it just to answer a page.
import type { UnitContext } from '@node-agent/sdk';
import { ConversationMessageUnit, ConversationStateUnit, SubagentsUnit } from './storage.js';
import type { Message } from './types.js';

/** Most transcript lines one `history` answer carries. */
export const HISTORY_MAX = 200;

/** What `agent.history` answers: a window of the transcript and where it sits in it. */
export type HistoryWindow = { from: number; total: number; messages: Message[] };

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** `count`, defaulted and bounded: one answer never carries more than HISTORY_MAX messages. */
export function historyCount(value: unknown): number {
  if (value === undefined || value === null) return HISTORY_MAX;
  const count = Number(value);
  if (!Number.isFinite(count)) return HISTORY_MAX;
  return Math.max(0, Math.min(Math.trunc(count), HISTORY_MAX));
}

/** A message index inside a transcript of `total` messages, clamped to it: an index past the end
 *  reads as the end, which is how a caller learns the transcript is shorter than it thought. */
export function historyFrom(value: unknown, total: number): number {
  const index = Number(value);
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.trunc(index), total));
}

/** The sub-agent names stored for this identity, read without starting any of them. */
export async function readSubagentNames(ctx: UnitContext): Promise<string[]> {
  const unit = new SubagentsUnit(ctx, 'subagents');
  await unit.load();
  const meta = unit.meta as { names?: unknown; agents?: unknown };
  const listed = Array.isArray(meta.agents)
    ? meta.agents
    : Array.isArray(meta.names)
      ? meta.names
      : [];
  const names: string[] = [];
  for (const row of listed) {
    if (typeof row === 'string' && row !== '') names.push(row);
    else if (typeof row === 'object' && row !== null) {
      const name = (row as { name?: unknown }).name;
      if (typeof name === 'string' && name !== '') names.push(name);
    }
  }
  return names;
}

/** Read one transcript window straight from its `conversation` and `conversation.<n>` units. */
export async function readHistory(
  ctx: UnitContext,
  prefix: string,
  from: unknown,
  count: unknown,
): Promise<HistoryWindow> {
  const stateUnit = new ConversationStateUnit(ctx, `${prefix}conversation`);
  await stateUnit.load();
  const total = isCount(stateUnit.meta.messages) ? stateUnit.meta.messages : 0;

  const width = historyCount(count);
  const start = from === undefined ? Math.max(0, total - width) : historyFrom(from, total);
  const end = Math.min(start + width, total);
  const messages: Message[] = [];
  for (let index = start; index < end; index += 1) {
    const unit = new ConversationMessageUnit(ctx, `${prefix}conversation.${index}`);
    await unit.load();
    if (unit.revision === 0) throw new Error(`history is missing message ${index} of ${total}`);
    messages.push(unit.meta);
  }
  return { from: start, total, messages };
}
