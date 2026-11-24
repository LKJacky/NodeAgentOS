// Every value this package keeps, as one Unit class: the transcript, its counter, the cache, the
// settings, the sub-agent list and the chosen provider. A private agent keeps them in its own
// SQLite file; a shared agent asks history. The SDK's Unit owns that choice.
import { Unit, type BindingScope } from '@node-agent/sdk';
import type { Message } from './types.js';

// Kept here, not imported, so storage has no back-edge into the modules that use it.
const CACHE_UNIT = 'cache';
const CONVERSATION_KEY = 'conversation';
const SETTINGS_UNIT = 'agent.settings';
const SETTINGS_VERSION = 1;

export type StoredAgent = { name: string; icon?: string; provider?: string };
export type StoredSettings = { version: number; values: Record<string, unknown> };
export type StoredConversation = {
  messages: number;
  forgotten?: number;
  usage?: Record<string, unknown>;
};
export type StoredSubagents = { names: string[]; agents: StoredAgent[] };
export type StoredProvider = { name: string };

export class CacheCounterUnit extends Unit<{ total: number }> {
  meta = { total: 0 };
}
export class CacheEntryUnit extends Unit<{ text: string; length: number }> {
  meta = { text: '', length: 0 };
}
export class ConversationStateUnit extends Unit<StoredConversation> {
  meta: StoredConversation = { messages: 0 };
}
export class ConversationMessageUnit extends Unit<Message> {}
export class SettingsUnit extends Unit<StoredSettings> {
  meta: StoredSettings = { version: SETTINGS_VERSION, values: {} };
}
export class SubagentsUnit extends Unit<StoredSubagents> {
  meta: StoredSubagents = { names: [], agents: [] };
}
export class ActiveProviderUnit extends Unit<StoredProvider> {
  meta: StoredProvider = { name: '' };
}

function at(prefix: string, unitId: string): string {
  return `${prefix}${unitId}`;
}

export function cacheCounter(scope: BindingScope, prefix = ''): CacheCounterUnit {
  return scope.unit(CacheCounterUnit, at(prefix, CACHE_UNIT));
}
export function cacheEntry(scope: BindingScope, prefix: string, id: number): CacheEntryUnit {
  return scope.unit(CacheEntryUnit, at(prefix, `${CACHE_UNIT}.${id}`));
}
export function conversationState(scope: BindingScope, prefix = ''): ConversationStateUnit {
  return scope.unit(ConversationStateUnit, at(prefix, CONVERSATION_KEY));
}
export function conversationMessage(
  scope: BindingScope,
  prefix: string,
  index: number,
): ConversationMessageUnit {
  return scope.unit(ConversationMessageUnit, at(prefix, `${CONVERSATION_KEY}.${index}`));
}
export function settingsStorage(scope: BindingScope, prefix = ''): SettingsUnit {
  return scope.unit(SettingsUnit, at(prefix, SETTINGS_UNIT));
}
export function subagentsStorage(scope: BindingScope, prefix = ''): SubagentsUnit {
  return scope.unit(SubagentsUnit, at(prefix, 'subagents'));
}
export function activeProviderStorage(scope: BindingScope, prefix = ''): ActiveProviderUnit {
  return scope.unit(ActiveProviderUnit, at(prefix, 'active_provider'));
}

/** Dispatch one already-named unit; used by destroy, which walks what history already holds. */
export function storedUnit(scope: BindingScope, prefix: string, unitId: string): Unit<any> {
  if (unitId === CACHE_UNIT) return cacheCounter(scope, prefix);
  if (unitId.startsWith(`${CACHE_UNIT}.`)) {
    return scope.unit(CacheEntryUnit, at(prefix, unitId));
  }
  if (unitId === CONVERSATION_KEY) return conversationState(scope, prefix);
  if (unitId.startsWith(`${CONVERSATION_KEY}.`)) {
    return scope.unit(ConversationMessageUnit, at(prefix, unitId));
  }
  if (unitId === SETTINGS_UNIT) return settingsStorage(scope, prefix);
  if (unitId === 'subagents') return subagentsStorage(scope, prefix);
  if (unitId === 'active_provider') return activeProviderStorage(scope, prefix);
  return scope.unit(Unit, at(prefix, unitId));
}

export async function listUnits(
  scope: BindingScope,
  prefix = '',
): Promise<{ unitId: string; revision?: number }[]> {
  const reply = await scope.call<{ units?: unknown }>('history', 'list', {});
  if (!Array.isArray(reply?.units)) return [];
  return reply.units.filter(
    (unit): unit is { unitId: string; revision?: number } =>
      typeof unit === 'object' &&
      unit !== null &&
      typeof (unit as { unitId?: unknown }).unitId === 'string' &&
      unit.unitId.startsWith(prefix),
  );
}

/** Whether this agent can persist at all: a private node always can; a shared one needs history. */
export async function storageAvailable(scope: BindingScope): Promise<boolean> {
  try {
    const nodes = await scope.listNodes();
    const self = nodes.find((node) => node.name === scope.nodeId);
    return self?.scope === 'private' || nodes.some((node) => node.name === 'history');
  } catch {
    return false;
  }
}
