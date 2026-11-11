// Where the browser is, and the one way the tests talk to it — shared rather than copied, because a
// second copy of this is a second place to get "the browser exited before it listened" wrong.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The browser this machine has, or null. A missing one skips the test by name, so nobody mistakes a
 *  skip for a pass: `CHROME` wins, then the usual binaries, then Playwright's cache — the one this
 *  repository's dev container keeps. */
export function chromePath() {
  const named = [
    process.env.CHROME,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const path of named) if (path && existsSync(path)) return path;

  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache))
    for (const dir of ['chrome-linux64', 'chrome-linux']) {
      const path = join(cache, entry, dir, 'chrome');
      if (existsSync(path)) return path;
    }
  return null;
}

/** Chrome on the debugging protocol: the browser's own port is asked for (0), so two runs never
 *  collide, and it is read back off the line Chrome prints. */
export async function startChrome(path) {
  const chrome = spawn(
    path,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      '--user-data-dir=' + join(process.env.TMPDIR ?? '/tmp', `sides-${process.pid}`),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const endpoint = await new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(
      () => reject(new Error(`chrome printed no debugging port: ${seen.slice(-400)}`)),
      20000,
    );
    chrome.stderr.setEncoding('utf8');
    chrome.stderr.on('data', (chunk) => {
      seen += chunk;
      const match = /DevTools listening on ws:\/\/([^/]+)\//.exec(seen);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    chrome.once('error', reject);
    chrome.once('exit', (code) => reject(new Error(`chrome exited (${code}) before it listened`)));
  });

  const list = await (await fetch(`http://${endpoint}/json/list`)).json();
  const page = list.find((target) => target.type === 'page');
  if (!page) throw new Error('chrome has no page target to measure');
  return { chrome, page };
}

/** One talkative socket to the page: `send` resolves with the reply carrying that id. */
export async function openPage(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    settle(message);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const request = ++id;
      pending.set(request, resolve);
      socket.send(JSON.stringify({ id: request, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  return { send, close: () => socket.close() };
}

/** Static broker scripts and subscription acknowledgement for the DOM-only stub servers. */
export function serveEventAssets(req, res) {
  const url = req.url ?? '/';
  if (url === '/webui/events-client.js' || url === '/webui/events-broker.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(new URL('../src/' + url.slice('/webui/'.length), import.meta.url), 'utf8'));
    return true;
  }
  if (url === '/events/subscriptions') {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return true;
  }
  return false;
}
