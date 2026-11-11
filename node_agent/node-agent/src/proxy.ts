// node-agent: the optional built-in proxy — one token, one login page, one door in front of the page.
//
// Off unless serve.ts is given NODE_AGENT_ACCESS_TOKEN: with it unset this module is never called, no
// port is opened and the loopback behaviour of the entry is exactly what it was.
//
//   GET  /login      the form (inline HTML, so the package carries no extra asset)
//   POST /login      the token; on a match, one HttpOnly cookie holding sha256(token)
//   GET  /healthz    liveness, always open, never proxied
//   everything else  the cookie or `Authorization: Bearer <token>`, then piped to the upstream
//
// The cookie never carries the token, comparisons are constant time, `/bus` (WebSocket upgrade) and
// `/events` (SSE) are piped rather than buffered, and the upstream is fixed — this cannot become an
// open proxy. TLS is not here: put your own terminator in front (a reverse proxy, a tunnel, or the
// Caddy of deploy/docker-compose.yml's `public` profile) and set NODE_AGENT_PROXY_SECURE=1 so the
// cookie is marked Secure. One token is one user.
import { createHash, timingSafeEqual } from 'node:crypto';
import { connect, type AddressInfo, type Socket } from 'node:net';
import {
  createServer,
  request as sendRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';

/** The cookie a successful login hands out. Its value is sha256(token) in hex, never the token. */
export const COOKIE_NAME = 'node_agent_access';

/** How long a login lasts, in seconds (30 days), the same as the gateway's cookie. */
export const COOKIE_MAX_AGE = 2_592_000;

export interface ProxyOptions {
  /** The one token a browser exchanges for the cookie. Never printed, never put in a URL. */
  token: string;
  /** The stack behind the door: the webui address serve.ts just read off its own log line. */
  upstream: string;
  /** Default `127.0.0.1`: the browser is on this host unless a deployment says otherwise. */
  bind?: string;
  /** Default `8080`. `0` asks the OS for a free port, which is what the tests do. */
  port?: number;
  /** `true` marks the cookie `Secure`; set it when TLS terminates in front. Default `false`. */
  secure?: boolean;
}

export interface ProxyHandle {
  /** Where the door listens, `http://<bind>:<port>` — the line serve.ts prints. */
  url: string;
  bind: string;
  /** The port actually bound, which is the requested one except when it was `0`. */
  port: number;
  close(): Promise<void>;
}

/**
 * Headers that belong to one connection and must not be forwarded. `cookie` and `host` are handled
 * separately: the browser's cookie is this door's business, not the stack's.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>node-agent</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
        background: Canvas;
        color: CanvasText;
      }
      form { width: min(22rem, 90vw); }
      h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
      p { margin: 0 0 1.25rem; opacity: 0.7; }
      label { display: block; margin-bottom: 0.35rem; }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 0.6rem 0.7rem;
        border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
        border-radius: 0.5rem;
        background: Canvas;
        color: inherit;
        font: inherit;
      }
      button {
        margin-top: 0.75rem;
        width: 100%;
        padding: 0.6rem 0.7rem;
        border: 0;
        border-radius: 0.5rem;
        background: color-mix(in srgb, CanvasText 88%, transparent);
        color: Canvas;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .error:empty { display: none; }
      .error { margin-top: 0.75rem; color: #c0392b; }
    </style>
  </head>
  <body>
    <form method="post" action="/login">
      <h1>node-agent</h1>
      <p>This stack belongs to one person. Enter its token to open it.</p>
      <label for="token">Token</label>
      <input id="token" name="token" type="password" autocomplete="current-password"
        autofocus required />
      <button type="submit">Open</button>
      <div class="error"><!--error--></div>
    </form>
  </body>
</html>
`;

function page(error = ''): string {
  return LOGIN_PAGE.replace('<!--error-->', error);
}

/** The one comparison both the cookie and the bearer token go through. */
function sameDigest(expected: Buffer, presented: string): boolean {
  const digest = createHash('sha256').update(presented).digest();
  return digest.length === expected.length && timingSafeEqual(digest, expected);
}

function sameHex(expected: Buffer, presentedHex: string): boolean {
  const presented = Buffer.from(presentedHex, 'hex');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function cookieOf(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return '';
}

function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return '';
  return rest.join(' ');
}

/** A request may prove itself with the cookie (browsers) or a bearer token (scripts). */
function allowed(req: IncomingMessage, expected: Buffer): boolean {
  const cookie = cookieOf(req);
  if (cookie !== '' && sameHex(expected, cookie)) return true;
  const bearer = bearerOf(req);
  return bearer !== '' && sameDigest(expected, bearer);
}

function body(req: IncomingMessage, limit = 8_192): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

/** Whatever the request carried, the stack behind the door sees only its own headers. */
function forwardHeaders(req: IncomingMessage, host: string): OutgoingHttpHeaders {
  const named = (req.headers.connection ?? '')
    .split(',')
    .map((one) => one.trim().toLowerCase())
    .filter((one) => one !== '');
  const drop = new Set([...HOP_BY_HOP, ...named, 'cookie', 'host']);
  const headers: OutgoingHttpHeaders = { host };
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || drop.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

/** Response headers travel as they are, minus what belongs to this hop, so pipes stay unbuffered. */
function replyHeaders(answer: IncomingMessage): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(answer.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

/**
 * Start the door. The upstream is fixed at start time; nothing in a request can move it, and an
 * absolute-form request line (`GET http://elsewhere/`) is refused rather than resolved.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const token = options.token.trim();
  if (token === '') throw new Error('startProxy needs a token');

  const bind = options.bind?.trim() || '127.0.0.1';
  const port = options.port ?? 8080;
  const secure = options.secure === true;
  const upstream = new URL(options.upstream);
  const upstreamHost = upstream.hostname;
  const upstreamPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  const expected = createHash('sha256').update(token).digest();

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page());
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' }).end();
      return;
    }
    const form = new URLSearchParams(await body(req));
    if (!sameDigest(expected, form.get('token') ?? '')) {
      res
        .writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        .end(page('That token was not the one.'));
      return;
    }
    const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_MAX_AGE}`];
    if (secure) attributes.push('Secure');
    res
      .writeHead(303, {
        'set-cookie': `${COOKIE_NAME}=${expected.toString('hex')}; ${attributes.join('; ')}`,
        location: '/',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      })
      .end('ok\n');
  }

  function proxy(req: IncomingMessage, res: ServerResponse): void {
    const outbound = sendRequest(
      {
        protocol: upstream.protocol,
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req, upstream.host),
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, replyHeaders(answer));
        // pipe, never buffer: /events is a long-lived connection and must reach the browser as it
        // is written, not when it ends.
        answer.pipe(res);
        answer.on('error', () => res.destroy());
      },
    );
    outbound.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('the stack behind this door is not answering\n');
    });
    res.on('close', () => {
      if (!res.writableFinished) outbound.destroy();
    });
    req.pipe(outbound);
  }

  /** A WebSocket (or any upgrade) is piped byte for byte: the gate is the cookie, not the frames. */
  function tunnel(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const upstreamSocket = connect(upstreamPort, upstreamHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(req.headers)) {
        // The upgrade's own hop-by-hop headers are the protocol here, so only the cookie goes.
        if (name === 'cookie' || name === 'host') continue;
        for (const one of Array.isArray(value) ? value : [value ?? '']) {
          lines.push(`${name}: ${one}`);
        }
      }
      lines.push(`host: ${upstream.host}`);
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    // An upgraded socket is no longer the server's to close, so the pair is closed here.
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
  }

  // Every socket is kept so close() can end the long-lived ones (SSE, WebSocket) instead of waiting
  // for a stream that by design never ends.
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    // A door, not a proxy: `GET http://elsewhere/` would otherwise be forwarded as written. The
    // client would have to know the token first, but a fixed upstream is the promise here.
    if (path.startsWith('//') || /^https?:/i.test(req.url ?? '')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('fixed upstream\n');
      req.resume();
      return;
    }
    if (path === '/login') {
      login(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request\n');
      });
      return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok\n');
      req.resume();
      return;
    }
    if (!allowed(req, expected)) {
      // Browsers get the page; anything else (a script, a fetch) gets the status instead of a
      // redirect it cannot follow.
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(303, { location: '/login', 'cache-control': 'no-store' }).end();
      } else {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('unauthorized\n');
      }
      req.resume();
      return;
    }
    proxy(req, res);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    if (!allowed(req, expected)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      return;
    }
    tunnel(req, socket as Socket, head);
  });

  return new Promise<ProxyHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      server.removeListener('error', reject);
      const address = server.address() as AddressInfo | null;
      const bound = address?.port ?? port;
      const host = bind.includes(':') ? `[${bind}]` : bind;
      resolve({
        url: `http://${host}:${bound}`,
        bind,
        port: bound,
        close: () =>
          new Promise<void>((done, fail) => {
            // An SSE stream never ends on its own, so closing must end it rather than wait for it.
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.closeAllConnections();
            server.close((error) => (error === undefined ? done() : fail(error)));
          }),
      });
    });
  });
}
