// The wire: one connection to the bus, carried inside WebSocket messages.
//
// There is one envelope, and no switch to pick another. A node dials the bus (Remote, below); the bus
// adopts the socket route() has just answered the upgrade on (Link, below). Both ends speak the same
// thing — the frames of wire.ts inside the messages of an RFC 6455 socket — and the calls above them
// are identical: send, end, receive, close, drop, gone. Nothing above this file knows about
// handshakes, masking, message headers or newlines.
//
// RFC 6455 is written out here because the workspace has no dependencies and what a WebSocket needs
// is small: an HTTP handshake and a frame header.
//
// The frames are not here. wire.ts owns them — dec() and the envelope (with the part frames that
// carry one too big for a message) — and both halves of this file hand their messages to that one
// decoder. A second frame format would be a bug, not a variant: there is
// exactly one place it could come from, and it is not this file.
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { Assembler, MAX_FRAME_CHARS, dec, parts } from './wire.js';

/** Why a connection that went away is reported. There is one wording because there is one wire: a
 *  node above this file is never told which envelope carried its frames. */
export const CLOSED = 'the bus closed the connection';

/** RFC 6455's magic value: the answer to a handshake is base64(sha1(key + this)). */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The opcodes this file has an opinion about; anything else is just a payload to pass on. */
const TEXT = 0x1;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;

/** How much of an HTTP request head is read before the socket is called "not a client of this
 *  protocol either". A real handshake is a few hundred bytes; anything past this is a request nobody
 *  here answers. */
const MAX_HEAD = 8 * 1024;

/** The longest method token that could start a request line. Longer than any method worth knowing,
 *  and short enough that a peer which opens with letters and never stops is closed at once. */
const MAX_METHOD = 16;

/** True while these first bytes might still be the start of an HTTP request line.
 *
 * There is one protocol on this port and it opens with `GET /… Upgrade: websocket`. A request line is
 * a method token — upper-case letters, then one space — so anything else in the first bytes (a bus
 * frame, a TLS hello, whatever a scanner sends) cannot become that request, and the socket is closed
 * instead of being read to see what else it might be. */
function maybeRequest(head: Buffer): boolean {
  for (let i = 0; i < head.length; i += 1) {
    const byte = head[i]!;
    if (byte === 0x20) return true; // the space after the method: a request line, read it whole
    if (byte < 0x41 || byte > 0x5a) return false;
    if (i >= MAX_METHOD) return false;
  }
  return true; // still letters: too short to say yet
}

/** What one wire offers, whichever end of it this is. These calls are the whole contract: a node
 *  dials a Remote, the bus keeps a Link, and neither side asks the other what is underneath. */
type Wire = {
  /** Write one already-encoded frame (wire.enc has run). False when nothing could be written. */
  send(text: string): boolean;
  /** Write one encoded frame and then shut this wire: the refusal arm of the handshake, where the
   *  reason has to arrive before the connection does not. */
  end(text: string): void;
  /** Attach the frame listener and the death listener: at most once, before anything is written.
   *  `onLost` is called at most once, and never after `close()`. */
  receive<F>(onFrame: (frame: F) => void, onLost: (why: string) => void): void;
  /** Shut it deliberately. Nothing that follows is a loss to report. */
  close(): void;
  /** Tear it out from under both ends, as if the peer had vanished — what a bus that dies, or the
   *  network, does. The death is reported like any other; this is the test seam for it. */
  drop(): void;
  /** True once nothing written here can still arrive. */
  readonly gone: boolean;
};

/** Hand a freshly accepted socket to `adopt`, once its first bytes say it is a WebSocket client.
 *
 * `node:net`'s server has no 'upgrade' event — that one belongs to `node:http`, and this bus is a raw
 * TCP server because the handshake and the frames that follow it are the whole of what it serves. So
 * the upgrade is recognised here, on the socket itself, before anything is adopted.
 *
 * This bus speaks one protocol. A socket that does not finish an HTTP request head asking for
 * `Upgrade: websocket` is closed: there is no second envelope to fall back to, and no reason to keep
 * reading from a peer that cannot talk to us.
 *
 * Nothing read to make that decision is lost: the bytes that arrived behind the request head are
 * already frames, and they are handed to the link as its first message.
 */
export function route(sock: Socket, adopt: (link: Link) => void): void {
  let head: Buffer = Buffer.alloc(0);

  // A socket that dies before it said anything is simply gone: nothing was adopted, so there is
  // nothing to unregister — and an 'error' with nobody listening is fatal to the process. This
  // listener is dropped again on adoption; the Link has its own from then on.
  const failed = (): void => {
    sock.destroy();
  };
  sock.on('error', failed);

  const onData = (chunk: Buffer): void => {
    head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);

    // The one protocol here starts with an HTTP request. Bytes that cannot start one are closed on
    // the spot rather than buffered to see what they might turn into: there is nothing else to read.
    if (!maybeRequest(head)) {
      sock.destroy();
      return;
    }

    const end = head.indexOf('\r\n\r\n');
    if (end === -1) {
      // An upgrade request is a few hundred bytes. A peer that has not finished one by the time it
      // has sent this much is not asking for the one protocol this bus speaks.
      if (head.length > MAX_HEAD) sock.destroy();
      return;
    }

    sock.off('data', onData);
    sock.pause();

    const link = upgrade(sock, head.subarray(0, end), head.subarray(end + 4));
    if (link === null) return; // not a WebSocket client: the socket is already gone

    sock.off('error', failed);
    adopt(link);
    sock.resume();
  };

  sock.on('data', onData);
}

/** True when this request head asks for a WebSocket. `Upgrade: websocket` is the whole test: a
 *  header name and a value are both case-insensitive (RFC 7230 3.2), and a request that names it has
 *  already sent the `Connection: Upgrade` that goes with it. */
function isUpgrade(head: string): boolean {
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (
      name === 'upgrade' &&
      line
        .slice(colon + 1)
        .trim()
        .toLowerCase() === 'websocket'
    )
      return true;
  }
  return false;
}

/** The request head's headers, by lower-cased name: only `sec-websocket-key` is needed. */
function field(head: string, name: string): string | null {
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim();
  }
  return null;
}

/** Answer the handshake and wrap the socket. `head` is the request line and headers; `rest` is what
 *  arrived in the same read behind them, which is already frames. Null means the request was not a
 *  WebSocket after all: the socket is destroyed and nothing is adopted. */
function upgrade(sock: Socket, head: Buffer, rest: Buffer): Link | null {
  const request = head.toString('latin1');
  const key = field(request, 'sec-websocket-key');

  if (key === null || !isUpgrade(request)) {
    sock.destroy();
    return null;
  }

  // RFC 6455 4.2.2: handing the key back proves we read it, and that this is a WebSocket server.
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  // Whatever arrived behind the head is already frames: a client does not have to wait for the 101.
  return new Link(sock, rest, tokenOf(request));
}

/** The bearer query of the WebSocket URL: the token a front door authenticates the upgrade with.
 *  The bus checks it before it accepts a registration. */
function tokenOf(request: string): string {
  const target = request.split(' ')[1] ?? '/';
  try {
    return new URL(target, 'ws://bus').searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

/** One accepted socket, its conversation carried inside WebSocket messages — the bus's half of the
 *  wire, the class route() adopts.
 *
 * What is written here is the envelope only: an opcode, a length, and — server to client — no mask.
 * The payload is handed straight to the decoder from wire.ts, so the bytes that reach the bus are the
 * frames of the protocol and nothing else. */
export class Link implements Wire {
  private socket: Socket;

  /** The bytes that arrived behind the request head, if any: already frames. */
  private rest: Buffer;

  private decode: ((chunk: Buffer) => void) | null = null;
  /** Whether the peer said it joins pieces of a cut frame (see parts). */
  chunks = false;
  /** The query credential this connection presented, if any; empty when it presented none. */
  readonly token: string;
  private lost: ((why: string) => void) | null = null;
  private dead = false;

  /** What has been read of a frame (or of a message) that is still arriving. */
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];

  constructor(socket: Socket, rest: Buffer, token = '') {
    this.socket = socket;
    this.rest = rest;
    this.token = token;
  }

  receive<F>(onFrame: (frame: F) => void, onLost: (why: string) => void): void {
    // The one decoder, from wire.ts: a WebSocket message is a frame to it and nothing more.
    this.decode = dec<F>(new Assembler<F>(onFrame).feed);
    this.lost = onLost;

    this.socket.on('data', (chunk: Buffer) => this.consume(chunk));
    // An 'error' with nobody listening is fatal to the process, and a node that leaves is a departure
    // to be handled, not a reason for the bus to die with it.
    this.socket.on('error', () => this.died(CLOSED));
    this.socket.on('close', () => this.died(CLOSED));

    const rest = this.rest;
    this.rest = Buffer.alloc(0);
    if (rest.length > 0) this.consume(rest);
  }

  send(text: string): boolean {
    if (Buffer.byteLength(text, 'utf8') <= MAX_FRAME_CHARS)
      return this.say(TEXT, Buffer.from(text, 'utf8'));
    // A frame one message cannot carry travels as several (see parts), but only to a peer that
    // said it joins them. One that did not is still sent the frame, as before.
    if (!this.chunks) {
      // The peer never said it joins part frames, so this message cannot cross and there is no
      // smaller form of it to send. Say so: closing the socket here is otherwise indistinguishable
      // from a network failure at the far end.
      console.error(
        `[bus] closing a link that cannot take a ${text.length} character message (peer does not join part frames)`,
      );
      this.socket.destroy();
      return false;
    }
    try {
      const pieces = parts(text);
      for (const [index, piece] of pieces.entries())
        if (!this.say(TEXT, Buffer.from(piece, 'utf8'))) {
          console.error(
            `[bus] part ${index + 1} of ${pieces.length} for a ${text.length} character message could not be written`,
          );
          return false;
        }
      return true;
    } catch (error) {
      console.error(
        `[bus] a ${text.length} character message could not be cut for the wire: ${(error as Error).message}`,
      );
      this.socket.destroy();
      return false;
    }
  }

  end(text: string): void {
    this.send(text);
    this.close();
  }

  close(): void {
    this.say(CLOSE, Buffer.alloc(0));
    this.dead = true;
    this.socket.end();
  }

  drop(): void {
    this.socket.destroy();
  }

  get gone(): boolean {
    return this.dead || this.socket.destroyed || this.socket.writableEnded;
  }

  /** Read every frame that is fully here, and keep the tail of the one that is not. */
  private consume(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    while (this.buf.length >= 2) {
      const first = this.buf[0]!;
      const second = this.buf[1]!;
      const fin = (first & 0x80) !== 0;
      const op = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let size = second & 0x7f;
      let at = 2;

      if (size === 126) {
        if (this.buf.length < 4) return;
        size = this.buf.readUInt16BE(2);
        at = 4;
      } else if (size === 127) {
        if (this.buf.length < 10) return;
        size = Number(this.buf.readBigUInt64BE(2));
        at = 10;
      }

      // A message that size is not a bus frame — wire.ts caps one at MAX_FRAME_CHARS, and a peer that
      // announces more than that is not a client of this protocol.
      if (size > MAX_FRAME_CHARS) {
        console.error(
          `[bus] closing a link that sent a ${size} byte message (the limit is ${MAX_FRAME_CHARS})`,
        );
        return void this.socket.destroy();
      }

      const maskAt = at;
      if (masked) at += 4;
      if (this.buf.length < at + size) return; // the rest of this frame is still on its way

      const mask = masked ? Buffer.from(this.buf.subarray(maskAt, maskAt + 4)) : null;
      const payload = Buffer.from(this.buf.subarray(at, at + size));
      this.buf = this.buf.subarray(at + size);

      // A client masks every frame it sends (RFC 6455 5.3). A peer that forgets is tolerated: the
      // payload of a frame is the same frame either way, and this is a bus, not a browser.
      if (mask !== null) {
        for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i & 3]!;
      }

      this.frame(fin, op, payload);
    }
  }

  /** One data frame, once its bytes are all here. */
  private frame(fin: boolean, op: number, payload: Buffer): void {
    if (op === CLOSE) {
      // The peer is leaving. Answer the goodbye (RFC 6455 5.5.1), shut the socket, and report the
      // departure like any other: a node that closed its connection has left the bus, and a registry
      // that kept its name would refuse the name to the next connection for ever.
      this.say(CLOSE, payload.subarray(0, 2));
      this.socket.end();
      this.died(CLOSED);
      return;
    }
    if (op === PING) return void this.say(PONG, payload);
    if (op === PONG) return;

    // A message may arrive in fragments; the first one starts it, the rest are its tail.
    if (op !== 0) this.parts = [payload];
    else this.parts.push(payload);
    if (!fin) return;

    const message = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
    this.parts = [];
    this.decode?.(message);
  }

  /** Write one frame. Never masked: only a client masks (RFC 6455 5.1). */
  private say(op: number, payload: Buffer): boolean {
    if (this.gone) return false;

    const size = payload.length;
    const head =
      size < 126
        ? Buffer.from([0x80 | op, size])
        : size < 0x10000
          ? Buffer.from([0x80 | op, 126, size >> 8, size & 0xff])
          : this.wide(op, size);

    this.socket.write(Buffer.concat([head, payload]));
    return true;
  }

  /** The 8-byte length form: nothing here is that big, and it costs nothing to be able to say so. */
  private wide(op: number, size: number): Buffer {
    const head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(size), 2);
    return head;
  }

  private died(why: string): void {
    if (this.dead) return;
    this.dead = true;
    // A socket that never sent a frame is a probe, a port check, or a client that changed its mind
    // before the handshake: those come and go by the hundred at start-up and say nothing about the
    // bus. A peer that spoke is a node, and its departure is worth a line - it is the only place a
    // drop during a big write is visible, because the far side only sees "lost the bus".
    if (this.decode !== null) {
      const where = `${this.socket.remoteAddress ?? '?'}:${this.socket.remotePort ?? '?'}`;
      console.error(`[bus] link closed: ${why} (${where})`);
    }
    this.lost?.(why);
  }
}

/** The node's half of the same wire: dial the bus, then the frames of wire.ts inside the messages of
 *  the socket that answers. Node's own WebSocket client is what dials — no dependency, and the same
 *  class the pages in this workspace already use.
 *
 * What it dials is one URL and nothing else. Building one from a host and a port was this class's job
 * once, and that could only ever say "plain, no path" — which is not where a bus behind a front door
 * is. ws:// and wss:// both arrive here as text, and wss:// is the TLS dial the same client makes. */
export class Remote implements Wire {
  /** The bus, in full: ws:// or wss://, path and query included, exactly as it was given. */
  readonly url: string;
  private ws: WebSocket | null = null;
  private decode: ((chunk: Buffer) => void) | null = null;
  /** Whether the bus said it joins pieces of a cut frame (see parts). */
  chunks = false;
  private lost: ((why: string) => void) | null = null;
  private dead = false;

  /** @param url the bus as it is named - the address a node keeps, prints and redials.
   *  @param dialUrl what the socket actually opens: the same address, with a token in the query when
   *  the token is a field of its own. The two differ on purpose: a credential belongs in the dial and
   *  in nothing else, so no log line or failure ever quotes it. */
  private readonly dialUrl: string;

  constructor(url: string, dialUrl: string = url) {
    this.url = url;
    this.dialUrl = dialUrl;
  }

  receive<F>(onFrame: (frame: F) => void, onLost: (why: string) => void): void {
    this.decode = dec<F>(new Assembler<F>(onFrame).feed);
    this.lost = onLost;
  }

  /** Open it, and resolve once it can carry frames. */
  dial(): Promise<void> {
    const ws = new WebSocket(this.dialUrl);
    this.ws = ws;

    // One message is one bus frame: the bytes wire.enc wrote, and nothing else. Text is the bus's
    // own form; a binary frame is accepted too, because a bridge or a proxy may hand the bytes on as
    // binary, and a client that ignored those would sit waiting for an answer it already had.
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (e: MessageEvent) => {
      if (typeof e.data === 'string') this.decode?.(Buffer.from(e.data));
      else if (e.data instanceof ArrayBuffer) this.decode?.(Buffer.from(e.data));
      else if (ArrayBuffer.isView(e.data))
        this.decode?.(Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength));
    });
    ws.addEventListener('error', () => this.died(CLOSED));
    ws.addEventListener('close', () => this.died(CLOSED));

    return new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok(), { once: true });
      ws.addEventListener('error', () => bad(new Error(`cannot reach the bus at ${this.url}`)), {
        once: true,
      });
      // A bus that answers the handshake and then hangs up has refused in the only way it could.
      ws.addEventListener(
        'close',
        () => bad(new Error('the connection closed before the handshake was answered')),
        { once: true },
      );
    });
  }

  send(text: string): boolean {
    const ws = this.ws;
    // 1 is OPEN: a socket that is still dialling, or already closing, has nowhere to put a frame.
    if (ws === null || this.dead || ws.readyState !== 1) return false;
    if (Buffer.byteLength(text, 'utf8') <= MAX_FRAME_CHARS) {
      ws.send(text);
      return true;
    }
    // The bus said it joins pieces, or this frame would not cross at all (see parts).
    try {
      for (const piece of parts(text)) ws.send(piece);
      return true;
    } catch {
      return false;
    }
  }

  end(text: string): void {
    this.send(text);
    this.close();
  }

  /** Deliberate: the peer is told (a WebSocket says goodbye), and nothing is reported. */
  close(): void {
    this.dead = true;
    this.ws?.close();
  }

  /** Pull it out from under both ends. This API has no way to skip the goodbye, so the close frame
   *  goes out and the death is reported when the answer to it arrives — which is what a bus that has
   *  just been killed looks like from here. */
  drop(): void {
    this.ws?.close();
  }

  get gone(): boolean {
    const ws = this.ws;
    return ws === null || ws.readyState !== 1;
  }

  private died(why: string): void {
    if (this.dead) return;
    this.dead = true;
    this.lost?.(why);
  }
}
