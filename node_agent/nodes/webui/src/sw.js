// The service worker: the shell on a home screen, and the shell when nothing answers.
//
// It may touch ONE list of paths — SHELL below — and nothing else. `/call`, `/events`, `/panels` and
// `/panel/<node>` are how a page talks to the bus, and they are never answered here: `isShell()` says
// no and the request goes to the network exactly as it would with no worker at all. That is
// deliberate, not an omission. A cached answer to a call is a lie about the state of the nodes; a
// cached event stream is not a stream, it is one moment that never ends; a cached `/panels` shows
// tabs for nodes that have left. Answering nothing is stronger than answering carefully, so the
// worker does not even look at them — offline they fail the way the page already knows how to show.
//
// What is cached is the static shell: the page itself (one file, styles and scripts inline), the
// drawings its tile is made of (the vector, and the two PNGs the build draws from it), and the
// manifest. Network first — a redeployed shell is never stale —
// and the cached copy answers only when the network does not. The cache name carries VERSION, so a
// worker that replaces this one deletes the shell it left behind instead of piling up copies; bump it
// when the SHELL list changes (the shell's own bytes do not need it: every online load refreshes the
// cached copy).
const VERSION = '2';

/** Every cache this worker has ever made starts with this, and only those are ever deleted. */
const PREFIX = 'node-agent-webui-';

/** The cache this version writes to: the version is in the name, which is what retires the old one. */
const CACHE = `${PREFIX}${VERSION}`;

/** The static shell, by path. Exactly these, and nothing else, is what this worker will answer.
 *  `/index.html` is the same document as `/` (the webui serves both), so it is folded in by `pathOf`
 *  rather than written twice — one cache entry per document, and no second copy to go stale.
 *
 *  The two PNGs are the tiles the manifest names: `npm run build` draws them from `icon.svg` with a
 *  rasterizer the machine may not have. An `install` that cannot fetch one of them is the failure
 *  described just below — the worker does not take over a page that works — and not a half-cached
 *  shell nobody notices. */
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

/** The cache key of a shell path. */
const pathOf = (url) => (url.pathname === '/index.html' ? '/' : url.pathname);

/** Whether this request is one of the shell's own. A method other than GET is never the shell, another
 *  origin is never ours, and a path outside the list is never ours either — so everything a page uses
 *  to reach the bus falls straight through to the network. */
function isShell(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return SHELL.includes(pathOf(url));
}

// Install: fetch the whole shell now, not on first use — an app installed and then opened with no
// network would otherwise have nothing to show. `addAll` rejects the install when any of them is
// missing, so a worker that cannot cache the shell never takes over a page that works.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

// Activate: delete the caches earlier versions left behind — ours only, by prefix: this origin may
// serve other things (the multi-user `serve` puts its own pages on the same origin), and a worker has
// no business deleting a cache it did not create. `clients.claim()` so the page that triggered this
// update is answered by it without a reload.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) => name !== CACHE && name.startsWith(PREFIX),
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch: answer the shell, and nothing else. A request that is not the shell is not passed through a
// handler at all — no `respondWith` means the browser fetches it exactly as if this worker did not exist.
self.addEventListener('fetch', (event) => {
  if (!isShell(event.request)) return;
  event.respondWith(shell(event.request));
});

/** The shell, network first: the page that is deployed now is the page that is shown, and the copy in
 *  the cache is only ever the answer to "the network is not there". A real answer is also the freshest
 *  copy, so it is put back — that is what keeps the offline page from being the first one ever seen. */
async function shell(request) {
  const key = pathOf(new URL(request.url));
  const cache = await caches.open(CACHE);

  try {
    const answer = await fetch(request);
    if (answer.ok) await cache.put(key, answer.clone());
    return answer;
  } catch (error) {
    // No network (or the webui is not up yet): the cached shell is the answer.
  }

  const kept = await cache.match(key);
  if (kept) return kept;

  // Nothing cached and nothing to fetch. A plain sentence, because there is no page left to draw one.
  return new Response('offline: the node_agent shell is not available\n', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
