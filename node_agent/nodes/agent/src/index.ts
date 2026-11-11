// node-agent-agent: the only node that holds a model — AgentNode, the runtime behind it, and the two
// ways a model gets plugged in (a provider on the bus or an endpoint in the environment, and the
// rule-based stand-in used when neither is configured).
export { AgentNode, CAPABILITIES, RUNTIME_BINDING, page, readAsset, runtimeFor } from './agent.js';
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
export { Cache, CACHE_UNIT, historyOverBus, type CacheHistory, type CacheMatch } from './cache.js';
export {
  CachedModel,
  COMPRESSION_NOTICE,
  CONVERSATION_KEY,
  EventQueue,
  FORGET_MESSAGE,
  NodeProvider,
  ProviderNodes,
  StatedModel,
  StreamHub,
  WindowMessages,
} from './model.js';
export { AgentBusEnv, type EnvHost, type UsableEntry } from './env.js';
export { ASK_USER_TOOL, SYSTEM, TOOLS } from './tools.js';
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
