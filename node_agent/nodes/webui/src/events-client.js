// EventSource-shaped handles. Embedded pages never own a physical stream: the shell routes it.
// Top-level pages prefer a tenant-scoped SharedWorker; unsupported browsers keep one stream per tab.
(() => {
  'use strict';
  const KIND = 'node-agent:events';
  const documentId = crypto.randomUUID();
  const handles = new Map();
  const safe = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
  function pairs(url) {
    const query = new URL(url, location.href).searchParams;
    const feeds = query.getAll('feed');
    const topics = query.getAll('topic');
    const node = query.get('node') || topics[0];
    for (const topic of topics) feeds.push(`${node}:${topic}`);
    const unique = [...new Set(feeds)];
    if (!unique.length || unique.length > 128 || unique.some((feed) => {
      const parts = feed.split(':');
      return parts.length !== 2 || !parts.every((part) => safe.test(part));
    })) throw new Error('invalid event feeds');
    return unique;
  }
  function physical(url) {
    const handle = { onopen: null, onmessage: null, onerror: null, close };
    let source, timer, stable, stopped = false, delay = 1000;
    function open() {
      if (stopped) return;
      const owned = new EventSource(url);
      source = owned;
      source.onmessage = (event) => handle.onmessage?.(event);
      source.onopen = (event) => {
        if (stopped || source !== owned) return;
        // Flapping streams must back off too; reset only after a stable connection.
        stable = setTimeout(() => { delay = 1000; }, 10000);
        handle.onopen?.(event);
      };
      source.onerror = (event) => {
        if (stopped || source !== owned) return;
        clearTimeout(stable);
        source.close();
        handle.onerror?.(event);
        if (!stopped) {
          timer = setTimeout(open, delay + Math.random() * delay * 0.2);
          delay = Math.min(30000, delay * 2);
        }
      };
    }
    function close() { stopped = true; clearTimeout(timer); clearTimeout(stable); source?.close(); }
    open();
    return handle;
  }
  function localTransport(tenant) {
    const client = crypto.randomUUID();
    const query = new URLSearchParams({ feed: 'bus:nodes', client });
    if (tenant) query.set('tenant', tenant);
    const handle = physical(`/events?${query}`);
    handle.update = async (feeds) => {
      const response = await fetch('/events/subscriptions', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client, tenant: tenant || undefined, feeds }),
      });
      if (!response.ok) throw new Error('subscription failed');
    };
    return handle;
  }
  function sharedTransport(tenant) {
    let worker, port, local, startup, ping, stopped = false, ready = false, seq = 0;
    const pending = new Map();
    const handle = { onopen: null, onmessage: null, onerror: null, update, close };
    function release() {
      clearTimeout(startup); clearInterval(ping);
      try { port?.postMessage({ type: 'close' }); port?.close(); } catch { /* Worker unavailable. */ }
    }
    function fallback() {
      if (local || stopped) return;
      release();
      for (const promise of pending.values()) promise.reject(new Error('worker unavailable'));
      pending.clear();
      handle.onerror?.({ type: 'error' });
      local = localTransport(tenant);
      local.onopen = (event) => handle.onopen?.(event);
      local.onmessage = (event) => handle.onmessage?.(event);
      local.onerror = (event) => handle.onerror?.(event);
    }
    function update(feeds) {
      if (stopped) return Promise.reject(new Error('event transport closed'));
      if (local) return local.update(feeds);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ type: 'update', id, feeds });
      });
    }
    function close() {
      stopped = true; release(); local?.close();
      for (const promise of pending.values()) promise.reject(new Error('event transport closed'));
      pending.clear();
    }
    try {
      worker = new SharedWorker(`/webui/events-shared-worker.js?tenant=${encodeURIComponent(tenant)}`, {
        name: `node-agent-events-v1:${tenant}`, credentials: 'same-origin',
      });
      port = worker.port;
      port.onmessage = ({ data }) => {
        if (stopped || local) return;
        if (data.type === 'ready') { ready = true; clearTimeout(startup); }
        if (data.type === 'open') handle.onopen?.({ type: 'open' });
        if (data.type === 'error') handle.onerror?.({ type: 'error' });
        if (data.type === 'message' && typeof data.data === 'string') handle.onmessage?.({ data: data.data });
        if (data.type === 'ack') {
          const promise = pending.get(data.id);
          if (!promise) return;
          pending.delete(data.id);
          if (data.ok) promise.resolve(); else promise.reject(new Error(data.error || 'subscription failed'));
        }
      };
      worker.onerror = fallback;
      port.start();
      // A successful script handshake disables startup fallback: an auth/network failure must
      // reconnect in the worker, not create one extra physical SSE in every tab.
      startup = setTimeout(() => { if (!ready) fallback(); }, 5000);
      ping = setInterval(() => port.postMessage({ type: 'ping' }), 15000);
    } catch { fallback(); }
    return handle;
  }
  function transport() {
    const tenant = document.querySelector?.('meta[name="node-agent-event-tenant"]')?.content;
    return typeof SharedWorker === 'function' && tenant ? sharedTransport(tenant) : localTransport(tenant);
  }
  function embedded() {
    try { return parent !== window && parent.location.origin === location.origin && !!parent.NodeAgentEventBroker; }
    catch { return false; }
  }
  function connect(url) {
    if (window.NodeAgentEventBroker) return window.NodeAgentEventBroker.connect(url);
    if (!embedded()) return physical(url);
    const id = crypto.randomUUID();
    const handle = { onopen: null, onmessage: null, onerror: null, close() {
      if (!handles.delete(id)) return;
      parent.postMessage({ kind: KIND, op: 'close', id, documentId }, location.origin);
    } };
    handle.feeds = pairs(url);
    handles.set(id, handle);
    parent.postMessage({ kind: KIND, op: 'subscribe', id, documentId, feeds: handle.feeds }, location.origin);
    return handle;
  }
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.kind !== KIND) return;
    const { id, op, data, documentId: doc } = event.data;
    if (doc !== documentId) return;
    const handle = handles.get(id);
    if (!handle) return;
    if (op === 'message' && typeof data === 'string') handle.onmessage?.({ data });
    if (op === 'open') handle.onopen?.({ type: 'open' });
    if (op === 'error') handle.onerror?.({ type: 'error' });
  });
  // pagehide also fires on iframe replacement, so its old subscriptions don't survive navigation.
  window.addEventListener('pagehide', (event) => {
    for (const [id, handle] of handles) {
      if (!event.persisted) handle.close();
      else parent.postMessage({ kind: KIND, op: 'close', id, documentId }, location.origin);
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) for (const [id, handle] of handles)
      parent.postMessage({ kind: KIND, op: 'subscribe', id, documentId, feeds: handle.feeds }, location.origin);
  });
  window.NodeAgentEvents = { connect, physical, transport, pairs, documentId };
})();
