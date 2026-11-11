// webui: the general browser front end. It is deliberately ignorant — it knows no node by name,
// and exactly one capability name.
//
//   GET  /            the shell page (webui.html): a list of pages, plus a frame to show one in
//   GET  /panels      who has a page, straight out of the bus directory
//   GET  /panel/<id>  that node's page — the node rendered it itself, we just hand it over
//   POST /call        {tool, args} -> the bus call, verbatim: how a page talks back
//   GET  /events      ?feed=<node>:<topic> (repeated); legacy node/topic URLs still work
//   POST /events/subscriptions {client, feeds} -> update a shell's stream in place
//
// The shell is also where the user's language is decided, once: the first request tells the system
// node what the browser asked for (`Accept-Language`), the system node persists it, and this process
// remembers the answer. Nothing here knows a single sentence — the words are the node's own, in its
// resource files (embedded by the node into the page it serves) or on the elements themselves;
// `i18n-client.js` draws both, and `/sdk/i18n.js`, `/sdk/i18n-resource.js`, `/sdk/i18n-client.js`
// are where the three halves of that SDK are served from.
//
// Three more paths make that page installable, and they are files rather than routes because they are
// content, not code: the manifest (name, colours, start_url, standalone), the tile's drawing, and the
// service worker that keeps the two of them plus the page itself for when the bus is not there. None
// of the three touches the bus, and the worker answers for nothing else (see sw.js). Two more paths,
// the PNG tiles the manifest also names, are not files in the package at all: `npm run build` draws
// them from that same drawing (scripts/png-icons.mjs), and a machine without a rasterizer leaves them
// missing, which is a 404 here and nothing worse.
//
// The convention is one word: a node that wants a page declares the `ui` capability, and answering it
// returns a whole HTML document. That is the entire contract between the front end and the nodes —
// no import, no registration call, nothing a supervisor has to wire up. A node that joins later
// has a page the moment it says so.
//
// Together /call and /events are the two directions of the binding: a page writes with a call and
// is told about every change on a stream — including changes it did not make itself, which is what
// a page cannot learn by calling. Subscribing is not a capability, so it never enters the directory.
//
// The webui declares no capability of its own: a node with no capabilities never appears in the bus
// directory, so the model is never offered a way back into the front end that is serving it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  loadResource,
  paintPage,
  type BusSession,
  type Resource,
  type ToolArgs,
} from '@node-agent/sdk';

const PANEL = 'ui';

type DirEntry = {
  tool: string;
  node: string;
  desc: string;
  icon?: string;
  parameters: Record<string, unknown>;
  /** The node's display names, when its manifest carries them. */
  names?: Readonly<Record<string, string>>;
};

type LegacyReply = { ok: true; value?: unknown } | { ok: false; error: string };

/** Browser event transport shared by the shell, node pages, and the SDK's language watcher. */
const EVENT_ASSETS: Record<string, string> = Object.fromEntries(
  ['events-client.js', 'events-broker.js', 'events-shared-worker.js'].map((name) => [
    `/webui/${name}`,
    readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'),
  ]),
);

/** The shell page is content, not code, so it lives in its own file; read once, at import time. */
const SHELL = readFileSync(new URL('./webui.html', import.meta.url), 'utf8');

/** The one line in the shell that is filled per request: the language this visit resolved to, and the
 *  SDK's browser half. The rest of what changes per visit (the words, the `lang` attribute, the
 *  resource script) is what `paintPage` writes — see `shellFor`. */
/** The worker name is scoped to the authenticated tenant, never to a token or a readable cookie.
 *  Pinning the same key on /events prevents an old worker reconnecting as a newly logged-in user. */
function eventTenant(html: string, tenant: string | null): string {
  if (tenant === null || html.includes('name="node-agent-event-tenant"')) return html;
  const escaped = tenant
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const meta = `<meta name="node-agent-event-tenant" content="${escaped}">`;
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, (head) => head + meta)
    : meta + html;
}

const LANGUAGE_SLOT = '<!-- node-agent:i18n -->';

/** The shell's own words: the chrome's sentences, a file per language beside the page. Read once, like
 *  the page itself, so a broken resource is a node that will not start rather than a page that greets
 *  half its readers in the wrong language. `node.i18n` names `dist/i18n`, and the build copies this
 *  folder there (see scripts/copy-assets.mjs); `label.node` in it is the name the shell publishes. */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

/** The language a visit gets when none can be resolved: the resource's own default. */
const DEFAULT_LANGUAGE = 'en';

/** The two files that let a page speak: the SDK's catalog, and the browser half that applies it. Both
 *  are served from the `@node-agent/sdk` package this node already depends on, and this map is the
 *  whole of what /sdk exposes — a route per file, never a directory. */
const SDK_FILES = {
  '/sdk/i18n.js': './i18n.js',
  '/sdk/i18n-resource.js': './i18n-resource.js',
  '/sdk/i18n-client.js': './i18n-client.js',
} as const;

/** The rest of the static shell, read the same way and for the same reason: they are what a browser
 *  needs to put this page on a home screen (the manifest and the drawing its tile is made of) and to
 *  show it again when the bus is not there (the worker). Nothing here interprets any of them.
 *  `npm run build` copies all three next to the compiled file — see scripts/copy-assets.mjs. */
const MANIFEST = readFileSync(new URL('./manifest.webmanifest', import.meta.url), 'utf8');
const ICON = readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');
const WORKER = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');

/** The two PNG tiles the manifest names, by URL path. They are the one piece of the shell that is not in
 *  the package at all: no binary is committed, so `npm run build` draws them from `icon.svg` with whatever
 *  rasterizer the machine has (see scripts/png-icons.mjs), and a machine with none leaves them missing.
 *  So they are read on the request rather than here, and a build that could not draw them answers 404 on
 *  those two paths instead of failing to start: the page, the manifest and the worker still work, and the
 *  SVG is still a tile. */
const TILES: Record<string, string> = {
  '/icon-192.png': './icon-192.png',
  '/icon-512.png': './icon-512.png',
};

/** A tile's bytes, from beside this module — src/ while a test imports it, dist/ once built; undefined
 *  when the build did not draw one, which is a machine without a rasterizer, not an error. */
function readTile(path: string): Buffer | undefined {
  try {
    return readFileSync(new URL(path, import.meta.url));
  } catch {
    return undefined;
  }
}

/** Where the page lives. 0 means "pick a free port" — the URL is printed either way. Setting
 *  this to a busy port is the one way serve() fails. */
const PORT = Number(process.env.NODE_AGENT_WEBUI_PORT ?? 8790);

/** The interface the page binds. Loopback by default, because this page has no auth of its own: what
 *  keeps it private is that no other machine can reach it. A container cannot be reached at all until
 *  it binds 0.0.0.0, so the docker deployment pins NODE_AGENT_WEBUI_BIND=0.0.0.0 — and then publishes
 *  nothing: the port stays inside the tenant's own network, and that network plus NODE_AGENT_TOKEN is
 *  the whole access control (see docker-compose.yml). */
const BIND = process.env.NODE_AGENT_WEBUI_BIND ?? '127.0.0.1';

/** Where a browser should open it. 0.0.0.0 is a listen address, not a destination, so a page bound to
 *  every interface is opened on loopback — which is where the published port forwards to anyway. */
const OPEN = BIND === '0.0.0.0' ? '127.0.0.1' : BIND;

/** A page normally posts one sentence or one command, but the agent's cache exists for the other
 *  case: a pasted log or file is one message too, and it must reach the agent to be trimmed into
 *  that cache. Eight mebibytes is a pasted file, not an upload; anything larger is refused. */
const MAX_BODY = 8 << 20;

/** A page id is a node id, and node ids are tame — so refuse anything odd before it reaches the
 *  bus (no "..", no slashes, no dots that would mean a different node). */
const ID = /^[A-Za-z0-9_-]+$/;

/** Event topics are node ids with optional dot-separated channels (`mindmap.view`). Every segment
 *  follows the node-id alphabet, so namespaced topics work without admitting paths or empty parts. */
const TOPIC = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/** How often an idle event stream says "still here". A connection that says nothing for long
 *  enough can be dropped by whatever sits in between, and silence is indistinguishable from a
 *  dead peer. A comment line costs nothing and keeps the stream visibly alive. */
const BEAT = 15_000;

/** Maximum data queued for one browser that is no longer reading its event stream. Node's HTTP
 *  response buffers writes in user space after socket backpressure starts; without a cap, repeated
 *  events can consume the container's entire memory and let the kernel kill the bus. */
const MAX_FEED_BUFFER = 1 << 20;

/** One row of the browser shell: which node, what it says its page is for, and (optionally) the
 *  capability the shell can poll for an online dot and the drawing its tab leads with. A node declares
 *  this on its own page capability, so the shell never has to know a node's name: `presence: '<cap>'`
 *  names a capability returning `{online}` to badge. The tab's picture comes from the node manifest,
 *  not its page.
 *
 *  Which COLUMN a page gets is not here, and is not the node's to choose: the shell puts the resident
 *  node (the agent) in the left column, always, and every other page on the launcher and the right.
 *  A `slot` parameter is simply ignored — no page can ask its way into the left column any more. */
type Panel = {
  node: string;
  desc: string;
  presence?: string;
  icon?: string;
  /** The display name the node publishes, per language (`labels.node` in its i18n files). The
   *  `node` field stays the canonical one: the shell addresses pages by it. */
  names?: Readonly<Record<string, string>>;
};

/** A page may name a capability the shell can poll for an online indicator. It has to be a plain
 *  local capability name (the shell calls `<node>.<presence>`), so anything else is ignored. */
function presenceOf(parameters: ToolArgs): string | undefined {
  const presence = (parameters as { presence?: unknown }).presence;
  return typeof presence === 'string' && ID.test(presence) ? presence : undefined;
}

/** How long one page call may wait for the node behind it.
 *
 *  This is a ceiling, not a turn's clock: a panel starts a turn with `chat_no_wait` and follows it
 *  from the node's events, so what is left here are the short control calls (a status or history
 *  read, a stop, a provider switch). It is the budget the layer in front already gives a POST —
 *  serve's page proxy waits `CALL_TIMEOUT`, 15 minutes — so a page and the proxy in front of it give
 *  up at the same moment instead of the page's clock cutting a call the proxy is still waiting for. */
const PAGE_CALL_MS = 15 * 60_000;

/** What a host may change without touching this code. */
export interface WebuiOptions {
  /** How long one `/call` may wait for the node behind it. Default: `PAGE_CALL_MS`. */
  readonly callTimeoutMs?: number;
}

/** Where the SDK's compiled files are, resolved through the dependency rather than guessed: `dist/` is
 *  the package's business. `null` when the package cannot be resolved, which costs the two i18n routes
 *  and nothing else. */
const SDK_DIR = ((): URL | null => {
  try {
    return new URL('./', import.meta.resolve('@node-agent/sdk'));
  } catch {
    return null;
  }
})();

/** One file of the SDK's i18n, read per request: a build that has not compiled it is a 404, not a node
 *  that will not start. */
function readSdkFile(path: string): string | null {
  if (SDK_DIR === null) return null;
  try {
    return readFileSync(new URL(path, SDK_DIR), 'utf8');
  } catch {
    return null;
  }
}

/** The shell for one visit: the words of the language it resolved to, the document saying that
 *  language, the SDK's browser half loaded, and the same words in the page as a resource so the shell's
 *  own script can build a sentence later (`t(...)`). All of it is written before anything is laid out,
 *  so the first paint is already the reader's and nothing flashes English at them.
 *
 *  `language` is null when there was nobody to ask (no tenant on this request): the page is still drawn
 *  from the resource — in its own default, English — but without the hand-off, so nothing claims to know
 *  a language the shell never resolved. */
function shellFor(language: string | null): string {
  // The tag is checked here too, so a hand-off can only ever carry a language tag.
  const tag = language !== null && LANGUAGE_TAG.test(language) ? language : DEFAULT_LANGUAGE;
  const painted = paintPage(SHELL, RESOURCE, { language: tag });
  if (language === null) return painted;
  const handOff = [
    `<script>window.__NODE_AGENT_LANGUAGE__ = ${JSON.stringify(tag)};</script>`,
    '<script type="module" src="/sdk/i18n-client.js"></script>',
  ].join('\n    ');
  return painted.replace(LANGUAGE_SLOT, () => handOff);
}

/** A language tag and nothing else is what goes into the page: `zh-CN`, `en`. The system node answers
 *  with one of two constants; this is the guard that keeps a hand-off from carrying anything else. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/** What the browser says it reads: the header the system node turns into a language. */
function acceptLanguageOf(req: IncomingMessage): string | undefined {
  const header = req.headers['accept-language'];
  return typeof header === 'string' ? header : undefined;
}

/** The language a `language` event carries: `resolved` when the payload says so, else `language`. */
function languageOfEvent(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { language, resolved } = value as { language?: unknown; resolved?: unknown };
  const tag = typeof resolved === 'string' ? resolved : language;
  return typeof tag === 'string' && LANGUAGE_TAG.test(tag) ? tag : null;
}

/** webui: hands the browser a general shell, then whatever pages the nodes made for themselves. */
export class WebuiNode {
  server?: Server;
  port = 0;
  /** The budget one page call gets, in milliseconds. */
  readonly callTimeoutMs: number;

  /** Open event streams per topic: the browsers currently being pushed that topic's events. */
  feeds = new Map<string, Set<ServerResponse>>();

  /** Topics the bus is already telling this node about. Kept apart from `feeds` because a bus
   *  subscription lives as long as this node does, not as long as one browser tab. */
  watching = new Set<string>();

  /** The language each tenant's pages are drawn in, decided by that tenant's first visit. */
  languages = new Map<string, string>();

  /** First visits in flight, so two requests racing on one decide once rather than twice. */
  private deciding = new Map<string, Promise<string>>();

  private readonly eventClients = new Map<
    string,
    {
      res: ServerResponse;
      feeds: Set<Set<ServerResponse>>;
      updates: Promise<void>;
    }
  >();
  private readonly subscribing = new Map<string, Promise<void>>();

  private readonly bus: BusSession;

  constructor(bus: BusSession, options: WebuiOptions = {}) {
    this.bus = bus;
    this.callTimeoutMs = Math.max(1, options.callTimeoutMs ?? PAGE_CALL_MS);
  }

  /** A signed tenant header from the trusted web front door. A bare header is not enough: the
   *  browser must not be able to choose whose page this request opens. */
  private tenantOf(req: IncomingMessage): string | null {
    const user = req.headers['x-serve-user'];
    const given = req.headers['x-serve-signature'];
    const secret = (
      process.env.NODE_AGENT_WEBUI_SECRET ??
      process.env.SERVE_PLATFORM_SECRET ??
      ''
    ).trim();
    // Home is a direct page with no front door. It is kept private by its loopback bind. The
    // runtime already computed this deployment user's bus id and handed it to the node process;
    // do not re-derive it from the token here. A deployment with a front door sets the secret and
    // must send the signed headers below.
    if (secret === '') return process.env.NODE_AGENT_USER_TENANT?.trim() || null;
    if (typeof user !== 'string' || user === '' || typeof given !== 'string') return null;
    const expected = createHmac('sha256', secret).update(user).digest('hex');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return user;
  }

  /** The directory as the page sees it: one row per (node, capability), the shape the old bus's
   *  dir() returned. */
  private async dir(tenantId: string): Promise<DirEntry[]> {
    const entries: DirEntry[] = [];
    for (const node of await this.bus.listNodes(tenantId)) {
      const caps = (await this.bus.listCapabilities?.(node.name, tenantId)) ?? [];
      for (const cap of caps)
        entries.push({
          tool: `${node.name}.${cap.cap}`,
          node: node.name,
          desc: node.desc,
          icon: node.icon,
          parameters: cap.parameters as Record<string, unknown>,
          ...(node.labels?.node === undefined ? {} : { names: node.labels.node }),
        });
    }
    return entries;
  }

  private async call(tenantId: string, tool: string, args: ToolArgs): Promise<LegacyReply> {
    const dot = tool.indexOf('.');
    if (dot <= 0 || dot === tool.length - 1) return { ok: false, error: `not an address: ${tool}` };
    try {
      const reply = await this.bus.call({
        id: randomUUID(),
        type: 'call',
        to: tool.slice(0, dot),
        tenantId,
        // A page call is a whole turn's worth of work (see PAGE_CALL_MS): the caller's clock, not
        // the transport's idea of how long a request should take.
        deadline: Date.now() + this.callTimeoutMs,
        payload: { cap: tool.slice(dot + 1), args },
      });
      return reply.payload;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async subscribe(node: string, topic: string, tenantId: string): Promise<LegacyReply> {
    if (this.bus.subscribe === undefined)
      return { ok: false, error: 'this transport cannot subscribe to topics' };
    try {
      await this.bus.subscribe(topic, tenantId, node);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The language for one tenant, decided by the first visit.
   *
   * This front end never chooses: it tells the system node what the browser asked for
   * (`Accept-Language`), and the system node stores it — once, and only while the stored profile has
   * never been chosen. Every later request here reuses the answer, so the bus is not asked again and a
   * returning browser cannot move the language on its own.
   */
  async ensureLanguage(tenantId: string, acceptLanguage: string | undefined): Promise<string> {
    const known = this.languages.get(tenantId);
    if (known !== undefined) return known;
    let deciding = this.deciding.get(tenantId);
    if (deciding === undefined) {
      deciding = this.decideLanguage(tenantId, acceptLanguage);
      this.deciding.set(tenantId, deciding);
    }
    try {
      const language = await deciding;
      this.languages.set(tenantId, language);
      return language;
    } finally {
      // Forgotten as soon as it settles: a failure is retried on the next visit, not remembered.
      if (this.deciding.get(tenantId) === deciding) this.deciding.delete(tenantId);
    }
  }

  /** The bus call behind ensureLanguage: the system node answers with the language to draw in. */
  private async decideLanguage(
    tenantId: string,
    acceptLanguage: string | undefined,
  ): Promise<string> {
    const args: ToolArgs = {};
    if (acceptLanguage !== undefined && acceptLanguage.trim() !== '') args.browser = acceptLanguage;
    const reply = await this.call(tenantId, 'system.ensure_language', args);
    if (!reply.ok) throw new Error(reply.error);
    const value = reply.value as { language?: unknown; resolved?: unknown } | null;
    const language = typeof value?.resolved === 'string' ? value.resolved : value?.language;
    if (typeof language !== 'string' || !LANGUAGE_TAG.test(language))
      throw new Error('system.ensure_language answered without a language tag');
    return language;
  }

  /**
   * The language for a shell request, or null when there is nobody to ask: no tenant on this request,
   * or a stack with no system node in it. Null means "hand nothing over" — the SDK's browser half then
   * draws with whatever the browser itself says, and the next visit asks again.
   */
  private async languageOf(
    tenantId: string | null,
    acceptLanguage: string | undefined,
  ): Promise<string | null> {
    if (tenantId === null) return null;
    try {
      return await this.ensureLanguage(tenantId, acceptLanguage);
    } catch {
      return null;
    }
  }

  /** Start serving on BIND and return the URL. Loopback by default, and no auth at all: what keeps
   *  this page private is that it is not reachable from another machine. */
  async serve(port: number = PORT): Promise<string> {
    const server = createServer((req, res) => {
      // Every route is async; a throw becomes a 500 answer instead of a dead process.
      void this.onRequest(req, res).catch((e: unknown) => {
        if (!res.headersSent) {
          this.send(
            res,
            500,
            'text/plain; charset=utf-8',
            `${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      });
    });

    await new Promise<void>((ok, bad) => {
      server.once('error', (e: Error) => {
        // A failed attempt must not linger: close it before handing the error on, so the caller can
        // retry on another port without leaving a half-open server behind.
        server.close();
        bad(e);
      });
      server.listen(port, BIND, ok);
    });

    this.server = server;
    const address = server.address();
    this.port = typeof address === 'object' && address !== null ? address.port : port;

    return this.url();
  }

  /** Where to open it. */
  url(): string {
    return `http://${OPEN}:${this.port}/`;
  }

  /** Close the page too, not just the bus socket. Open streams are finished off first: a tab left
   *  listening would otherwise sit there until it noticed the socket was gone. */
  close(): void {
    for (const feed of this.feeds.values()) for (const res of feed) res.end();
    this.feeds.clear();
    this.server?.close();
  }

  /** Who has a page right now: the directory, filtered down to the one capability name that means
   *  "I have one". Nothing is cached here, so a node that joins (or leaves) later just shows up. */
  async panels(tenantId: string): Promise<Panel[]> {
    const entries = await this.dir(tenantId);

    return entries
      .filter((e) => e.tool === `${e.node}.${PANEL}`)
      .map((e) => {
        const { description, icon } = e.parameters as { description?: string; icon?: unknown };

        return {
          node: e.node,
          desc: description ?? e.desc,
          presence: presenceOf(e.parameters),
          icon: e.icon ?? (typeof icon === 'string' ? icon : undefined),
          ...(e.names === undefined ? {} : { names: e.names }),
        };
      });
  }

  /** One node's page: ask it for the capability it declared. It has to be a whole HTML document —
   *  that is what lets the browser show it in a frame with its own styles and its own scripts. */
  async panel(
    tenantId: string,
    node: string,
    language?: string,
    onboarding = false,
  ): Promise<string> {
    // The language of this visit goes with the question: a page that paints its own words should
    // paint them in the reader's language from the first byte, not once a script has run. The
    // onboarding flag asks the introduce node for its first-visit page instead of the guide.
    const args: Record<string, unknown> = {};
    if (language !== undefined) args.language = language;
    if (onboarding) args.onboarding = true;
    const reply = await this.call(tenantId, `${node}.${PANEL}`, args);
    if (!reply.ok) throw new Error(reply.error);
    if (typeof reply.value !== 'string')
      throw new Error(`${node}.${PANEL} did not return a chunk of HTML`);

    return reply.value;
  }

  /** One browser request. A handful of routes, no framework. The query string only matters for
   *  /events, so the path is what the routes are matched on. */
  async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [url = '/', search = ''] = (req.url ?? '/').split('?');

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      // The first visit is where the user's language is decided: the browser says what it reads, the
      // system node stores it once, and the answer is written into the page we are about to send.
      const language = await this.languageOf(this.tenantOf(req), acceptLanguageOf(req));
      return this.send(
        res,
        200,
        'text/html; charset=utf-8',
        eventTenant(shellFor(language), this.tenantOf(req)),
        'no-store',
      );
    }

    if (req.method === 'GET' && EVENT_ASSETS[url] !== undefined) {
      return this.send(res, 200, 'text/javascript; charset=utf-8', EVENT_ASSETS[url], 'no-cache');
    }

    // The SDK's own i18n, for a page that wants to translate itself: the catalog a node uses on the
    // server, and the browser half that applies it. Read per request, so a build that has not
    // compiled them is a 404 on these two paths rather than a node that will not start.
    const asset = req.method === 'GET' ? SDK_FILES[url as keyof typeof SDK_FILES] : undefined;
    if (asset !== undefined) {
      const file = readSdkFile(asset);
      if (file !== null)
        return this.send(res, 200, 'text/javascript; charset=utf-8', file, 'no-cache');
    }

    // The installable shell. The manifest says the name, the colours, the start URL and that the page
    // runs without a browser's chrome; the drawing is what a home screen puts on the tile; the worker
    // keeps those two and the page itself for a moment when there is no network. `no-cache` on the two
    // that a worker reads, so a redeployed shell is seen on the next visit rather than in a day — the
    // worker's own cache name is what makes old copies go away (see sw.js).
    if (req.method === 'GET' && url === '/manifest.webmanifest') {
      return this.send(res, 200, 'application/manifest+json; charset=utf-8', MANIFEST, 'no-cache');
    }

    if (req.method === 'GET' && url === '/sw.js') {
      // A JavaScript MIME, or the browser refuses to register the worker at all.
      return this.send(res, 200, 'text/javascript; charset=utf-8', WORKER, 'no-cache');
    }

    if (req.method === 'GET' && url === '/icon.svg') {
      return this.send(res, 200, 'image/svg+xml; charset=utf-8', ICON);
    }

    // The two raster tiles the manifest names, from the folder beside this module (see TILES): build
    // output rather than source, so they are read per request, and a build that had no rasterizer is a
    // 404 on these two decorative paths — the fall-through at the end — not a node that will not start.
    const tile = req.method === 'GET' ? TILES[url] : undefined;
    if (tile) {
      const png = readTile(tile);
      if (png) return this.send(res, 200, 'image/png', png);
    }

    if (req.method === 'GET' && url === '/panels') {
      const tenant = this.tenantOf(req);
      if (tenant === null) return this.unauthorized(res);
      // A page load through this route is a first visit too, and decides the language the same way.
      await this.languageOf(tenant, acceptLanguageOf(req));
      const panels = await this.panels(tenant);
      return this.send(
        res,
        200,
        'application/json; charset=utf-8',
        JSON.stringify({ panels }),
        'no-store',
      );
    }

    if (req.method === 'GET' && url.startsWith('/panel/')) {
      const tenant = this.tenantOf(req);
      if (tenant === null) return this.unauthorized(res);
      // The same decision the shell made: a page is drawn in the language of this visit.
      const language = await this.languageOf(tenant, acceptLanguageOf(req));
      return this.onPanel(
        tenant,
        url.slice('/panel/'.length),
        res,
        language ?? undefined,
        new URLSearchParams(search).get('onboarding') === '1',
      );
    }

    if (req.method === 'GET' && url === '/events/identity') {
      const tenant = this.tenantOf(req);
      if (tenant === null || new URLSearchParams(search).get('tenant') !== tenant)
        return this.unauthorized(res);
      return this.send(
        res,
        200,
        'application/json; charset=utf-8',
        JSON.stringify({ tenant }),
        'no-store',
      );
    }

    if (req.method === 'POST' && url === '/events/subscriptions') {
      const tenant = this.tenantOf(req);
      if (tenant === null) return this.unauthorized(res);
      return this.onSubscriptions(tenant, req, res);
    }

    if (req.method === 'GET' && url === '/events') {
      const tenant = this.tenantOf(req);
      if (tenant === null) return this.unauthorized(res);
      return this.onEvents(tenant, new URLSearchParams(search), res);
    }

    if (req.method === 'POST' && url === '/call') {
      const tenant = this.tenantOf(req);
      if (tenant === null) return this.unauthorized(res);
      return this.onCall(tenant, req, res);
    }

    this.send(res, 404, 'text/plain; charset=utf-8', 'no such path\n');
  }

  /** GET /panel/<node> → that node's own page, as it rendered it, in this visit's language. */
  async onPanel(
    tenantId: string,
    node: string,
    res: ServerResponse,
    language?: string,
    onboarding = false,
  ): Promise<void> {
    const known = (await this.panels(tenantId)).some((p) => p.node === node);
    if (!ID.test(node) || !known) {
      return this.send(res, 404, 'text/plain; charset=utf-8', `no such node "${node}"\n`);
    }

    let html: string;
    try {
      html = await this.panel(tenantId, node, language, onboarding);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return this.send(res, 502, 'text/plain; charset=utf-8', `${why}\n`);
    }

    // Pages without a custom event watcher still have SDK i18n. Give every panel the same
    // transport before its scripts run; inside our frames the broker stays in the parent.
    if (!html.includes('/webui/events-client.js')) {
      const scripts =
        '<script src="/webui/events-client.js"></script><script src="/webui/events-broker.js"></script>';
      html = /<head\b[^>]*>/i.test(html)
        ? html.replace(/<head\b[^>]*>/i, (head) => head + scripts)
        : scripts + html;
    }
    this.send(res, 200, 'text/html; charset=utf-8', eventTenant(html, tenantId), 'no-store');
  }

  /** GET /events?feed=<node>:<topic> → multiplexed SSE (repeated feed allowed).
   *  Repeated legacy topic parameters still share one publisher, or default to (topic, topic). */
  async onEvents(tenantId: string, query: URLSearchParams, res: ServerResponse): Promise<void> {
    if (query.has('tenant') && query.get('tenant') !== tenantId) return this.unauthorized(res);
    let pairs: [string, string][];
    try {
      pairs = this.eventPairs(query);
    } catch {
      return this.send(
        res,
        400,
        'text/plain; charset=utf-8',
        'node and topic must be dot-separated names\n',
      );
    }
    const client = query.get('client');
    if (client !== null && !/^[a-zA-Z0-9-]{16,80}$/.test(client))
      return this.send(res, 400, 'text/plain; charset=utf-8', 'invalid event client\n');
    const feeds = await Promise.all(
      pairs.map(([node, topic]) => this.audience(tenantId, node, topic)),
    );
    if (res.destroyed || res.writableEnded) return;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const session = { res, feeds: new Set(feeds), updates: Promise.resolve() };
    for (const feed of session.feeds) feed.add(res);
    const key = client === null ? null : `${tenantId}\u0000${client}`;
    if (key !== null) {
      this.eventClients.get(key)?.res.destroy();
      this.eventClients.set(key, session);
    }
    const beat = setInterval(() => this.writeFeed(res, ': still here\n\n'), BEAT);
    res.on('close', () => {
      clearInterval(beat);
      for (const feed of session.feeds) feed.delete(res);
      if (key !== null && this.eventClients.get(key) === session) this.eventClients.delete(key);
    });
  }

  /** A stream can mix publishers, while legacy node/topic URLs keep their exact meaning. */
  private eventPairs(query: URLSearchParams): [string, string][] {
    const pairs: [string, string][] = query.getAll('feed').map((feed) => {
      const parts = feed.split(':');
      if (parts.length !== 2) throw new Error('invalid feed');
      return [parts[0]!, parts[1]!];
    });
    const topics = query.getAll('topic');
    const node = query.get('node') ?? topics[0] ?? '';
    for (const topic of topics) pairs.push([node, topic]);
    if (
      pairs.length === 0 ||
      pairs.length > 128 ||
      pairs.some(([n, t]) => !TOPIC.test(n) || !TOPIC.test(t))
    )
      throw new Error('invalid feeds');
    return [...new Map(pairs.map((pair) => [pair.join(':'), pair])).values()];
  }

  /** Change subscriptions in place, not by closing the stream (which would lose in-flight events).
   *  The random client id is scoped to the authenticated tenant and lives only as long as its SSE.
   *  Additions are attached before removals, with serialized updates and no network round trip gap. */
  async onSubscriptions(
    tenantId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let client: string;
    let pairs: [string, string][];
    try {
      const body = JSON.parse(await this.body(req));
      if (body.tenant !== undefined && body.tenant !== tenantId) return this.unauthorized(res);
      if (
        typeof body.client !== 'string' ||
        !Array.isArray(body.feeds) ||
        body.feeds.some((f: unknown) => typeof f !== 'string')
      )
        throw new Error('invalid subscription');
      client = body.client;
      const query = new URLSearchParams();
      for (const feed of body.feeds) query.append('feed', feed);
      pairs = this.eventPairs(query);
    } catch {
      return this.send(res, 400, 'text/plain; charset=utf-8', 'invalid subscriptions\n');
    }
    const session = this.eventClients.get(`${tenantId}\u0000${client}`);
    if (session === undefined || session.res.destroyed || session.res.writableEnded)
      return this.send(res, 404, 'text/plain; charset=utf-8', 'event stream not connected\n');
    const update = session.updates.then(async () => {
      // Attach each addition as soon as its bus subscription is ready. Existing feeds stay live.
      const next = new Set<Set<ServerResponse>>();
      await Promise.all(
        pairs.map(async ([node, topic]) => {
          const feed = await this.audience(tenantId, node, topic);
          next.add(feed);
          if (!session.res.destroyed && !session.res.writableEnded) {
            feed.add(session.res);
            session.feeds.add(feed);
          }
        }),
      );
      for (const feed of session.feeds) if (!next.has(feed)) feed.delete(session.res);
      session.feeds = next;
    });
    session.updates = update.catch(() => {});
    try {
      await update;
      this.send(res, 200, 'application/json; charset=utf-8', '{"ok":true}', 'no-store');
    } catch {
      this.send(res, 502, 'text/plain; charset=utf-8', 'subscription failed\n');
    }
  }

  /** The open streams for one topic, subscribing on the bus the first time anyone asks for it.
   *  The set is created before the subscribe round trip, so two pages opening at once share one
   *  set instead of the second one replacing the first. */
  async audience(tenantId: string, node: string, topic: string): Promise<Set<ServerResponse>> {
    const key = `${tenantId}\u0000${node}\u0000${topic}`;
    const feed = this.feeds.get(key) ?? new Set<ServerResponse>();
    this.feeds.set(key, feed);

    let pending = this.subscribing.get(key);
    if (pending === undefined && !this.watching.has(key)) {
      pending = (async () => {
        const verdict = await this.subscribe(node, topic, tenantId);
        if (verdict.ok !== true) throw new Error(`subscribe ${node}.${topic}: ${verdict.error}`);
        this.watching.add(key);
      })();
      this.subscribing.set(key, pending);
      void pending.finally(() => this.subscribing.delete(key)).catch(() => {});
    }
    await pending;
    return feed;
  }

  /** One event off the bus: hand it to every browser watching that topic. The webui does not
   *  interpret the value either — it wraps it in the SSE envelope and passes it on. The one thing it
   *  keeps for itself is a language change, so the next shell is drawn in the language just chosen. */
  onEvent(tenantId: string, node: string, topic: string, value: unknown, from: string): void {
    if (node === 'system' && topic === 'language') {
      const language = languageOfEvent(value);
      if (language !== null) this.languages.set(tenantId, language);
    }
    const line = `data: ${JSON.stringify({ node, topic, from, value })}\n\n`;
    for (const res of this.feeds.get(`${tenantId}\u0000${node}\u0000${topic}`) ?? [])
      this.writeFeed(res, line);
  }

  /** Write to one event stream without allowing a stalled browser to create an unbounded HTTP
   *  buffer. Destroying it is safe: EventSource reconnects, and the page reloads current state. */
  private writeFeed(res: ServerResponse, line: string): void {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength + Buffer.byteLength(line) > MAX_FEED_BUFFER) {
      res.destroy();
      return;
    }
    res.write(line);
  }

  /** POST /call {"tool":"<node>.<capability>","args":{…}} → the bus call, and the answer as it came back.
   *  This is the whole API a page gets: the webui does not know what `tool` means. A tool that
   *  fails still answers 200 with `{ok:false,error}` — the call itself went through, and how to
   *  show a failure is the page's business. */
  async onCall(tenantId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await this.body(req);
    } catch (error) {
      const why = error instanceof Error ? error.message : 'request body is too large';
      return this.send(
        res,
        200,
        'application/json; charset=utf-8',
        JSON.stringify({ ok: false, error: why }),
      );
    }

    let body: { tool?: unknown; args?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return this.send(res, 400, 'text/plain; charset=utf-8', 'request body is not valid JSON\n');
    }

    const tool = body.tool;
    if (typeof tool !== 'string' || tool === '') {
      return this.send(
        res,
        400,
        'text/plain; charset=utf-8',
        'tool must be a full name like "node.capability"\n',
      );
    }

    const reply = await this.call(tenantId, tool, (body.args ?? {}) as ToolArgs);

    // Only the two fields a page cares about: the bus frame around them (op, id) is not its
    // business, and the answer's shape stays the same whether the tool worked or not.
    const answer = reply.ok ? { ok: true, value: reply.value } : { ok: false, error: reply.error };

    return this.send(res, 200, 'application/json; charset=utf-8', JSON.stringify(answer));
  }

  private unauthorized(res: ServerResponse): void {
    this.send(res, 401, 'text/plain; charset=utf-8', 'a signed tenant header is required\n');
  }

  /** Read a request body with a cap. */
  async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY) throw new Error('request body too large');

      chunks.push(buf);
    }

    return Buffer.concat(chunks).toString('utf8');
  }

  /** One answer. Dynamic pages are never cached: their words, and the language they are drawn in,
   *  change with the user and with the visit. The two files a service worker reads say "revalidate"
   *  instead, so a redeployed shell is not invisible. */
  send(
    res: ServerResponse,
    status: number,
    type: string,
    body: string | Buffer,
    cache?: string,
  ): void {
    res.writeHead(
      status,
      cache ? { 'content-type': type, 'cache-control': cache } : { 'content-type': type },
    );
    res.end(body);
  }
}

export default WebuiNode;
