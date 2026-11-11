import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const CLIENT = readFileSync(new URL('../src/events-client.js', import.meta.url), 'utf8');
const BROKER = readFileSync(new URL('../src/events-broker.js', import.meta.url), 'utf8');
const ORIGIN = 'http://localhost:8901';
function browser(parent?: object) {
  const listeners = new Map<string, (event: any) => void>();
  const sources: any[] = [];
  let seq = 0;
  const sandbox: any = {
    location: { href: ORIGIN + '/', origin: ORIGIN },
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}` },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    addEventListener: (type: string, handler: (event: any) => void) => listeners.set(type, handler),
    EventSource: class {
      closed = false;
      onopen?: (event: object) => void;
      onmessage?: (event: object) => void;
      onerror?: (event: object) => void;
      url: string;
      constructor(url: string) {
        this.url = url;
        sources.push(this);
      }
      close() {
        this.closed = true;
      }
    },
  };
  sandbox.window = sandbox;
  sandbox.parent = parent ?? sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(CLIENT, context);
  return { sandbox, context, sources, listeners };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test('embedded panel uses postMessage, no physical EventSource, and validates parent/origin/document', () => {
  const sent: any[] = [];
  const parent = {
    location: { origin: ORIGIN },
    NodeAgentEventBroker: {},
    postMessage: (data: any, origin: string) => sent.push({ data, origin }),
  };
  const { sandbox, sources, listeners } = browser(parent);
  const handle = sandbox.NodeAgentEvents.connect(
    '/events?node=agent&topic=agent&topic=agent.helper',
  );
  assert.equal(sources.length, 0);
  assert.deepEqual(Array.from(sent[0].data.feeds), ['agent:agent', 'agent:agent.helper']);
  assert.equal(sent[0].origin, ORIGIN);
  const data = { ...sent[0].data, op: 'message', data: '{"node":"agent","topic":"agent.helper"}' };
  const messages: string[] = [];
  handle.onmessage = (event: { data: string }) => messages.push(event.data);
  listeners.get('message')!({ source: parent, origin: 'https://evil.invalid', data });
  listeners.get('message')!({ source: {}, origin: ORIGIN, data });
  listeners.get('message')!({
    source: parent,
    origin: ORIGIN,
    data: { ...data, documentId: 'old-document' },
  });
  assert.deepEqual(messages, []);
  listeners.get('message')!({ source: parent, origin: ORIGIN, data });
  assert.deepEqual(messages, [data.data]);
  handle.close();
  assert.equal(sent[1].data.op, 'close');
  listeners.get('message')!({ source: parent, origin: ORIGIN, data });
  assert.equal(messages.length, 1);
});

test('standalone panel falls back to one stream, and all embedded page sources use broker handles', () => {
  const { sandbox, sources } = browser();
  const handle = sandbox.NodeAgentEvents.connect('/events?feed=notes:notes');
  assert.equal(sources.length, 1);
  handle.close();
  assert.equal(sources[0].closed, true);
  for (const node of ['agent', 'notes', 'todo', 'timer']) {
    const html = readFileSync(new URL(`../../${node}/src/ui.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /new EventSource\(/);
    assert.match(html, /\/webui\/events-client\.js/);
    assert.match(html, /window\.NodeAgentEvents\.connect\(/);
  }
});

test('broker routes exact feeds to known panel windows and updates subscriptions without another stream', async () => {
  const { sandbox, context, sources, listeners } = browser();
  const receivedA: any[] = [],
    receivedB: any[] = [];
  const a = {
    NodeAgentEvents: { documentId: 'doc-a' },
    postMessage: (data: any) => receivedA.push(data),
  };
  const b = {
    NodeAgentEvents: { documentId: 'doc-b' },
    postMessage: (data: any) => receivedB.push(data),
  };
  const frames: Record<string, any> = {
    'pinned-view': { src: ORIGIN + '/panel/agent', contentWindow: a, addEventListener() {} },
    view: { src: ORIGIN + '/panel/notes', contentWindow: b, addEventListener() {} },
  };
  const posts: any[] = [];
  sandbox.document = { getElementById: (id: string) => frames[id] };
  sandbox.fetch = async (_url: string, options: any) => {
    posts.push(JSON.parse(options.body));
    return { ok: true };
  };
  vm.runInContext(BROKER, context);
  sandbox.NodeAgentEventBroker.setPanels([{ node: 'agent' }, { node: 'notes' }]);
  const register = (
    source: any,
    id: string,
    documentId: string,
    feeds: string[],
    origin = ORIGIN,
  ) =>
    listeners.get('message')!({
      source,
      origin,
      data: { kind: 'node-agent:events', op: 'subscribe', id, documentId, feeds },
    });
  register(a, 'a', 'doc-a', ['agent:agent', 'agent:agent.helper']);
  register(b, 'b', 'doc-b', ['notes:notes']);
  // Unknown iframe, forged origin, and cross-node subscriptions never gain access.
  register({}, 'evil', 'bad', ['notes:notes']);
  register(a, 'evil', 'doc-a', ['agent:secret'], 'https://evil.invalid');
  register(a, 'evil', 'doc-a', ['notes:notes']);
  assert.equal(sources.length, 1);
  sources[0].onopen({});
  await settle();
  assert.deepEqual(posts[0].feeds, [
    'agent:agent',
    'agent:agent.helper',
    'bus:nodes',
    'notes:notes',
  ]);
  assert.equal(receivedA.filter((d) => d.op === 'open').length, 1);
  assert.equal(receivedB.filter((d) => d.op === 'open').length, 1);
  function emit(node: string, topic: string) {
    sources[0].onmessage({ data: JSON.stringify({ node, topic, from: node, value: topic }) });
  }
  emit('agent', 'agent.helper');
  emit('notes', 'notes');
  emit('notes', 'agent.helper');
  emit('agent', 'secret');
  assert.deepEqual(
    receivedA.filter((d) => d.op === 'message').map((d) => JSON.parse(d.data).topic),
    ['agent.helper'],
  );
  assert.deepEqual(
    receivedB.filter((d) => d.op === 'message').map((d) => JSON.parse(d.data).topic),
    ['notes'],
  );
  listeners.get('message')!({
    source: a,
    origin: ORIGIN,
    data: { kind: 'node-agent:events', op: 'close', id: 'a', documentId: 'doc-a' },
  });
  await settle();
  assert.deepEqual(posts.at(-1).feeds, ['bus:nodes', 'notes:notes']);
  assert.equal(sources.length, 1);
  listeners.get('pagehide')!({});
  assert.equal(sources[0].closed, true);
});

test('standalone broker shares panel and SDK language handles on one physical connection', async () => {
  const { sandbox, context, sources, listeners } = browser();
  sandbox.document = { getElementById: () => null };
  const posts: any[] = [];
  sandbox.fetch = async (_url: string, options: any) => {
    posts.push(JSON.parse(options.body));
    return { ok: true };
  };
  vm.runInContext(BROKER, context);
  const first = sandbox.NodeAgentEvents.connect('/events?node=agent&topic=agent');
  const language = sandbox.NodeAgentEvents.connect('/events?node=system&topic=language');
  let opened = 0;
  first.onopen = language.onopen = () => opened++;
  sources[0].onopen({});
  await settle();
  assert.equal(opened, 2);
  assert.equal(sources.length, 1);
  assert.deepEqual(posts[0].feeds, ['agent:agent', 'bus:nodes', 'system:language']);
  listeners.get('pagehide')!({});
});

test('physical stream has exponential backoff, closes before reconnect, and cancels pending retries', () => {
  const { sandbox, sources } = browser();
  sandbox.Math = Object.create(Math);
  sandbox.Math.random = () => 0;
  const timers: { run: () => void; ms: number; cancelled?: boolean }[] = [];
  sandbox.setTimeout = (run: () => void, ms: number) => {
    timers.push({ run, ms });
    return timers.length;
  };
  sandbox.clearTimeout = (id: number) => {
    if (timers[id - 1]) timers[id - 1].cancelled = true;
  };
  const handle = sandbox.NodeAgentEvents.physical('/events?feed=a:x');
  for (let index = 0; index < 3; index++) {
    sources[index].onopen({});
    sources[index].onerror({});
    assert.equal(sources[index].closed, true);
    const timer = timers.filter((t) => !t.cancelled).at(-1)!;
    assert.equal(timer.ms, 1000 * 2 ** index);
    timer.cancelled = true;
    timer.run();
  }
  assert.equal(sources.length, 4);
  sources[3].onerror({});
  handle.close();
  assert.ok(timers.every((timer) => timer.cancelled));
  assert.ok(sources.every((source) => source.closed));
});

test('SharedWorker constructor failure falls back to a pinned per-tab stream', async () => {
  const { sandbox, sources } = browser();
  sandbox.document = { querySelector: () => ({ content: 'alice' }) };
  sandbox.SharedWorker = class {
    constructor() {
      throw new Error('worker blocked by CSP');
    }
  };
  const requests: any[] = [];
  sandbox.fetch = async (_url: string, options: any) => {
    requests.push(options);
    return { ok: true };
  };
  const transport = sandbox.NodeAgentEvents.transport();
  assert.equal(sources.length, 1);
  assert.equal(new URL(sources[0].url, ORIGIN).searchParams.get('tenant'), 'alice');
  await transport.update(['bus:nodes', 'a:x']);
  assert.equal(requests[0].credentials, 'same-origin');
  assert.equal(JSON.parse(requests[0].body).tenant, 'alice');
  transport.close();
  assert.equal(sources[0].closed, true);
});
