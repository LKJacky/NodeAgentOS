// The wire the bus and its nodes speak: one WebSocket message, one envelope.
//
// A message is a complete JSON object - the envelope of envelope.ts - and nothing else. There is no
// line protocol behind it: no newline delimiter, no NDJSON stream, no second frame shape. A message
// that does not parse is dropped, and said so, because a peer that keeps sending them has to be
// visible without taking the connection down.
//
// A frame larger than one WebSocket message can carry travels as part frames instead: the same JSON
// text, cut into pieces, each one a message of its own. The peer joins them back before anything
// above the wire sees them, so the layer above only ever sees whole envelopes (see parts / Assembler).
import { randomUUID } from 'node:crypto';

/** Maximum UTF-8 bytes in one WebSocket message. The historical name remains part of the package
 *  API, but WebSocket limits payload bytes, not JavaScript string code units. */
export const MAX_FRAME_CHARS = 1 << 20;

/** A frame over MAX_FRAME_CHARS cannot cross a socket as one message, so it travels as part frames.
 *  A rejoined frame may be this big. */
function ceiling(fallback: number): number {
  const said = Number(process.env.NODE_AGENT_BUS_MAX_MESSAGE_CHARS ?? '');
  return Number.isFinite(said) && said > 0 ? said : fallback;
}

/** 512 MiB, not 64: one chat turn carries the whole transcript, and a reader with a long one sends
 *  more than the old ceiling - which took the link down instead of saying why. */
export const MAX_MESSAGE_CHARS = ceiling(512 << 20);

/** The marker a piece of a bigger frame carries; it is not part of the envelope protocol, only of
 *  the way one envelope is carried. */
const PART = 'part';

interface Part {
  op: 'part';
  id: string;
  seq: number;
  value: string;
  last?: boolean;
}

/** Frame-decoder factory: one instance per connection; returns the 'message' listener.
 *  Every message is one whole frame, so there is nothing to buffer between messages. Malformed
 *  messages are dropped and logged: a peer that sends something else should be visible, and a
 *  connection that never carried an envelope is not worth keeping open on its behalf. */
export const dec = <T>(onFrame: (frame: T) => void) => {
  // A WebSocket message is one complete envelope. There is no newline framing and no legacy
  // op-frame parser: a message that is not JSON is dropped and reported.
  return (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.trim() === '') return;
    try {
      onFrame(JSON.parse(text) as T);
    } catch (error) {
      console.error(`[bus] dropped a frame that did not parse: ${(error as Error).message}`);
    }
  };
};

/** One piece of a cut frame, as the JSON text that carries it. */
const pieceOf = (id: string, seq: number, value: string, last: boolean): string =>
  JSON.stringify({ op: PART, id, seq, value, last } satisfies Part);

/** True at a UTF-16 high surrogate: the first half of a pair that must not be cut in two. */
const high = (at: number): boolean => at >= 0xd800 && at <= 0xdbff;

/** `text` as the messages that carry it: itself when one message carries it whole.
 *
 *  A piece never ends between the two halves of a surrogate pair when that can be helped. Every
 *  encoded piece is measured in UTF-8 bytes because that is what the WebSocket limit counts. */
export const parts = (text: string, maxBytes: number = MAX_FRAME_CHARS): string[] => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new RangeError(
      'a frame of ' +
        text.length +
        ' characters is past the ' +
        MAX_MESSAGE_CHARS +
        ' this wire carries',
    );
  }

  const id = randomUUID();
  const values: string[] = [];
  const size = Math.max(1, Math.floor((maxBytes - 256) / 2));
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length && high(text.charCodeAt(end - 1))) end = Math.max(at + 1, end - 1);
    let piece = text.slice(at, end);
    while (
      Buffer.byteLength(pieceOf(id, values.length, piece, false), 'utf8') > maxBytes &&
      piece.length > 1
    ) {
      end = at + Math.max(1, Math.floor(piece.length / 2));
      if (end < text.length && high(text.charCodeAt(end - 1))) end = Math.max(at + 1, end - 1);
      piece = text.slice(at, end);
    }
    if (Buffer.byteLength(pieceOf(id, values.length, piece, false), 'utf8') > maxBytes) {
      throw new RangeError(`a part frame cannot fit within ${maxBytes} bytes`);
    }
    values.push(piece);
    at += piece.length;
  }
  return values.map((value, seq) => pieceOf(id, seq, value, seq === values.length - 1));
};

/** The other half of `parts`: pieces in, the frame they were cut from out.
 *
 *  One instance per connection. A frame that is not a piece goes straight up; a piece is held until
 *  the one marked `last` arrives, and the joined text is parsed and handed up as one frame - the
 *  shape the sender wrote, however many messages carried it. Bounded by maxChars in total, because a
 *  peer that streams pieces and never says last is not carrying a frame this wire will hold. */
export class Assembler<F> {
  private readonly held = new Map<string, string[]>();
  private heldChars = 0;

  private readonly onFrame: (frame: F) => void;
  private readonly maxChars: number;

  constructor(onFrame: (frame: F) => void, maxChars: number = MAX_MESSAGE_CHARS) {
    this.onFrame = onFrame;
    this.maxChars = maxChars;
  }

  feed = (frame: unknown): void => {
    const part = frame as Part | null;
    if (typeof part !== 'object' || part === null || part.op !== PART) {
      this.onFrame(frame as F);
      return;
    }
    const { id, seq, value } = part;
    if (typeof id !== 'string' || typeof value !== 'string' || !Number.isInteger(seq)) {
      console.error('[bus] dropped a part frame with no id, sequence or value');
      return;
    }
    const pieces = this.held.get(id) ?? [];
    if (seq !== pieces.length) {
      console.error(
        `[bus] part gap for ${id}: got seq ${seq}, want ${pieces.length}; the frame is dropped`,
      );
      this.forget(id, pieces);
      return;
    }
    pieces.push(value);
    this.held.set(id, pieces);
    this.heldChars += value.length;
    if (this.heldChars > this.maxChars) {
      console.error(
        `[bus] dropped ${this.held.size} half-arrived frame(s): more than ${this.maxChars} characters held`,
      );
      this.held.clear();
      this.heldChars = 0;
      return;
    }
    if (part.last !== true) return;
    this.forget(id, pieces);
    try {
      this.onFrame(JSON.parse(pieces.join('')) as F);
    } catch (error) {
      console.error(
        `[bus] a ${pieces.length}-part frame did not parse: ${(error as Error).message}`,
      );
    }
  };

  private forget(id: string, pieces: string[]): void {
    if (!this.held.delete(id)) return;
    this.heldChars -= pieces.reduce((sum, piece) => sum + piece.length, 0);
  }
}
