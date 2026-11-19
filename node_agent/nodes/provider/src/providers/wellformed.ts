// The last line of defence before the wire.
//
// Half a UTF-16 surrogate pair is not valid Unicode. Python's json.loads accepts the escape but
// rejects the string ("no low surrogate in string"), so a server that reads strict JSON answers
// 400 to the whole request - and the provider, seeing a failing call, retries the same broken
// body eight times before giving up. One stray half therefore costs a whole sample.
//
// Earlier layers fix what they can (`wellFormedMessage` in the agent, `windowOf` in the cache),
// but each of them has to know every string it touches. This one does not: it walks the finished
// request body and replaces every lone half with U+FFFD, and says where it found one so the next
// occurrence can be traced to the layer that made it.

/** A high half with no low half after it, or a low half with no high half before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** One place a lone surrogate was found, in the words of the path that led there. */
export interface SurrogateHit {
  path: string;
  count: number;
  context: string;
}

/** `text` with every lone surrogate replaced by U+FFFD. */
export function wellFormedText(text: string): string {
  return text.replace(new RegExp(LONE_SURROGATE.source, 'g'), '\uFFFD');
}

function scrub(value: unknown, path: string, hits: SurrogateHit[]): unknown {
  if (typeof value === 'string') {
    const match = LONE_SURROGATE.exec(value);
    if (match === null) return value;
    const at = match.index;
    hits.push({
      path,
      count: value.match(new RegExp(LONE_SURROGATE.source, 'g'))?.length ?? 1,
      context: value.slice(Math.max(0, at - 80), at + 80),
    });
    return wellFormedText(value);
  }
  if (Array.isArray(value)) return value.map((item, index) => scrub(item, `${path}[${index}]`, hits));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrub(item, `${path}.${key}`, hits);
    }
    return out;
  }
  return value;
}

/** `body` with every lone surrogate replaced, and one log line per place one was found.
 *
 * `warn` is the operator's channel: the default writes to stderr, which the runtime keeps in the
 * node's log next to the request that would otherwise have failed. */
export function scrubSurrogates<T>(body: T, warn: (line: string) => void = console.error): T {
  const hits: SurrogateHit[] = [];
  const cleaned = scrub(body, 'body', hits) as T;
  for (const hit of hits.slice(0, 5)) {
    warn(`[surrogate] ${hit.path} x${hit.count} near ${JSON.stringify(hit.context)}`);
  }
  if (hits.length > 5) warn(`[surrogate] ... and ${hits.length - 5} more places`);
  return cleaned;
}
