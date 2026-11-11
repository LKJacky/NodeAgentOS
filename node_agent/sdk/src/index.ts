export type {
  CallEnvelope,
  CallPayload,
  CapabilityEntry,
  ConnectEnvelope,
  ConnectPayload,
  CreateUserEnvelope,
  CreateUserPayload,
  DestroyUserEnvelope,
  DestroyUserPayload,
  DisconnectEnvelope,
  DisconnectPayload,
  Envelope,
  EnvelopeBase,
  EnvelopeType,
  EventEnvelope,
  EventPayload,
  ListCapabilitiesEnvelope,
  ListCapabilitiesPayload,
  ListNodesEnvelope,
  ListNodesPayload,
  NodeEntry,
  NodeManifest,
  OutboundCallEnvelope,
  OutboundConnectEnvelope,
  OutboundCreateUserEnvelope,
  OutboundDestroyUserEnvelope,
  OutboundDisconnectEnvelope,
  OutboundEventEnvelope,
  OutboundListCapabilitiesEnvelope,
  OutboundListNodesEnvelope,
  OutboundRegisterEnvelope,
  OutboundResultEnvelope,
  Outcome,
  RegisterEnvelope,
  RequestEnvelopeBase,
  RegisterPayload,
  UnregisterEnvelope,
  UnregisterPayload,
  OutboundUnregisterEnvelope,
  ResultEnvelope,
  ResultPayload,
  ToolArgs,
} from './envelope.js';

export {
  Node,
  requireBindings,
  type NodeBindings,
  type NodeClass,
  type BindingScope,
  type NodeContext,
  type NodeHandler,
  type NodeHandlers,
  type NodeHostContext,
  type SubNode,
  type SubNodeOptions,
} from './node.js';

export {
  NodeHost,
  nodeDefinitionOfPackage,
  type BusSession,
  type NodeDefinition,
  type NodeHostOptions,
} from './host.js';

export { WebSocketBusSession, type WebSocketBusSessionOptions } from './bus_session.js';
export { LegacyBusSession, type LegacyBusSessionOptions } from './legacy_session.js';

export {
  isBindingKey,
  loadNodePackage,
  manifestFromPackage,
  nodeManifestOfPackage,
  type LoadedNodePackage,
  type NodePackageBlock,
} from './package.js';
export { servePackage, servePackages, type BusTransport, type ServeOptions } from './runner.js';

export {
  isArchivePath,
  packageFiles,
  packLocalPackage,
  writeArchive,
  type ArchiveFile,
  type PackedPackage,
  type PublishedManifest,
} from './archive.js';

export { nodeAgentDir, nodeAgentHome } from './home.js';

// One sentence, written by whoever uses it: the SDK owns the language, never the words. The browser
// side of the same class is `src/i18n-client.js`, which the webui serves as /sdk/i18n-client.js.
export {
  DEFAULT_LOCALE,
  LOCALES,
  Text,
  acceptLanguageTags,
  isLocale,
  normalizeLocale,
  resolveAcceptLanguage,
  resolveLocale,
  type Locale,
  type TextMessages,
  type TextParams,
} from './i18n.js';

// A node's sentences can live in files (`i18n/en.json`, `i18n/zh-CN.json`) instead of in code. These
// read a folder into `Text` values, and put the same resource into the script tag a page reads.
export {
  RESOURCE_ATTRIBUTE,
  flattenResource,
  labelText,
  manifestLabels,
  paintPage,
  paintResource,
  pageLanguage,
  resourceScript,
  RESOURCE_SLOT,
  resourceTexts,
  type LocalizedText,
  type NodeLabels,
  type Resource,
} from './i18n-resource.js';
export { loadResource, resourceValue } from './i18n-node.js';
