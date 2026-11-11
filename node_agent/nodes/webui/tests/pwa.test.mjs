// The installable half of the shell: a manifest a phone can read, a worker that keeps the shell and
// nothing else, and the page that registers it. Three of these four files are read from dist/ on
// purpose — `npm run build` copies them next to the compiled webui, and a build that did not run would
// hand the browser yesterday's shell while src/ looked perfectly fine.
//
// The worker is the one piece here that is not TypeScript and has no test runner of its own: it is run
// the way a browser runs it, as a script whose only world is `self`, and asked the one question that
// matters — which paths it is willing to answer for. Everything a page uses to talk to the bus has to
// come back "not mine", because a cached answer to a call is a lie about the nodes.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WebuiNode } from '../src/index.ts';

//: The repository root, three levels up from webui/tests/.
const ROOT = new URL('../../../', import.meta.url);

/** The static shell by name, from the place the build copies it to: the bytes the browser is handed. */
const served = (name) => new URL(`webui/dist/${name}`, ROOT);

/** The same file where it is written, which is what the build copies from. */
const source = (name) => new URL(`webui/src/${name}`, ROOT);

//: dist/ is git-ignored and only exists after a build; every test here skips rather than fails without
//: it, so nobody mistakes "not built" for "wrong".
const built = (t) => {
  if (existsSync(served('webui.html'))) return true;
  t.skip('dist/ is only there after `npm run build`');
  return false;
};

/** Enough of a ServerResponse for the webui's own `send`. */
function answer() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      return this;
    },
    end(body = '') {
      this.body = body;
      return this;
    },
  };
}

/** One request through the real router. No bus is joined and none is needed: these four paths are
 *  static content and are answered before anything could reach the bus. */
async function get(url, method = 'GET') {
  const webui = new WebuiNode();
  const res = answer();
  await webui.onRequest({ method, url }, res);
  return res;
}

/** The worker, loaded the way a browser loads it: a script that knows `self` and the cache store, run
 *  here inside a function so this file can reach into it. The bytes are the file in dist/ — the same
 *  ones a browser is given. */
function loadWorker(options = {}) {
  const handlers = {};
  const deleted = [];
  const fetched = [];
  const keys = options.keys ?? [];
  const cached = new Map(options.cached ?? []);

  const cache = {
    addAll: async (paths) => {
      for (const path of paths) {
        fetched.push(path);
        cached.set(path, `cached:${path}`);
      }
    },
    match: async (key) => cached.get(key),
    put: async (key, value) => cached.set(key, value),
  };

  const scope = {
    addEventListener: (type, handler) => {
      handlers[type] = handler;
    },
    location: { origin: 'http://127.0.0.1:8790' },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  const store = {
    open: async () => cache,
    keys: async () => [...keys],
    delete: async (name) => {
      deleted.push(name);
      return true;
    },
  };

  const script = readFileSync(served('sw.js'), 'utf8');
  const factory = new Function(
    'self',
    'caches',
    'fetch',
    'Response',
    `${script}\nreturn { isShell, VERSION, CACHE, PREFIX, SHELL };`,
  );

  return { ...factory(scope, store, options.fetch, Response), handlers, deleted, fetched, cached };
}

/** A request as the handler sees one: two fields, and nothing else it may rely on. */
const request = (url, method = 'GET') => ({ url: `http://127.0.0.1:8790${url}`, method });

/** Dispatch through the worker's fetch handler; returns what it answered with, if it answered. */
function dispatch(worker, url, method = 'GET') {
  let responded;
  worker.handlers.fetch({
    request: request(url, method),
    respondWith: (promise) => {
      responded = promise;
    },
  });
  return responded;
}

test('test_the_manifest_is_a_manifest_and_valid_json', async (t) => {
  if (!built(t)) return;

  // Fetched through the real router, exactly as a browser asks for it, and parsed as the browser would.
  const res = await get('/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/manifest\+json/);
  assert.equal(res.headers['cache-control'], 'no-cache', 'a redeployed shell is not a stale manifest');

  const manifest = JSON.parse(res.body);
  assert.equal(manifest.name, 'node_agent');
  assert.equal(manifest.short_name, 'node_agent', 'the name under the tile has to be short');
  assert.equal(manifest.start_url, '/', 'the app opens the shell');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone', 'no browser chrome once it is installed');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);

  // Every icon has to be a file this node serves. The scalable drawing is the one that lives in the
  // package, so it is fetched and compared byte for byte; the two PNGs the manifest also names are drawn
  // by the build from that same drawing (a machine may have no rasterizer at all), and icons.test.mjs is
  // where those are checked.
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'the tile needs a picture');
  const shapes = manifest.icons.filter((icon) => icon.type === 'image/svg+xml');
  assert.equal(shapes.length, 2, 'the drawing, declared for both purposes');
  for (const icon of shapes) {
    assert.equal(icon.src, '/icon.svg');
    assert.equal(icon.sizes, 'any', 'one scalable drawing, so no size can go missing');
    assert.ok(['any', 'maskable'].includes(icon.purpose));
    const picture = await get(icon.src);
    assert.equal(picture.status, 200, `${icon.src} has to be served`);
    assert.match(picture.headers['content-type'], /^image\/svg\+xml/);
    assert.equal(picture.body, readFileSync(source('icon.svg'), 'utf8'));
  }
  assert.ok(
    manifest.icons.some((icon) => icon.purpose === 'maskable'),
    'a platform that crops the tile to its own shape needs the padded drawing',
  );
});

test('test_the_page_registers_the_worker_and_names_the_manifest', async (t) => {
  if (!built(t)) return;

  const page = readFileSync(served('webui.html'), 'utf8');
  assert.match(page, /<link rel="manifest" href="\/manifest.webmanifest" \/>/);
  // Registration is an addition: a browser without a worker, or one that refuses this page (a private
  // window, plain http on a phone), has to keep working, so it is guarded and its failure is dropped.
  assert.match(page, /if \('serviceWorker' in navigator\) \{/);
  assert.match(page, /navigator\.serviceWorker\.register\('\/sw\.js'\)\.catch\(\(\) => \{/);

  // The worker it registers is served as JavaScript, or the browser refuses it before running it.
  const worker = await get('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers['content-type'], /^text\/javascript/);
  assert.match(worker.body, /self\.addEventListener\('fetch'/);
});

test('test_the_worker_answers_the_shell_and_refuses_the_bus', async (t) => {
  if (!built(t)) return;
  const worker = loadWorker();

  // What a page does with the bus. None of it is the worker's business: no answer at all means the
  // browser fetches it exactly as if there were no worker, which is the strongest form of "not cached".
  const bus = [
    ['/call', 'POST'],
    ['/call', 'GET'],
    ['/events?topic=nodes', 'GET'],
    ['/events?topic=mindmap.view', 'GET'],
    ['/panels', 'GET'],
    ['/panel/agent', 'GET'],
    ['/login', 'GET'],
  ];
  for (const [url, method] of bus) {
    assert.equal(worker.isShell(request(url, method)), false, `${method} ${url} is not the shell`);
    assert.equal(dispatch(worker, url, method), undefined, `${method} ${url} must reach the network untouched`);
  }

  // …and the shell is answered, from the list the worker carries and nowhere else.
  for (const path of worker.SHELL) {
    assert.equal(worker.isShell(request(path)), true, `${path} is the shell`);
    assert.ok(dispatch(worker, path), `${path} is answered by the worker`);
  }
  // `/index.html` is the same document as `/`, and one cache entry is enough for both.
  assert.equal(worker.isShell(request('/index.html')), true);

  // Another origin is never ours, whatever the path says.
  assert.equal(worker.isShell({ url: 'http://elsewhere.test/', method: 'GET' }), false);
});

test('test_the_worker_keeps_the_shell_for_when_nothing_answers', async (t) => {
  if (!built(t)) return;

  // Install: the whole shell is fetched up front, so an app installed and then opened with no network
  // has something to show.
  const worker = loadWorker();
  const waiting = [];
  worker.handlers.install({ waitUntil: (promise) => waiting.push(promise) });
  await Promise.all(waiting);
  assert.deepEqual(worker.fetched, worker.SHELL, 'install fetches exactly the shell, once each');

  // A version is in the cache name, so a new worker can tell its own cache from an old one.
  assert.ok(worker.CACHE.includes(worker.VERSION), 'the cache name carries the version');
  assert.ok(worker.CACHE.startsWith(worker.PREFIX));

  // Fetch with no network at all (here: no fetch to call): the cached shell is the answer, and the
  // query on a live URL does not miss it.
  const offline = loadWorker({ cached: [['/', 'the shell as it was kept']] });
  assert.equal(await dispatch(offline, '/'), 'the shell as it was kept');
  assert.equal(await dispatch(offline, '/index.html'), 'the shell as it was kept');
  assert.equal(await dispatch(offline, '/?from=home-screen'), 'the shell as it was kept');

  // Nothing cached and nothing to fetch: a sentence, not a hang and not an empty answer.
  const empty = loadWorker();
  const nothing = await dispatch(empty, '/');
  assert.equal(nothing.status, 503);
  assert.match(await nothing.text(), /offline/);
});

test('test_a_new_version_clears_the_cache_it_replaces', async (t) => {
  if (!built(t)) return;

  const keys = [];
  const worker = loadWorker({ keys });
  const old = `${worker.PREFIX}0`;
  keys.push(worker.CACHE, old, 'another-app-shell-1');

  const waiting = [];
  worker.handlers.activate({ waitUntil: (promise) => waiting.push(promise) });
  await Promise.all(waiting);

  // Its own cache stays, an older one of OURS goes, and a cache this worker did not make is left alone:
  // the same origin may serve other things (the multi-user `serve` puts its own pages there).
  assert.deepEqual(worker.deleted, [old]);
});

test('test_the_shell_in_dist_is_the_shell_in_src', (t) => {
  if (!built(t)) return;

  // Four files the running node reads from beside its compiled self: the page, the manifest, the Tile's
  // drawing and the worker. A build that did not copy one of them would serve the old one (or none).
  for (const name of ['webui.html', 'manifest.webmanifest', 'icon.svg', 'sw.js']) {
    assert.equal(
      readFileSync(served(name), 'utf8'),
      readFileSync(source(name), 'utf8'),
      `run \`npm run build\`: dist/${name} is copied from src/, not compiled`,
    );
  }
});

test('test_the_shell_keeps_a_phone_s_edges_and_says_how_to_install_it', (t) => {
  const html = readFileSync(source('webui.html'), 'utf8');

  // Every edge the hardware takes: the home indicator at the bottom, the status bar on top, and the
  // notch on either side when the phone is turned.
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    assert.match(html, new RegExp(`env\\(safe-area-inset-${edge}\\)`), `the ${edge} inset is respected`);
  }

  // iOS has no beforeinstallprompt, so the install story there is one line the reader can close — and
  // the line is only shown where it applies (iOS, not already installed), never as permanent furniture.
  assert.match(html, /Install on the home screen: Share → Add to Home Screen\./);
  assert.match(html, /<div class="bar" id="install" hidden>/);
  assert.match(html, /const INSTALL = 'node_agent\.installed'/);
  assert.match(html, /if \(!apple \|\| installed\) return;/);

  // And the offline answer: one sentence and a retry, shown when /panels cannot be reached. The words
  // are a resource key with the English written on them (see src/i18n), so the marker sits between the
  // id and the text and the sentence still reads as it always did.
  assert.match(html, /<div class="bar" id="offline" hidden>/);
  assert.match(html, /<button id="retry" type="button" data-text-key="chrome\.retry">Retry<\/button>/);
  assert.match(html, /retry\.addEventListener\('click', \(\) => void load\(\)\)/);
});
