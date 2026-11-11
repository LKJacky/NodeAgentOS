// The built-in proxy: the gate (cookie or bearer), what it refuses, and what it must not leak
// upstream. The only network here is a fake stack on loopback, so nothing depends on the internet.
//
// Every test starts its own upstream and its own door on port 0, so tests can run in parallel and
// never collide with whatever is on 8080.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as sendRequest } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { COOKIE_NAME, startProxy } from '../dist/proxy.js';
import { line, start, stateDir } from './entry.mjs';

const TOKEN = 'test-access-token-0123456789abcdef';
const DIGEST = createHash('sha256').update(TOKEN).digest('hex');
const COOKIE = `${COOKIE_NAME}=${DIGEST}`;

/**
 * A stand-in for the stack: it echoes the headers it was given (so the tests can see what was
 * forwarded), streams SSE slowly enough to tell a pipe from a buffer, and answers upgrades.
 */
async function fakeStack() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 250);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

/** One upstream plus one door, torn down with the test. */
async function door(t, options = {}) {
  const stack = await fakeStack();
  const proxy = await startProxy({ token: TOKEN, upstream: stack.url, port: 0, ...options });
  t.after(async () => {
    await proxy.close();
    await stack.stop();
  });
  return { stack, proxy, base: proxy.url };
}

/** The `set-cookie` of a response, whether the client exposes one or many. */
function setCookie(response) {
  const many = response.headers.getSetCookie?.() ?? [];
  return many[0] ?? response.headers.get('set-cookie') ?? '';
}

/** Read a whole response body as text. */
async function text(response) {
  return response.text();
}

/**
 * Send a raw HTTP request through a real socket: some headers the gate must drop (`connection` with
 * extra tokens, `te`) cannot be expressed through fetch.
 */
function rawRequest(proxy, path, headers) {
  return new Promise((resolve, reject) => {
    const request = sendRequest(
      { host: proxy.bind, port: proxy.port, path, method: 'GET', headers },
      (response) => {
        let collected = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (collected += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body: collected }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** A raw socket, for the upgrade and absolute-URI cases. */
async function rawSocket(proxy) {
  const socket = connect(proxy.port, proxy.bind);
  await once(socket, 'connect');
  const chunks = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => chunks.push(chunk));
  return {
    socket,
    seen: () => chunks.join(''),
    send: (text) => socket.write(text),
    async until(test) {
      const until = Date.now() + 5_000;
      while (Date.now() < until) {
        if (test(chunks.join(''))) return chunks.join('');
        await delay(10);
      }
      throw new Error(`never matched; got ${JSON.stringify(chunks.join(''))}`);
    },
  };
}

test('without a cookie the page is a redirect to /login, and a POST is refused', async (t) => {
  const { base, stack } = await door(t);

  const page = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login');
  await text(page);

  const api = await fetch(`${base}/api/status`, { method: 'POST', body: 'x', redirect: 'manual' });
  assert.equal(api.status, 401);
  await text(api);

  const login = await fetch(`${base}/login`);
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await text(login), /name="token"/);

  assert.deepEqual(
    stack.seen.map((one) => one.url),
    [],
    'a request without the cookie reached the stack',
  );
});

test('the right token buys a cookie that holds sha256, not the token', async (t) => {
  const { base } = await door(t);

  const wrong = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ token: 'not-the-token' }),
    redirect: 'manual',
  });
  assert.equal(wrong.status, 401);
  assert.equal(setCookie(wrong), '', 'a failed login handed out a cookie');
  await text(wrong);

  const good = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ token: TOKEN }),
    redirect: 'manual',
  });
  assert.equal(good.status, 303);
  const cookie = setCookie(good);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=2592000/);
  assert.doesNotMatch(cookie, /Secure/, 'Secure by default would break plain-HTTP login');
  assert.equal(cookie.split(';')[0], COOKIE, 'the cookie is not sha256(token)');
  assert.doesNotMatch(cookie, new RegExp(TOKEN), 'the token itself ended up in the cookie');
  await text(good);

  // The cookie is what opens the page, and only on this door.
  const opened = await fetch(`${base}/`, { headers: { cookie: COOKIE } });
  assert.equal(opened.status, 200);
  assert.equal(JSON.parse(await text(opened)).path, '/');

  // A cookie with a plausible shape but the wrong hash is still nothing.
  const forged = await fetch(`${base}/`, {
    headers: { cookie: `${COOKIE_NAME}=${'0'.repeat(64)}` },
    redirect: 'manual',
  });
  assert.equal(forged.status, 303);
  await text(forged);
});

test('with TLS in front the cookie is marked Secure', async (t) => {
  const { base } = await door(t, { secure: true });
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ token: TOKEN }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  assert.match(setCookie(login), /; Secure/);
  await text(login);
});

test('a bearer token lets a script in, a wrong one does not', async (t) => {
  const { base } = await door(t);

  const good = await fetch(`${base}/api/me`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(await text(good)).path, '/api/me');

  const bad = await fetch(`${base}/api/me`, {
    headers: { authorization: 'Bearer definitely-not' },
    redirect: 'manual',
  });
  assert.equal(bad.status, 303);
  await text(bad);
});

test('/healthz needs no cookie and is never proxied', async (t) => {
  const { base, stack } = await door(t);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await text(health), 'ok\n');
  assert.deepEqual(stack.seen, []);
});

test('the browser cookie and hop-by-hop headers never reach the stack', async (t) => {
  const { proxy, stack } = await door(t);

  const answer = await rawRequest(proxy, '/page', {
    cookie: `${COOKIE_NAME}=${DIGEST}`,
    connection: 'keep-alive, x-hop-by-hop',
    'x-hop-by-hop': 'drop me',
    'x-keep-me': 'yes',
    te: 'trailers',
  });
  assert.equal(answer.status, 200);
  const forwarded = JSON.parse(answer.body).headers;

  assert.equal(forwarded.cookie, undefined, 'the browser cookie was forwarded');
  assert.equal(forwarded['x-hop-by-hop'], undefined, 'a Connection-named header was forwarded');
  assert.doesNotMatch(
    String(forwarded.connection ?? ''),
    /x-hop-by-hop/,
    'a Connection-named header survived in connection',
  );
  assert.equal(forwarded.te, undefined, 'te was forwarded');
  assert.equal(forwarded['x-keep-me'], 'yes', 'an ordinary header was lost');
  assert.equal(forwarded.host, new URL(stack.url).host, 'host was not rewritten');
});

test('/events is piped, not buffered', async (t) => {
  const { proxy } = await door(t);

  const chunks = [];
  const stamps = [];
  await new Promise((resolve, reject) => {
    const request = sendRequest(
      { host: proxy.bind, port: proxy.port, path: '/events', headers: { cookie: COOKIE } },
      (response) => {
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          chunks.push(chunk);
          stamps.push(Date.now());
        });
        response.on('end', resolve);
      },
    );
    request.on('error', reject);
    request.end();
  });

  assert.equal(chunks[0], 'data: one\n\n');
  assert.equal(chunks.join(''), 'data: one\n\ndata: two\n\n', 'the stream was mangled');
  assert.ok(
    stamps.length >= 2 && stamps[1] - stamps[0] > 150,
    `the first event waited for the second (${JSON.stringify(stamps)})`,
  );
});

test('/bus upgrades are tunnelled with the cookie, refused without it', async (t) => {
  const { proxy, stack } = await door(t);

  const denied = await rawSocket(proxy);
  denied.send('GET /bus HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
  assert.match(await denied.until((all) => all.includes('\r\n\r\n')), /^HTTP\/1\.1 401/);
  denied.socket.destroy();
  assert.deepEqual(stack.seen, [], 'an unauthenticated upgrade reached the stack');

  const allowed = await rawSocket(proxy);
  allowed.send(
    'GET /bus HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
      'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n' +
      `cookie: ${COOKIE}\r\n\r\n`,
  );
  assert.match(await allowed.until((all) => all.includes('\r\n\r\n')), /^HTTP\/1\.1 101/);
  allowed.send('ping');
  assert.match(await allowed.until((all) => all.includes('ping')), /\r\n\r\nping$/);
  allowed.socket.destroy();

  assert.equal(stack.seen.length, 1, 'the upgrade was not forwarded exactly once');
  assert.equal(stack.seen[0].headers.cookie, undefined, 'the cookie was forwarded upstream');
});

test('the upstream is fixed: an absolute request line is refused', async (t) => {
  const { proxy, stack } = await door(t);

  const answer = await rawSocket(proxy);
  answer.send(`GET http://example.com/ HTTP/1.1\r\nhost: example.com\r\ncookie: ${COOKIE}\r\n\r\n`);
  assert.match(await answer.until((all) => all.includes('\r\n\r\n')), /^HTTP\/1\.1 400/);
  answer.socket.destroy();
  assert.deepEqual(stack.seen, [], 'an absolute-form request was proxied somewhere');
});

// The wiring, not the code: serve.ts is what decides whether the door exists, and with no token it
// must not print a line, open a port, or otherwise change the loopback output it always had.
test('the entry opens the door only when NODE_AGENT_ACCESS_TOKEN is set', async (t) => {
  const closed = start({ NODE_AGENT_HOME: join(stateDir(t), 'closed') });
  t.after(() => closed.child.kill('SIGKILL'));
  const page = (await line(closed, 'webui: ')).slice('webui: '.length);
  assert.equal((await fetch(page)).status, 200);
  await delay(300);
  assert.deepEqual(
    closed.lines.filter((one) => one.startsWith('proxy: ')),
    [],
    'a door was opened without NODE_AGENT_ACCESS_TOKEN',
  );

  const opened = start({
    NODE_AGENT_HOME: join(stateDir(t), 'opened'),
    NODE_AGENT_ACCESS_TOKEN: 'entry-access-token',
    NODE_AGENT_PROXY_PORT: '0',
  });
  t.after(() => opened.child.kill('SIGKILL'));
  const door = (await line(opened, 'proxy: ')).slice('proxy: '.length);

  // The page behind the door is the stack's page: closed until the login, open after it.
  const before = await fetch(door, { redirect: 'manual' });
  assert.equal(before.status, 303);
  assert.equal(before.headers.get('location'), '/login');
  await text(before);

  const login = await fetch(`${door}/login`, {
    method: 'POST',
    body: new URLSearchParams({ token: 'entry-access-token' }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const cookie = setCookie(login);
  const after = await fetch(door, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(after.status, 200);
  assert.match(await text(after), /<html/i);
});
