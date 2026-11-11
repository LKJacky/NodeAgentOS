// Chunking for the legacy bus wire, kept here because the SDK has no dependency on the bus package.
//
// A frame over one megabyte cannot cross a WebSocket message to the bus (it refuses it) or arrive
// whole from it (the bus cuts it up). `parts` cuts one frame into messages that fit; `Assembler`
// puts them back. Both sides measure UTF-8 bytes, because that is what the transport counts.
import { randomUUID } from 'node:crypto';

/** The largest message the bus accepts, in bytes. */
export const MAX_FRAME_BYTES = 1 << 20;

/** The largest frame the wire carries in total, in characters. */
export const MAX_MESSAGE_CHARS = 512 << 20;

const partOf = (id: string, seq: number, value: string, last: boolean): string =>
  `${JSON.stringify({ op: 'part', id, seq, value, last })}\n`;

/** True at a UTF-16 high surrogate: the first half of a pair that must not be cut in two. */
const high = (at: number): boolean => at >= 0xd800 && at <= 0xdbff;

/** `text` as the messages that carry it: itself when one message carries it whole. */
export const parts = (text: string, maxBytes: number = MAX_FRAME_BYTES): string[] => {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const whole = text.endsWith('\n') ? text : text + '\n';
  if (Buffer.byteLength(whole, 'utf8') <= maxBytes) return [whole];
  if (body.length > MAX_MESSAGE_CHARS) {
    throw new RangeError(
      `a frame of ${body.length} characters is past the ${MAX_MESSAGE_CHARS} this wire carries`,
    );
  }

  const id = randomUUID();
  const values: string[] = [];
  const size = Math.max(1, Math.floor((maxBytes - 256) / 2));
  let at = 0;
  while (at < body.length) {
    let end = Math.min(body.length, at + size);
    if (end < body.length && high(body.charCodeAt(end - 1))) end = Math.max(at + 1, end - 1);
    let piece = body.slice(at, end);
    while (
      Buffer.byteLength(partOf(id, values.length, piece, false), 'utf8') > maxBytes &&
      piece.length > 1
    ) {
      end = at + Math.max(1, Math.floor(piece.length / 2));
      if (end < body.length && high(body.charCodeAt(end - 1))) end = Math.max(at + 1, end - 1);
      piece = body.slice(at, end);
    }
    if (Buffer.byteLength(partOf(id, values.length, piece, false), 'utf8') > maxBytes) {
      throw new RangeError(`a part frame cannot fit within ${maxBytes} bytes`);
    }
    values.push(piece);
    at += piece.length;
  }
  return values.map((value, seq) => partOf(id, seq, value, seq === values.length - 1));
};

/** The other half of `parts`. A frame that is not a piece goes straight up; a piece is held until
 *  the one marked `last` arrives. A gap or a duplicate is a broken frame, not a shorter one: that
 *  transfer is dropped and said so, because a truncated frame is worse than no frame. */
export class Assembler {
  readonly #held = new Map<string, string[]>();
  #heldChars = 0;
  readonly #onFrame: (frame: unknown) => void;
  readonly #maxChars: number;

  constructor(onFrame: (frame: unknown) => void, maxChars: number = MAX_MESSAGE_CHARS) {
    this.#onFrame = onFrame;
    this.#maxChars = maxChars;
  }

  feed = (frame: unknown): void => {
    const part = frame as {
      op?: unknown;
      id?: unknown;
      seq?: unknown;
      value?: unknown;
      last?: unknown;
    } | null;
    if (typeof part !== 'object' || part === null || part.op !== 'part') {
      this.#onFrame(frame);
      return;
    }
    const { id, seq, value } = part;
    if (typeof id !== 'string' || typeof value !== 'string' || !Number.isInteger(seq)) {
      console.error('[bus] dropped a part frame with no id, sequence or value');
      return;
    }
    const pieces = this.#held.get(id) ?? [];
    if (seq !== pieces.length) {
      console.error(
        `[bus] part gap for ${id}: got seq ${seq}, want ${pieces.length}; the frame is dropped`,
      );
      this.#forget(id, pieces);
      return;
    }
    pieces.push(value);
    this.#held.set(id, pieces);
    this.#heldChars += value.length;
    if (this.#heldChars > this.#maxChars) {
      console.error(
        `[bus] dropped ${this.#held.size} half-arrived frame(s): more than ${this.#maxChars} characters held`,
      );
      this.#held.clear();
      this.#heldChars = 0;
      return;
    }
    if (part.last !== true) return;
    this.#forget(id, pieces);
    try {
      this.#onFrame(JSON.parse(pieces.join('')));
    } catch (error) {
      console.error(
        `[bus] a ${pieces.length}-part frame did not parse: ${(error as Error).message}`,
      );
    }
  };

  #forget(id: string, pieces: string[]): void {
    if (!this.#held.delete(id)) return;
    this.#heldChars -= pieces.reduce((sum, piece) => sum + piece.length, 0);
  }
}
