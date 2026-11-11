// A BusSession that speaks the bus main already runs.
//
// The SDK's envelope has a tenant on every frame. The legacy bus predates that field and speaks a
// smaller wire: a hello carrying the token and a flat capability list, `op: 'call'` frames, and
// replies keyed only by id. This adapter keeps the new Node/NodeHost API and translates at the
// edge, so a package can be migrated before the bus is.
//
// The legacy bus is single-tenant. `tenantId` here is therefore an adapter setting, not something
// read from a payload; when the bus itself learns tenants this adapter goes away.
import { randomUUID } from 'node:crypto';
import type {
  CallEnvelope,
  CapabilityEntry,
  EventEnvelope,
  NodeEntry,
  NodeManifest,
  Outcome,
  OutboundCallEnvelope,
  OutboundEventEnvelope,
  ResultEnvelope,
} from './envelope.js';
import { Assembler, MAX_FRAME_BYTES, parts } from './chunks.js';
import { CALL_DEADLINE_MS, type BusSession } from './host.js';
import { allowInsecureTls } from './tls.js';

export interface LegacyBusSessionOptions {
  readonly WebSocket?: typeof WebSocket;
  readonly tenantId?: string;
  readonly registerTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** Dial again after a connection goes away without close() being called. Default true. */
  readonly autoReconnect?: boolean;
  /** The first wait between dials; it doubles for each attempt in a row and is capped. */
  readonly reconnectDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

interface Pending {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface LegacyDirEntry {
  readonly tool: string;
  readonly node: string;
  readonly desc: string;
  readonly parameters: Record<string, unknown>;
}

interface LegacyReply {
  readonly id: string;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly entries?: LegacyDirEntry[];
  readonly chunks?: boolean;
}

interface LegacyCall {
  readonly op: 'call';
  readonly id: string;
  readonly cap: string;
  readonly args?: Record<string, unknown>;
  readonly from?: string;
}

interface LegacyEvent {
  readonly op: 'event';
  readonly topic: string;
  readonly value: unknown;
  readonly from?: string;
}

export class LegacyBusSession implements BusSession {
  readonly #Socket: typeof WebSocket;
  readonly #tenantId: string;
  readonly #registerTimeout: number;
  readonly #callTimeout: number;
  readonly #autoReconnect: boolean;
  readonly #reconnectDelay: number;
  readonly #reconnectMaxDelay: number;
  readonly #pending = new Map<string, Pending>();
  readonly #subscriptions = new Set<string>();
  #ws: WebSocket | null = null;
  #token = '';
  #url = '';
  #manifest: NodeManifest | null = null;
  #wasConnected = false;
  #closing = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0;
  #onCall: ((call: CallEnvelope) => Promise<void> | void) | null = null;
  #onEvent: ((event: EventEnvelope) => void) | null = null;
  /** The bus cuts a message that does not fit one WebSocket frame into `part` frames; this puts
   *  them back before any of the code above sees a frame. */
  readonly #assembler = new Assembler((frame) => this.#route(frame as Record<string, any>));

  readonly #forkOptions: LegacyBusSessionOptions;

  constructor(options: LegacyBusSessionOptions = {}) {
    this.#forkOptions = options;
    this.#Socket = options.WebSocket ?? WebSocket;
    this.#tenantId = options.tenantId ?? 'default';
    this.#registerTimeout = options.registerTimeoutMs ?? 5_000;
    this.#callTimeout = options.callTimeoutMs ?? CALL_DEADLINE_MS;
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

  /** Dial once and wait for the socket to open. Reconnects call this again; a close here is what
   *  `#lost` turns into the next dial. */
  async #dial(): Promise<void> {
    // The legacy bus reads the token from the hello frame. The query is kept as well because a
    // front door may authenticate the upgrade before the frame arrives, exactly as old Node.join().
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
      }, this.#registerTimeout);
      ws.addEventListener('open', () => {
        opened = true;
        clearTimeout(timer);
        this.#wasConnected = true;
        resolve();
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
      ws.addEventListener('error', () => {
        // A failed upgrade reports here and then closes; `close` owns the retry so one failure cannot
        // schedule two dials. Before open there may be no close at all, so fail the connect promise.
        if (!opened) {
          clearTimeout(timer);
          ws.close();
          reject(new Error('bus connection failed'));
        }
      });
    }).catch((error: unknown) => {
      if (this.#ws === ws) this.#ws = null;
      throw error;
    });
  }

  /** A second session with the same wire settings, for a node this one starts. */
  fork(): BusSession {
    return new LegacyBusSession({ ...this.#forkOptions, tenantId: this.#tenantId });
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
    this.#subscriptions.clear();
  }

  /** The socket went away and nobody asked for that: fail what was waiting, then dial again. A
   *  deliberate close, a connection that never opened, and a stale socket's late close all return
   *  without scheduling anything. */
  #lost(ws: WebSocket, why: string): void {
    if (this.#closing || ws !== this.#ws) return;
    this.#ws = null;
    this.#failPending(new Error(why));
    if (!this.#autoReconnect || !this.#wasConnected) return;
    const who = this.#manifest?.name ?? this.#url;
    console.error(`${who}: lost the bus — retrying in ${this.#reconnectDelay / 1_000}s`);
    this.#scheduleReconnect();
  }

  /** Wait, then dial again. The wait doubles with each attempt in a row, up to the cap; a successful
   *  handshake resets it. The timer is deliberately ref'd: a process whose only work is this session
   *  must stay alive while it retries, and close() clears it so a deliberate stop can still exit. */
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

  /** One reconnect: open, register the same manifest, ask again for every topic. A refusal (the old
   *  socket's name not released yet, say) is just another lost dial; the handshake timeout bounds it. */
  async #reconnect(): Promise<void> {
    if (this.#closing || this.#ws !== null) return;
    try {
      await this.#dial();
      if (this.#manifest !== null) await this.#registerNow(this.#manifest);
      for (const topic of [...this.#subscriptions]) await this.subscribe(topic);
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
    const id = manifest.name;
    const verdict = (await this.#ask(
      {
        id,
        caps: Object.keys(manifest.caps),
        desc: manifest.desc,
        schemas: manifest.caps,
        token: this.#token,
        chunks: true,
      },
      this.#registerTimeout,
    )) as LegacyReply;
    if (verdict.ok !== true)
      throw new Error(`bus refused the connection: ${verdict.error ?? 'unknown error'}`);
  }

  async unregister(_name: string): Promise<void> {
    // The legacy bus has no unregister frame: closing the socket is the unregister.
  }

  onCall(handler: (call: CallEnvelope) => Promise<void> | void): void {
    this.#onCall = handler;
  }

  onEvent(handler: (event: EventEnvelope) => void): void {
    this.#onEvent = handler;
  }

  call(call: OutboundCallEnvelope): Promise<ResultEnvelope> {
    const legacyId = call.id;
    return this.#ask(
      {
        op: 'call',
        id: legacyId,
        cap: `${call.to}.${call.payload.cap}`,
        args: call.payload.args,
      },
      Math.max(1, call.deadline - Date.now()),
    ).then((reply) => {
      const answer = reply as LegacyReply;
      return {
        id: randomUUID(),
        type: 'result',
        from: call.to,
        to: '',
        replyTo: legacyId,
        tenantId: call.tenantId,
        payload:
          answer.ok === true
            ? { ok: true, value: answer.value }
            : { ok: false, error: answer.error ?? 'legacy call failed' },
      } as ResultEnvelope;
    });
  }

  publish(event: OutboundEventEnvelope): void {
    this.#send({ op: 'event', topic: event.payload.topic, value: event.payload.value });
  }

  async reply(call: CallEnvelope, outcome: Outcome): Promise<void> {
    this.#send({ op: 'result', to: call.from, id: call.id, ...outcome });
  }

  async listNodes(): Promise<NodeEntry[]> {
    const entries = await this.#directory();
    const seen = new Map<string, NodeEntry>();
    for (const entry of entries) {
      if (seen.has(entry.node)) continue;
      seen.set(entry.node, {
        name: entry.node,
        desc: entry.desc,
        packageId: 'legacy',
        version: '',
        icon: '',
        scope: 'shared',
      });
    }
    return [...seen.values()];
  }

  async listCapabilities(node: string): Promise<CapabilityEntry[]> {
    return (await this.#directory())
      .filter((entry) => entry.node === node)
      .map((entry) => ({ cap: entry.tool.slice(node.length + 1), parameters: entry.parameters }));
  }

  /** Legacy events are subscription-based. The bus broadcasts all SDK events, but this wire does
   *  not: a node that needs a topic must ask for it. Exposed for compatibility tests and for
   *  packages that know they need a topic while the bus is still legacy. */
  async subscribe(topic: string): Promise<void> {
    const reply = (await this.#ask(
      { op: 'subscribe', id: randomUUID(), topic },
      this.#registerTimeout,
    )) as LegacyReply;
    if (reply.ok !== true) throw new Error(reply.error ?? `could not subscribe to ${topic}`);
    this.#subscriptions.add(topic);
  }

  async #directory(): Promise<LegacyDirEntry[]> {
    const reply = (await this.#ask(
      { op: 'dir', id: randomUUID() },
      this.#registerTimeout,
    )) as LegacyReply;
    if (reply.ok === false) throw new Error(reply.error ?? 'directory request failed');
    return reply.entries ?? [];
  }

  #ask(frame: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = String(frame.id ?? '');
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new Error('bus request timeout'));
        },
        Math.max(1, timeoutMs),
      );
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send(frame);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #send(frame: unknown): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('bus session is not open');
    // The legacy wire is NDJSON: the decoder only sees a frame when its newline arrives. Too big for
    // one message, the frame travels as parts the bus puts back together (it said it joins them).
    const text = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(text, 'utf8') <= MAX_FRAME_BYTES) {
      ws.send(text);
      return;
    }
    try {
      for (const piece of parts(text)) ws.send(piece);
    } catch (error) {
      console.error(
        `[bus] a ${text.length} character frame could not be cut for the wire: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  #onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(data) as Record<string, any>;
    } catch (error) {
      console.error(
        `[bus] dropped a ${data.length} character frame that did not parse: ${(error as Error).message}`,
      );
      return;
    }
    this.#assembler.feed(frame);
  }

  #route(frame: Record<string, any>): void {
    if (frame.op === 'call') {
      this.#incomingCall(frame as LegacyCall);
      return;
    }
    if (frame.op === 'event') {
      const event = frame as LegacyEvent;
      this.#onEvent?.({
        id: randomUUID(),
        type: 'event',
        from: event.from ?? '',
        to: '*',
        tenantId: this.#tenantId,
        payload: { node: event.from ?? '', topic: event.topic, value: event.value },
      });
      return;
    }
    const pending = this.#pending.get(String(frame.id ?? ''));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(String(frame.id));
    pending.resolve(frame);
  }

  #incomingCall(frame: LegacyCall): void {
    if (!this.#onCall) return;
    // The legacy bus strips the address to the local capability before forwarding; a direct
    // frame may still carry the full address. Both are accepted.
    const at = frame.cap.indexOf('.');
    const node = at > 0 ? frame.cap.slice(0, at) : (this.#manifest?.name ?? '');
    const cap = at > 0 ? frame.cap.slice(at + 1) : frame.cap;
    const carried = (frame as { deadline?: unknown }).deadline;
    const deadline =
      typeof carried === 'number' && carried > Date.now()
        ? carried
        : Date.now() + this.#callTimeout;
    const call: CallEnvelope = {
      id: frame.id,
      type: 'call',
      from: frame.from ?? '',
      to: this.#manifest?.name ?? node,
      tenantId: this.#tenantId,
      // The wire has no deadline field (the legacy `Call` frame is op/id/cap/args/from); one that
      // rides along anyway is the caller's and outranks this session's own clock.
      deadline,
      payload: { cap, args: frame.args ?? {} },
    };
    Promise.resolve(this.#onCall(call)).catch(() => {});
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
