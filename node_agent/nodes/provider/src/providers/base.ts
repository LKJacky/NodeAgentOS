// Provider-neutral chat types and the OpenAI-compatible implementation.
//
// The three protocols share these shapes. A caller sends a transcript in the neutral message shape,
// the provider translates it to its wire, and the answer comes back in the same neutral shape. The
// node, the page and an agent therefore never learn which protocol answered.
import { setTimeout as sleep } from 'node:timers/promises';
import OpenAI from 'openai';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: unknown };
export type Fetcher = typeof fetch;

/** How many attempts one request gets, the first one included; `NODE_AGENT_MODEL_ATTEMPTS` (8).
 *  1 means "never retry". A failed request is a pause, not the end. */
export const RETRY_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.NODE_AGENT_MODEL_ATTEMPTS ?? '8', 10) || 8,
);
/** The wait before the second attempt, in seconds; `NODE_AGENT_MODEL_BACKOFF` (1). */
export const RETRY_BACKOFF = Number(process.env.NODE_AGENT_MODEL_BACKOFF ?? '1') || 1;
/** The longest one wait may grow to, in seconds; `NODE_AGENT_MODEL_MAX_DELAY` (60). */
export const RETRY_MAX_DELAY = Math.max(
  0,
  Number(process.env.NODE_AGENT_MODEL_MAX_DELAY ?? '60') || 60,
);
/** Statuses this deployment asked *not* to retry: `NODE_AGENT_MODEL_NO_RETRY_STATUSES=401,403`,
 *  `4xx`, or `400-499`.
 *
 *  The policy is "an HTTP failure is a retry", 400 and 404 included, because a gateway in front of a
 *  model answers all of those for reasons a second attempt outlives. A status is skipped only when
 *  somebody writes it here, in the open — never because the base class quietly decided a retry is
 *  pointless. A 429 or an upstream limit body is retried even so: that is a wait, not a verdict. */
export const RETRY_EXCLUDED_STATUSES = parseStatuses(
  process.env.NODE_AGENT_MODEL_NO_RETRY_STATUSES ?? '',
);

/** `401,403`, `4xx` and `400-499` in one comma-separated list, as a set of statuses. */
function parseStatuses(raw: string): Set<number> {
  const statuses = new Set<number>();
  for (const part of raw.split(',')) {
    const text = part.trim();
    if (text === '') continue;
    const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(text);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let status = from; status <= to; status += 1) statuses.add(status);
      continue;
    }
    const wholeClass = /^([1-5])xx$/i.exec(text);
    if (wholeClass !== null) {
      const hundred = Number(wholeClass[1]) * 100;
      for (let status = hundred; status < hundred + 100; status += 1) statuses.add(status);
      continue;
    }
    const single = Number(text);
    if (Number.isInteger(single) && single >= 100 && single <= 599) statuses.add(single);
  }
  return statuses;
}

/** Everything the retry policy reads, in one object: a test replaces a field instead of sleeping. */
export type RetryPolicy = {
  /** Total attempts, the first one included. */
  attempts: number;
  /** The wait before the second attempt, in seconds; every later one doubles it. */
  backoffSeconds: number;
  /** A ceiling on one wait, in seconds. A `Retry-After` from the endpoint overrides it. */
  maxDelaySeconds: number;
  /** Statuses this deployment asked not to retry (see `RETRY_EXCLUDED_STATUSES`). */
  excludedStatuses: Set<number>;
  /** The jitter source: 0 gives the plain doubled wait, 1 the longest one. */
  random: () => number;
};

/** The one policy the three protocols run under; the base class owns it, a provider does not. */
export const retryPolicy: RetryPolicy = {
  attempts: RETRY_ATTEMPTS,
  backoffSeconds: RETRY_BACKOFF,
  maxDelaySeconds: RETRY_MAX_DELAY,
  excludedStatuses: new Set(RETRY_EXCLUDED_STATUSES),
  random: () => Math.random(),
};

/** The wait before attempt `attempt + 1`, in seconds: the base doubled per attempt, jittered, capped.
 *
 *  Half of the wait is fixed and half random, so callers that failed together do not all come back
 *  at the same instant, while the wait still grows with every attempt. */
export function retryDelaySeconds(attempt: number, policy: RetryPolicy = retryPolicy): number {
  const cap = Math.max(0, policy.maxDelaySeconds);
  const base = Math.min(Math.max(0, policy.backoffSeconds) * 2 ** Math.max(0, attempt - 1), cap);
  if (base <= 0) return 0;
  const jitter = 0.5 + Math.min(Math.max(policy.random(), 0), 1) * 0.5;
  return Math.min(base * jitter, cap);
}

/** What an OpenAI row posts to when the page leaves `base_url` blank. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** The pause between two attempts. A test replaces it, because the wait is not what it checks; a
 *  cancel closes it early, because a caller that stopped waiting deserves its error back at once. */
export const retryPause = {
  async for(seconds: number, signal?: AbortSignal): Promise<void> {
    await sleep(seconds * 1000, undefined, signal ? { signal } : {});
  },
};

/** One model request's HTTP failure, carrying the status that decides whether a retry can help. */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** What kind of failure a caller is looking at after the retries are spent. */
export type FailureKind = 'connection' | 'rate_limit' | 'server' | 'http' | 'aborted' | 'unknown';

/** The errno and undici codes that mean the request never reached the endpoint. */
const REFUSED_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** The classes both SDKs name a request that never reached the endpoint. */
const CONNECTION_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'ConnectTimeoutError',
  'TimeoutError',
]);

/** The classes that mean somebody stopped the request: a cancel is not a connection to retry. */
const ABORT_NAMES = new Set(['AbortError', 'APIUserAbortError']);

/** Error names/codes that mean an upstream rate limiter answered, not a dead socket. */
const RATE_LIMIT_NAMES = new Set(['RateLimitError', 'RateLimitExceededError']);
const RATE_LIMIT_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests']);

/** What an upstream says when it is the concurrency that is spent, not the quota.
 *
 *  A 429 is the polite way to say it; the gateways in front of these models also say it on a 400, a
 *  403 or a 503, and the same request would work once a slot frees up. The words are matched
 *  case-insensitively against the whole cause chain, so a body the SDK kept in `message`, `body` or
 *  `response.data` is read either way. */
const UPSTREAM_LIMIT_MARKERS = [
  'concurrency',
  'concurrent request',
  'too many request',
  'too many connection',
  'rate limit',
  'rate-limit',
  'ratelimit',
  'slow down',
  'capacity',
  'overloaded',
  'resource_exhausted',
  'resource exhausted',
  'quota exceeded',
  'quota_exceeded',
  'server_busy',
  'server busy',
  'try again later',
  // The gateways in front of the MIOFFICE models say it in Chinese.
  '并发',
  '限流',
  '请求过多',
  '稍后重试',
];

/** An error's own name and its class name: the SDKs leave `name` at "Error" and rely on the class. */
function kindsOf(error: object): string[] {
  const shape = error as { name?: unknown; constructor?: unknown };
  const kinds: string[] = [];
  if (typeof shape.name === 'string') kinds.push(shape.name);
  const own = (shape.constructor as { name?: unknown } | undefined)?.name;
  if (typeof own === 'string') kinds.push(own);
  return kinds;
}

/** An error and the `cause` chain under it: `fetch` hides why it failed one or two levels down. */
function chainOf(error: unknown): object[] {
  const links: object[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    links.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return links;
}

/** Did somebody cancel this request? Whichever layer wrapped it, the abort is in the chain. */
export function isAbortFailure(error: unknown): boolean {
  return chainOf(error).some((link) => {
    if (kindsOf(link).some((kind) => ABORT_NAMES.has(kind))) return true;
    const code = (link as { code?: unknown }).code;
    return code === 'ABORT_ERR' || code === 'ABORTED';
  });
}

/** The error a cancel becomes, named the way every other abort in the chain is. */
function abortFailure(signal: AbortSignal): unknown {
  const reason = signal.reason as unknown;
  if (reason instanceof Error) return reason;
  const error = new Error('the request was aborted');
  error.name = 'AbortError';
  return error;
}

/** The HTTP status an SDK or a fetch error carries, if it has one. */
export function statusOf(error: unknown): number | null {
  for (const link of chainOf(error)) {
    for (const key of ['status', 'statusCode'] as const) {
      const value = (link as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    const response = (link as { response?: { status?: unknown } }).response;
    if (typeof response?.status === 'number') return response.status;
  }
  return null;
}

/** The first machine-readable code in the chain (`ECONNRESET`, `rate_limit_exceeded`, …). */
export function codeOf(error: unknown): string {
  for (const link of chainOf(error)) {
    const value = (link as { code?: unknown }).code;
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** Read one response header without assuming which SDK shape carries it. */
function headerOf(error: object, name: string): string {
  const headers = (error as { headers?: unknown }).headers;
  if (headers instanceof Headers) return headers.get(name) ?? '';
  if (headers !== null && typeof headers === 'object') {
    const value = (headers as Record<string, unknown>)[name];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds. */
export function retryAfterMsFromHeader(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const text = raw.trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 300_000);
  const at = Date.parse(text);
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 300_000);
  return null;
}

/** Parse `Retry-After` off an error or anything in its cause chain. */
export function retryAfterMsOf(error: unknown): number | null {
  for (const link of chainOf(error)) {
    // `HttpError` keeps the parsed header in a typed field; an SDK error keeps it in `headers`.
    const own = (link as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof own === 'number' && Number.isFinite(own) && own >= 0) {
      return Math.min(own, 300_000);
    }
    for (const name of ['retry-after', 'retryAfter']) {
      const parsed = retryAfterMsFromHeader(headerOf(link, name));
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

/** One link's own text: the message, the code, its type, and whatever body came with it. */
function textOfValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }
  return String(value);
}

/** Everything this link says, so a marker is found in `message`, `code`, `body` or `response.data`.
 *  An SDK error keeps the endpoint's own words in one of those, and which one differs per SDK. */
function textOfLink(link: object): string {
  const parts: string[] = [];
  for (const key of ['message', 'code', 'type', 'body', 'detail'] as const) {
    const text = textOfValue((link as Record<string, unknown>)[key]);
    if (text !== '') parts.push(text);
  }
  const response = (link as { response?: unknown }).response;
  if (response !== null && typeof response === 'object') {
    for (const key of ['body', 'data', 'text'] as const) {
      const text = textOfValue((response as Record<string, unknown>)[key]);
      if (text !== '') parts.push(text);
    }
  }
  return parts.join(' ');
}

/** The whole chain as one lowercase string: markers are matched without caring about case. */
function textOfChain(error: unknown): string {
  return chainOf(error).map(textOfLink).join(' ').toLowerCase();
}

/** Did the endpoint answer "you have no slot right now"?
 *
 *  A spent concurrency slot, a rate limiter, an overloaded gateway: the status is the polite part and
 *  the body is the truth. A 429 says it outright, and a 400, 403 or 503 carrying the words means the
 *  same thing — the same request works once a slot frees up. */
export function isUpstreamLimitFailure(error: unknown): boolean {
  if (statusOf(error) === 429) return true;
  if (RATE_LIMIT_CODES.has(codeOf(error))) return true;
  if (chainOf(error).some((link) => kindsOf(link).some((kind) => RATE_LIMIT_NAMES.has(kind))))
    return true;
  const text = textOfChain(error);
  return UPSTREAM_LIMIT_MARKERS.some((marker) => text.includes(marker));
}

/** The name the callers, the logs and the kinds already use: a concurrency answer is a rate limit. */
export function isRateLimitFailure(error: unknown): boolean {
  return isUpstreamLimitFailure(error);
}

/** Did the endpoint answer, but with a server-side failure? */
export function isServerFailure(error: unknown): boolean {
  const status = statusOf(error);
  return status !== null && status >= 500;
}

/** Did the request fail to reach the endpoint at all? */
export function isConnectionFailure(error: unknown): boolean {
  if (error instanceof HttpError || isAbortFailure(error)) return false;
  return chainOf(error).some((link) => {
    if (link instanceof HttpError) return false;
    if (kindsOf(link).some((kind) => CONNECTION_NAMES.has(kind))) return true;
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string' && REFUSED_CODES.has(code)) return true;
    if (link instanceof TypeError) {
      const message = link.message.toLowerCase();
      return (
        message.includes('fetch failed') ||
        message.includes('network') ||
        message.includes('connection') ||
        message.includes('terminated')
      );
    }
    return false;
  });
}

/** The broad class of the final failure, so callers and logs can tell a dead socket from a 429. */
export function failureKind(error: unknown): FailureKind {
  if (isAbortFailure(error)) return 'aborted';
  if (isRateLimitFailure(error)) return 'rate_limit';
  if (isServerFailure(error)) return 'server';
  if (statusOf(error) !== null) return 'http';
  if (isConnectionFailure(error)) return 'connection';
  return 'unknown';
}

/** Is this failure one a second attempt can fix?
 *
 *  Every HTTP failure is: a status that is not 2xx reached this function because an attempt failed,
 *  and a gateway, a proxy or a queue in front of the model is free to answer 400, 401, 403, 404 or
 *  409 for a reason that goes away by itself. So the answer is yes for all of them, and a caller
 *  that knows its endpoint better says otherwise through `excludedStatuses`
 *  (`NODE_AGENT_MODEL_NO_RETRY_STATUSES`) — in the open, never by the base class quietly deciding
 *  that a retry is pointless. Two things are never retried: a request somebody cancelled, and a
 *  failure with no status and no dead socket behind it (a malformed answer, which a retry would
 *  reproduce). A wait the endpoint asked for — a 429 or an upstream concurrency body — is always
 *  retried, whatever status carried it and whatever was excluded. */
export function retryable(error: unknown, policy: RetryPolicy = retryPolicy): boolean {
  if (isAbortFailure(error)) return false;
  if (isUpstreamLimitFailure(error)) return true;
  const status = statusOf(error);
  if (status === null) return isConnectionFailure(error);
  return !policy.excludedStatuses.has(status);
}

/** The type name a person can search for, even when the SDK left `name` as "Error". */
function typeOf(error: unknown): string {
  if (error === null || typeof error !== 'object') return typeof error;
  const own = ((error as { constructor?: unknown }).constructor as { name?: unknown } | undefined)
    ?.name;
  const named = (error as { name?: unknown }).name;
  return typeof own === 'string' && own !== ''
    ? own
    : typeof named === 'string' && named !== ''
      ? named
      : 'Error';
}

/** A gateway sometimes answers one error body inside another: the real sentence, and its code, sit in
 *  `param` as JSON while `message` says only "Request Error". That buried sentence is the only part a
 *  person reading the failure can act on, so it is read back out and shown beside the type. */
function buriedDetail(error: object): string {
  const param = (error as { param?: unknown }).param;
  if (typeof param !== 'string' || param.trim().startsWith('{') === false) return '';
  try {
    const parsed = JSON.parse(param) as { error?: { message?: unknown; code?: unknown } } | null;
    const inner = parsed?.error ?? {};
    const message = typeof inner.message === 'string' ? inner.message.trim() : '';
    const code = typeof inner.code === 'string' ? inner.code.trim() : '';
    if (message === '') return '';
    return code === '' ? message : `${message} (${code})`;
  } catch {
    return '';
  }
}

/** The id the endpoint logged this request under, when the SDK kept one: what an operator needs to
 *  find the same request on the gateway's side. */
function requestIdOf(error: object): string {
  for (const key of ['requestID', 'request_id'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** One link of the cause chain, with everything a caller would need to identify it. */
function describeLink(error: object): string {
  const type = typeOf(error);
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message.trim().replace(/\.$/, '')
      : '';
  const buried = buriedDetail(error);
  const meta: string[] = [];
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') meta.push(`code=${code}`);
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') meta.push(`status=${status}`);
  const requestId = requestIdOf(error);
  if (requestId !== '') meta.push(`request_id=${requestId}`);
  const retryAfter = retryAfterMsOf(error);
  if (retryAfter !== null) meta.push(`retry_after_ms=${retryAfter}`);
  return `${type}${message === '' ? '' : `: ${message}`}${buried === '' ? '' : ` (${buried})`}${meta.length === 0 ? '' : ` [${meta.join(', ')}]`}`;
}

/** The SDK says `Connection error.` and hides the reason in `cause`; show the whole chain, with every
 *  type and machine-readable field, instead of one bare sentence. */
export function failureReason(error: unknown): string {
  const parts: string[] = [];
  for (const link of chainOf(error)) {
    const text = describeLink(link);
    if (text !== '' && !parts.includes(text)) parts.push(text);
  }
  return parts.join(' -> ') || 'no answer';
}

/** One endpoint as a failure message names it: the row, and the host that did not answer. */
export type Endpoint = { name: string; host: string };

/** The host inside a base URL, or the wire's own when the row names none. */
export function endpointHost(baseUrl: string | null, fallback: string): string {
  const raw = (baseUrl ?? '').trim() || fallback;
  try {
    return new URL(raw).host;
  } catch {
    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    return withoutScheme.split('/')[0] || raw;
  }
}

/** What a caller reads when the attempts are spent: provider, host, attempts, final kind, and the
 *  complete cause chain (type, message, code, status, Retry-After). */
export function failureMessage(
  endpoint: Endpoint,
  attempts: number,
  cause: unknown,
  streamStarted = false,
): string {
  const tries = attempts === 1 ? '1 attempt' : `${attempts} attempts`;
  const kind = failureKind(cause);
  const verb = streamStarted
    ? 'failed while streaming from'
    : kind === 'connection'
      ? 'cannot reach'
      : 'failed at';
  const status = statusOf(cause);
  const meta = [`kind=${kind}`];
  if (status !== null) meta.push(`status=${status}`);
  const code = codeOf(cause);
  if (code !== '') meta.push(`code=${code}`);
  return `provider "${endpoint.name}" ${verb} the model endpoint ${endpoint.host} after ${tries}: ${failureReason(cause)} [${meta.join(', ')}]`;
}

/** A model request that failed after the provider's retry policy was spent. It keeps the original
 *  error as `cause` and exposes the fields a caller needs without parsing the sentence. */
export class ProviderCallError extends Error {
  readonly provider: string;
  readonly host: string;
  readonly attempts: number;
  readonly kind: FailureKind;
  readonly status: number | null;
  readonly code: string;
  readonly causeType: string;
  readonly streamStarted: boolean;

  constructor(endpoint: Endpoint, attempts: number, cause: unknown, streamStarted = false) {
    super(failureMessage(endpoint, attempts, cause, streamStarted), { cause });
    this.name = 'ProviderCallError';
    this.provider = endpoint.name;
    this.host = endpoint.host;
    this.attempts = attempts;
    this.kind = failureKind(cause);
    this.status = statusOf(cause);
    this.code = codeOf(cause);
    this.causeType = typeOf(cause);
    this.streamStarted = streamStarted;
  }
}

/** Kept as the connection-specific name so callers that already distinguish an unreachable host
 *  keep working; it now carries the same full detail as every other ProviderCallError. */
export class UnreachableError extends ProviderCallError {
  constructor(endpoint: Endpoint, attempts: number, cause: unknown, streamStarted = false) {
    super(endpoint, attempts, cause, streamStarted);
    this.name = 'UnreachableError';
  }
}

/** The error to raise once the attempts are spent. Every failure is wrapped: a 429, a 500 and a
 *  malformed answer all deserve the provider, host, attempt count and original type. */
export function providerFailure(
  error: unknown,
  endpoint: Endpoint,
  attempts: number,
  streamStarted = false,
): ProviderCallError {
  if (failureKind(error) === 'connection')
    return new UnreachableError(endpoint, attempts, error, streamStarted);
  return new ProviderCallError(endpoint, attempts, error, streamStarted);
}

/** Wait out the pause before the next attempt: the endpoint's `Retry-After` when it named one, the
 *  policy's doubled and jittered backoff otherwise. A cancel ends the wait instead of sleeping on. */
export async function waitBeforeRetrying(
  attempt: number,
  error: unknown,
  policy: RetryPolicy = retryPolicy,
  signal?: AbortSignal,
): Promise<void> {
  const retryAfter = retryAfterMsOf(error);
  const wait = retryAfter !== null ? retryAfter / 1000 : retryDelaySeconds(attempt, policy);
  const basis = retryAfter !== null ? 'the endpoint asked for it' : 'backoff';
  console.error(
    `model request failed (${failureReason(error)}); retrying in ${wait}s (${basis}; attempt ${attempt + 1} of ${policy.attempts})`,
  );
  await retryPause.for(wait, signal);
}

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export type ToolCall = {
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
  index?: number;
};
export type Message = {
  role?: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
  provider_state?: JsonObject;
  [key: string]: unknown;
};
export type ToolSpec = {
  type: 'function';
  function?: { name?: string; description?: string; parameters?: JsonObject; strict?: boolean };
};
export type ChatOutput = {
  message: Message;
  usage: Usage | null;
  previous_response_id: string | null;
};
export type StreamOutput = {
  delta: Message;
  usage?: Usage | null;
  previous_response_id?: string | null;
  provider_state?: JsonObject;
};

/** One optional string field of a provider row. */
export function optionalString(data: JsonObject, key: string): string | null {
  const value = data[key];
  if (value !== undefined && value !== null && typeof value !== 'string')
    throw new Error(`provider ${key} must be a string or null`);
  return value === null || value === undefined ? null : value;
}

/** The row's optional thinking effort: an empty value means the endpoint's default. */
export function thinkingEffort(data: JsonObject): string | null {
  const value = optionalString(data, 'thinking_effort');
  return value === null ? null : value.trim() || null;
}

export function timeoutOf(data: JsonObject, label: string): number | null {
  const value = data.timeout;
  if (value !== undefined && value !== null && (typeof value !== 'number' || Number.isNaN(value)))
    throw new Error(`${label} provider timeout must be a number or null`);
  return value === undefined || value === null ? null : value;
}

export function missingProviderMessage(name: string, known: string[]): string {
  const others = [...known].sort().join(', ');
  const suffix = others ? ` (configured: ${others})` : '';
  return `no provider "${name}" yet — open the provider page and add one${suffix}`;
}

export function blankProviderMessage(): string {
  return 'this provider is not filled in yet — open the provider page and add its model and API key';
}

/** Resolve with the work, or reject after `ms` rather than waiting forever on a request. */
export async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** JSON-compatible plain data, with null object fields dropped like model_dump(exclude_none). */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => plain(item));
  if (value !== null && typeof value === 'object') {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value as JsonObject)) {
      if (item === undefined || item === null) continue;
      result[key] = plain(item);
    }
    return result;
  }
  return value;
}

export function messageOf(value: unknown): Message {
  const message = plain(value);
  if (message === null || typeof message !== 'object' || Array.isArray(message))
    throw new Error(`provider returned an invalid message: ${typeof value}`);
  return message as Message;
}

export function usageFromOpenAI(value: unknown): Usage | null {
  if (value === null || value === undefined) return null;
  const u = value as JsonObject;
  return {
    prompt_tokens: Number(u.prompt_tokens ?? 0),
    completion_tokens: Number(u.completion_tokens ?? 0),
    total_tokens: Number(u.total_tokens ?? 0),
  };
}

/** POST a JSON body and return its JSON answer, raising an HttpError for a non-2xx status. */
export async function postJson(
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string>,
  body: JsonObject,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(
      response.status,
      `HTTP ${response.status}: ${text}`,
      retryAfterMsFromHeader(response.headers.get('retry-after')),
    );
  }
  return (await response.json()) as JsonObject;
}

/** Read a server-sent-event body and yield each JSON `data:` payload. */
export async function* sseEvents(response: Response): AsyncGenerator<JsonObject, void, unknown> {
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(
      response.status,
      `HTTP ${response.status}: ${text}`,
      retryAfterMsFromHeader(response.headers.get('retry-after')),
    );
  }
  if (response.body === null) throw new Error('the model stream had no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0) {
        let line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length > 0) {
            const payload = data.join('\n');
            data = [];
            if (payload !== '[DONE]') yield JSON.parse(payload) as JsonObject;
          }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart());
        }
        boundary = buffer.indexOf('\n');
      }
      if (done) break;
    }
    if (data.length > 0) {
      const payload = data.join('\n');
      if (payload !== '[DONE]') yield JSON.parse(payload) as JsonObject;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** What a retried request may be told: the policy to run under, and the caller's cancel. */
export type RetryOptions = {
  policy?: RetryPolicy;
  /** A request the caller aborted is never retried, and neither is the wait before the next try. */
  signal?: AbortSignal;
};

/** Retry one request under the policy: the one loop every protocol goes through.
 *
 *  This and `retryStream` are the whole retry story of the package. A provider says how to make one
 *  attempt and nothing else — which statuses are retried, how long to wait, when to give up and how
 *  the failure is wrapped are decided here, once. */
export async function retryRequests<T>(
  work: () => Promise<T>,
  endpoint: Endpoint,
  options: RetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? retryPolicy;
  let attempt = 0;
  for (;;) {
    // A cancel that landed while this request waited must not send another one.
    if (options.signal?.aborted)
      throw providerFailure(abortFailure(options.signal), endpoint, Math.max(attempt, 1));
    attempt += 1;
    try {
      return await work();
    } catch (error) {
      if (attempt >= policy.attempts || !retryable(error, policy))
        throw providerFailure(error, endpoint, attempt);
      try {
        await waitBeforeRetrying(attempt, error, policy, options.signal);
      } catch (stopped) {
        // The caller cancelled while this request was waiting: report the cancel, not the wait.
        throw providerFailure(stopped, endpoint, attempt);
      }
    }
  }
}

/** Retry a stream only until its first chunk; a retry after that would repeat what was read. */
export async function* retryStream<T>(
  open: () => AsyncGenerator<T, void, unknown>,
  endpoint: Endpoint,
  options: RetryOptions = {},
): AsyncGenerator<T, void, unknown> {
  const policy = options.policy ?? retryPolicy;
  let emitted = false;
  let attempt = 0;
  for (;;) {
    if (options.signal?.aborted)
      throw providerFailure(abortFailure(options.signal), endpoint, Math.max(attempt, 1), emitted);
    attempt += 1;
    try {
      for await (const event of open()) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      if (emitted || attempt >= policy.attempts || !retryable(error, policy))
        throw providerFailure(error, endpoint, attempt, emitted);
      try {
        await waitBeforeRetrying(attempt, error, policy, options.signal);
      } catch (stopped) {
        throw providerFailure(stopped, endpoint, attempt, emitted);
      }
    }
  }
}

/** The base every protocol extends — the `BaseProvider` the retry policy is written for.
 *
 *  A protocol implements `chat` and `chatStream` as one attempt each and hands the attempt over
 *  through `attempt` / `attemptStream`. The retry itself — which failures are retried, the wait (backoff,
 *  jitter, `Retry-After`), the attempt ceiling, the abort, the wrapping into `ProviderCallError` —
 *  lives here and only here, so the three wires cannot drift apart. */
export abstract class Provider {
  /** The row this provider serves, set by whoever built it: a failure names the row, not the wire. */
  name = '';
  /** The retry policy this row runs under; the module's own unless a caller replaced it. */
  policy: RetryPolicy = retryPolicy;
  /** The host this provider posts to. */
  abstract readonly host: string;
  protected endpoint(): Endpoint {
    return { name: this.name || String(this.dump().type ?? 'provider'), host: this.host };
  }
  /** Run one attempt's request under the policy, and wrap the final failure once it is spent. */
  protected attempt<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return retryRequests(work, this.endpoint(), { policy: this.policy, signal });
  }
  /** Run one attempt's stream under the policy: retried until the first chunk, never after it. */
  protected attemptStream<T>(
    open: () => AsyncGenerator<T, void, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<T, void, unknown> {
    return retryStream(open, this.endpoint(), { policy: this.policy, signal });
  }
  abstract dump(): JsonObject;
  abstract chat(
    messages: Message[],
    tools?: ToolSpec[] | null,
    maxCompletionTokens?: number | null,
    previousResponseId?: string | null,
  ): Promise<ChatOutput>;
  abstract chatStream(
    messages: Message[],
    tools?: ToolSpec[] | null,
    maxCompletionTokens?: number | null,
    previousResponseId?: string | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamOutput, void, unknown>;
  async close(): Promise<void> {}
}

/** The OpenAI chat-completions provider. */
export class OpenAIProvider extends Provider {
  readonly apiKey: string | null;
  readonly organization: string | null;
  readonly modelName: string;
  readonly baseUrl: string | null;
  readonly timeout: number | null;
  readonly effort: string | null;
  readonly fetcher: Fetcher;
  readonly client: OpenAI | null;
  readonly host: string;

  static build(data: JsonObject, fetcher: Fetcher): OpenAIProvider {
    return new OpenAIProvider({
      apiKey: optionalString(data, 'api_key'),
      organization: optionalString(data, 'organization'),
      modelName: optionalString(data, 'model_name') ?? '',
      baseUrl: optionalString(data, 'base_url'),
      timeout: timeoutOf(data, 'OpenAI'),
      effort: thinkingEffort(data),
      fetcher,
    });
  }

  constructor(options: {
    apiKey?: string | null;
    organization?: string | null;
    modelName?: string;
    baseUrl?: string | null;
    timeout?: number | null;
    effort?: string | null;
    fetcher: Fetcher;
  }) {
    super();
    this.apiKey = options.apiKey ?? null;
    this.organization = options.organization ?? null;
    this.modelName = options.modelName ?? '';
    this.baseUrl = options.baseUrl ?? null;
    this.timeout = options.timeout ?? null;
    this.effort = options.effort ?? null;
    this.fetcher = options.fetcher;
    this.host = endpointHost(this.baseUrl, OPENAI_BASE_URL);
    this.client = this.apiKey
      ? new OpenAI({
          apiKey: this.apiKey,
          ...(this.organization ? { organization: this.organization } : {}),
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
          ...(this.timeout !== null ? { timeout: this.timeout * 1000 } : {}),
          maxRetries: 0,
          fetch: this.fetcher,
        })
      : null;
  }

  dump(): JsonObject {
    return {
      type: 'openai',
      api_key: this.apiKey,
      organization: this.organization,
      model_name: this.modelName,
      base_url: this.baseUrl,
      timeout: this.timeout,
      thinking_effort: this.effort,
    };
  }

  /** One transcript line as the endpoint reads it. Split out so a subclass can speak a wire whose
   *  house rules differ from the generic one (DeepSeek, for instance, insists on a field a plain
   *  chat-completions endpoint never heard of). */
  protected wireMessage(message: Message): JsonObject {
    const row = { ...message };
    delete row.usage;
    delete row.at;
    delete row.took_ms;
    return row;
  }

  protected body(
    messages: Message[],
    tools?: ToolSpec[] | null,
    limit?: number | null,
  ): JsonObject {
    if (this.modelName === '' || this.apiKey === null) throw new Error(blankProviderMessage());
    const body: JsonObject = {
      model: this.modelName,
      messages: messages.map((message) => this.wireMessage(message)),
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (limit !== null && limit !== undefined) body.max_completion_tokens = limit;
    if (this.effort) body.reasoning_effort = this.effort;
    return body;
  }

  async chat(
    messages: Message[],
    tools?: ToolSpec[] | null,
    maxCompletionTokens?: number | null,
    _previousResponseId?: string | null,
  ): Promise<ChatOutput> {
    const body = this.body(messages, tools, maxCompletionTokens);
    if (this.client === null) throw new Error(blankProviderMessage());
    const client = this.client;
    const response = await this.attempt(() => client.chat.completions.create(body as never));
    const payload = JSON.parse(JSON.stringify(response)) as JsonObject;
    const choices = payload.choices as JsonObject[] | undefined;
    const message = messageOf((choices?.[0] as JsonObject | undefined)?.message);
    return {
      message,
      usage: usageFromOpenAI(payload.usage),
      previous_response_id: null,
    };
  }

  async *chatStream(
    messages: Message[],
    tools?: ToolSpec[] | null,
    maxCompletionTokens?: number | null,
    _previousResponseId?: string | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamOutput, void, unknown> {
    const body = {
      ...this.body(messages, tools, maxCompletionTokens),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.client === null) throw new Error(blankProviderMessage());
    const client = this.client;
    yield* this.attemptStream(async function* () {
      const stream = await client.chat.completions.create(body as never, { signal });
      try {
        for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
          const payload = JSON.parse(JSON.stringify(chunk)) as JsonObject;
          const usage = usageFromOpenAI(payload.usage);
          const choices = payload.choices as JsonObject[] | undefined;
          if (!choices || choices.length === 0) {
            yield { delta: {}, usage, previous_response_id: null };
            continue;
          }
          for (const choice of choices) {
            yield { delta: messageOf(choice.delta), usage, previous_response_id: null };
          }
        }
      } finally {
        (stream as { controller?: AbortController }).controller?.abort();
      }
    }, signal);
  }
}

/** The same class under the name the retry policy talks about. */
export { Provider as BaseProvider };
