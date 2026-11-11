// The first visit is where a user's language is decided, and the shell is where it is handed over.
//
// Two things here are easy to break silently: asking the system node on *every* request (a bus
// round trip per page load, and a language that follows whichever browser came last) and losing the
// hand-off to the SDK's browser half (a page that draws in English for a Chinese reader). Both are
// pinned below, against a bus double, because the shape of the answer is all webui needs.
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { WebuiNode } from '../src/index.ts';

const TENANT = 'language-tenant';

/** Just enough of a response to read what a route answered. */
class Response {
  status = 0;
  headers: Record<string, string> = {};
  body = '';
  writableLength = 0;
  writableEnded = false;
  destroyed = false;

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  end(chunk = ''): this {
    this.body += typeof chunk === 'string' ? chunk : String(chunk);
    this.writableEnded = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  on(): this {
    return this;
  }
}

interface BusCall {
  readonly to: string;
  readonly cap: string;
  readonly args: Record<string, unknown>;
}

/** A bus that records what the node asked for and answers `system.ensure_language` as configured. */
/** A bus double over whatever directory the test wants to see. */
function busDouble(
  directory: {
    nodes?: readonly unknown[];
    caps?: (node: string) => readonly unknown[];
  } = {},
) {
  const calls: BusCall[] = [];
  let answer: { ok: true; value: unknown } | { ok: false; error: string } = {
    ok: true,
    value: { language: 'zh-CN', resolved: 'zh-CN', changed: true },
  };
  const bus = {
    async call(frame: { to: string; payload: { cap: string; args?: Record<string, unknown> } }) {
      calls.push({ to: frame.to, cap: frame.payload.cap, args: frame.payload.args ?? {} });
      return { payload: answer };
    },
    async listNodes() {
      return directory.nodes ?? [];
    },
    async listCapabilities(name: string) {
      return directory.caps?.(name) ?? [];
    },
    async subscribe() {},
  };
  return {
    bus,
    calls,
    answering(next: typeof answer) {
      answer = next;
    },
  };
}

/** A visit: the method and header a browser sends. A tenant header is what `tenantOf` reads. */
function request(url: string, acceptLanguage?: string, method = 'GET'): IncomingMessage {
  const headers: Record<string, string> = {};
  if (acceptLanguage !== undefined) headers['accept-language'] = acceptLanguage;
  if (process.env.NODE_AGENT_USER_TENANT !== undefined) headers['x-serve-user'] = TENANT;
  return { method, url, headers } as unknown as IncomingMessage;
}

/** Run one request against a node, with the tenant the deployment would have given this process. */
async function visit(webui: WebuiNode, url: string, acceptLanguage?: string): Promise<Response> {
  const fake = new Response();
  await webui.onRequest(request(url, acceptLanguage), fake as unknown as ServerResponse);
  return fake;
}

/** The language hand-off the shell carries, as a browser would see it. */
function handedOff(body: string): string | undefined {
  return /window\.__NODE_AGENT_LANGUAGE__ = "([^"]*)"/.exec(body)?.[1];
}

const ensureCalls = (calls: BusCall[]): BusCall[] =>
  calls.filter((call) => `${call.to}.${call.cap}` === 'system.ensure_language');

/** A node bound to one tenant, as a deployment's environment makes it. */
function withTenant<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_AGENT_USER_TENANT;
  const previousSecret = process.env.NODE_AGENT_WEBUI_SECRET;
  const previousPlatform = process.env.SERVE_PLATFORM_SECRET;
  process.env.NODE_AGENT_USER_TENANT = TENANT;
  delete process.env.NODE_AGENT_WEBUI_SECRET;
  delete process.env.SERVE_PLATFORM_SECRET;
  return run().finally(() => {
    if (previous === undefined) delete process.env.NODE_AGENT_USER_TENANT;
    else process.env.NODE_AGENT_USER_TENANT = previous;
    if (previousSecret !== undefined) process.env.NODE_AGENT_WEBUI_SECRET = previousSecret;
    if (previousPlatform !== undefined) process.env.SERVE_PLATFORM_SECRET = previousPlatform;
  });
}

test('the first visit tells the system node what the browser reads, once', async () => {
  await withTenant(async () => {
    const { bus, calls } = busDouble();
    const webui = new WebuiNode(bus as never);

    const first = await visit(webui, '/', 'zh-CN,zh;q=0.9,en;q=0.8');
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(first.headers['cache-control'], 'no-store');
    // The answer is in the page before anything is drawn, and the SDK's browser half is loaded.
    assert.equal(handedOff(first.body), 'zh-CN');
    assert.match(first.body, /<script type="module" src="\/sdk\/i18n-client\.js"><\/script>/);
    assert.deepEqual(ensureCalls(calls), [
      {
        to: 'system',
        cap: 'ensure_language',
        args: { browser: 'zh-CN,zh;q=0.9,en;q=0.8' },
      },
    ]);

    // A second visit — another browser, another header — changes nothing and asks nobody.
    const second = await visit(webui, '/', 'en-US,en;q=0.9');
    assert.equal(handedOff(second.body), 'zh-CN');
    assert.equal(ensureCalls(calls).length, 1, 'a return visit must not ask the system node again');
    assert.deepEqual(ensureCalls(calls)[0]?.args, { browser: 'zh-CN,zh;q=0.9,en;q=0.8' });

    // /panels is a page load as well: it reuses the same decision.
    const panels = await visit(webui, '/panels', 'fr-FR');
    assert.equal(panels.status, 200);
    assert.equal(panels.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(panels.body), { panels: [] });
    assert.equal(ensureCalls(calls).length, 1);
  });
});

test('a first visit through /panels decides the language as well', async () => {
  await withTenant(async () => {
    const { bus, calls } = busDouble();
    const webui = new WebuiNode(bus as never);

    await visit(webui, '/panels', 'en-GB,en;q=0.9');
    assert.deepEqual(
      ensureCalls(calls).map((call) => call.args),
      [{ browser: 'en-GB,en;q=0.9' }],
    );

    const shell = await visit(webui, '/', 'zh-CN');
    assert.equal(handedOff(shell.body), 'zh-CN');
    assert.equal(ensureCalls(calls).length, 1, 'the shell request reused the decision');
  });
});

test('a panel carries the display name its node publishes, and the canonical name too', async () => {
  await withTenant(async () => {
    const { bus, answering } = busDouble({
      nodes: [
        {
          name: 'system',
          desc: 'the system node',
          icon: '',
          scope: 'shared',
          labels: { node: { en: 'System', 'zh-CN': '系统' } },
        },
      ],
      caps: () => [
        {
          cap: 'ui',
          parameters: { type: 'object', properties: {}, description: 'Settings', icon: '<svg/>' },
        },
      ],
    });
    const webui = new WebuiNode(bus as never);

    const answer = JSON.parse((await visit(webui, '/panels', 'zh-CN')).body) as {
      panels: Array<Record<string, unknown>>;
    };
    assert.deepEqual(answer.panels, [
      {
        node: 'system',
        desc: 'Settings',
        icon: '',
        names: { en: 'System', 'zh-CN': '系统' },
      },
    ]);

    answering({ ok: true, value: '<!doctype html><html lang="en"></html>' });
    const page = await visit(webui, '/panel/system', 'en');
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
  });
});

test('a request with no browser preference asks with no header rather than an empty one', async () => {
  await withTenant(async () => {
    const { bus, calls } = busDouble();
    const webui = new WebuiNode(bus as never);

    await visit(webui, '/');
    assert.deepEqual(ensureCalls(calls), [{ to: 'system', cap: 'ensure_language', args: {} }]);
  });
});

test('a page nobody is signed in for is still a page, and asks nobody', async () => {
  const previous = process.env.NODE_AGENT_USER_TENANT;
  delete process.env.NODE_AGENT_USER_TENANT;
  try {
    const { bus, calls } = busDouble();
    const webui = new WebuiNode(bus as never);

    const shell = await visit(webui, '/', 'zh-CN');
    assert.equal(shell.status, 200);
    // No tenant means no profile to set: the SDK's browser half falls back to what the browser says.
    assert.equal(handedOff(shell.body), undefined);
    assert.deepEqual(calls, []);
  } finally {
    if (previous !== undefined) process.env.NODE_AGENT_USER_TENANT = previous;
  }
});

test('a stack without a system node still serves the shell, and retries next time', async () => {
  await withTenant(async () => {
    const { bus, calls, answering } = busDouble();
    answering({ ok: false, error: 'no such node for user: system' });
    const webui = new WebuiNode(bus as never);

    const shell = await visit(webui, '/', 'zh-CN');
    assert.equal(shell.status, 200);
    assert.equal(handedOff(shell.body), undefined);

    // Nothing was remembered from a failed first visit: the next one asks again, and succeeds.
    answering({ ok: true, value: { language: 'zh-CN', resolved: 'zh-CN', changed: true } });
    const later = await visit(webui, '/', 'zh-CN');
    assert.equal(handedOff(later.body), 'zh-CN');
    assert.equal(ensureCalls(calls).length, 2);
  });
});

test('an announcement changes what the next page is drawn in, without asking again', async () => {
  await withTenant(async () => {
    const { bus, calls } = busDouble();
    const webui = new WebuiNode(bus as never);

    await visit(webui, '/', 'en-US');
    assert.equal(handedOff((await visit(webui, '/', 'en-US')).body), 'zh-CN');

    // The settings page switched the language: webui keeps the event for itself as well as passing it on.
    webui.onEvent(TENANT, 'system', 'language', { language: 'en', resolved: 'en' }, 'system');
    const after = await visit(webui, '/');
    assert.equal(handedOff(after.body), 'en');
    assert.equal(ensureCalls(calls).length, 1, 'a known language is never re-negotiated');

    // Something else published on a topic that is not the language: nothing changes.
    webui.onEvent(TENANT, 'system', 'timers', { language: 'zh-CN' }, 'system');
    webui.onEvent(TENANT, 'todo', 'language', { language: 'zh-CN' }, 'todo');
    // ...and neither does a payload that is not a language tag.
    webui.onEvent(TENANT, 'system', 'language', { language: 'not a tag!' }, 'system');
    assert.equal(handedOff((await visit(webui, '/')).body), 'en');
  });
});

test('a hand-off carries a language tag or nothing at all', async () => {
  await withTenant(async () => {
    const { bus, answering } = busDouble();
    // Whatever the system node says, only a tag reaches the page: this value is not one.
    answering({
      ok: true,
      value: {
        language: 'zh-CN"><script>alert(1)</script>',
        resolved: 'zh-CN"><script>alert(1)</script>',
      },
    });
    const webui = new WebuiNode(bus as never);

    const shell = await visit(webui, '/', 'zh-CN');
    assert.equal(shell.status, 200);
    assert.equal(handedOff(shell.body), undefined);
    assert.doesNotMatch(shell.body, /alert/);
  });
});

test('the SDK\u2019s i18n is served to the page, and nothing else under /sdk', async () => {
  const webui = new WebuiNode(busDouble().bus as never);

  const textModule = await visit(webui, '/sdk/i18n.js');
  assert.equal(textModule.status, 200);
  assert.equal(textModule.headers['content-type'], 'text/javascript; charset=utf-8');
  // The class a node (or a page) wraps its own sentence in — and no catalog of anybody's words.
  assert.match(textModule.body, /export class Text/);
  assert.doesNotMatch(textModule.body, /MESSAGES|data-i18n|'common\./);

  const client = await visit(webui, '/sdk/i18n-client.js');
  assert.equal(client.status, 200);
  assert.equal(client.headers['content-type'], 'text/javascript; charset=utf-8');
  // The browser half imports what it needs from beside itself, and listens for the language event.
  assert.match(client.body, /from '\.\/i18n\.js'/);
  assert.match(client.body, /data-text-key/);
  assert.match(client.body, /data-i18n-resource|RESOURCE_ATTRIBUTE/);
  assert.match(client.body, /node-agent:language/);
  assert.match(client.body, /\/events\?node=system&topic=language/);
  assert.doesNotMatch(client.body, /MESSAGES|'common\./);

  // The resource half is a module of its own now, and must be served too — otherwise the client's
  // import sits there as a 404 and no page drawn from a resource file works.
  const resourceModule = await visit(webui, '/sdk/i18n-resource.js');
  assert.equal(resourceModule.status, 200);
  assert.equal(resourceModule.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.match(resourceModule.body, /export function resourceTexts/);
  assert.match(resourceModule.body, /export function resourceScript/);

  // The map is the whitelist: no directory, no other file of the package.
  for (const path of ['/sdk/index.js', '/sdk/', '/sdk/../index.js', '/sdk/i18n.ts']) {
    const missing = await visit(webui, path);
    assert.equal(missing.status, 404, path);
  }
});
