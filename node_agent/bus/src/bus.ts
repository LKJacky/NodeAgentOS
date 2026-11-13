// The bus: one WebSocket per node, envelope frames only.
//
// Two layers share this file:
//
//   Node registration  register / unregister. A node is global; one process can serve every user.
//   User space         call / result / event / subscribe / unsubscribe / list_* /
//                      create_user / destroy_user / connect / disconnect. These
//                      frames belong to a user, never to the node that carries them.
//
// The four frames that change a user table are the control connection's alone: a connection
// that presents NODE_AGENT_CONTROL_TOKEN (only the runtime supervisor holds it) and no other
// connection may send them, so no node — shared or private — can decide who reaches whom.
//
// A connection speaks one protocol: the envelope frames of envelope.ts, one JSON object per
// WebSocket message. There is no second frame shape and no legacy handshake.
//
// Permissions sit in front of that: a capability's schema may carry `callers`, and before the bus
// forwards any call it asks the `system` node (`system.authorize`). A refusal is answered to the
// caller and the call never leaves; a system that does not answer is a refusal too, and the
// system's own calls are not asked about — the question would be addressed to the node that has to
// answer it.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
  type AuthorizeVerdict,
  type CallEnvelope,
  type CapabilityEntry,
  type ConnectEnvelope,
  type CreateUserEnvelope,
  type DestroyUserEnvelope,
  type DisconnectEnvelope,
  type Envelope,
  type EventEnvelope,
  type ListCapabilitiesEnvelope,
  type ListNodesEnvelope,
  type NodeEntry,
  type NodeManifest,
  type Outcome,
  type RegisterEnvelope,
  type ResultEnvelope,
  type SubscribeEnvelope,
  type UnsubscribeEnvelope,
  type UnregisterEnvelope,
} from './envelope.js';
import {
  AUTHORIZE_CAP,
  SYSTEM_NODE,
  capCallers,
  capExposed,
  normalizeManifestPolicy,
} from './envelope.js';
import { route, type Link } from './link.js';
import { busLog } from './log.js';
import { socketUrl } from './node.js';

interface EnvelopeRegistration {
  readonly id: string;
  manifest: NodeManifest;
  link: Link;
  /** Undefined for a shared node; otherwise the only user allowed to see this registration. */
  readonly tenantId?: string;
  /** This registration presented the bus super token. */
  readonly super: boolean;
}

const PRIVATE_TOKEN_PREFIX = 'private-node:';

/** Mint the credential used only on the trusted runtime-to-bus hop for one user's outside node. */
export function privateNodeToken(busToken: string, tenantId: string): string {
  const signature = createHmac('sha256', busToken)
    .update(`${PRIVATE_TOKEN_PREFIX}${tenantId}`)
    .digest('base64url');
  return `${tenantId}.${signature}`;
}

function privateTenant(busToken: string, presented: string): string | undefined {
  const split = presented.lastIndexOf('.');
  if (split < 1) return undefined;
  const tenantId = presented.slice(0, split);
  if (!isUserId(tenantId)) return undefined;
  const expected = Buffer.from(privateNodeToken(busToken, tenantId));
  const received = Buffer.from(presented);
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? tenantId
    : undefined;
}

/** The four frames that change a user table: a control connection's alone. */
type ControlEnvelope =
  CreateUserEnvelope | DestroyUserEnvelope | ConnectEnvelope | DisconnectEnvelope;

function isControlFrame(frame: Envelope): frame is ControlEnvelope {
  return (
    frame.type === 'create_user' ||
    frame.type === 'destroy_user' ||
    frame.type === 'connect' ||
    frame.type === 'disconnect'
  );
}

const PORT = Number(process.env.NODE_AGENT_BUS_PORT ?? 0);
const BIND = process.env.NODE_AGENT_BUS_BIND ?? '127.0.0.1';
const pendingKey = (caller: string, id: string): string => `${caller}\u0000${id}`;

/** What the system node answers when the bus asks whether a call may be forwarded. */
export type AuthorizationVerdict = AuthorizeVerdict;

interface AuthorizationPending {
  readonly resolve: (verdict: AuthorizationVerdict) => void;
  readonly timer: NodeJS.Timeout;
  /** The registration the question went to: it alone may answer, and its departure fails the check. */
  readonly system: EnvelopeRegistration;
  /** The user space that asked: destroying it settles the question at once. */
  readonly user: User;
}

/**
 * How much a user space may hold. A caller chooses how many calls it has in flight and how far in
 * the future their deadlines point, so without a ceiling one connection could grow the pending table
 * — and the timers behind it — until the bus runs out of memory. Every limit is a knob: a bus that
 * needs more says so through the environment (or through the constructor, in a test).
 */
function limit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * The defaults, before the environment or the constructor has a say. The pending ceiling leaves room
 * for a fan-out of sub-agents with their tool calls in flight, and no more.
 */
const DEFAULT_PENDING_PER_USER = 1_024;
const DEFAULT_USERS = 1_000;
/** Ten minutes of work plus a margin: the SDK's own default call deadline is 600_000 ms. */
const DEFAULT_MAX_CALL_MS = 3_600_000;
/** How long a forwarded call waits for the system node's verdict before it is refused. */
const DEFAULT_AUTH_MS = 5_000;

/**
 * cap-level permissions: the bus asks the `system` node before it forwards any call, and these say
 * what the bus does when the system cannot answer.
 */
export interface BusPermissions {
  /** Sent as `defaultCallers`: the whitelist a cap that names no `callers` of its own is held to.
   *  The default is `['*']`; an explicitly empty manifest list stays empty and allows nobody. */
  readonly defaultCallers?: readonly string[];
  /** With no system node on the bus: false (the default) forwards the call, true refuses it. The
   *  reserve a deployment needs before the system node is part of every runtime. */
  readonly enforce?: boolean;
  /** How long a forwarded call waits for the system node's verdict before it is refused. */
  readonly authMs?: number;
}

/** The ceilings one bus runs under; every field is filled in by the constructor. */
export interface BusLimits {
  /** Calls one user space may have in flight at once. */
  readonly pendingPerUser?: number;
  /** User spaces the bus keeps at once; `destroy_user` is the only thing that frees one. */
  readonly users?: number;
  /** The longest a call may stay pending, whatever deadline its frame names. */
  readonly callMs?: number;
  /** The permission knobs: the whitelist a cap inherits, and what to do without a system node. */
  readonly permissions?: BusPermissions;
}

/** A bus user id is an opaque token, not a display name: long enough that a collision is a bug. */
const USER_ID = /^[A-Za-z0-9_.-]{32,128}$/;

/** A topic is a short address, not free text: node names plus dot-separated channels. */
const TOPIC = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const eventKey = (node: string, topic: string): string =>
  `${node}${String.fromCharCode(0)}${topic}`;

/** The internal user that carries node-to-node calls; it owns nothing, it is only a user space. */
export const SERVICE_TENANT = '0000000000000000000000000000000000000000000000000000000000000000';

export function isUserId(value: string): boolean {
  return USER_ID.test(value);
}

function tell(link: Link, frame: Envelope): void {
  link.send(JSON.stringify(frame));
}

/** What an error is, for a frame that has to carry it as text. */
function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One user's space: the shared nodes they may use, and the calls they have in flight. */
class User {
  /** Node names this user is connected to. The nodes themselves live on the bus, once. */
  readonly nodes = new Set<string>();
  /** eventKey(node, topic) -> the exact registrations in this user that asked to hear it. */
  private readonly subscriptions = new Map<string, Set<EnvelopeRegistration>>();
  /** Calls waiting for the control-plane authorization before they are handed to their target. */
  private readonly authorizing = new Set<string>();
  /** registration + request id -> the call this user is waiting for, and the timer that ends it. */
  private readonly pending = new Map<
    string,
    {
      caller: EnvelopeRegistration;
      target: EnvelopeRegistration;
      id: string;
      from: string;
      timer: NodeJS.Timeout;
    }
  >();

  readonly id: string;
  private readonly bus: Bus;

  constructor(id: string, bus: Bus) {
    this.id = id;
    this.bus = bus;
  }

  connect(name: string): void {
    if (!this.bus.envelopeNodes.has(name)) throw new Error(`no such shared node: ${name}`);
    this.nodes.add(name);
  }

  disconnect(name: string): void {
    const shared = this.bus.envelopeNodes.get(name);
    this.nodes.delete(name);
    if (shared === undefined) return;
    for (const [topic, audience] of this.subscriptions) {
      audience.delete(shared);
      if (audience.size === 0) this.subscriptions.delete(topic);
    }
  }

  resolve(name: string): EnvelopeRegistration | undefined {
    return (
      (this.nodes.has(name) ? this.bus.envelopeNodes.get(name) : undefined) ??
      this.bus.privateNodes.get(this.id)?.get(name)
    );
  }

  /** Whether this exact registration came from this user's private table, not the shared table. */
  isPrivate(registration: EnvelopeRegistration): boolean {
    return this.bus.privateNodes.get(this.id)?.get(registration.manifest.name) === registration;
  }

  /**
   * The system node that rules this space: the shared one, else this user's own private one. It is
   * found whether or not the user connected it — a permission check is the bus's question, not a
   * capability the user chose to use — and a private system never answers for another tenant.
   */
  systemNode(): EnvelopeRegistration | undefined {
    return (
      this.bus.envelopeNodes.get(SYSTEM_NODE) ??
      this.bus.privateNodes.get(this.id)?.get(SYSTEM_NODE)
    );
  }

  /** Shared nodes win by name; private nodes fill the names no connected shared node owns. */
  entries(): NodeEntry[] {
    const entries = new Map<string, NodeEntry>();
    const entryOf = (node: EnvelopeRegistration, scope: NodeEntry['scope']): NodeEntry => ({
      name: node.manifest.name,
      desc: node.manifest.desc,
      packageId: node.manifest.packageId,
      version: node.manifest.version,
      publisher: node.manifest.publisher,
      bindings: node.manifest.bindings,
      icon: node.manifest.icon,
      scope,
      ...(node.manifest.labels === undefined ? {} : { labels: node.manifest.labels }),
    });
    for (const [name, node] of this.bus.privateNodes.get(this.id) ?? [])
      entries.set(name, entryOf(node, 'private'));
    for (const name of this.nodes) {
      const node = this.bus.envelopeNodes.get(name);
      if (node !== undefined) entries.set(name, entryOf(node, 'shared'));
    }
    return [...entries.values()];
  }

  capabilities(name: string): CapabilityEntry[] | null {
    const node = this.resolve(name);
    if (node === undefined) return null;
    const labels = node.manifest.labels;
    return Object.entries(node.manifest.caps).map(([cap, parameters]) => ({
      cap,
      parameters,
      // The labels travel with the cap so a directory reader needs no second call: the canonical
      // `cap` name stays what a caller sends, these are only what a page shows.
      ...(labels?.caps?.[cap] === undefined ? {} : { labels: labels.caps[cap] }),
      ...(labels?.args?.[cap] === undefined ? {} : { argLabels: labels.args[cap] }),
    }));
  }

  async call(frame: CallEnvelope, caller: EnvelopeRegistration): Promise<void> {
    const targetName = frame.to;
    const now = Date.now();
    // A frame names its own deadline, and a caller may name any moment it likes — including one past
    // the age of the machine. The wait is therefore bounded by the bus's own ceiling as well: the
    // pending table is only safe when every entry in it is going to end.
    const named = Number.isFinite(frame.deadline) ? frame.deadline : now + this.bus.limits.callMs;
    const expires = Math.min(named, now + this.bus.limits.callMs);
    if (expires <= now) return this.reply(caller, frame, { ok: false, error: 'deadline exceeded' });

    const target = this.resolve(targetName);
    if (target === undefined)
      return this.reply(caller, frame, {
        ok: false,
        error: `no such node for user: ${targetName}`,
      });
    if (!Object.hasOwn(target.manifest.caps, frame.payload.cap))
      return this.reply(caller, frame, {
        ok: false,
        error: `no node provides the capability "${targetName}.${frame.payload.cap}"`,
      });

    busLog('debug', 'call', {
      tenant: this.id,
      from: caller.manifest.name,
      to: targetName,
      cap: frame.payload.cap,
      id: frame.id,
    });

    const key = pendingKey(caller.id, frame.id);
    if (this.pending.has(key) || this.authorizing.has(key))
      return this.reply(caller, frame, {
        ok: false,
        error: `the call id "${frame.id}" is already in flight`,
      });
    if (this.pending.size + this.authorizing.size >= this.bus.limits.pendingPerUser)
      return this.reply(caller, frame, {
        ok: false,
        error: `too many calls in flight for this user (limit ${this.bus.limits.pendingPerUser})`,
      });

    // Every ordinary call is checked by the system node before it is forwarded. The system's own
    // calls are trusted for shared targets; a private target still follows its local expose rule.
    if (!caller.super && (caller.manifest.name !== SYSTEM_NODE || this.isPrivate(target))) {
      this.authorizing.add(key);
      let verdict: AuthorizationVerdict;
      try {
        verdict = await this.bus.authorize(this, caller, target, frame);
      } catch (error) {
        // A check that could not even be asked is a check that was not answered: fail closed, and
        // never leave the caller waiting on a promise nobody holds.
        verdict = { allow: false, reason: said(error) };
      } finally {
        this.authorizing.delete(key);
      }
      // destroy_user may have removed this space while the check was in flight.
      if (this.bus.users.get(this.id) !== this) return;
      if (!verdict.allow)
        return this.reply(caller, frame, {
          ok: false,
          error: `permission denied: ${verdict.reason ?? 'not allowed'}`,
        });
    }
    if (expires <= Date.now())
      return this.reply(caller, frame, { ok: false, error: 'deadline exceeded' });
    // The target may have left while the check was in flight; its promises are not the caller's.
    if (this.resolve(targetName) !== target)
      return this.reply(caller, frame, {
        ok: false,
        error: `no such node for user: ${targetName}`,
      });

    // The call is out: if the target never answers, this timer is the only thing that will settle it.
    // It is unref'd, so a pending call cannot hold the process open on its own; a bus with a socket
    // still has the event loop those sockets keep alive.
    const timer = setTimeout(() => this.expire(key), expires - now);
    timer.unref();
    const alias = typeof frame.from === 'string' ? frame.from.trim() : '';
    const from = caller.super && alias !== '' && TOPIC.test(alias) ? alias : caller.manifest.name;
    this.pending.set(key, { caller, target, id: frame.id, from, timer });
    tell(target.link, { ...frame, from, tenantId: this.id });
  }

  /** The wait a call's frame allowed is over: drop it and tell the caller what became of it. */
  private expire(key: string): void {
    const call = this.pending.get(key);
    if (call === undefined) return;
    this.pending.delete(key);
    this.sendResult(call.caller, call.target, call.id, { ok: false, error: 'deadline exceeded' });
  }

  result(frame: ResultEnvelope, sender: EnvelopeRegistration): void {
    const pending = [...this.pending.entries()].find(
      ([, value]) =>
        value.target === sender && value.id === (frame.replyTo ?? '') && value.from === frame.to,
    );
    if (pending === undefined) return;
    this.pending.delete(pending[0]);
    clearTimeout(pending[1].timer);
    this.sendResult(pending[1].caller, pending[1].target, pending[1].id, frame.payload);
  }

  event(frame: EventEnvelope, from: EnvelopeRegistration): void {
    // `from` is the bus's authenticated registration; a payload cannot choose or forge it.
    this.notify(
      from.manifest.name,
      frame.payload?.topic ?? '',
      frame.payload.value,
      undefined,
      from.manifest.name,
    );
  }

  /** Register this exact node connection's interest in a node/topic pair. */
  subscribe(frame: SubscribeEnvelope, caller: EnvelopeRegistration): void {
    const node = frame.payload?.node ?? '';
    const topic = frame.payload?.topic ?? '';
    if (!TOPIC.test(node) || !TOPIC.test(topic))
      return this.reply(caller, frame, { ok: false, error: 'subscribe wants a node and a topic' });
    if (this.resolve(caller.manifest.name) !== caller)
      return this.reply(caller, frame, {
        ok: false,
        error: `no such node for user: ${caller.manifest.name}`,
      });
    const key = eventKey(node, topic);
    const audience = this.subscriptions.get(key) ?? new Set<EnvelopeRegistration>();
    audience.add(caller);
    this.subscriptions.set(key, audience);
    this.reply(caller, frame, { ok: true, value: { node, topic } });
  }

  unsubscribe(frame: UnsubscribeEnvelope, caller: EnvelopeRegistration): void {
    const node = frame.payload?.node ?? '';
    const topic = frame.payload?.topic ?? '';
    if (!TOPIC.test(node) || !TOPIC.test(topic))
      return this.reply(caller, frame, {
        ok: false,
        error: 'unsubscribe wants a node and a topic',
      });
    const key = eventKey(node, topic);
    const audience = this.subscriptions.get(key);
    audience?.delete(caller);
    if (audience !== undefined && audience.size === 0) this.subscriptions.delete(key);
    this.reply(caller, frame, { ok: true, value: { node, topic } });
  }

  /** Tell the exact registrations that asked for this node/topic pair. */
  notify(
    node: string,
    topic: string,
    value: unknown,
    skip?: EnvelopeRegistration,
    from = 'bus',
  ): void {
    if (!TOPIC.test(node) || !TOPIC.test(topic)) return;
    for (const entry of this.subscriptions.get(eventKey(node, topic)) ?? []) {
      if (entry === skip) continue;
      tell(entry.link, {
        id: randomUUID(),
        type: 'event',
        from,
        to: entry.manifest.name,
        tenantId: this.id,
        payload: { node, topic, value },
      });
    }
  }

  listNodes(frame: ListNodesEnvelope, caller: EnvelopeRegistration): void {
    this.reply(caller, frame, { ok: true, value: this.entries() });
  }

  listCapabilities(frame: ListCapabilitiesEnvelope, caller: EnvelopeRegistration): void {
    const target = frame.payload?.node ?? '';
    const caps = this.capabilities(target);
    if (caps === null)
      return this.reply(caller, frame, {
        ok: false,
        error: `no such node: ${frame.payload?.node}`,
      });
    // `expose: false` is invisible to ordinary sibling nodes. webui needs the full schema to render
    // a page; system needs it to enforce `allow_edit_permission` and to hide those rows in its UI.
    const trusted = caller.manifest.name === 'webui' || caller.manifest.name === SYSTEM_NODE;
    const visible = trusted ? caps : caps.filter((cap) => capExposed(cap.parameters));
    this.reply(caller, frame, { ok: true, value: visible });
  }

  /** A registration left: fail only calls involving that exact global/private node. */
  failNode(registration: EnvelopeRegistration, error: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.target === registration)
        this.sendResult(pending.caller, pending.target, pending.id, { ok: false, error });
      if (pending.target === registration || pending.caller === registration) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
      }
    }
    for (const [topic, audience] of this.subscriptions) {
      audience.delete(registration);
      if (audience.size === 0) this.subscriptions.delete(topic);
    }
  }

  /**
   * The user space is going away (`destroy_user`): settle what it was waiting for and forget all of
   * it — pending calls, subscriptions, and the shared nodes it was connected to. Nothing of it is
   * left for a later user with the same id to inherit.
   */
  destroy(reason: string): void {
    this.authorizing.clear();
    this.bus.failUserAuthorizations(this, reason);
    for (const [key, call] of this.pending) {
      this.pending.delete(key);
      clearTimeout(call.timer);
      this.sendResult(call.caller, call.target, call.id, { ok: false, error: reason });
    }
    this.subscriptions.clear();
    this.nodes.clear();
  }

  /** How many calls this space is waiting for; the number the per-user quota is measured in. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private reply(caller: EnvelopeRegistration, frame: Envelope, outcome: Outcome<unknown>): void {
    if (!outcome.ok)
      busLog('debug', 'call.refused', {
        tenant: this.id,
        from: caller.manifest.name,
        to: frame.to,
        cap: (frame.payload as { cap?: unknown } | undefined)?.cap,
        id: frame.id,
        error: outcome.error,
      });
    tell(caller.link, {
      id: randomUUID(),
      type: 'result',
      from: caller.manifest.name,
      to: frame.from,
      replyTo: frame.id,
      tenantId: this.id,
      payload: outcome,
    });
  }

  private sendResult(
    caller: EnvelopeRegistration,
    target: EnvelopeRegistration,
    replyTo: string,
    outcome: Outcome<unknown>,
  ): void {
    busLog('debug', 'call.done', {
      tenant: this.id,
      from: target.manifest.name,
      to: caller.manifest.name,
      id: replyTo,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.error }),
    });
    tell(caller.link, {
      id: randomUUID(),
      type: 'result',
      from: target.manifest.name,
      to: caller.manifest.name,
      replyTo,
      tenantId: this.id,
      payload: outcome,
    });
  }
}

export class Bus {
  readonly token: string;
  /** The runtime supervisor's credential; empty means this bus has no control connection at all. */
  readonly controlToken: string;
  /** A bus-wide super credential; empty disables super connections. */
  readonly superToken: string;
  /** The ceilings every user space on this bus is held to (see BusLimits). */
  readonly limits: Required<Omit<BusLimits, 'permissions'>>;
  /** The permission knobs: the default whitelist, and what to do without a system node. */
  readonly permissions: Required<BusPermissions>;
  /** Shared registrations, addressed only after a user explicitly connects them. */
  envelopeNodes = new Map<string, EnvelopeRegistration>();
  /** Private registrations by owner; equal names in different user maps are independent. */
  readonly privateNodes = new Map<string, Map<string, EnvelopeRegistration>>();
  /** user id -> that user's node set and in-flight calls. */
  readonly users = new Map<string, User>();
  /** Internal calls waiting for system.authorize, keyed by the check frame's request id. */
  private readonly authorizations = new Map<string, AuthorizationPending>();
  server!: Server;

  /** `controlToken` is a string, or limits passed alone by a test that needs no control plane. */
  constructor(
    token: string,
    controlTokenOrLimits: string | BusLimits = '',
    limits: BusLimits = {},
    superToken = '',
  ) {
    this.token = token;
    if (typeof controlTokenOrLimits === 'string') {
      this.controlToken = controlTokenOrLimits.trim();
    } else {
      this.controlToken = '';
      limits = controlTokenOrLimits;
    }
    this.superToken = superToken.trim();
    this.limits = {
      pendingPerUser:
        limits.pendingPerUser ?? limit('NODE_AGENT_BUS_MAX_PENDING', DEFAULT_PENDING_PER_USER),
      users: limits.users ?? limit('NODE_AGENT_BUS_MAX_USERS', DEFAULT_USERS),
      callMs: limits.callMs ?? limit('NODE_AGENT_BUS_MAX_CALL_MS', DEFAULT_MAX_CALL_MS),
    };
    this.permissions = {
      defaultCallers: [...(limits.permissions?.defaultCallers ?? ['*'])],
      enforce: limits.permissions?.enforce ?? false,
      authMs: limits.permissions?.authMs ?? limit('NODE_AGENT_BUS_AUTH_MS', DEFAULT_AUTH_MS),
    };
  }

  /** Ask the system node whether `caller` may call `target.cap` for this user. With no system node on
   *  the bus there is no policy to consult, so the bus preserves the historical allow-all behavior
   *  unless `permissions.enforce` asks for the reserve; a real runtime always has one. A system that
   *  is present but fails to answer is fail-closed. */
  async authorize(
    user: User,
    caller: EnvelopeRegistration,
    target: EnvelopeRegistration,
    frame: CallEnvelope,
  ): Promise<AuthorizationVerdict> {
    const privateTarget = user.isPrivate(target);
    const system = user.systemNode();
    if (system === undefined)
      return this.permissions.enforce
        ? { allow: false, reason: 'this bus has no system node to authorize the call' }
        : { allow: true };
    // A cap's own `callers` is the list that applies to it; a cap that names none is held to the
    // bus's default, which is empty when the bus holds no opinion and the system node decides alone.
    // Private nodes still ask system, but with `private: true` and an allow-all default so their
    // manifest callers and old overrides never restrict them.
    const defaultCallers = privateTarget
      ? ['*']
      : (capCallers(target.manifest.caps[frame.payload.cap]) ?? [
          ...this.permissions.defaultCallers,
        ]);
    const expose = capExposed(target.manifest.caps[frame.payload.cap]);
    const authMs = this.permissions.authMs;
    const id = `auth-${randomUUID()}`;
    const verdict = new Promise<AuthorizationVerdict>((resolve) => {
      const timer = setTimeout(() => {
        this.authorizations.delete(id);
        resolve({ allow: false, reason: `the system did not answer authorize within ${authMs}ms` });
      }, authMs);
      timer.unref();
      this.authorizations.set(id, { resolve, timer, system, user });
    });
    tell(system.link, {
      id,
      type: 'call',
      from: 'bus',
      to: system.manifest.name,
      tenantId: user.id,
      deadline: Date.now() + authMs,
      payload: {
        cap: AUTHORIZE_CAP,
        args: {
          caller: caller.manifest.name,
          target: target.manifest.name,
          cap: frame.payload.cap,
          tenant: user.id,
          defaultCallers,
          expose,
          ...(privateTarget ? { private: true } : {}),
        },
      },
    });
    return verdict;
  }

  /** Take one system.authorize result out of the internal table. False means it was an ordinary call. */
  resolveAuthorization(frame: ResultEnvelope, sender: EnvelopeRegistration): boolean {
    if (sender.manifest.name !== SYSTEM_NODE || frame.to !== 'bus') return false;
    const pending = this.authorizations.get(frame.replyTo ?? '');
    if (pending === undefined || pending.system !== sender) return false;
    this.authorizations.delete(frame.replyTo ?? '');
    clearTimeout(pending.timer);
    const payload = frame.payload;
    if (!payload.ok) {
      pending.resolve({ allow: false, reason: payload.error });
      return true;
    }
    const value = payload.value;
    if (typeof value !== 'object' || value === null) {
      pending.resolve({ allow: false, reason: 'the system returned no permission verdict' });
      return true;
    }
    const answer = value as Record<string, unknown>;
    pending.resolve({
      allow: answer.allow === true,
      reason: typeof answer.reason === 'string' && answer.reason !== '' ? answer.reason : undefined,
    });
    return true;
  }

  /** Number of permission checks still waiting for the system (used by tests and metrics). */
  get authPendingCount(): number {
    return this.authorizations.size;
  }

  /** The user space for `id`, created on demand when `create` is true. */
  user(id: string, create = false): User | undefined {
    if (!isUserId(id)) throw new Error('a bus user id must be an opaque token');
    let user = this.users.get(id);
    if (user === undefined && create) {
      // A user id is chosen by whoever asks for one, so the count of spaces is a quota like any other.
      if (this.users.size >= this.limits.users)
        throw new Error(`the bus already holds ${this.users.size} user spaces`);
      user = new User(id, this);
      this.users.set(id, user);
    }
    return user;
  }

  /**
   * Drop one user space and everything it owns: its in-flight calls, its subscriptions, its private
   * nodes and the connections those nodes are on. A private registration lives inside one user's
   * space, so it cannot outlive it — the next `user(id, true)` starts from nothing and no private
   * node of the destroyed space comes back with it.
   *
   * Returns whether there was anything to drop.
   */
  destroyUser(id: string): boolean {
    const user = this.users.get(id);
    const nodes = this.privateNodes.get(id);
    // Both tables go first: a connection that reacts to its socket closing must not find a space to
    // put its name back into, and `remove` on a missing map is a no-op by construction.
    this.users.delete(id);
    this.privateNodes.delete(id);
    user?.destroy('the user was destroyed');
    for (const node of nodes?.values() ?? []) node.link.close();
    return user !== undefined || (nodes?.size ?? 0) > 0;
  }

  /** How many calls every user space is waiting for together. */
  get pendingCount(): number {
    let total = 0;
    for (const user of this.users.values()) total += user.pendingCount;
    return total;
  }

  listen(port: number = PORT, bind: string = BIND): Promise<this> {
    return new Promise((ok, bad) => {
      this.server = createServer((sock) => this.accept(sock));
      this.server.once('error', (e: Error) => {
        this.server?.close();
        bad(e);
      });
      this.server.listen(port, bind, () => {
        busLog('info', 'listening', { bind, port: this.port });
        ok(this);
      });
    });
  }

  get port(): number {
    const address = this.server.address();
    return address !== null && typeof address === 'object' ? address.port : 0;
  }

  get url(): string {
    const bound = this.server.address();
    const local =
      bound !== null &&
      typeof bound === 'object' &&
      bound.address !== '0.0.0.0' &&
      bound.address !== '::'
        ? bound.address
        : '127.0.0.1';
    return socketUrl(local, this.port);
  }

  /** Settle every permission check one user still has waiting; destroy_user is the end of them. */
  failUserAuthorizations(user: User, error: string): void {
    for (const [id, check] of this.authorizations) {
      if (check.user !== user) continue;
      this.authorizations.delete(id);
      clearTimeout(check.timer);
      check.resolve({ allow: false, reason: error });
    }
  }

  failEnvelopeCalls(registration: EnvelopeRegistration, error: string): void {
    for (const user of this.users.values()) user.failNode(registration, error);
    // The system node leaving mid-question is an answer the bus already has: nothing will ever
    // arrive for the checks that were waiting on it, so they are refused now rather than at their
    // timers, and the table does not keep a question whose asker is gone.
    for (const [id, check] of this.authorizations) {
      if (check.system !== registration) continue;
      this.authorizations.delete(id);
      clearTimeout(check.timer);
      check.resolve({ allow: false, reason: error });
    }
  }

  privateMap(tenantId: string, create = false): Map<string, EnvelopeRegistration> | undefined {
    let nodes = this.privateNodes.get(tenantId);
    if (nodes === undefined && create) {
      nodes = new Map<string, EnvelopeRegistration>();
      this.privateNodes.set(tenantId, nodes);
    }
    return nodes;
  }

  accept(sock: Socket): void {
    route(sock, (link) => new Connection(this, link).start());
  }

  close(): void {
    busLog('info', 'closing', { port: this.port });
    this.server?.close();
  }
}

class Connection {
  private readonly bus: Bus;
  private readonly link: Link;
  private readonly id = randomUUID().slice(0, 8);
  private node: EnvelopeRegistration | null = null;

  constructor(bus: Bus, link: Link) {
    this.bus = bus;
    this.link = link;
  }

  start(): void {
    busLog('info', 'connection.open', { connection: this.id });
    this.link.receive<Envelope>(
      (frame) => this.onFrame(frame),
      () => this.onClose(),
    );
  }

  /** Only the connection that presented the control token may change a user table. */
  private get isControl(): boolean {
    return this.bus.controlToken !== '' && this.link.token === this.bus.controlToken;
  }

  /** The super connection bypasses call authorization and may choose the forwarded `from`. */
  private get isSuper(): boolean {
    return this.bus.superToken !== '' && this.link.token === this.bus.superToken;
  }

  private onFrame(frame: Envelope): void {
    // A connection the bus has already closed (a destroyed user's private node) has no space left to
    // speak into: a late frame must not create one.
    if (this.link.gone) return;
    if (this.node === null) {
      // A control connection owns no node of its own: it may speak its frames straight away.
      if (this.isControl && isControlFrame(frame)) {
        if (!this.acceptsTenant(frame)) return this.refuse(frame, 'invalid tenant');
        return this.onControl(frame);
      }
      if (frame.type !== 'register')
        return this.refuse(frame, 'the first envelope must be register');
      return this.onRegister(frame);
    }
    // Node-related frames come first and are user-independent. They must not validate a tenant or
    // create a user space just to register or remove a node.
    switch (frame.type) {
      case 'register':
        return this.onRegister(frame);
      case 'unregister':
        return this.onUnregister(frame);
    }

    if (!this.acceptsTenant(frame)) return this.refuse(frame, 'invalid tenant');
    let user: User;
    try {
      user = this.userOf(frame);
    } catch (error) {
      // The tenant quota is full: the frame is refused, and the connection stays up for the space it
      // already has.
      return this.result(frame, { ok: false, error: said(error) });
    }
    switch (frame.type) {
      case 'call':
        void user.call(frame, this.node!);
        return;
      case 'result':
        if (this.node !== null && this.bus.resolveAuthorization(frame, this.node)) return;
        return user.result(frame, this.node);
      case 'event':
        return user.event(frame, this.node);
      case 'subscribe':
        return user.subscribe(frame, this.node);
      case 'unsubscribe':
        return user.unsubscribe(frame, this.node);
      case 'list_nodes':
        return user.listNodes(frame, this.node);
      case 'list_capabilities':
        return user.listCapabilities(frame, this.node);
      case 'create_user':
      case 'destroy_user':
      case 'connect':
      case 'disconnect':
        // A user table is the control connection's to change: no node, shared or private, decides
        // who may reach whom.
        if (!this.isControl)
          return this.result(frame, {
            ok: false,
            error: 'control frames need a control connection',
          });
        return this.onControl(frame);
    }
  }

  private onControl(frame: ControlEnvelope): void {
    if (frame.type === 'create_user') return this.onCreateUser(frame);
    if (frame.type === 'destroy_user') return this.onDestroyUser(frame);
    if (frame.type === 'connect') return this.onConnect(frame);
    this.onDisconnect(frame);
  }

  /** Private connections are permanently bound to their owner, regardless of frame content. */
  private userOf(frame: Envelope): User {
    const id = this.node?.tenantId ?? (frame.tenantId === '*' ? SERVICE_TENANT : frame.tenantId);
    return this.bus.user(id, true)!;
  }

  private onClose(): void {
    const self = this.node;
    busLog('info', 'connection.close', { connection: this.id, node: self?.manifest.name });
    if (self === null) return;
    this.node = null;
    this.remove(self, `node "${self.manifest.name}" left before answering`);
  }

  private remove(self: EnvelopeRegistration, error: string): void {
    if (self.tenantId === undefined) {
      if (this.bus.envelopeNodes.get(self.manifest.name) === self)
        this.bus.envelopeNodes.delete(self.manifest.name);
      for (const user of this.bus.users.values()) {
        user.notify('bus', 'nodes', { node: self.manifest.name, action: 'disconnected' }, self);
        user.disconnect(self.manifest.name);
      }
    } else {
      const nodes = this.bus.privateMap(self.tenantId);
      if (nodes?.get(self.manifest.name) === self) nodes.delete(self.manifest.name);
      if (nodes?.size === 0) this.bus.privateNodes.delete(self.tenantId);
      this.bus
        .user(self.tenantId)
        ?.notify('bus', 'nodes', { node: self.manifest.name, action: 'disconnected' }, self);
    }
    this.bus.failEnvelopeCalls(self, error);
  }

  private acceptsTenant(frame: Envelope): boolean {
    if (this.node?.tenantId !== undefined) return typeof frame.tenantId === 'string';
    return (
      typeof frame.tenantId === 'string' && (frame.tenantId === '*' || isUserId(frame.tenantId))
    );
  }

  private result(frame: Envelope, outcome: Outcome<unknown>): void {
    tell(this.link, {
      id: randomUUID(),
      type: 'result',
      from: this.node?.manifest.name ?? '',
      to: frame.from,
      replyTo: frame.id,
      tenantId: (this.node?.tenantId ?? frame.tenantId) || SERVICE_TENANT,
      payload: outcome,
    });
  }

  private refuse(frame: Envelope, error: string): void {
    busLog('warn', 'connection.refuse', { connection: this.id, type: frame.type, error });
    this.result(frame, { ok: false, error });
    this.link.close();
  }

  private onRegister(frame: RegisterEnvelope): void {
    // A control connection is trusted: what it registers is a shared node like any other.
    const tenantId =
      this.isControl || this.isSuper || this.link.token === this.bus.token
        ? undefined
        : privateTenant(this.bus.token, this.link.token);
    if (
      !this.isControl &&
      !this.isSuper &&
      this.link.token !== this.bus.token &&
      tenantId === undefined
    )
      return this.refuse(frame, 'wrong token');

    const manifest = frame.payload?.manifest;
    if (
      manifest === null ||
      typeof manifest !== 'object' ||
      typeof manifest.name !== 'string' ||
      manifest.name.trim() === '' ||
      typeof manifest.caps !== 'object' ||
      manifest.caps === null
    ) {
      return this.refuse(frame, 'register wants a manifest with a name and caps');
    }

    const policyError = normalizeManifestPolicy(manifest);
    if (policyError !== null) return this.refuse(frame, policyError);

    const name = manifest.name;
    this.link.chunks = frame.payload.chunks === true;
    const registry =
      tenantId === undefined ? this.bus.envelopeNodes : this.bus.privateMap(tenantId, true)!;
    const previous = this.node;
    if (previous !== null && previous.manifest.name === name) {
      previous.manifest = manifest;
      this.result(frame, { ok: true });
      return;
    }
    // A name is either shared or private, never both: the two tables have different visibility
    // rules, so a collision would make the same address mean different things to different users.
    if (tenantId === undefined) {
      for (const nodes of this.bus.privateNodes.values()) {
        if (nodes.has(name))
          return this.refuse(frame, `the name "${name}" is already taken by a private node`);
      }
    } else if (this.bus.envelopeNodes.has(name)) {
      return this.refuse(frame, `the name "${name}" is already taken by a shared node`);
    }
    const holder = registry.get(name);
    if (holder !== undefined && holder.link !== this.link)
      return this.refuse(frame, `the name "${name}" is already taken by another connection`);

    if (previous !== null) this.remove(previous, 'the node re-registered');
    this.node = { id: randomUUID(), manifest, link: this.link, tenantId, super: this.isSuper };
    registry.set(name, this.node);
    busLog('info', 'node.register', {
      connection: this.id,
      node: name,
      tenant: tenantId,
      scope: tenantId === undefined ? 'shared' : 'private',
    });

    if (tenantId !== undefined) {
      // The space this node belongs to; a bus too full to hold one still lets the node in, it just
      // has nobody to tell about it.
      try {
        const user = this.bus.user(tenantId, true);
        user?.notify('bus', 'nodes', { node: name, action: 'connected' }, this.node);
      } catch (error) {
        console.error(`[bus] a private node joined without a user space: ${said(error)}`);
      }
    }
    this.result(frame, { ok: true });
  }

  private onUnregister(frame: UnregisterEnvelope): void {
    const self = this.node;
    if (self === null || frame.payload?.name !== self.manifest.name) return;
    busLog('info', 'node.unregister', {
      connection: this.id,
      node: self.manifest.name,
      tenant: self.tenantId,
    });
    this.node = null;
    this.remove(self, 'the node unregistered');
  }

  private onCreateUser(frame: CreateUserEnvelope): void {
    const user = frame.payload?.user?.trim?.() ?? '';
    if (!isUserId(user))
      return this.result(frame, { ok: false, error: 'create_user wants an opaque user token' });
    try {
      this.bus.user(user, true);
    } catch (error) {
      return this.result(frame, { ok: false, error: said(error) });
    }
    this.result(frame, { ok: true, value: { user, nodes: [] } });
  }

  private onDestroyUser(frame: DestroyUserEnvelope): void {
    const user = frame.payload?.user?.trim?.() ?? '';
    if (!isUserId(user))
      return this.result(frame, { ok: false, error: 'destroy_user wants an opaque user token' });
    const removed = this.bus.destroyUser(user);
    this.result(frame, { ok: true, value: { user, removed } });
  }

  private onConnect(frame: ConnectEnvelope): void {
    const user = frame.payload?.user?.trim?.() ?? '';
    const node = frame.payload?.node?.trim?.() ?? '';
    if (!isUserId(user) || node === '')
      return this.result(frame, {
        ok: false,
        error: 'connect wants an opaque user token and a node',
      });
    try {
      const space = this.bus.user(user, true)!;
      const already = space.nodes.has(node);
      space.connect(node);
      busLog('info', 'user.connect', { user, node, already });
      if (!already)
        space.notify('bus', 'nodes', { node, action: 'connected' }, space.resolve(node));
    } catch (error) {
      return this.result(frame, { ok: false, error: said(error) });
    }
    this.result(frame, { ok: true, value: { user, node } });
  }

  private onDisconnect(frame: DisconnectEnvelope): void {
    const user = frame.payload?.user?.trim?.() ?? '';
    const node = frame.payload?.node?.trim?.() ?? '';
    if (!isUserId(user) || node === '')
      return this.result(frame, {
        ok: false,
        error: 'disconnect wants an opaque user token and a node',
      });
    const space = this.bus.user(user);
    if (space !== undefined) {
      const registration = space.resolve(node);
      space.disconnect(node);
      space.notify('bus', 'nodes', { node, action: 'disconnected' }, registration);
    }
    this.result(frame, { ok: true, value: { user, node } });
  }
}
