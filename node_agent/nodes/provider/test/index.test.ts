import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { NodeContext, ToolArgs } from '@node-agent/sdk';
import { ProviderNode } from '../src/index.ts';
import { RETRY_ATTEMPTS, retryPause } from '../src/providers/base.ts';

type Published = { topic: string; value: unknown };

function context(
  fetchImpl: typeof fetch,
  published: Published[] = [],
  id = 'provider',
): NodeContext {
  const units = new Map<string, { meta: Record<string, unknown>; revision: number }>();
  return {
    nodeId: id,
    tenantId: 'default',
    from: 'caller',
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    fetch: fetchImpl,
    publish: (topic, value) => published.push({ topic, value }),
    call: async <T>(node: string, cap: string, args: ToolArgs): Promise<T> => {
      if (node !== 'history') throw new Error(`unexpected node ${node}`);
      const unitId = String(args.unitId);
      if (cap === 'load') return { unit: units.get(unitId) ?? null } as T;
      if (cap === 'save') {
        const previous = units.get(unitId);
        const expected = args.expectedRevision;
        if (typeof expected === 'number' && previous && previous.revision !== expected)
          throw new Error('revision conflict');
        const unit = {
          meta: args.meta as Record<string, unknown>,
          revision: (previous?.revision ?? 0) + 1,
        };
        units.set(unitId, unit);
        return { unit } as T;
      }
      throw new Error(`unexpected history capability ${cap}`);
    },
  };
}

async function run<T>(node: ProviderNode, cap: string, args: ToolArgs): Promise<T> {
  return (await node.handlers[cap]!(args)) as T;
}

/** The event name of one published stream event. */
function eventOf(entry: Published): string | undefined {
  return (entry.value as { event?: string }).event;
}

/** Wait for the provider worker, which runs after `stream_ready` answers, to reach `done`. */
async function until(test: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the stream');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** One saved row called `work`, so a stream test never repeats the same four lines. */
async function saveWork(node: ProviderNode): Promise<void> {
  await run(node, 'providers', {
    action: 'save',
    name: 'work',
    config: {
      type: 'openai',
      model_name: 'gpt-test',
      api_key: 'sk-secret',
      base_url: 'https://x.test/v1',
    },
  });
}

/** A chat-completions stream of `contents`, counting how many requests reached it. */
function chatCompletionsStream(contents: string[]): { fetch: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  const fetch = (async () => {
    calls.push(calls.length + 1);
    const events = contents.map((content) =>
      JSON.stringify({ choices: [{ index: 0, delta: { content } }] }),
    );
    const body = events.map((event) => `data: ${event}\n\n`).join('');
    return new Response(`${body}data: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  return { fetch, calls };
}

/** A stream that delivers one delta and then stays open, so a cancel has something to stop. */
function chatCompletionsHangingStream(content: string): {
  fetch: typeof fetch;
  calls: number[];
} {
  const calls: number[] = [];
  const fetch = (async () => {
    calls.push(calls.length + 1);
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`,
          ),
        );
        // Never closed: the cancel is what ends this stream.
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  return { fetch, calls };
}

test('a fresh node offers one blank provider and hides API keys', async () => {
  const node = new ProviderNode(context(async () => new Response('{}')));
  const state = await run<{
    providers: { name: string; config: Record<string, unknown>; has_api_key: boolean }[];
    persistent: boolean;
  }>(node, 'providers', { action: 'list' });
  assert.equal(state.persistent, true);
  assert.equal(state.providers.length, 1);
  assert.equal(state.providers[0]?.name, 'default');
  assert.equal(state.providers[0]?.config.type, 'openai');
  assert.equal(state.providers[0]?.has_api_key, false);
});

test('save keeps a blank key, persists the row, and a new instance loads it', async () => {
  const ctx = context(async () => new Response('{}'));
  const node = new ProviderNode(ctx);
  const saved = await run<{
    providers: { name: string; config: Record<string, unknown>; has_api_key: boolean }[];
  }>(node, 'providers', {
    action: 'save',
    name: 'work',
    config: {
      type: 'openai',
      model_name: 'gpt-test',
      api_key: 'sk-secret',
      base_url: 'https://x.test/v1',
    },
  });
  const row = saved.providers.find((provider) => provider.name === 'work');
  assert.equal(row?.has_api_key, true);
  assert.equal(row?.config.api_key, undefined);

  const again = new ProviderNode(ctx);
  const state = await run<{ providers: { name: string; has_api_key: boolean }[] }>(
    again,
    'providers',
    {
      action: 'list',
    },
  );
  assert.equal(state.providers.find((provider) => provider.name === 'work')?.has_api_key, true);
});

test('chat dispatches through the saved row, and the page carries the node id', async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const ctx = context(fetcher);
  const node = new ProviderNode(ctx);
  await run(node, 'providers', {
    action: 'save',
    name: 'work',
    config: {
      type: 'openai',
      model_name: 'gpt-test',
      api_key: 'sk-secret',
      base_url: 'https://x.test/v1',
    },
  });
  const answer = await run<{ message: { content: string } }>(new ProviderNode(ctx), 'chat', {
    name: 'work',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(answer.message.content, 'hello');
  const page = await run<string>(node, 'ui', {});
  assert.match(page, /const INJECTED = "provider";/);
});

test('start_stream answers with an id and dials nothing; the stream begins at stream_ready', async () => {
  const fetcher = chatCompletionsStream(['he', 'llo']);
  const published: Published[] = [];
  const ctx = context(fetcher.fetch, published);
  await saveWork(new ProviderNode(ctx));

  const started = await run<{ stream_id: string; topic: string }>(
    new ProviderNode(ctx),
    'start_stream',
    { name: 'work', messages: [{ role: 'user', content: 'hi' }] },
  );
  assert.match(started.stream_id, /^[0-9a-f]{32}$/, 'an opaque id, not the caller name');
  assert.equal(started.topic, `provider.stream.${started.stream_id}`);
  // Nothing is asked of the model, and nothing is published, before the caller says it listens.
  assert.equal(fetcher.calls.length, 0);
  assert.deepEqual(published, []);

  assert.deepEqual(
    await run(new ProviderNode(ctx), 'stream_ready', { stream_id: started.stream_id }),
    { started: true },
  );
  await until(() => published.some((entry) => eventOf(entry) === 'done'));
  assert.ok(published.every((entry) => entry.topic === `provider.stream.${started.stream_id}`));
  assert.deepEqual(
    published.map(eventOf),
    ['chunk', 'chunk', 'done'],
    'both deltas survive: the room was open before the model was dialled',
  );
  assert.deepEqual(
    published
      .filter((entry) => eventOf(entry) === 'chunk')
      .map(
        (entry) => (entry.value as { chunk: { delta: { content?: string } } }).chunk.delta.content,
      ),
    ['he', 'llo'],
  );
});

test('a stream is forgotten once it ends: its id cannot be started or cancelled again', async () => {
  const fetcher = chatCompletionsStream(['only']);
  const published: Published[] = [];
  const ctx = context(fetcher.fetch, published);
  await saveWork(new ProviderNode(ctx));
  const started = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
    name: 'work',
    messages: [{ role: 'user', content: 'hi' }],
  });
  await run(new ProviderNode(ctx), 'stream_ready', { stream_id: started.stream_id });
  await until(() => published.some((entry) => eventOf(entry) === 'done'));

  await assert.rejects(
    run(new ProviderNode(ctx), 'stream_ready', { stream_id: started.stream_id }),
    /no provider stream/,
  );
  assert.deepEqual(
    await run(new ProviderNode(ctx), 'cancel_stream', { stream_id: started.stream_id }),
    { canceled: false },
  );
});

test('cancelling before stream_ready drops the stream and never dials the model', async () => {
  const fetcher = chatCompletionsStream(['never']);
  const published: Published[] = [];
  const ctx = context(fetcher.fetch, published);
  await saveWork(new ProviderNode(ctx));
  const started = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
    name: 'work',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(
    await run(new ProviderNode(ctx), 'cancel_stream', { stream_id: started.stream_id }),
    { canceled: true },
  );
  assert.equal(fetcher.calls.length, 0, 'a stream nobody opened costs no request');
  const done = published.at(-1)?.value as { event?: string; canceled?: boolean };
  assert.equal(done.event, 'done');
  assert.equal(done.canceled, true);
  assert.deepEqual(
    await run(new ProviderNode(ctx), 'cancel_stream', { stream_id: started.stream_id }),
    { canceled: false },
    'the id is gone once it is cancelled',
  );
});

test('cancelling while streaming stops it and closes the stream once', async () => {
  const fetcher = chatCompletionsHangingStream('first');
  const published: Published[] = [];
  const ctx = context(fetcher.fetch, published);
  await saveWork(new ProviderNode(ctx));
  const started = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
    name: 'work',
    messages: [{ role: 'user', content: 'hi' }],
  });
  await run(new ProviderNode(ctx), 'stream_ready', { stream_id: started.stream_id });
  await until(() => published.some((entry) => eventOf(entry) === 'chunk'));

  assert.deepEqual(
    await run(new ProviderNode(ctx), 'cancel_stream', { stream_id: started.stream_id }),
    { canceled: true },
  );
  await until(() => published.some((entry) => eventOf(entry) === 'done'));
  assert.deepEqual(published.map(eventOf), ['chunk', 'done']);
  assert.equal((published.at(-1)?.value as { canceled: boolean }).canceled, true);
  assert.deepEqual(
    await run(new ProviderNode(ctx), 'cancel_stream', { stream_id: started.stream_id }),
    { canceled: false },
  );
});

test('two streams run side by side, each on the topic its own id names', async () => {
  const fetcher = chatCompletionsStream(['a']);
  const published: Published[] = [];
  const ctx = context(fetcher.fetch, published);
  await saveWork(new ProviderNode(ctx));
  const first = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
    name: 'work',
    messages: [{ role: 'user', content: 'one' }],
  });
  const second = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
    name: 'work',
    messages: [{ role: 'user', content: 'two' }],
  });
  assert.notEqual(first.stream_id, second.stream_id);
  await run(new ProviderNode(ctx), 'stream_ready', { stream_id: first.stream_id });
  await run(new ProviderNode(ctx), 'stream_ready', { stream_id: second.stream_id });
  await until(() => published.filter((entry) => eventOf(entry) === 'done').length === 2);
  const topics = new Set(published.map((entry) => entry.topic));
  assert.deepEqual(
    [...topics].sort(),
    [`provider.stream.${first.stream_id}`, `provider.stream.${second.stream_id}`].sort(),
  );
  for (const entry of published)
    assert.equal(
      (entry.value as { stream_id: string }).stream_id,
      entry.topic.replace('provider.stream.', ''),
      'every event carries the id its topic names',
    );
});

test('a bus that goes away mid-stream cannot take the provider process with it', async () => {
  // The publishes of a stream happen after the call that asked for it was answered, so a throw from
  // one has no caller to go to: it used to end the whole process (an unhandled rejection from a
  // floating task), and with it every other caller's stream. A dead bus is a lost event, nothing more.
  const fetcher = chatCompletionsStream(['one', 'two']);
  const published: Published[] = [];
  const ctx = context(fetcher.fetch, published);
  const push = ctx.publish;
  let broken = false;
  ctx.publish = (topic, value) => {
    if (broken) throw new Error('bus session is not open');
    push(topic, value);
  };
  await saveWork(new ProviderNode(ctx));

  const first = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
    name: 'work',
    messages: [{ role: 'user', content: 'hi' }],
  });
  await run(new ProviderNode(ctx), 'stream_ready', { stream_id: first.stream_id });
  await until(() => published.some((entry) => eventOf(entry) === 'chunk'));
  broken = true;

  // The stream finishes into a dead bus: no throw escapes (an unhandled rejection would fail this
  // whole file), the session is still cleaned up, and the node keeps serving.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    await run(new ProviderNode(ctx), 'cancel_stream', { stream_id: first.stream_id }),
    { canceled: false },
    'the stream is gone even though its done event was lost',
  );
  broken = false;
  const second = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
    name: 'work',
    messages: [{ role: 'user', content: 'again' }],
  });
  assert.notEqual(second.stream_id, first.stream_id);
  const before = published.length;
  await run(new ProviderNode(ctx), 'stream_ready', { stream_id: second.stream_id });
  await until(() => published.slice(before).some((entry) => eventOf(entry) === 'done'));
  assert.deepEqual(
    published.slice(before).map(eventOf),
    ['chunk', 'chunk', 'done'],
    'the next stream is served as if nothing happened',
  );
});

test('a stream that cannot connect says so and ends, rather than answering nothing', async () => {
  const pause = retryPause.for;
  retryPause.for = async () => {};
  try {
    const fetcher = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const published: Published[] = [];
    const ctx = context(fetcher, published);
    await saveWork(new ProviderNode(ctx));

    const started = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
      name: 'work',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // The failure cannot be the answer of `stream_ready`: the caller is already listening, so it is
    // an `error` event and then a `done`, never a silent end and never a rejected call.
    assert.deepEqual(
      await run(new ProviderNode(ctx), 'stream_ready', { stream_id: started.stream_id }),
      { started: true },
    );
    await until(() => published.some((entry) => eventOf(entry) === 'done'));
    assert.deepEqual(published.map(eventOf), ['error', 'done']);
    const failure = (published[0]?.value as { error: string }).error;
    assert.match(
      failure,
      new RegExp(
        `^provider "work" cannot reach the model endpoint x[.]test after ${RETRY_ATTEMPTS} attempts: `,
      ),
    );
    assert.equal((published[1]?.value as { canceled: boolean }).canceled, false);
    assert.equal(
      (published[1]?.value as { stream_id: string }).stream_id,
      started.stream_id,
      'even the end of a failed stream names the stream it belongs to',
    );
  } finally {
    retryPause.for = pause;
  }
});

test('the page follows the name serve registered, not the package id', async () => {
  // Local mode is the same page under another address: the switch it draws has to call
  // `local-provider.providers`, so the injected name is the registered one the host handed in.
  const local = new ProviderNode(context(async () => new Response('{}'), [], 'local-provider'));
  assert.match(await run<string>(local, 'ui', {}), /const INJECTED = "local-provider";/);

  const shared = new ProviderNode(context(async () => new Response('{}')));
  assert.match(await run<string>(shared, 'ui', {}), /const INJECTED = "provider";/);
});

test('local mode keeps its rows in a file, not in the bus history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-local-'));
  const file = join(dir, 'nested', 'local-provider.json');
  const before = { ...process.env };
  Object.assign(process.env, { NODE_AGENT_PROVIDER_CONFIG: file });
  delete process.env.NODE_AGENT_MODEL_URL;
  delete process.env.NODE_AGENT_MODEL_KEY;
  delete process.env.NODE_AGENT_MODEL_NAME;
  try {
    // Any call at all would be a bug here: the local node's rows belong to the machine it runs on,
    // so the context is watched rather than merely stubbed.
    const asked: string[] = [];
    const ctx = context(async () => new Response('{}'), [], 'local-provider');
    const busCall = ctx.call;
    ctx.call = async <T>(node: string, cap: string, args: ToolArgs): Promise<T> => {
      asked.push(`${node}.${cap}`);
      return await busCall<T>(node, cap, args);
    };

    const saved = await run<{ persistent: boolean }>(new ProviderNode(ctx), 'providers', {
      action: 'save',
      name: 'near',
      config: { type: 'openai', api_key: 'k', model_name: 'm', timeout: 3 },
    });
    assert.equal(saved.persistent, true);
    assert.deepEqual(asked, []);

    const document = JSON.parse(readFileSync(file, 'utf8')) as {
      providers: Record<string, { model_name?: string }>;
    };
    assert.deepEqual(Object.keys(document.providers).sort(), ['default', 'near']);
    assert.equal(document.providers.near?.model_name, 'm');
    // The rows carry an API key in clear text: the file is private to this user, not to everyone on
    // the machine, and its directory keeps a listing of it private too.
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);

    // A second process reads the same file back: that is what "stored locally" has to mean.
    const listed = await run<{ providers: { name: string }[]; persistent: boolean }>(
      new ProviderNode(context(async () => new Response('{}'), [], 'local-provider')),
      'providers',
      { action: 'list' },
    );
    assert.equal(listed.persistent, true);
    assert.deepEqual(
      listed.providers.map((row) => row.name),
      ['default', 'near'],
    );
  } finally {
    process.env = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
