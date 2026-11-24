// node-agent-agent: the only node that holds a model — AgentNode, the runtime behind it, and the two
// ways a model gets plugged in: a `provider` row dialled in this process (the provider package's own
// core), a `local-provider` row read over the bus, and the provider an embedder hands over.
export {
  AgentNode,
  CAPABILITIES,
  RUNTIME_BINDING,
  familyFor,
  page,
  readAsset,
  runtimeFor,
} from './agent.js';
export { AgentFamily } from './family.js';
export { default } from './agent.js';
export type { AgentOptions } from './agent.js';
export {
  AgentRuntime,
  HISTORY_MAX,
  ASK_TIMEOUT_SECONDS,
  addMetaInfo,
  historyCount,
  historyFrom,
  type AgentStatus,
  type ChatMeta,
  type HistoryWindow,
  type RuntimeOptions,
} from './runtime.js';
export { Cache, CACHE_UNIT, DEFAULT_CACHE_SIZE, type CacheMatch } from './cache.js';
export {
  CachedModel,
  COMPRESSION_NOTICE,
  COMPRESSION_THRESHOLD,
  COMPRESSION_TOKENS,
  CONVERSATION_KEY,
  EventQueue,
  FORGET_MESSAGE,
  NodeProvider,
  ProviderNodes,
  StatedModel,
  StreamHub,
  WindowMessages,
} from './model.js';
export {
  DirectProvider,
  missingConfig,
  type CoreBuilder,
  type DirectProviderOptions,
} from './direct.js';
export { AgentBusEnv, type EnvHost, type UsableEntry } from './env.js';
export {
  DEFAULT_SETTINGS,
  LIVE_SETTINGS,
  RESTART_REQUIRED_SETTINGS,
  SETTINGS_NAMES,
  SETTINGS_UNIT,
  type AgentSettings,
  type SettingsPatch,
} from './settings.js';
export { ASK_USER_TOOL, SYSTEM, TOOLS } from './tools.js';
export {
  ActiveProviderUnit,
  CacheCounterUnit,
  CacheEntryUnit,
  ConversationMessageUnit,
  ConversationStateUnit,
  SettingsUnit,
  SubagentsUnit,
  activeProviderStorage,
  cacheCounter,
  cacheEntry,
  conversationMessage,
  conversationState,
  listUnits,
  settingsStorage,
  storageAvailable,
  storedUnit,
  subagentsStorage,
  type StoredAgent,
  type StoredConversation,
  type StoredProvider,
  type StoredSettings,
  type StoredSubagents,
} from './storage.js';
export { requireBindings, type BindingScope, type NodeBindings } from '@node-agent/sdk';

export type {
  ChatReply,
  ChatRequest,
  Message,
  Provider,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolSpec,
  UsageSummary,
} from './types.js';
