import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebuiNode } from '../src/index.ts';
import { chromePath, startChrome, openPage } from '../tests/browser.mjs';

async function until(check: () => Promise<any> | any, description: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout: ${description}`);
}
async function fixture() {
  const webui = new WebuiNode({ async subscribe() {} } as never) as any;
  const cookie = (req: any) =>
    req.headers.cookie?.match(/(?:^|;\s*)session=(alice|bob)(?:;|$)/)?.[1] ?? null;
  webui.tenantOf = cookie;
  webui.languageOf = async () => 'en';
  webui.panels = async () => ['agent', 'notes'].map((node) => ({ node, desc: node, icon: '' }));
  webui.panel = async (_tenant: string, node: string) => `<!doctype html><html><head>
    <script type="module" src="/sdk/i18n-client.js"></script></head><body>${node}
    <script>window.received=[];window.opened=0;
      const handle=window.NodeAgentEvents.connect('/events?feed=${node}:${node}');
      handle.onopen=()=>window.opened++;
      handle.onmessage=event=>window.received.push(JSON.parse(event.data));
    </script></body></html>`;
  const streams = new Map<ServerResponse, string>();
  const subscriptions: { tenant: string; feeds: string[] }[] = [];
  const cookies: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/login') {
      const user = url.searchParams.get('user') === 'bob' ? 'bob' : 'alice';
      res.writeHead(302, {
        'set-cookie': `session=${user}; HttpOnly; SameSite=Lax; Path=/`,
        location: '/',
      });
      res.end();
      return;
    }
    const tenant = cookie(req);
    if (!tenant) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (url.pathname === '/events/subscriptions') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        subscriptions.push({ tenant, feeds: JSON.parse(body).feeds });
      });
    }
    if (
      url.pathname === '/events' &&
      req.method === 'GET' &&
      (!url.searchParams.has('tenant') || url.searchParams.get('tenant') === tenant)
    ) {
      // Record real physical HTTP streams, including the HttpOnly cookie delivered from the worker.
      streams.set(res, tenant);
      cookies.push(req.headers.cookie!);
      res.on('close', () => streams.delete(res));
    }
    void webui.onRequest(req, res).catch((error: Error) => {
      res.writeHead(500);
      res.end(error.message);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    streams,
    subscriptions,
    cookies,
    emit: (tenant: string, node: string, topic: string, value: unknown) =>
      webui.onEvent(tenant, node, topic, value, node),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function browsers(origin: string, fallback = false) {
  const { chrome, page } = await startChrome(chromePath());
  const first = await openPage(page.webSocketDebuggerUrl);
  const connections: any[] = [first];
  const targets: string[] = [page.id];
  const endpoint = new URL(page.webSocketDebuggerUrl);
  async function setup(cdp: any, url: string) {
    if (fallback)
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'window.SharedWorker=undefined;',
      });
    await cdp.send('Page.navigate', { url });
    await until(async () => {
      try {
        return await evaluate(
          cdp,
          '!!window.NodeAgentEventBroker && !!document.getElementById("pinned-view")?.contentWindow?.opened',
        );
      } catch {
        return false;
      }
    }, 'shell and embedded agent open');
    return cdp;
  }
  async function add(user?: string) {
    const result = await first.send('Target.createTarget', { url: 'about:blank' });
    const id = result.result.targetId;
    targets.push(id);
    const pages = await (await fetch(`http://${endpoint.host}/json/list`)).json();
    const target = pages.find((candidate: any) => candidate.id === id);
    const cdp = await openPage(target.webSocketDebuggerUrl);
    connections.push(cdp);
    await setup(cdp, origin + (user ? `/login?user=${user}` : '/'));
    return { cdp, id };
  }
  async function closeTarget(id: string) {
    await first.send('Target.closeTarget', { targetId: id });
  }
  await setup(first, origin + '/login?user=alice');
  return {
    first,
    firstId: page.id,
    add,
    closeTarget,
    async close() {
      for (const cdp of connections) cdp.close();
      chrome.kill('SIGTERM');
      await once(chrome, 'exit');
    },
  };
}
async function evaluate(cdp: any, expression: string) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result.exceptionDetails)
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response.result.result.value;
}
async function subscribe(cdp: any, feeds: string[]) {
  await evaluate(
    cdp,
    `window.messages=[];window.opens=0;window.testHandle=window.NodeAgentEventBroker.connect('/events?${feeds.map((feed) => 'feed=' + encodeURIComponent(feed)).join('&')}');
    testHandle.onmessage=e=>messages.push(JSON.parse(e.data));testHandle.onopen=()=>opens++;`,
  );
  await until(() => evaluate(cdp, 'opens>0'), 'tab subscription confirmed');
}
const chrome = chromePath();

test(
  'two real browser tabs share one cookie-authenticated SSE, union feeds and release a closed tab',
  { skip: !chrome, timeout: 40000 },
  async () => {
    const server = await fixture();
    let browser: any;
    try {
      browser = await browsers(server.origin);
      const second = await browser.add();
      await subscribe(browser.first, ['a:x', 'shared:z']);
      await subscribe(second.cdp, ['b:y', 'shared:z']);
      assert.equal(
        await evaluate(browser.first, 'document.cookie'),
        '',
        'HttpOnly cookie is not readable by the shell',
      );
      assert.equal(
        server.streams.size,
        1,
        'two top-level tabs and their panel/i18n handles have one physical stream',
      );
      assert.deepEqual(server.cookies, ['session=alice']);
      await until(
        () =>
          server.subscriptions.at(-1)?.feeds.includes('a:x') &&
          server.subscriptions.at(-1)?.feeds.includes('b:y'),
        'union contains both tab feeds',
      );
      server.emit('alice', 'a', 'x', 'only first');
      server.emit('alice', 'b', 'y', 'only second');
      server.emit('alice', 'shared', 'z', 'both');
      await until(() => evaluate(browser.first, 'messages.length===2'), 'first tab routed events');
      await until(() => evaluate(second.cdp, 'messages.length===2'), 'second tab routed events');
      assert.deepEqual(await evaluate(second.cdp, 'messages.map(m=>m.value)'), [
        'only second',
        'both',
      ]);
      // Drop the network stream. The worker alone reconnects and both logical tabs get open again.
      for (const response of server.streams.keys()) response.destroy();
      await until(
        () => server.cookies.length === 2 && server.streams.size === 1,
        'one shared worker reconnects',
      );
      await until(() => evaluate(browser.first, 'opens>1'), 'first tab open after reconnect');
      await until(() => evaluate(second.cdp, 'opens>1'), 'second tab open after reconnect');
      // Closing the second tab must release b:y, keep shared:z for the surviving first tab, and not reconnect.
      await browser.closeTarget(second.id);
      await until(
        () => !server.subscriptions.at(-1)?.feeds.includes('b:y'),
        'closed tab feeds released',
      );
      assert.equal(server.streams.size, 1);
      assert.equal(server.cookies.length, 2);
      assert.ok(server.subscriptions.at(-1)?.feeds.includes('shared:z'));
      server.emit('alice', 'a', 'x', 'still alive');
      await until(
        () => evaluate(browser.first, 'messages.some(m=>m.value==="still alive")'),
        'surviving tab still receives',
      );
      // End the final top-level document's ownership; the worker stops only when its port count is zero.
      await evaluate(browser.first, 'dispatchEvent(new PageTransitionEvent("pagehide"))');
      await until(() => server.streams.size === 0, 'last tab releases physical stream');
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);

test(
  'without SharedWorker, real browser tabs retain one SSE each, not one per iframe',
  { skip: !chrome, timeout: 30000 },
  async () => {
    const server = await fixture();
    let browser: any;
    try {
      browser = await browsers(server.origin, true);
      const second = await browser.add();
      await subscribe(browser.first, ['a:x']);
      await subscribe(second.cdp, ['b:y']);
      assert.equal(server.streams.size, 2);
      assert.equal(server.cookies.length, 2);
      server.emit('alice', 'a', 'x', 'fallback');
      await until(() => evaluate(browser.first, 'messages.length===1'), 'fallback receives');
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);

test(
  'cookie account changes use another tenant worker and cannot attach a new port to the old worker',
  { skip: !chrome, timeout: 40000 },
  async () => {
    const server = await fixture();
    let browser: any;
    try {
      browser = await browsers(server.origin);
      await subscribe(browser.first, ['a:x']);
      const bob = await browser.add('bob');
      await subscribe(bob.cdp, ['a:x']);
      assert.deepEqual([...server.streams.values()].sort(), ['alice', 'bob']);
      server.emit('bob', 'a', 'x', 'private to bob');
      await until(() => evaluate(bob.cdp, 'messages.length===1'), 'bob receives his event');
      assert.deepEqual(await evaluate(browser.first, 'messages'), []);
      // Even a caller that knows Alice's public worker name must authenticate its new port.
      await evaluate(
        bob.cdp,
        `window.rogue=[];window.rogueWorker=new SharedWorker('/webui/events-shared-worker.js?tenant=alice',{name:'node-agent-events-v1:alice',credentials:'same-origin'});
      rogueWorker.port.onmessage=e=>rogue.push(e.data);rogueWorker.port.start();`,
      );
      await until(
        () => evaluate(bob.cdp, 'rogue.some(m=>m.type==="error")'),
        'wrong tenant port rejected',
      );
      server.emit('alice', 'a', 'x', 'private to alice');
      await until(
        () => evaluate(browser.first, 'messages.length===1'),
        'old authenticated tab receives only its own tenant',
      );
      assert.equal(
        await evaluate(bob.cdp, 'rogue.some(m=>m.type==="message" || m.type==="open")'),
        false,
      );
      await evaluate(
        bob.cdp,
        'rogueWorker.port.postMessage({type:"close"});rogueWorker.port.close()',
      );
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
