import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebuiNode } from '../src/index.ts';
import { chromePath, startChrome, openPage } from '../tests/browser.mjs';

async function until(check: () => Promise<any> | any, description: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout: ${description}`);
}
async function evaluate(cdp: any, expression: string) {
  const reply = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result.result.value;
}
async function page(mode: string) {
  const state = { mode, statusCalls: 0, roots: 0, panels: [] as string[] };
  const webui = new WebuiNode({ async subscribe() {} } as never) as any;
  webui.tenantOf = () => 'onboarding-test';
  webui.languageOf = async () => 'en';
  webui.panels = async () =>
    ['agent', 'introduce', 'notes'].map((node) => ({ node, desc: node, icon: '' }));
  webui.panel = async (
    _tenant: string,
    node: string,
  ) => `<!doctype html><html><head></head><body><h1>${node}</h1>
    ${
      node === 'introduce'
        ? `<select id="language"><option>English</option></select><script>
      window.onboardingMode=new URLSearchParams(location.search).get('onboarding');
      const feed=window.NodeAgentEvents.connect('/events?feed=system:language');
      feed.onopen=()=>window.feedOpened=true;
    </script>`
        : ''
    }</body></html>`;
  webui.onCall = async (_tenant: string, req: any, res: any) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const { tool } = JSON.parse(Buffer.concat(chunks).toString());
    if (tool !== 'introduce.status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"value":null}');
      return;
    }
    state.statusCalls++;
    if (state.mode === 'timeout') return;
    if (state.mode === 'network') {
      req.socket.destroy();
      return;
    }
    if (state.mode === 'http') {
      res.writeHead(503);
      res.end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        state.mode === 'error'
          ? { ok: false, error: 'introduce.status is unavailable' }
          : {
              ok: true,
              value: {
                initialized: state.mode === 'malformed' ? 'wrong type' : state.mode === 'true',
                language: state.mode === 'true' ? 'en' : null,
              },
            },
      ),
    );
  };
  const server = createServer((req, res) => {
    if (req.url === '/' && req.headers['sec-fetch-dest'] === 'document') state.roots++;
    if (req.url?.startsWith('/panel/')) state.panels.push(req.url);
    void webui.onRequest(req, res).catch((error: Error) => {
      res.writeHead(500);
      res.end(error.message);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  let chrome: any, cdp: any;
  try {
    const browser = await startChrome(chromePath());
    chrome = browser.chrome;
    cdp = await openPage(browser.page.webSocketDebuggerUrl);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.statusFetches=0;const realFetch=window.fetch;window.fetch=(url,options)=>{if(url==='/call'&&JSON.parse(options.body).tool==='introduce.status')statusFetches++;return realFetch(url,options);};window.warnings=[];const warn=console.warn;console.warn=(...args)=>{warnings.push(String(args[0]));warn(...args);};`,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    return {
      cdp,
      state,
      async close() {
        cdp.close();
        chrome.kill('SIGTERM');
        await once(chrome, 'exit');
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  } catch (error) {
    cdp?.close();
    if (chrome) {
      chrome.kill('SIGTERM');
      await once(chrome, 'exit');
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
const chrome = chromePath();
const normal = '!!document.getElementById("pinned-view")?.getAttribute("src")';

test(
  'initialized status keeps the normal shell and checks setup only once, even on SSE open',
  { skip: !chrome, timeout: 15000 },
  async () => {
    const browser = await page('true');
    try {
      await until(() => evaluate(browser.cdp, normal), 'normal agent panel');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(browser.state.statusCalls, 1);
      assert.equal(
        await evaluate(browser.cdp, 'document.getElementById("onboarding").hidden'),
        true,
      );
      assert.equal(
        await evaluate(
          browser.cdp,
          'document.getElementById("onboarding-frame").getAttribute("src")',
        ),
        null,
      );
      assert.ok(browser.state.panels.includes('/panel/agent'));
      assert.equal(
        browser.state.panels.some((url) => url.startsWith('/panel/introduce')),
        false,
      );
      assert.equal(await evaluate(browser.cdp, 'document.getElementById("split").inert'), false);
      await evaluate(
        browser.cdp,
        `document.getElementById('onboarding-frame').contentWindow.eval("parent.postMessage({kind:'node-agent:setup-complete'}, parent.location.origin)")`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(browser.state.roots, 1, 'hidden setup iframe cannot reload initialized webui');
    } finally {
      await browser.close();
    }
  },
);

test(
  'uninitialized status opens a focused full-viewport gate, mounts no normal panels, and validates completion messages',
  { skip: !chrome, timeout: 20000 },
  async () => {
    const browser = await page('false');
    try {
      await until(
        () =>
          evaluate(
            browser.cdp,
            'document.getElementById("onboarding-frame")?.contentWindow?.feedOpened',
          ),
        'onboarding frame and shared language feed',
      );
      assert.equal(browser.state.statusCalls, 1);
      assert.deepEqual(browser.state.panels, ['/panel/introduce?onboarding=1']);
      assert.equal(
        await evaluate(
          browser.cdp,
          'document.getElementById("onboarding-frame").contentWindow.onboardingMode',
        ),
        '1',
      );
      assert.equal(
        await evaluate(browser.cdp, 'document.getElementById("onboarding").hidden'),
        false,
      );
      assert.equal(
        await evaluate(browser.cdp, 'document.getElementById("pinned-view").getAttribute("src")'),
        null,
      );
      assert.equal(
        await evaluate(browser.cdp, 'document.querySelectorAll("#launcher-grid .card").length'),
        0,
      );
      assert.equal(await evaluate(browser.cdp, 'document.activeElement.id'), 'onboarding-frame');
      assert.equal(
        await evaluate(
          browser.cdp,
          'document.getElementById("tabs").inert && document.getElementById("split").inert',
        ),
        true,
      );
      assert.equal(
        await evaluate(
          browser.cdp,
          `(()=>{const box=document.getElementById('onboarding').getBoundingClientRect();return box.x===0&&box.y===0&&box.width===innerWidth&&box.height===innerHeight;})()`,
        ),
        true,
      );
      // A top-level sender, a normal sibling iframe, a forged origin and a wrong kind cannot complete setup.
      await evaluate(
        browser.cdp,
        `window.postMessage({kind:'node-agent:setup-complete'},location.origin);
      document.getElementById('view').contentWindow.eval("parent.postMessage({kind:'node-agent:setup-complete'},parent.location.origin)");
      window.dispatchEvent(new MessageEvent('message',{origin:'https://evil.invalid',source:document.getElementById('onboarding-frame').contentWindow,data:{kind:'node-agent:setup-complete'}}));
      document.getElementById('onboarding-frame').contentWindow.eval("parent.postMessage({kind:'not-setup-complete'},parent.location.origin)");`,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(browser.state.roots, 1);
      browser.state.mode = 'true';
      await evaluate(
        browser.cdp,
        `document.getElementById('onboarding-frame').contentWindow.eval("parent.postMessage({kind:'node-agent:setup-complete'},parent.location.origin)")`,
      );
      await until(() => browser.state.roots === 2, 'valid completion reloads shell');
      await until(() => evaluate(browser.cdp, normal), 'normal shell after completion');
      assert.equal(browser.state.statusCalls, 2);
      assert.equal(
        await evaluate(browser.cdp, 'document.getElementById("onboarding").hidden'),
        true,
      );
    } finally {
      await browser.close();
    }
  },
);

for (const mode of ['error', 'http', 'network', 'timeout', 'malformed']) {
  test(
    `onboarding status ${mode} logs and falls back to normal shell`,
    { skip: !chrome, timeout: 15000 },
    async () => {
      const browser = await page(mode);
      try {
        await until(() => evaluate(browser.cdp, normal), `${mode} fallback`);
        assert.equal(await evaluate(browser.cdp, 'statusFetches'), 1);
        if (mode !== 'network') assert.equal(browser.state.statusCalls, 1);
        // Chrome may transparently retry a reset HTTP connection; the shell itself calls fetch once.
        assert.equal(
          await evaluate(browser.cdp, 'document.getElementById("onboarding").hidden'),
          true,
        );
        assert.ok(
          await evaluate(
            browser.cdp,
            'warnings.some(line=>line.includes("onboarding status unavailable"))',
          ),
        );
        assert.equal(
          browser.state.panels.some((url) => url.startsWith('/panel/introduce')),
          false,
        );
      } finally {
        await browser.close();
      }
    },
  );
}
