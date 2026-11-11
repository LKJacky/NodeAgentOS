// node-agent-bus: the bus and the envelope wire — it knows no model and no concrete node.
export { Bus, SERVICE_TENANT, privateNodeToken } from './bus.js';
export type { AuthorizationVerdict, BusLimits, BusPermissions } from './bus.js';
export { DEFAULT_HOST, DEFAULT_PORT, busAddress, busFromEnv, socketUrl } from './node.js';
export { UsageError, busArgsOrExit, busUsage, listenAddress, parseBusArgs } from './args.js';
export type { BusArgs } from './args.js';
// The wire: one WebSocket message, one envelope — plus the part frames that carry an envelope too
// big for one message (see wire.ts).
export { Assembler, MAX_FRAME_CHARS, dec, parts } from './wire.js';
export { AUTHORIZE_CAP, SYSTEM_NODE, capCallers, capExposed, isEnvelope } from './envelope.js';
export type {
  Envelope,
  EnvelopeType,
  RegisterEnvelope,
  UnregisterEnvelope,
  CallEnvelope,
  ResultEnvelope,
  EventEnvelope,
  ListNodesEnvelope,
  ListCapabilitiesEnvelope,
  CreateUserEnvelope,
  DestroyUserEnvelope,
  ConnectEnvelope,
  DisconnectEnvelope,
  RegisterPayload,
  UnregisterPayload,
  CallPayload,
  ResultPayload,
  EventPayload,
  ListNodesPayload,
  ListCapabilitiesPayload,
  CreateUserPayload,
  DestroyUserPayload,
  ConnectPayload,
  DisconnectPayload,
  NodeManifest,
  NodeEntry,
  CapabilityEntry,
  ToolArgs,
  Outcome,
} from './envelope.js';
// The transport: the bus's half of the WebSocket (adopted by Bus.accept) and the node's half, which
// dials the bus. Neither knows what an envelope means.
export { CLOSED, Link, Remote, route } from './link.js';
