import { createHmac, randomUUID } from 'node:crypto';
import type {
  CallEnvelope,
  CapabilityEntry,
  EventEnvelope,
  NodeEntry,
  NodeManifest,
  Outcome,
  OutboundCallEnvelope,
  OutboundConnectEnvelope,
  OutboundEventEnvelope,
  OutboundListCapabilitiesEnvelope,
  OutboundListNodesEnvelope,
  OutboundRegisterEnvelope,
  OutboundResultEnvelope,
  OutboundSubscribeEnvelope,
  OutboundUnsubscribeEnvelope,
  OutboundUnregisterEnvelope,
  ResultEnvelope,
} from './envelope.js';
import { Assembler, parts } from './chunks.js';
import type { BusSession } from './host.js';
import { allowInsecureTls } from './tls.js';

export interface WebSocketBusSessionOptions {
  readonly WebSocket?: typeof WebSocket;
  readonly registerTimeoutMs?: number;
  readonly autoReconnect?: boolean;
  readonly reconnectDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

interface Pending {
  readonly resolve: (result: ResultEnvelope) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class WebSocketBusSession implements BusSession {
  readonly #Socket: typeof WebSocket;
  readonly #timeout: number;
  readonly #autoReconnect: boolean;
  readonly #reconnectDelay: number;
  readonly #reconnectMaxDelay: number;
  readonly #pending = new Map<string, Pending>();
  readonly #subscriptions = new Map<string, { topic: string; tenantId: string; node: string }>();
  readonly #assembler = new Assembler((frame) => this.#route(frame));
  #ws: WebSocket | null = null;
  #token: string | null = null;
  #url = '';
  #manifest: NodeManifest | null = null;
  #wasConnected = false;
  #closing = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0;
  #onCall: ((call: CallEnvelope) => Promise<void> | void) | null = null;
  #onEvent: ((event: EventEnvelope) => void) | null = null;

  readonly #forkOptions: WebSocketBusSessionOptions;

  constructor(options: WebSocketBusSessionOptions = {}) {
    this.#forkOptions = options;
    this.#Socket = options.WebSocket ?? WebSocket;
    this.#timeout = options.registerTimeoutMs ?? 5_000;
    this.#autoReconnect = options.autoReconnect ?? true;
    this.#reconnectDelay = Math.max(1, options.reconnectDelayMs ?? 1_000);
    this.#reconnectMaxDelay = Math.max(this.#reconnectDelay, options.reconnectMaxDelayMs ?? 30_000);
  }

  async connect(url: string, token: string): Promise<void> {
    if (this.#ws) throw new Error('bus session already connected');
    this.#closing = false;
    this.#wasConnected = false;
    this.#reconnectAttempts = 0;
    this.#url = url;
    this.#token = token;
    await this.#dial();
  }

  async #dial(): Promise<void> {
    allowInsecureTls();
    const endpoint = new URL(this.#url);
    if (this.#token) endpoint.searchParams.set('token', this.#token);
    const ws = new this.#Socket(endpoint.toString());
    this.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('bus connect timeout'));
      }, this.#timeout);
      ws.addEventListener('open', () => {
        opened = true;
        this.#wasConnected = true;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        if (!opened) {
          clearTimeout(timer);
          ws.close();
          reject(new Error('bus connect failed'));
        }
      });
      ws.addEventListener('message', (event) => {
        if (this.#ws === ws) this.#onMessage(event.data);
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        if (!opened) {
          reject(new Error('bus connection closed before open'));
          return;
        }
        this.#lost(ws, 'bus connection closed');
      });
    }).catch((error: unknown) => {
      if (this.#ws === ws) this.#ws = null;
      throw error;
    });
  }

  /** A second session with the same transport settings, for a node this one starts. */
  fork(): BusSession {
    return new WebSocketBusSession(this.#forkOptions);
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#failPending(new Error('bus session closed'));
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
    this.#token = null;
    this.#subscriptions.clear();
  }

  #lost(ws: WebSocket, why: string): void {
    if (this.#closing || ws !== this.#ws) return;
    this.#ws = null;
    this.#failPending(new Error(why));
    if (!this.#autoReconnect || !this.#wasConnected) return;
    const who = this.#manifest?.name ?? this.#url;
    console.error(`${who}: lost the bus — retrying in ${this.#reconnectDelay / 1_000}s`);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closing || this.#reconnectTimer !== null) return;
    this.#reconnectAttempts += 1;
    const wait = Math.min(
      this.#reconnectDelay * 2 ** Math.min(this.#reconnectAttempts - 1, 10),
      this.#reconnectMaxDelay,
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#reconnect();
    }, wait);
  }

  async #reconnect(): Promise<void> {
    if (this.#closing || this.#ws !== null) return;
    try {
      await this.#dial();
      if (this.#manifest !== null) await this.#registerNow(this.#manifest);
      for (const { topic, tenantId, node } of this.#subscriptions.values())
        await this.#subscribeNow(topic, tenantId, node);
      this.#reconnectAttempts = 0;
    } catch (error) {
      const ws = this.#ws as WebSocket | null;
      this.#ws = null;
      ws?.close();
      this.#failPending(error instanceof Error ? error : new Error(String(error)));
      this.#scheduleReconnect();
    }
  }

  async register(manifest: NodeManifest): Promise<void> {
    this.#manifest = manifest;
    await this.#registerNow(manifest);
  }

  async #registerNow(manifest: NodeManifest): Promise<void> {
    const result = await this.#request({
      id: randomUUID(),
      type: 'register',
      to: manifest.name,
      tenantId: '*',
      deadline: Date.now() + this.#timeout,
      payload: { manifest, chunks: true },
    });
    if (!result.payload.ok) throw new Error(result.payload.error);
  }

  /** Mint a private registration credential for one tenant, or reuse this private one. */
  privateTokenFor(tenant: string): string {
    const base = this.#token;
    if (base === null) throw new Error('bus session is not connected');
    const split = base.lastIndexOf('.');
    if (split > 0 && base.slice(0, split) === tenant) return base;
    const signature = createHmac('sha256', base)
      .update(`private-node:${tenant}`)
      .digest('base64url');
    return `${tenant}.${signature}`;
  }

  /** Connect a registered node to one user's directory.
   *
   *  A node used to be allowed to do this and is not any more: only the runtime's control connection
   *  changes a user table, so the bus refuses this frame from a node connection. */
  async connectNode(user: string, node: string): Promise<void> {
    const result = await this.#request({
      id: randomUUID(),
      type: 'connect',
      to: 'bus',
      tenantId: '*',
      deadline: Date.now() + this.#timeout,
      payload: { user, node },
    } as OutboundConnectEnvelope);
    if (!result.payload.ok) throw new Error(result.payload.error);
  }

  async unregister(name: string): Promise<void> {
    this.#send({
      id: randomUUID(),
      type: 'unregister',
      to: name,
      tenantId: '*',
      payload: { name },
    });
  }

  onCall(handler: (call: CallEnvelope) => Promise<void> | void): void {
    this.#onCall = handler;
  }

  onEvent(handler: (event: EventEnvelope) => void): void {
    this.#onEvent = handler;
  }

  async subscribe(topic: string, tenantId: string, node: string): Promise<void> {
    await this.#subscribeNow(topic, tenantId, node);
    this.#subscriptions.set(JSON.stringify([topic, tenantId, node]), { topic, tenantId, node });
  }

  async #subscribeNow(topic: string, tenantId: string, node: string): Promise<void> {
    const result = await this.#request({
      id: randomUUID(),
      type: 'subscribe',
      to: 'bus',
      tenantId,
      deadline: Date.now() + this.#timeout,
      payload: { node, topic },
    } as OutboundSubscribeEnvelope);
    if (!result.payload.ok) throw new Error(result.payload.error);
  }

  async unsubscribe(topic: string, tenantId: string, node: string): Promise<void> {
    const result = await this.#request({
      id: randomUUID(),
      type: 'unsubscribe',
      to: 'bus',
      tenantId,
      deadline: Date.now() + this.#timeout,
      payload: { node, topic },
    } as OutboundUnsubscribeEnvelope);
    if (!result.payload.ok) throw new Error(result.payload.error);
    this.#subscriptions.delete(JSON.stringify([topic, tenantId, node]));
  }

  async listNodes(tenantId = '*'): Promise<NodeEntry[]> {
    const result = await this.#request({
      id: randomUUID(),
      type: 'list_nodes',
      to: 'bus',
      tenantId,
      deadline: Date.now() + this.#timeout,
      payload: {},
    });
    if (!result.payload.ok) throw new Error(result.payload.error);
    return (result.payload.value as NodeEntry[] | undefined) ?? [];
  }

  async listCapabilities(node: string, tenantId = '*'): Promise<CapabilityEntry[]> {
    const result = await this.#request({
      id: randomUUID(),
      type: 'list_capabilities',
      to: 'bus',
      tenantId,
      deadline: Date.now() + this.#timeout,
      payload: { node },
    });
    if (!result.payload.ok) throw new Error(result.payload.error);
    return (result.payload.value as CapabilityEntry[] | undefined) ?? [];
  }

  async reply(call: CallEnvelope, outcome: Outcome): Promise<void> {
    this.#send({
      id: randomUUID(),
      type: 'result',
      to: call.from,
      replyTo: call.id,
      tenantId: call.tenantId,
      payload: outcome,
    });
  }

  call(call: OutboundCallEnvelope): Promise<ResultEnvelope> {
    return this.#request(call);
  }

  publish(event: OutboundEventEnvelope): void {
    this.#send(event);
  }

  #request(
    envelope:
      | OutboundCallEnvelope
      | OutboundConnectEnvelope
      | OutboundListNodesEnvelope
      | OutboundListCapabilitiesEnvelope
      | OutboundSubscribeEnvelope
      | OutboundUnsubscribeEnvelope
      | OutboundRegisterEnvelope,
  ): Promise<ResultEnvelope> {
    return new Promise<ResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(envelope.id);
          reject(new Error('bus request timeout'));
        },
        Math.max(1, envelope.deadline - Date.now()),
      );
      this.#pending.set(envelope.id, { resolve, reject, timer });
      try {
        this.#send(envelope);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(envelope.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #send(envelope: unknown): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== this.#Socket.OPEN) throw new Error('bus session is not open');
    for (const piece of parts(JSON.stringify(envelope))) ws.send(piece);
  }

  #onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    try {
      this.#assembler.feed(JSON.parse(data));
    } catch {
      return;
    }
  }

  #route(frame: unknown): void {
    const envelope = frame as ResultEnvelope | CallEnvelope | EventEnvelope;
    if (envelope.type === 'result') {
      const pending = this.#pending.get(envelope.replyTo ?? '');
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(envelope.replyTo ?? '');
      pending.resolve(envelope);
      return;
    }
    if (envelope.type === 'event') {
      this.#onEvent?.(envelope);
      return;
    }
    if (envelope.type === 'call' && this.#onCall)
      Promise.resolve(this.#onCall(envelope)).catch(() => {});
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
