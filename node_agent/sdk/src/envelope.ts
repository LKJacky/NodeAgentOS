import type { LocalizedText, NodeLabels } from './i18n-resource.js';

/** Arguments and results as they cross the wire. */
export type ToolArgs = Record<string, unknown>;

export type Outcome<T = unknown> = { ok: true; value?: T } | { ok: false; error: string };

/** Metadata announced by a register envelope. */
export interface NodeManifest {
  /** Stable package identity assigned by the control plane; never chosen by the node. */
  readonly packageId: string;

  /** Unique node name; used as the address prefix: notes -> notes.add. */
  readonly name: string;
  /** Capability name -> argument JSON Schema. */
  readonly caps: Readonly<Record<string, ToolArgs>>;

  /** The keys this node may keep an object under, as its package.json declared them. Absent means
   *  it keeps nothing, and `ctx.bind` refuses every key. */
  readonly bindings?: readonly string[];
  readonly desc: string;
  readonly version: string;

  /** Package publisher, from package.json#publisher. Metadata, not an access boundary. */
  readonly publisher: string;

  /** Inline SVG source or data URL for this node's icon. */
  readonly icon: string;

  /** Display names for this node, its caps and their arguments, per language. The names themselves
   *  stay canonical: a label is only ever what a page shows. */
  readonly labels?: NodeLabels;
}

/** One registered node, as the bus knows it. */
export interface NodeEntry {
  readonly name: string;
  readonly desc: string;
  readonly packageId: string;
  readonly version: string;
  readonly publisher?: string;
  /** Carried through so a directory or a tool can show what a node keeps. */
  readonly bindings?: readonly string[];
  /** The manifest icon: inline SVG source or a data URL. */
  readonly icon: string;
  /** Whether this node is shared across the service tenant or owned by this user space. */
  readonly scope: 'shared' | 'private';
  /** The manifest's labels, carried through so a directory can show them. */
  readonly labels?: NodeLabels;
}

/** One capability of one registered node. */
export interface CapabilityEntry {
  readonly cap: string;
  readonly parameters: ToolArgs;
  /** The cap's display name per language, from the node's labels. */
  readonly labels?: LocalizedText;
  /** Display names for this cap's arguments: argument name -> per-language text. */
  readonly argLabels?: Readonly<Record<string, LocalizedText>>;
}

/**
 * The transport frame that crosses a Bus or a VirtualBus.
 *
 * `from` is the authenticated sender on this hop. `tenantId` is the
 * single-user tenant and must be bound to the connection by the Bus; it must
 * never be trusted from the payload alone.
 */
export type EnvelopeType =
  | 'register'
  | 'unregister'
  | 'call'
  | 'result'
  | 'event'
  | 'subscribe'
  | 'unsubscribe'
  | 'list_nodes'
  | 'list_capabilities'
  | 'create_user'
  | 'destroy_user'
  | 'connect'
  | 'disconnect';

export interface EnvelopeBase<T extends EnvelopeType, P> {
  /** Unique per message; also the deduplication key. */
  readonly id: string;

  readonly type: T;

  /** Authenticated sender node id at this hop. */
  readonly from: string;

  /** Target node name. The capability is selected by payload.cap. */
  readonly to: string;

  /** Set on requests; the result must carry it back. */
  readonly replyTo?: string;

  /** Single-user tenant: this is both the tenant id and the user id. */
  readonly tenantId: string;

  readonly payload: P;
}

/** Announce or refresh one node's capabilities. */
export interface RegisterPayload {
  readonly manifest: NodeManifest;
  /** This connection can reassemble `part` frames for messages over the wire frame limit. */
  readonly chunks?: boolean;
}

/** Remove one node registration. */
export interface UnregisterPayload {
  readonly name: string;
}

/** Invoke one capability. */
export interface CallPayload {
  readonly cap: string;
  readonly args: ToolArgs;
}

/** A capability result. Failure is data, not an exception. */
export type ResultPayload = Outcome;

/** Fire-and-forget publication. */
export interface EventPayload {
  /** The node that owns this event channel. */
  readonly node: string;
  readonly topic: string;
  readonly value: unknown;
}

export interface SubscribePayload {
  readonly node: string;
  readonly topic: string;
}
export type UnsubscribePayload = SubscribePayload;

/** Ask the bus for all registered nodes. */
export interface ListNodesPayload {}

/** Ask the bus for one node's capabilities. */
export interface ListCapabilitiesPayload {
  readonly node: string;
}
export interface CreateUserPayload {
  readonly user: string;
}
export interface DestroyUserPayload {
  readonly user: string;
}
export interface ConnectPayload {
  readonly user: string;
  readonly node: string;
}
export interface DisconnectPayload {
  readonly user: string;
  readonly node: string;
}

/** A request carries the deadline that applies to its execution. */
export type RequestEnvelopeBase<T extends EnvelopeType, P> = EnvelopeBase<T, P> & {
  readonly deadline: number;
};

export type RegisterEnvelope = RequestEnvelopeBase<'register', RegisterPayload>;
export type UnregisterEnvelope = EnvelopeBase<'unregister', UnregisterPayload>;
export type CallEnvelope = RequestEnvelopeBase<'call', CallPayload>;
export type ResultEnvelope = EnvelopeBase<'result', ResultPayload>;
export type EventEnvelope = EnvelopeBase<'event', EventPayload>;
export type SubscribeEnvelope = RequestEnvelopeBase<'subscribe', SubscribePayload>;
export type UnsubscribeEnvelope = RequestEnvelopeBase<'unsubscribe', UnsubscribePayload>;
export type ListNodesEnvelope = RequestEnvelopeBase<'list_nodes', ListNodesPayload>;
export type ListCapabilitiesEnvelope = RequestEnvelopeBase<
  'list_capabilities',
  ListCapabilitiesPayload
>;
export type CreateUserEnvelope = RequestEnvelopeBase<'create_user', CreateUserPayload>;
export type DestroyUserEnvelope = RequestEnvelopeBase<'destroy_user', DestroyUserPayload>;
export type ConnectEnvelope = RequestEnvelopeBase<'connect', ConnectPayload>;
export type DisconnectEnvelope = RequestEnvelopeBase<'disconnect', DisconnectPayload>;

/** Host-built messages never carry `from`; only the BusSession can fill it. */
export type OutboundCallEnvelope = Omit<CallEnvelope, 'from'>;
export type OutboundEventEnvelope = Omit<EventEnvelope, 'from' | 'payload'> & {
  readonly payload: { readonly topic: string; readonly value: unknown };
};
export type OutboundSubscribeEnvelope = Omit<SubscribeEnvelope, 'from'>;
export type OutboundUnsubscribeEnvelope = Omit<UnsubscribeEnvelope, 'from'>;
export type OutboundListNodesEnvelope = Omit<ListNodesEnvelope, 'from'>;
export type OutboundListCapabilitiesEnvelope = Omit<ListCapabilitiesEnvelope, 'from'>;
export type OutboundCreateUserEnvelope = Omit<CreateUserEnvelope, 'from'>;
export type OutboundDestroyUserEnvelope = Omit<DestroyUserEnvelope, 'from'>;
export type OutboundConnectEnvelope = Omit<ConnectEnvelope, 'from'>;
export type OutboundDisconnectEnvelope = Omit<DisconnectEnvelope, 'from'>;
export type OutboundResultEnvelope = Omit<ResultEnvelope, 'from'>;
export type OutboundRegisterEnvelope = Omit<RegisterEnvelope, 'from'>;
export type OutboundUnregisterEnvelope = Omit<UnregisterEnvelope, 'from'>;

export type Envelope =
  | RegisterEnvelope
  | UnregisterEnvelope
  | CallEnvelope
  | ResultEnvelope
  | EventEnvelope
  | SubscribeEnvelope
  | UnsubscribeEnvelope
  | ListNodesEnvelope
  | ListCapabilitiesEnvelope
  | CreateUserEnvelope
  | DestroyUserEnvelope
  | ConnectEnvelope
  | DisconnectEnvelope;
