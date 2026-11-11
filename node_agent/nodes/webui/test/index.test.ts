import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import { WebuiNode } from '../src/index.ts';

class Response {
  status = 0;
  body = '';
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  close?: () => void;

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  end(chunk = ''): this {
    this.body += chunk;
    this.writableEnded = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.close?.();
    return this;
  }

  on(event: string, listener: () => void): this {
    if (event === 'close') this.close = listener;
    return this;
  }
}

class TestWebuiNode extends WebuiNode {
  readonly topics: string[] = [];

  override async audience(
    _tenantId: string,
    node: string,
    topic: string,
  ): Promise<Set<ServerResponse>> {
    this.topics.push(`${node}.${topic}`);
    return new Set<ServerResponse>();
  }
}

/** A stand-in for the bus directory, so `panels()` can be read without a bus: what each node says
 *  about its own page is exactly what the handshake puts here. */
class DirectoryWebuiNode extends WebuiNode {
  override async dir(_tenantId: string): ReturnType<WebuiNode['dir']> {
    return [
      {
        tool: 'agent.ui',
        node: 'agent',
        desc: 'the node description',
        parameters: {
          description: 'Talk to the agent',
          presence: 'state',
          icon: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M4 4h9"/></svg>',
        },
      },
      { tool: 'agent.chat', node: 'agent', desc: 'a capability, not a page', parameters: {} },
      // A page that still asks for a column gets none: which column a page is in is the shell's
      // business now, and `slot` is not read (the row below has no `slot` key at all).
      {
        tool: 'todo.ui',
        node: 'todo',
        desc: 'Today card with free text',
        parameters: { slot: 'left' },
      },
      {
        tool: 'notes.ui',
        node: 'notes',
        desc: 'Documents with tags',
        // Not a string, so not a drawing: the shell would have nothing to put in the tab.
        parameters: { icon: 42 },
      },
    ];
  }
}

const response = (): [Response, ServerResponse] => {
  const fake = new Response();
  return [fake, fake as unknown as ServerResponse];
};

test('panels hands the shell what each page asked for, and drops a drawing that is not a string', async () => {
  const panels = await new DirectoryWebuiNode().panels('t');

  assert.deepEqual(panels, [
    {
      node: 'agent',
      desc: 'Talk to the agent',
      presence: 'state',
      icon: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M4 4h9"/></svg>',
    },
    // A page whose schema says nothing gets the tab and the node's own description, and no drawing:
    // nothing has to be declared for a node to be shown.
    {
      node: 'todo',
      desc: 'Today card with free text',
      presence: undefined,
      icon: undefined,
    },
    // A drawing that is not even a string never reaches the page: the tab shows its name alone.
    {
      node: 'notes',
      desc: 'Documents with tags',
      presence: undefined,
      icon: undefined,
    },
  ]);
});

test('events accepts a safe node and topic pair', async () => {
  const webui = new TestWebuiNode();
  const [fake, res] = response();

  await webui.onEvents('t', new URLSearchParams('node=mindmap&topic=view'), res);
  fake.close?.();

  assert.equal(fake.status, 200);
  assert.deepEqual(webui.topics, ['mindmap.view']);
  assert.match(fake.body, /^: connected/);
});

test('events multiplexes topics without crossing tenant or publisher boundaries and cleans up on close', async () => {
  const subscriptions: string[] = [];
  const webui = new WebuiNode({
    async subscribe(topic: string, tenant: string, node: string) {
      subscriptions.push(`${tenant}:${node}:${topic}`);
    },
  } as never);
  const [fake, res] = response();
  await webui.onEvents(
    't',
    new URLSearchParams('node=agent&topic=agent&topic=agent.helper&topic=agent'),
    res,
  );
  try {
    assert.equal(fake.status, 200);
    assert.deepEqual(subscriptions, ['t:agent:agent', 't:agent:agent.helper']);
    webui.onEvent('other', 'agent', 'agent', 'other tenant', 'agent');
    webui.onEvent('t', 'other', 'agent', 'other publisher', 'other');
    webui.onEvent('t', 'agent', 'agent.unknown', 'unsubscribed', 'agent');
    assert.equal(fake.body, ': connected\n\n');
    webui.onEvent('t', 'agent', 'agent', 'main update', 'agent');
    webui.onEvent('t', 'agent', 'agent.helper', 'helper update', 'agent');
    const events = fake.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(
      events.map(({ topic, value }) => ({ topic, value })),
      [
        { topic: 'agent', value: 'main update' },
        { topic: 'agent.helper', value: 'helper update' },
      ],
    );
  } finally {
    fake.close?.();
  }
  assert.ok([...webui.feeds.values()].every((feed) => !feed.has(res)));
});

test('events validates every multiplexed topic before subscribing', async () => {
  const webui = new TestWebuiNode();
  const [fake, res] = response();
  await webui.onEvents('t', new URLSearchParams('node=agent&topic=agent&topic=../bad'), res);
  assert.equal(fake.status, 400);
  assert.deepEqual(webui.topics, []);
});

test('events disconnects a browser whose output buffer stops draining', () => {
  const webui = new WebuiNode();
  const [fake, res] = response();
  fake.writableLength = 1 << 20;
  webui.feeds.set('t\u0000agent\u0000agent', new Set([res]));

  webui.onEvent('t', 'agent', 'agent', { content: 'next token' }, 'agent');

  assert.equal(fake.destroyed, true);
});

test('events rejects malformed topics before subscribing', async () => {
  for (const topic of ['', '.graph', 'mindmap.', 'mindmap..view', 'mindmap/view']) {
    const webui = new TestWebuiNode();
    const [fake, res] = response();

    await webui.onEvents('t', new URLSearchParams({ topic }), res);

    assert.equal(fake.status, 400, topic);
    assert.deepEqual(webui.topics, [], topic);
  }
});

function callRequest(tool: string, referer?: string): IncomingMessage {
  const body = JSON.stringify({ tool, args: {} });
  return {
    headers: referer === undefined ? {} : { referer },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
}

test('a page may call any node: the referer it sends is not a boundary', async () => {
  const calls: string[] = [];
  const node = new WebuiNode({
    async call(frame: { to: string; payload: { cap: string } }) {
      calls.push(`${frame.to}.${frame.payload.cap}`);
      return { payload: { ok: true, value: 'yes' } };
    },
  } as never);

  // A page at `/panel/<node>` calling another node: this is what the agent page does to list the
  // providers it can use (`local-provider.providers`, `provider.providers`). A referer rule used to
  // refuse it, and could not be a rule: the same page can send `fetch('/call', { referrer: '' })`
  // and arrive with no referer at all — exactly what the shell's own page sends. What a browser may
  // reach is the bus's answer to the webui's own session, not a header the page writes.
  const [elsewhere, elsewhereRes] = response();
  await node.onCall('tenant', callRequest('store.list', 'http://webui/panel/shell'), elsewhereRes);
  assert.equal(elsewhere.status, 200);
  assert.deepEqual(JSON.parse(elsewhere.body), { ok: true, value: 'yes' });
  assert.deepEqual(calls, ['store.list']);

  // Its own node, and the shell's own page (no panel referer), reach the same proxy.
  const [own, ownRes] = response();
  await node.onCall('tenant', callRequest('shell.exec', 'http://webui/panel/shell'), ownRes);
  assert.equal(own.status, 200);
  assert.deepEqual(calls, ['store.list', 'shell.exec']);

  const [shell, shellRes] = response();
  await node.onCall('tenant', callRequest('store.list', 'http://webui/'), shellRes);
  assert.equal(shell.status, 200);
  assert.deepEqual(calls, ['store.list', 'shell.exec', 'store.list']);
});
/** A call as the webui hands it to the bus, so a test can read the envelope it built. */
type SentCall = {
  readonly to: string;
  readonly tenantId: string;
  readonly deadline: number;
  readonly payload: { readonly cap: string; readonly args: Record<string, unknown> };
};

/** A bus session that only records: what a page's call looks like on the wire. */
class RecordingBus {
  readonly calls: SentCall[] = [];

  async call(call: SentCall) {
    this.calls.push(call);
    return { payload: { ok: true as const, value: 'answered' } };
  }
}

/** A bus session that behaves like the real one for the question here: a reply that has not come
 *  when the envelope's deadline passes is never waited for — the pending call rejects, in the exact
 *  words the page then shows. */
class DeadlineBus {
  readonly calls: SentCall[] = [];

  async call(call: SentCall) {
    this.calls.push(call);
    await new Promise((ok) => setTimeout(ok, Math.max(1, call.deadline - Date.now())));
    throw new Error('bus request timeout');
  }
}

test('a page call is given the proxy\u2019s budget, not a round trip\u2019s 30 seconds', async () => {
  const bus = new RecordingBus();
  const node = new WebuiNode(bus as never);
  const [fake, res] = response();

  const now = Date.now();
  await node.onCall('tenant', callRequest('agent.status'), res);

  assert.equal(fake.status, 200);
  assert.deepEqual(JSON.parse(fake.body), { ok: true, value: 'answered' });
  const [sent] = bus.calls;
  assert.equal(sent?.to, 'agent');
  assert.equal(sent?.payload.cap, 'status');
  // What a page is waiting for is a control call, and the proxy in front of it already waits 15 minutes
  // for a POST; a page that gave up at a round trip's 30 seconds cut calls the proxy was still holding
  // (and the node was still running).
  assert.ok(
    sent !== undefined && sent.deadline - now >= 10 * 60_000,
    `a page call outlives a slow node, not ${((sent?.deadline ?? now) - now) / 1_000}s`,
  );
});

test('the allowance is the page call budget, and a short one cuts a slow answer', async () => {
  const bus = new DeadlineBus();
  const node = new WebuiNode(bus as never, { callTimeoutMs: 30 });
  const [fake, res] = response();

  const now = Date.now();
  await node.onCall('tenant', callRequest('agent.chat'), res);

  // The page is told what the bus said, verbatim: nothing here rewrites an expired wait into a
  // different story (that is what made `something went wrong: bus request timeout` so hard to place).
  assert.deepEqual(JSON.parse(fake.body), { ok: false, error: 'bus request timeout' });
  const [sent] = bus.calls;
  assert.ok(
    sent !== undefined && sent.deadline - now <= 100,
    'the constructor option is what the envelope carries',
  );
});

test('one SSE connection carries multiple publishers with exact feed and tenant isolation', async () => {
  const webui = new WebuiNode({ async subscribe() {} } as never);
  const [fake, res] = response();
  await webui.onEvents('t', new URLSearchParams('feed=a:x&feed=b:y&feed=a:x'), res);
  try {
    webui.onEvent('t', 'a', 'x', 1, 'a');
    webui.onEvent('t', 'b', 'y', 2, 'b');
    webui.onEvent('t', 'a', 'y', 'wrong publisher', 'a');
    webui.onEvent('t', 'b', 'x', 'wrong topic', 'b');
    webui.onEvent('other', 'a', 'x', 'wrong tenant', 'a');
    const events = fake.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(events, [
      { node: 'a', topic: 'x', from: 'a', value: 1 },
      { node: 'b', topic: 'y', from: 'b', value: 2 },
    ]);
  } finally {
    fake.close?.();
  }
  assert.ok([...webui.feeds.values()].every((feed) => feed.size === 0));
});

test('feed URLs reject every invalid pair before subscribing, and can mix legacy topics', async () => {
  const webui = new TestWebuiNode();
  for (const query of [
    'feed=a:x&feed=b:../bad',
    'feed=a:x:y',
    'feed=:x',
    'feed=a:',
    'feed=../a:x',
  ]) {
    const [fake, res] = response();
    await webui.onEvents('t', new URLSearchParams(query), res);
    assert.equal(fake.status, 400);
  }
  assert.deepEqual(webui.topics, []);
  const [fake, res] = response();
  await webui.onEvents('t', new URLSearchParams('feed=a:x&node=b&topic=y'), res);
  fake.close?.();
  assert.deepEqual(webui.topics, ['a.x', 'b.y']);
});

test('live subscription updates keep existing feeds flowing without replacing SSE', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const webui = new WebuiNode({
    async subscribe(topic: string) {
      if (topic === 'y') await wait;
    },
  } as never);
  const [fake, res] = response();
  const client = '12345678-1234-1234-1234-123456789012';
  await webui.onEvents('t', new URLSearchParams(`feed=a:x&client=${client}`), res);
  function request(feeds: string[]) {
    return {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ client, feeds }));
      },
    } as never;
  }
  try {
    const [reply, updateRes] = response();
    const update = webui.onSubscriptions('t', request(['a:x', 'b:y']), updateRes);
    await new Promise((resolve) => setImmediate(resolve));
    webui.onEvent('t', 'a', 'x', 'during subscribe', 'a');
    assert.match(fake.body, /during subscribe/);
    release();
    await update;
    assert.equal(reply.status, 200);
    webui.onEvent('t', 'b', 'y', 'new feed', 'b');
    assert.match(fake.body, /new feed/);
    assert.equal((fake.body.match(/: connected/g) ?? []).length, 1);
    const [wrongTenant, wrongRes] = response();
    await webui.onSubscriptions('other', request(['a:x']), wrongRes);
    assert.equal(wrongTenant.status, 404);
    const [, removeRes] = response();
    await webui.onSubscriptions('t', request(['b:y']), removeRes);
    webui.onEvent('t', 'a', 'x', 'removed feed', 'a');
    assert.doesNotMatch(fake.body, /removed feed/);
  } finally {
    release();
    fake.close?.();
  }
  assert.ok([...webui.feeds.values()].every((feed) => feed.size === 0));
  const [gone, goneRes] = response();
  await webui.onSubscriptions('t', request(['a:x']), goneRes);
  assert.equal(gone.status, 404);
});

test('HTTP /events?feed=a:x&feed=b:y sends both events in one response', async () => {
  const webui = new WebuiNode({ async subscribe() {} } as never);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    void webui.onEvents('t', new URL(req.url!, 'http://localhost').searchParams, res).then(() => {
      webui.onEvent('t', 'a', 'x', 'first', 'a');
      webui.onEvent('t', 'b', 'y', 'second', 'b');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/events?feed=a:x&feed=b:y`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    let body = '';
    while (!body.includes('second')) {
      const { value, done } = await reader.read();
      if (done) break;
      body += new TextDecoder().decode(value);
    }
    await reader.cancel();
    const events = body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(
      events.map(({ node, topic, value }) => [node, topic, value]),
      [
        ['a', 'x', 'first'],
        ['b', 'y', 'second'],
      ],
    );
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the panel call can ask for the introduce onboarding page explicitly', async () => {
  const webui = new WebuiNode({} as never) as any;
  let seen: unknown[] = [];
  webui.call = async (...args: unknown[]) => {
    seen = args;
    return { ok: true, value: '<!doctype html>' };
  };
  assert.equal(await webui.panel('t', 'introduce', 'en', true), '<!doctype html>');
  assert.deepEqual(seen, ['t', 'introduce.ui', { language: 'en', onboarding: true }]);
  await webui.panel('t', 'introduce', 'en', false);
  assert.deepEqual(seen, ['t', 'introduce.ui', { language: 'en' }]);
});

test('all served panels get the shared transport before SDK i18n, without double injection', async () => {
  const webui = new WebuiNode({} as never);
  webui.panels = async () => [{ node: 'provider', desc: '', icon: '' }];
  webui.panel = async () =>
    '<!doctype html><html><head><script src="/sdk/i18n-client.js"></script></head><body>page</body></html>';
  const [fake, res] = response();
  await webui.onPanel('t', 'provider', res);
  assert.equal(fake.status, 200);
  assert.ok(
    fake.body.indexOf('/webui/events-client.js') < fake.body.indexOf('/sdk/i18n-client.js'),
  );
  assert.match(fake.body, /\/webui\/events-broker\.js/);
  const injected = fake.body;
  webui.panel = async () => injected;
  const [again, againRes] = response();
  await webui.onPanel('t', 'provider', againRes);
  assert.equal(again.body, injected);
});

test('worker tenant pin is checked before subscribing or changing an authenticated stream', async () => {
  const webui = new TestWebuiNode();
  const [wrong, wrongRes] = response();
  await webui.onEvents('bob', new URLSearchParams('tenant=alice&feed=a:x'), wrongRes);
  assert.equal(wrong.status, 401);
  assert.deepEqual(webui.topics, []);
  const request = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ client: 'unused', tenant: 'alice', feeds: ['a:x'] }));
    },
  } as never;
  const [update, updateRes] = response();
  await webui.onSubscriptions('bob', request, updateRes);
  assert.equal(update.status, 401);
});
