// A stand-in for the bus `LegacyBusSession` was written against: the older wire, where a node says
// hello with its token and a flat capability list, a call is an `op: 'call'` frame addressed by
// `node.capability`, and a reply is keyed only by id. The real bus speaks envelopes now (bus/tests
// pins that), so the adapter's own coverage lives here, against the wire it still translates.
//
// The frames, as legacy_session.ts writes and reads them:
//
//   -> { id: name, caps: [...], desc, schemas, token, chunks }        the hello, and the register
//   <- { id: name, ok: true }
//   -> { op: 'dir', id }                                             the directory
//   <- { id, ok: true, entries: [{ tool, node, desc, parameters }] }
//   -> { op: 'call', id, cap: 'node.cap', args }                     one call
//   <- { op: 'call', id, cap, args, from }                           to the node it names
//   -> { op: 'result', to: callerName, id, ok, value | error }       that node's answer
//   <- { id, ok, value | error }                                     back to the caller
//   -> { op: 'subscribe', id, topic }  /  { op: 'event', topic, value }
//   <- { op: 'event', topic, value, from }                           to every subscriber
//
// It answers in the process, over the sockets a session dials: the transport is the one thing these
// tests do not need to prove twice, and `test-bus-session.mjs` already drives the real WebSocket.

/** One registered node: the socket it answers on and what it said it can do. */
function entryOf(hello, socket) {
  const schemas = hello.schemas ?? {};
  return {
    name: String(hello.id),
    caps: Array.isArray(hello.caps) ? hello.caps.map(String) : Object.keys(schemas),
    desc: typeof hello.desc === 'string' ? hello.desc : '',
    schemas,
    socket,
  };
}

/** A bus for one test: registered nodes, subscriptions, and the calls waiting for an answer. */
export class LegacyBus {
  #nodes = new Map();
  #subscribers = new Map();
  #pending = new Map();
  #sockets = new Set();

  constructor(token) {
    this.token = token;
    // The session dials this address; nothing listens on it, because the socket is made here.
    this.url = 'ws://legacy.test/bus';
    this.WebSocket = this.#socketClass();
  }

  /** The WebSocket the session talks to: open at once, and every frame goes to the bus. */
  #socketClass() {
    const bus = this;
    return class LegacySocket extends EventTarget {
      static OPEN = 1;
      readyState = 0;

      constructor() {
        super();
        bus.#sockets.add(this);
        setTimeout(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
        }, 0);
      }

      send(text) {
        const frame = JSON.parse(String(text));
        if (frame.op === 'part') throw new Error('this bus never asks for parts');
        bus.#onFrame(this, frame);
      }

      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        bus.#sockets.delete(this);
        this.dispatchEvent(new Event('close'));
      }

      /** One frame from the bus to this socket. */
      receive(frame) {
        const event = Object.assign(new Event('message'), { data: JSON.stringify(frame) });
        setTimeout(() => this.dispatchEvent(event), 0);
      }
    };
  }

  /** Drop every socket: what closing the old bus did to the nodes on it. */
  close() {
    for (const socket of [...this.#sockets]) socket.close();
  }

  #say(socket, frame) {
    socket.receive(frame);
  }

  #nameOf(socket) {
    for (const [name, node] of this.#nodes) if (node.socket === socket) return name;
    return '';
  }

  #onFrame(socket, frame) {
    if (frame.op === undefined) return this.#hello(socket, frame);
    if (frame.op === 'dir') {
      return this.#say(socket, { id: frame.id, ok: true, entries: this.#dir() });
    }
    if (frame.op === 'call') return this.#call(socket, frame);
    if (frame.op === 'result') return this.#result(frame);
    if (frame.op === 'subscribe') {
      const audience = this.#subscribers.get(String(frame.topic)) ?? new Set();
      audience.add(socket);
      this.#subscribers.set(String(frame.topic), audience);
      return this.#say(socket, { id: frame.id, ok: true });
    }
    if (frame.op === 'event') {
      const from = this.#nameOf(socket);
      for (const subscriber of this.#subscribers.get(String(frame.topic)) ?? []) {
        this.#say(subscriber, { op: 'event', topic: frame.topic, value: frame.value, from });
      }
      return undefined;
    }
    return undefined;
  }

  /** The first frame is the hello, and its token is the whole authentication of the old wire. */
  #hello(socket, hello) {
    if (hello.token !== this.token) {
      this.#say(socket, { id: hello.id, ok: false, error: 'wrong token' });
      return;
    }
    const entry = entryOf(hello, socket);
    if (this.#nodes.has(entry.name)) {
      this.#say(socket, { id: hello.id, ok: false, error: `the name "${entry.name}" is taken` });
      return;
    }
    this.#nodes.set(entry.name, entry);
    this.#say(socket, { id: entry.name, ok: true });
  }

  #dir() {
    return [...this.#nodes.values()].flatMap((node) =>
      node.caps.map((cap) => ({
        tool: `${node.name}.${cap}`,
        node: node.name,
        desc: node.desc,
        parameters: node.schemas[cap] ?? {},
      })),
    );
  }

  /** One call: the frame goes to the node the address names, and the caller waits for its result. */
  #call(caller, frame) {
    const at = String(frame.cap).indexOf('.');
    const node = at > 0 ? String(frame.cap).slice(0, at) : '';
    const target = this.#nodes.get(node);
    if (target === undefined) {
      this.#say(caller, { id: frame.id, ok: false, error: `no node named "${node}"` });
      return;
    }
    this.#pending.set(String(frame.id), caller);
    this.#say(target.socket, {
      op: 'call',
      id: frame.id,
      cap: frame.cap,
      args: frame.args ?? {},
      from: this.#nameOf(caller),
    });
  }

  #result(frame) {
    const caller = this.#pending.get(String(frame.id));
    if (caller === undefined) return;
    this.#pending.delete(String(frame.id));
    this.#say(caller, {
      id: frame.id,
      ...(frame.ok === true ? { ok: true, value: frame.value } : { ok: false, error: frame.error }),
    });
  }
}
