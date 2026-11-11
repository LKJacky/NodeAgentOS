// One shell, one physical EventSource. Subscriptions change over POST without reopening SSE;
// this keeps existing feeds live while a new panel or sub-agent joins. Top-level shells delegate
// physical transport to a tenant-scoped SharedWorker when available, or keep a per-tab fallback.
(() => {
  'use strict';
  // The same file can be loaded by a standalone panel. Inside the shell's iframe,
  // keep ownership in the parent instead of starting a second broker.
  try { if (parent !== window && parent.location.origin === location.origin && parent.NodeAgentEventBroker) return; }
  catch { /* Unrelated/off-origin embeddings use a standalone stream. */ }
  const KIND = 'node-agent:events';
  const subscribers = new Map();
  let panels = new Set();
  let connected = false, revision = 0, epoch = 0, syncing = false, retry, delay = 1000;
  const frames = ['pinned-view', 'view', 'onboarding-frame'].map((id) => document.getElementById(id)).filter(Boolean);
  let stream = window.NodeAgentEvents.transport();
  function send(sub, op, data) {
    if (sub.source) sub.source.postMessage({ kind: KIND, id: sub.id, documentId: sub.documentId, op, data }, location.origin);
    else if (op === 'message') sub.handle.onmessage?.({ data });
    else if (op === 'open') sub.handle.onopen?.({ type: 'open' });
    else if (op === 'error') sub.handle.onerror?.({ type: 'error' });
  }
  function changed() { revision++; clearTimeout(retry); retry = undefined; void sync(); }
  async function sync() {
    if (!connected || syncing) return;
    syncing = true;
    const version = revision;
    const generation = epoch;
    const current = [...subscribers.values()];
    const feeds = [...new Set(['bus:nodes', ...current.flatMap((s) => s.feeds)])].sort();
    try {
      await stream.update(feeds);
      if (connected && generation === epoch) for (const sub of current) {
        if (!sub.opened && subscribers.get(sub.id) === sub) {
          sub.opened = true;
          send(sub, 'open');
        }
      }
      delay = 1000;
    } catch {
      if (connected) {
        retry = setTimeout(() => { retry = undefined; void sync(); }, delay + Math.random() * delay * 0.2);
        delay = Math.min(30000, delay * 2);
      }
    } finally {
      syncing = false;
      if (connected && version !== revision && retry === undefined) void sync();
    }
  }
  function bindStream() {
    stream.onopen = () => {
      epoch++;
      connected = true;
      for (const sub of subscribers.values()) sub.opened = false;
      changed();
    };
    stream.onerror = () => {
      epoch++;
      connected = false;
      clearTimeout(retry); retry = undefined;
      for (const sub of subscribers.values()) { sub.opened = false; send(sub, 'error'); }
    };
    stream.onmessage = (event) => {
      let envelope;
      try { envelope = JSON.parse(event.data); } catch { return; }
      const feed = `${envelope.node}:${envelope.topic}`;
      for (const sub of subscribers.values()) if (sub.feeds.includes(feed)) send(sub, 'message', event.data);
    };
  }
  bindStream();
  function frameOf(source) { return frames.find((frame) => frame.contentWindow === source); }
  function nodeOf(frame) {
    try {
      const url = new URL(frame.src, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/panel/')) return null;
      const node = decodeURIComponent(url.pathname.slice(7));
      return panels.has(node) ? node : null;
    } catch { return null; }
  }
  function prune() {
    let dirty = false;
    for (const [id, sub] of subscribers) if (sub.source) {
      const frame = frameOf(sub.source);
      let valid = false;
      try { valid = !!frame && nodeOf(frame) !== null && sub.source.NodeAgentEvents?.documentId === sub.documentId; }
      catch { /* A page that navigated off-origin is no longer a trusted panel. */ }
      if (!valid) { subscribers.delete(id); dirty = true; }
    }
    if (dirty) changed();
  }
  for (const frame of frames) frame.addEventListener('load', prune);
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.origin !== location.origin || data?.kind !== KIND || typeof data.id !== 'string' || typeof data.documentId !== 'string') return;
    const frame = frameOf(event.source);
    if (!frame) return;
    if (data.op === 'close') {
      const sub = subscribers.get(data.id);
      if (sub?.source === event.source && sub.documentId === data.documentId) { subscribers.delete(data.id); changed(); }
      return;
    }
    const node = nodeOf(frame);
    if (data.op !== 'subscribe' || node === null) return;
    let feeds;
    try {
      if (event.source.NodeAgentEvents?.documentId !== data.documentId || !Array.isArray(data.feeds)) return;
      const query = new URLSearchParams();
      for (const feed of data.feeds) query.append('feed', feed);
      feeds = window.NodeAgentEvents.pairs(`/events?${query}`);
      // SDK i18n historically watches this one system feed in every page. Nothing else
      // lets a panel subscribe to a different publishing node.
      if (feeds.some((feed) => feed.split(':')[0] !== node && feed !== 'system:language')) return;
      // Keep total subscriptions bounded just like the server protocol.
      const union = new Set(['bus:nodes', ...feeds, ...[...subscribers.values()].flatMap((sub) => sub.feeds)]);
      if (union.size > 128) return;
    } catch { return; }
    prune();
    subscribers.set(data.id, { id: data.id, source: event.source, documentId: data.documentId, feeds, opened: false });
    changed();
  });
  function connect(url) {
    const id = crypto.randomUUID();
    const handle = { onopen: null, onmessage: null, onerror: null, close() { subscribers.delete(id); changed(); } };
    subscribers.set(id, { id, handle, feeds: window.NodeAgentEvents.pairs(url), opened: false });
    changed();
    return handle;
  }
  window.addEventListener('pagehide', () => { connected = false; epoch++; clearTimeout(retry); stream.close(); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    stream = window.NodeAgentEvents.transport();
    bindStream();
  });
  window.NodeAgentEventBroker = { connect, setPanels(rows) { panels = new Set(rows.map((row) => row.node)); prune(); } };
})();
