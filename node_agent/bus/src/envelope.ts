// The envelope protocol the bus and the SDK share.
//
// This is deliberately a copy of sdk/src/envelope.ts: the bus package is
// standalone (it carries no SDK dependency), and the two sides are kept honest by wire tests rather
// than by one importing the other's build output. A field added here must be added there too.

export type ToolArgs = Record<string, unknown>;

export type Outcome<T = unknown> = { ok: true; value?: T } | { ok: false; error: string };

/** One display name, per language tag. The identifiers it labels stay canonical. */
export type LocalizedText = Readonly<Record<string, string>>;

/** A node's display names: its own, its caps', and their arguments'. */
export interface NodeLabels {
  readonly node?: LocalizedText;
  readonly caps?: Readonly<Record<string, LocalizedText>>;
  readonly args?: Readonly<Record<string, Readonly<Record<string, LocalizedText>>>>;
}

export interface NodeManifest {
  readonly packageId: string;
  readonly name: string;
  readonly caps: Readonly<Record<string, ToolArgs>>;
  readonly bindings?: readonly string[];
  readonly desc: string;
  readonly version: string;
  readonly publisher: string;
  readonly icon: string;
  /** Display names, carried verbatim: the bus never reads them, a directory shows them. */
  readonly labels?: NodeLabels;
}

export interface NodeEntry {
  readonly name: string;
  readonly desc: string;
  readonly packageId: string;
  readonly version: string;
  readonly publisher?: string;
  readonly bindings?: readonly string[];
  readonly icon: string;
  /** Whether this node is shared across the service tenant or owned by this user space. */
  readonly scope: 'shared' | 'private';
  /** The manifest's labels, carried through so a directory can show them. */
  readonly labels?: NodeLabels;
}

export interface CapabilityEntry {
  readonly cap: string;
  readonly parameters: ToolArgs;
  /** The cap's display name per language, from the node's labels. */
  readonly labels?: LocalizedText;
  /** Display names for this cap's arguments. */
  readonly argLabels?: Readonly<Record<string, LocalizedText>>;
}

/** The node a call is authorized by, and the capability it is asked at. */
export const SYSTEM_NODE = 'system';
export const AUTHORIZE_CAP = 'authorize';

/** What the system node answers: only `allow: true` lets the call through. */
export interface AuthorizeVerdict {
  readonly allow: boolean;
  readonly reason?: string;
}

/**
 * The `callers` a capability's schema declares, cleaned of what could not be a node name, or
 * `undefined` when it declares none — the caller then applies the bus default.
 */
export function capCallers(schema: ToolArgs | undefined): string[] | undefined {
  const named = (schema as { callers?: unknown } | undefined)?.callers;
  if (!Array.isArray(named)) return undefined;
  return named.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * Whether a capability is visible to sibling nodes.
 *
 * Explicit is explicit: `expose: false` hides it. And one shape of manifest says the same thing
 * without the word — a cap that names no caller (`callers: []`, so no sibling may call it) and is
 * reserved from the permission editor (`allow_edit_permission: false`, so there is no row to grant)
 * is the node's own and its page's. Such a cap is not a policy anyone can edit and not a door a
 * sibling should see, so listing it would only invite a call `authorize` refuses; it is treated as
 * `expose: false`. A cap that is merely uneditable (a fixed whitelist in `callers`) stays exposed:
 * reading the directory is not the same permission as calling.
 */
export function capExposed(schema: ToolArgs | undefined): boolean {
  const policy = schema as
    { expose?: unknown; callers?: unknown; allow_edit_permission?: unknown } | undefined;
  if (policy?.expose === false) return false;
  const callers = policy?.callers;
  const internal = Array.isArray(callers) && callers.length === 0;
  return !(internal && policy?.allow_edit_permission === false);
}

/**
 * Fixed policy for a node's `ui` capability. A page is rendered by webui only: it must not be
 * exposed to sibling nodes and it must not become an editable permission-table entry. The bus
 * normalises legacy/third-party manifests instead of rejecting them, so an old package with a
 * plain `ui: {}` still joins while the runtime invariants hold. Returns an error only when `ui`
 * is present but is not an object.
 */
export function normalizeManifestPolicy(manifest: NodeManifest): string | null {
  const ui = manifest.caps.ui as Record<string, unknown> | undefined;
  if (ui === undefined) return null;
  if (ui === null || typeof ui !== 'object') return `${manifest.name}.ui must be an object`;
  ui.expose = false;
  ui.allow_edit_permission = false;
  return null;
}

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
  readonly id: string;
  readonly type: T;
  /** The authenticated sender on this hop. The bus overwrites it. */
  readonly from: string;
  readonly to: string;
  readonly replyTo?: string;
  /** The tenant bound to the connection. The bus overwrites it. */
  readonly tenantId: string;
  readonly payload: P;
}

export interface RegisterPayload {
  readonly manifest: NodeManifest;
  /** This connection can reassemble `part` frames for messages over the wire frame limit. */
  readonly chunks?: boolean;
}
export interface UnregisterPayload {
  readonly name: string;
}
export interface CallPayload {
  readonly cap: string;
  readonly args: ToolArgs;
}
export type ResultPayload = Outcome;
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
export type ListNodesPayload = Record<string, never>;
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

/** A first frame is an envelope when it has a `type` and no legacy `op`. */
export function isEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') return false;
  const frame = value as { type?: unknown; op?: unknown };
  return typeof frame.type === 'string' && frame.op === undefined;
}
