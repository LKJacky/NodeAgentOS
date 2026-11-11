// One same-origin, authenticated tenant per named SharedWorker; ports are top-level tab brokers.
// Cookies (including HttpOnly) are sent by EventSource/fetch, never read or passed through a port.
// /events pins the public tenant key so a cookie change cannot reconnect this worker as another user.
'use strict';
const tenant = new URL(self.location.href).searchParams.get('tenant');
const client = crypto.randomUUID();
const tabs = new Map();
const SAFE = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
const LEASE_MS = 180000;
let source, reconnect, stable, retry, connected = false, syncing = false;
let revision = 0, epoch = 0, reconnectDelay = 1000, updateDelay = 1000;
function send(tab, data) { try { tab.port.postMessage(data); } catch { remove(tab); } }
function broadcast(data) { for (const tab of tabs.values()) send(tab, data); }
function union(replacement, feeds) {
  return [...new Set(['bus:nodes', ...[...tabs.values()].flatMap((tab) => tab === replacement ? feeds : tab.feeds)])].sort();
}
function stop() {
  connected = false; epoch++;
  clearTimeout(reconnect); clearTimeout(stable); clearTimeout(retry);
  reconnect = retry = undefined;
  source?.close(); source = undefined;
}
function disconnect() {
  stop();
  broadcast({ type: 'error' });
  if (tabs.size) {
    reconnect = setTimeout(open, reconnectDelay + Math.random() * reconnectDelay * 0.2);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  }
}
function open() {
  reconnect = undefined;
  if (!tabs.size || source) return;
  const query = new URLSearchParams({ feed: 'bus:nodes', client, tenant });
  const owned = new EventSource(`/events?${query}`, { withCredentials: true });
  source = owned;
  source.onopen = () => {
    if (source !== owned) return;
    connected = true; epoch++;
    stable = setTimeout(() => { reconnectDelay = 1000; }, 10000);
    // Each broker confirms its logical subscriptions (ACK below) before sending open to panels.
    broadcast({ type: 'open' });
    changed();
  };
  source.onerror = () => { if (source === owned) disconnect(); };
  source.onmessage = (event) => {
    if (source !== owned) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    const feed = `${frame.node}:${frame.topic}`;
    for (const tab of tabs.values()) if (tab.feeds.includes(feed)) send(tab, { type: 'message', data: event.data });
  };
}
function changed() { revision++; clearTimeout(retry); retry = undefined; void sync(); }
async function sync() {
  if (!connected || syncing || !tabs.size) return;
  syncing = true;
  const version = revision, generation = epoch;
  try {
    const response = await fetch('/events/subscriptions', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client, tenant, feeds: union() }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) disconnect();
      throw new Error('subscription failed');
    }
    if (connected && generation === epoch) for (const tab of tabs.values()) {
      const confirmed = tab.waiting.filter((request) => request.version <= version);
      tab.waiting = tab.waiting.filter((request) => request.version > version);
      for (const request of confirmed) send(tab, { type: 'ack', id: request.id, ok: true });
    }
    updateDelay = 1000;
  } catch {
    if (connected) {
      retry = setTimeout(() => { retry = undefined; void sync(); }, updateDelay + Math.random() * updateDelay * 0.2);
      updateDelay = Math.min(30000, updateDelay * 2);
    }
  } finally {
    syncing = false;
    if (connected && version !== revision && retry === undefined) void sync();
  }
}
function remove(tab) {
  clearTimeout(tab.authRetry);
  if (!tabs.delete(tab.port)) return;
  // A frozen tab may have a logical update awaiting ACK. Reject it before releasing its
  // lease so a resumed broker is not stuck awaiting an ACK from a removed port forever.
  if (!tab.closed) for (const request of tab.waiting) {
    try { tab.port.postMessage({ type: 'ack', id: request.id, ok: false, error: 'tab lease expired' }); } catch {}
  }
  tab.waiting = [];
  if (!tabs.size) stop(); else changed();
}
self.onconnect = ({ ports: [port] }) => {
  const tab = { port, feeds: [], waiting: [], lastSeen: Date.now(), closed: false, authorized: false };
  function join() {
    if (tabs.has(port)) return;
    tabs.set(port, tab);
    if (connected) { send(tab, { type: 'open' }); changed(); }
    else if (!source && reconnect === undefined) open();
  }
  port.onmessage = ({ data }) => {
    if (tab.closed) return;
    tab.lastSeen = Date.now();
    if (data?.type === 'close') { tab.closed = true; remove(tab); port.close(); return; }
    if (!tab.authorized) return;
    join(); // A suspended tab whose lease expired can rejoin without a second physical SSE.
    if (data?.type === 'ping') return;
    if (data?.type !== 'update' || !Number.isSafeInteger(data.id)) return;
    const feeds = data.feeds;
    if (!Array.isArray(feeds) || !feeds.length || feeds.length > 128 || feeds.some((feed) => {
      if (typeof feed !== 'string') return true;
      const pair = feed.split(':');
      return pair.length !== 2 || !pair.every((part) => SAFE.test(part));
    }) || union(tab, feeds).length > 128 || tab.waiting.length >= 128) {
      send(tab, { type: 'ack', id: data.id, ok: false, error: 'invalid or excessive event feeds' });
      return;
    }
    tab.feeds = [...new Set(feeds)];
    tab.waiting.push({ id: data.id, version: revision + 1 });
    changed();
  };
  port.onmessageerror = () => remove(tab);
  port.start();
  send(tab, { type: 'ready' });
  // A new port must authenticate with the *current* cookie too. Knowing an old worker name
  // must not let a newly logged-in tenant attach to its still-open authenticated SSE.
  let authDelay = 1000;
  function authenticate() {
    tab.authRetry = undefined;
    if (tab.closed || Date.now() - tab.lastSeen > LEASE_MS) return;
    void fetch(`/events/identity?tenant=${encodeURIComponent(tenant)}`, {
      credentials: 'same-origin', signal: AbortSignal.timeout(10000),
    }).then(async (response) => {
      if (!response.ok || (await response.json()).tenant !== tenant) throw new Error('tenant changed');
      if (tab.closed) return;
      tab.authorized = true;
      join();
    }).catch(() => {
      if (tab.closed) return;
      send(tab, { type: 'error', error: 'tenant authentication failed' });
      tab.authRetry = setTimeout(authenticate, authDelay + Math.random() * authDelay * 0.2);
      authDelay = Math.min(30000, authDelay * 2);
    });
  }
  authenticate();
};
// MessagePort has no reliable disconnect event after a tab crash. Normal pagehide explicitly closes;
// a generous lease handles crashes, and a resumed/background tab can rejoin on its next ping.
setInterval(() => {
  const now = Date.now();
  for (const tab of tabs.values()) if (now - tab.lastSeen > LEASE_MS) remove(tab);
}, 30000);
