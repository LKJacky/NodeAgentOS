// search: DeepSeek's own web search and a safe fetch of a page, on the bus.
//
// The key this node searches with is not only an environment variable any more. It can be saved on the
// node's page, through the `key` capability — is a key set, save one, clear it — and it is written
// through the **history** node so a restart does not forget it, the way the other nodes here keep their
// state. The key itself never comes back out: `key` answers whether one is set and where it came from,
// and the page asks for that rather than ever holding the secret in its HTML. With no key at all a
// search fails with a sentence that says where to put one, because "missing credentials" from the
// provider underneath says nothing about this node's page.
//
// The SDK host builds one node per invocation, so nothing that has to outlive a call is kept in one:
// every call reads the saved key back from history before it answers. On a bus with no history node
// the key has nowhere to be written, and the one this process keeps is held by a map at module load —
// the only state here that outlives a call, and it is keyed per tenant.
import { readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import {
  DEFAULT_USER_AGENT,
  HttpFetchProvider,
  type HttpFetchLimits,
} from '@deepseek-ai/dsh-web-fetch-http';
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
  type DeepSeekSearchProviderOptions,
} from '@deepseek-ai/dsh-web-search-deepseek';
import {
  WebRuntime,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web';
import {
  Node,
  type NodeClass,
  type NodeContext,
  type NodeHandlers,
  type ToolArgs,
  loadResource,
  paintPage,
  type Resource,
} from '@node-agent/sdk';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 5_000_000;
const DEFAULT_FETCH_MAX_BODY_CHARS = 100_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 5;

/** The name this node answers to on the bus (`search.search`), and the name the page is filled with.
 *  The new SDK has no per-node id: a package is one node, so the name is a constant here and in
 *  package.json. */
const NODE_ID = 'search';

/** The capability that reads and writes the key: the page and a person both go through this one name,
 *  and it is the only way a key gets in. */
const KEY = 'key';

/** The page's capability: the shell asks a node for its page by this name, and knows no node's own. */
const PANEL = 'ui';

/** The history unit the saved key lives in — one unit, holding nothing else. */
const HISTORY_UNIT = 'api-key';

/** Said when a search has no key to send. The page is the way out, so the sentence names it: the
 *  provider's own "missing credentials" would leave a person looking in the wrong place. */
const NO_KEY = 'no DeepSeek API key yet — open the search page and save one';

/** The node's own page, read from next to the compiled JS (`npm run build` copies src/*.html there). */
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

/** The page's words, read from next to the compiled JS (same copy). */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

export type SearchProviderApi = WebSearchProvider;
export type FetchProviderApi = WebFetchProvider;

export interface WebRuntimeApi {
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
}

/** Where a search's key comes from: the one saved on this node's page, the one this process was started
 *  with (`DEEPSEEK_API_KEY`, or the key the node was constructed with), or nowhere. */
export type KeySource = 'page' | 'environment' | 'none';

/** Everything `key` says about the key, and all it ever says: the key itself never travels back out, so
 *  a page cannot show it and a log cannot keep it. `persistent` is false when there is no history node
 *  to write to, i.e. a saved key lasts as long as this process. */
export interface KeyState {
  configured: boolean;
  source: KeySource;
  persistent: boolean;
}

/** The `api-key` unit as it comes back from history: the revision it is filed at, and the key inside
 *  it — or no key, for the `null` a cleared one is written as. */
type SavedKeyUnit = { revision: number; meta: { api_key?: unknown } };

export type SearchProviderFactory = (
  resolveOptions: () => DeepSeekSearchProviderOptions,
) => SearchProviderApi;
export type FetchProviderFactory = (limits: HttpFetchLimits) => FetchProviderApi;
export type WebRuntimeFactory = (
  searchProvider: SearchProviderApi,
  fetchProvider: FetchProviderApi,
) => WebRuntimeApi;

export interface DeepSeekSearchOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  apiVersion?: string;
  maxTokens?: number;
  maxUses?: number;
  maxResults?: number;
  timeoutMs?: number;
  fetchMaxResponseBytes?: number;
  fetchMaxBodyChars?: number;
  fetchTimeoutMs?: number;
  fetchMaxRedirects?: number;
  fetchUserAgent?: string;
  providerFactory?: SearchProviderFactory;
  fetchProviderFactory?: FetchProviderFactory;
  webRuntimeFactory?: WebRuntimeFactory;
}

/** A call that failed because there is no such node on the bus: the one refusal that means "work
 *  without history" rather than "history refused". The new context has no directory to ask, so the
 *  read itself is the probe. */
const NO_HISTORY = /no node provides|no such node|unknown node|not registered/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The key a bus with no history node still keeps, one entry per tenant, for as long as this process
 *  lives. `dispose()` runs after every invocation and must not clear it: a key that went away with the
 *  call that saved it would be a saved key that never worked. */
const processKeys = new Map<string, string | null>();

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/** A key as this node will hold one: a non-empty string once trimmed. Anything else — a number, null,
 *  a blank — is not a key, and both ends read it the same way: a save refuses it, and a value found at
 *  join is "no key saved" rather than a reason not to start. */
function keyFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function searchRequestFrom(
  args: { query?: unknown; maxResults?: unknown },
  defaultMaxResults: number,
): WebSearchRequest {
  if (typeof args.query !== 'string' || args.query.trim() === '') {
    throw new Error('search.search wants a non-empty query string');
  }
  const maxResults =
    args.maxResults === undefined
      ? defaultMaxResults
      : positiveInteger(Number(args.maxResults), 'maxResults');
  return { query: args.query.trim(), maxResults };
}

function fetchRequestFrom(args: { url?: unknown }): WebFetchRequest {
  if (typeof args.url !== 'string' || args.url.trim() === '') {
    throw new Error('search.fetch wants a non-empty URL string');
  }
  return { url: args.url.trim() };
}

function createWebRuntime(
  searchProvider: SearchProviderApi,
  fetchProvider: FetchProviderApi,
): WebRuntime {
  const runtime = new WebRuntime(new Context(), {
    searchProvider: searchProvider.id,
    fetchProvider: fetchProvider.id,
  });
  runtime.registerSearchProvider(searchProvider);
  runtime.registerFetchProvider(fetchProvider);
  return runtime;
}

/** The DeepSeek search this node exposes through the Harness web capability seam, plus the key it needs
 *  and the page a person saves that key on. Built once per invocation by the Node below; every key it
 *  uses is read back before the call it serves answers. */
class SearchService {
  readonly timeoutMs: number;
  readonly fetchTimeoutMs: number;
  readonly maxResults: number;
  readonly webRuntime: WebRuntimeApi;

  /** The key this node was constructed with, if any: one a page cannot change, and the last resort
   *  after the saved key and the environment. */
  private readonly launchKey: string;

  /** The key saved on the page, read back from history at the start of the call and never handed out
   *  again over the bus. */
  private savedKey: string | null = null;

  /** The history revision the saved key was read from: a save names it, so a write made on top of
   *  what this node knows is refused rather than silently overwriting another one. */
  private keyRevision: number | null = null;

  /** Whether history.load and history.save are on the bus. Without them a saved key lives until the
   *  process stops, and the page says so. */
  private persistent = false;

  /** This call's context, and whether the key has been read back under it yet. */
  private ctx: NodeContext | null = null;
  private activated = false;

  constructor(options: DeepSeekSearchOptions = {}) {
    this.launchKey = (options.apiKey ?? '').trim();
    this.timeoutMs = positiveInteger(
      options.timeoutMs ??
        Number(process.env.NODE_AGENT_DEEPSEEK_SEARCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
      'timeoutMs',
    );
    this.maxResults = positiveInteger(
      options.maxResults ??
        Number(process.env.NODE_AGENT_DEEPSEEK_SEARCH_MAX_RESULTS ?? DEFAULT_MAX_RESULTS),
      'maxResults',
    );
    this.fetchTimeoutMs = positiveInteger(
      options.fetchTimeoutMs ??
        Number(process.env.NODE_AGENT_DEEPSEEK_FETCH_TIMEOUT_MS ?? DEFAULT_FETCH_TIMEOUT_MS),
      'fetchTimeoutMs',
    );
    const fetchUserAgent =
      options.fetchUserAgent ??
      process.env.NODE_AGENT_DEEPSEEK_FETCH_USER_AGENT ??
      DEFAULT_USER_AGENT;
    if (fetchUserAgent.trim() === '') throw new Error('fetchUserAgent must be non-empty');
    const fetchLimits: HttpFetchLimits = {
      maxResponseBytes: positiveInteger(
        options.fetchMaxResponseBytes ??
          Number(
            process.env.NODE_AGENT_DEEPSEEK_FETCH_MAX_RESPONSE_BYTES ??
              DEFAULT_FETCH_MAX_RESPONSE_BYTES,
          ),
        'fetchMaxResponseBytes',
      ),
      maxBodyChars: positiveInteger(
        options.fetchMaxBodyChars ??
          Number(
            process.env.NODE_AGENT_DEEPSEEK_FETCH_MAX_BODY_CHARS ?? DEFAULT_FETCH_MAX_BODY_CHARS,
          ),
        'fetchMaxBodyChars',
      ),
      timeoutMs: this.fetchTimeoutMs,
      maxRedirects: nonNegativeInteger(
        options.fetchMaxRedirects ??
          Number(
            process.env.NODE_AGENT_DEEPSEEK_FETCH_MAX_REDIRECTS ?? DEFAULT_FETCH_MAX_REDIRECTS,
          ),
        'fetchMaxRedirects',
      ),
      userAgent: fetchUserAgent,
    };

    const resolveOptions = (): DeepSeekSearchProviderOptions => ({
      apiKey: this.launchKey === '' ? undefined : this.launchKey,
      // Asked per search rather than captured: a key saved on the page has to be the one the next
      // search goes out with, and the page saves it during the call that updates it.
      resolveApiKey: async () => this.currentKey() || undefined,
      baseURL: options.baseURL ?? process.env.DEEPSEEK_SEARCH_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL,
      model:
        options.model ?? process.env.NODE_AGENT_DEEPSEEK_SEARCH_MODEL ?? DEEPSEEK_DEFAULT_MODEL,
      apiVersion:
        options.apiVersion ??
        process.env.NODE_AGENT_DEEPSEEK_SEARCH_API_VERSION ??
        DEEPSEEK_DEFAULT_API_VERSION,
      maxTokens: positiveInteger(
        options.maxTokens ??
          Number(process.env.NODE_AGENT_DEEPSEEK_SEARCH_MAX_TOKENS ?? DEEPSEEK_DEFAULT_MAX_TOKENS),
        'maxTokens',
      ),
      maxUses: positiveInteger(
        options.maxUses ??
          Number(process.env.NODE_AGENT_DEEPSEEK_SEARCH_MAX_USES ?? DEEPSEEK_DEFAULT_MAX_USES),
        'maxUses',
      ),
    });
    const searchProvider = (
      options.providerFactory ?? ((resolver) => new DeepSeekSearchProvider(resolver))
    )(resolveOptions);
    const fetchProvider = (
      options.fetchProviderFactory ?? ((limits) => new HttpFetchProvider(limits))
    )(fetchLimits);
    this.webRuntime = (options.webRuntimeFactory ?? createWebRuntime)(
      searchProvider,
      fetchProvider,
    );
  }

  /** Take this call's context and read the saved key back under it. The host builds a context per
   *  call, so this runs once per instance, before any capability answers. */
  async activate(ctx: NodeContext): Promise<void> {
    this.ctx = ctx;
    if (this.activated) return;
    this.activated = true;
    await this.restoreKey();
  }

  async handle(
    cap: string,
    args: ToolArgs,
  ): Promise<KeyState | string | WebSearchResult | WebFetchResult> {
    if (cap === 'search') return this.search(searchRequestFrom(args, this.maxResults));
    if (cap === 'fetch') return this.fetch(fetchRequestFrom(args));
    if (cap === KEY) return this.keyAction(args);
    // The page carries this node's own name as a placeholder, filled in here where the node knows what
    // it is called: only the name is substituted, so both the filled and the unfilled page stay valid
    // JavaScript.
    if (cap === PANEL)
      return paintPage(PAGE, RESOURCE, args).replace('__NODE__', () =>
        JSON.stringify(NODE_ID).slice(1, -1),
      );
    throw new Error(`search provides search, fetch, ${KEY} and ${PANEL} (got "${cap}")`);
  }

  /** The `key` capability: what a page may ask about the key, and the only two ways to change it. */
  private async keyAction(args: ToolArgs): Promise<KeyState> {
    const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'status';
    if (action === 'status') return this.keyState();
    if (action === 'save') {
      // Refused here, before the history node is touched: a blank or a number written now is a unit
      // the next call could only ignore, and a person would have been told it was saved.
      const wanted = keyFrom(args.api_key);
      if (wanted === null)
        throw new Error('saving a key wants api_key: the key itself, copied from DeepSeek');
      // Written before it takes effect here: a key that only lived until the next call would look
      // saved and not be.
      await this.writeKey(wanted);
      this.savedKey = wanted;
      return this.keyState();
    }
    if (action === 'clear') {
      await this.writeKey(null);
      this.savedKey = null;
      return this.keyState();
    }
    throw new Error(`unknown key action "${action}" (status, save, clear)`);
  }

  /** What the page and the model may know: whether a key is set, where it comes from, and whether a
   *  saved one survives a restart. Never the key — a status call that answered with it would put a
   *  second copy of the secret on the bus every time a page was opened. */
  private keyState(): KeyState {
    if (this.savedKey !== null)
      return { configured: true, source: 'page', persistent: this.persistent };
    if (this.currentKey() !== '') {
      return { configured: true, source: 'environment', persistent: this.persistent };
    }
    return { configured: false, source: 'none', persistent: this.persistent };
  }

  /** The key a search goes out with: the one saved on the page first, then the one this process was
   *  started with. Read at every search, so a key saved now is used now. */
  private currentKey(): string {
    if (this.savedKey !== null) return this.savedKey;
    return this.launchKey || (process.env.DEEPSEEK_API_KEY ?? '').trim();
  }

  /** Write the key through the history node. With no history node there is nothing to write to, and a
   *  saved key lasts as long as this process — the page says which of the two it is. */
  private async writeKey(apiKey: string | null): Promise<void> {
    if (!this.persistent) {
      if (this.ctx !== null) processKeys.set(this.ctx.tenantId, apiKey);
      return;
    }
    const request: ToolArgs = { unitId: HISTORY_UNIT, meta: { api_key: apiKey } };
    if (this.keyRevision !== null) request.expectedRevision = this.keyRevision;
    try {
      const saved = await this.ctx!.call<{ unit: { revision: number } }>(
        'history',
        'save',
        request,
      );
      this.keyRevision = saved.unit.revision;
    } catch (error) {
      throw new Error(`search could not save the key: ${message(error)}`);
    }
  }

  /** The key read back at the start of a call. A history node that refuses a read is said out loud and
   *  survived: an environment key still searches, and a page that cannot save yet is better than a node
   *  that would not answer. A unit that holds something which is not a key — a number, null, a blank,
   *  left there by anything else that wrote to it — is read as no key saved: the node comes up
   *  unconfigured, and nothing is warned about a value it never wrote. */
  private async restoreKey(): Promise<void> {
    const ctx = this.ctx!;
    let unit: SavedKeyUnit | null;
    try {
      const loaded = await ctx.call<{ unit: SavedKeyUnit | null }>('history', 'load', {
        unitId: HISTORY_UNIT,
      });
      unit = loaded.unit;
    } catch (error) {
      if (NO_HISTORY.test(message(error))) {
        // No history node on the bus: the key this process keeps is the one a page saved earlier in
        // it, and the page says that is all the persistence there is.
        this.savedKey = processKeys.get(ctx.tenantId) ?? null;
        return;
      }
      console.warn(`search could not read its saved key: ${message(error)}`);
      this.persistent = true;
      return;
    }
    this.persistent = true;
    if (unit === null) return;
    this.savedKey = keyFrom(unit.meta.api_key);
    this.keyRevision = unit.revision;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult> {
    const normalizedRequest = searchRequestFrom(request, this.maxResults);
    // Said here rather than left to the provider: its own missing-credential sentence points at a
    // settings page of its own, and the one that has the field is this node's.
    if (this.currentKey() === '') throw new Error(NO_KEY);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      return await this.webRuntime.search(normalizedRequest, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const normalizedRequest = fetchRequestFrom(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    timer.unref();
    try {
      return await this.webRuntime.fetch(normalizedRequest, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

const CAPABILITIES = ['search', 'fetch', KEY, PANEL] as const;

/** A per-invocation Node. Every call reads its own key back from history; nothing outlives the call
 *  except the key this process keeps when there is no history node to write to. */
export class DeepSeekSearchNode extends Node {
  readonly handlers: NodeHandlers;
  private readonly service: SearchService;

  constructor(ctx: NodeContext, options: DeepSeekSearchOptions = {}) {
    super(ctx);
    this.service = new SearchService(options);
    this.handlers = Object.fromEntries(
      CAPABILITIES.map((cap) => [
        cap,
        async (args: ToolArgs) => {
          await this.service.activate(this.ctx);
          return await this.service.handle(cap, args);
        },
      ]),
    );
  }
}

/** The class with these options fixed: how a test — or a deployment that configures the node in code
 *  rather than through the environment — hosts it. The SDK host itself always calls `new Node(ctx)`. */
export function searchNodeClass(options: DeepSeekSearchOptions = {}): NodeClass {
  return class extends DeepSeekSearchNode {
    constructor(ctx: NodeContext) {
      super(ctx, options);
    }
  };
}

export default DeepSeekSearchNode;
