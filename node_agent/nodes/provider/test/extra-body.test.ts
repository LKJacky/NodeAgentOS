// The row's own fields for the wire: `extra_body`.
//
// Two questions are asked here, and both are asked end to end. The first is the row's: an
// `extra_body` is saved, read back by another process, and cleared. The second is the request's: a
// throwaway HTTP server on 127.0.0.1 reads the bytes a chat and a stream really post, so nothing is
// asserted about a body that only exists in a mock. The refusals — a string, an array, a reserved
// key, a protocol with no chat-completions body — are checked where a row is built.
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { NodeContext, ToolArgs } from '@node-agent/sdk';
import { ProviderNode } from '../src/index.ts';
import { buildProvider, type JsonObject } from '../src/providers/index.ts';
import { extraBodyOf } from '../src/providers/base.ts';

type Published = { topic: string; value: unknown };

/** The node's context with an in-memory history, so a save really does survive a new instance. */
function context(fetchImpl: typeof fetch, published: Published[] = []): NodeContext {
  const units = new Map<string, { meta: Record<string, unknown>; revision: number }>();
  return {
    nodeId: 'provider',
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

/** Wait for the stream worker to publish its last event. */
async function until(test: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the stream');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A local endpoint that answers a chat and a stream, and keeps every body it was posted. */
async function endpoint(): Promise<{
  baseUrl: string;
  seen: JsonObject[];
  close: () => Promise<void>;
}> {
  const seen: JsonObject[] = [];
  const server = createServer((request, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject;
      seen.push(body);
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const deltas = ['he', 'llo'].map((content) =>
        JSON.stringify({ choices: [{ index: 0, delta: { content } }] }),
      );
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${deltas.map((delta) => `data: ${delta}\n\n`).join('')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The example the task names: a top-level pair and a nested object. */
const EXTRA: JsonObject = {
  top_k: -1,
  for_training: false,
  chat_template_kwargs: { thinking: false },
};

function row(baseUrl: string, extra?: JsonObject | null): JsonObject {
  return {
    type: 'openai',
    model_name: 'qwen3-32b',
    api_key: 'sk-test',
    base_url: baseUrl,
    ...(extra === undefined ? {} : { extra_body: extra }),
  };
}

test('a saved extra_body is read back as saved, and clearing it clears the row', async () => {
  const ctx = context(async () => new Response('{}'));
  const saved = await run<{ providers: { name: string; config: JsonObject }[] }>(
    new ProviderNode(ctx),
    'providers',
    { action: 'save', name: 'work', config: row('https://x.test/v1', EXTRA) },
  );
  assert.deepEqual(
    saved.providers.find((provider) => provider.name === 'work')?.config.extra_body,
    EXTRA,
    'the object comes back whole, nested fields included',
  );

  // A second process reads what the first one persisted: the field is in the stored document.
  const reopened = await run<{ providers: { name: string; config: JsonObject }[] }>(
    new ProviderNode(ctx),
    'providers',
    { action: 'list' },
  );
  assert.deepEqual(
    reopened.providers.find((provider) => provider.name === 'work')?.config.extra_body,
    EXTRA,
  );

  // Clearing the box saves null, and nothing of the old object is left behind.
  const cleared = await run<{ providers: { name: string; config: JsonObject }[] }>(
    new ProviderNode(ctx),
    'providers',
    { action: 'save', name: 'work', config: { ...row('https://x.test/v1'), extra_body: null } },
  );
  assert.equal(
    cleared.providers.find((provider) => provider.name === 'work')?.config.extra_body,
    null,
  );
  const emptied = await run<{ providers: { name: string; config: JsonObject }[] }>(
    new ProviderNode(ctx),
    'providers',
    { action: 'list' },
  );
  assert.equal(
    emptied.providers.find((provider) => provider.name === 'work')?.config.extra_body,
    null,
  );
});

test('chat and chatStream post the extra fields a local endpoint reads', async () => {
  const server = await endpoint();
  const published: Published[] = [];
  const ctx = context(fetch, published);
  try {
    await run(new ProviderNode(ctx), 'providers', {
      action: 'save',
      name: 'work',
      config: row(server.baseUrl, EXTRA),
    });

    const answer = await run<{ message: { content: string } }>(new ProviderNode(ctx), 'chat', {
      name: 'work',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(answer.message.content, 'hello');

    const started = await run<{ stream_id: string }>(new ProviderNode(ctx), 'start_stream', {
      name: 'work',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await run(new ProviderNode(ctx), 'stream_ready', { stream_id: started.stream_id });
    await until(() =>
      published.some((entry) => (entry.value as { event?: string }).event === 'done'),
    );

    assert.equal(server.seen.length, 2, 'one request for the chat and one for the stream');
    const [chat, stream] = server.seen;
    for (const [label, body] of [
      ['chat', chat],
      ['chatStream', stream],
    ] as const) {
      // The extra fields, top-level and nested, reach the wire exactly as the row spelled them.
      assert.equal(body?.top_k, -1, `${label} keeps the top-level number`);
      assert.equal(body?.for_training, false, `${label} keeps the top-level boolean`);
      assert.deepEqual(
        body?.chat_template_kwargs,
        { thinking: false },
        `${label} keeps the nested object`,
      );
      // And the request is still the caller's: nothing of the spine was replaced.
      assert.equal(body?.model, 'qwen3-32b', `${label} keeps the row's model`);
      assert.deepEqual(
        body?.messages,
        [{ role: 'user', content: 'hi' }],
        `${label} keeps the caller's transcript`,
      );
    }
    assert.equal(chat?.stream, undefined, 'a chat is not a stream');
    assert.equal(stream?.stream, true, 'a stream still streams');
    assert.deepEqual(
      stream?.stream_options,
      { include_usage: true },
      'and still asks for the usage of its last chunk',
    );

    const deltas = published
      .filter((entry) => (entry.value as { event?: string }).event === 'chunk')
      .map(
        (entry) => (entry.value as { chunk: { delta: { content?: string } } }).chunk.delta.content,
      );
    assert.deepEqual(deltas, ['he', 'llo'], 'the extra fields did not cost the stream its deltas');
  } finally {
    await server.close();
  }
});

test('a row saved before extra_body existed sends exactly the body it used to', async () => {
  const server = await endpoint();
  try {
    const plain = buildProvider(row(server.baseUrl), fetch);
    await plain.chat([{ role: 'user', content: 'hi' }], null, 12);
    const stream = buildProvider(row(server.baseUrl), fetch).chatStream(
      [{ role: 'user', content: 'hi' }],
      null,
      12,
    );
    for await (const _chunk of stream) {
      // Drain it: the body was captured before the first delta.
    }

    const [chat, streamed] = server.seen;
    assert.deepEqual(Object.keys(chat ?? {}).sort(), [
      'max_completion_tokens',
      'messages',
      'model',
    ]);
    assert.deepEqual(Object.keys(streamed ?? {}).sort(), [
      'max_completion_tokens',
      'messages',
      'model',
      'stream',
      'stream_options',
    ]);
  } finally {
    await server.close();
  }
});

test('a deepseek row sends extra_body too, and keeps its thinking switch', async () => {
  const seen: JsonObject[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)) as JsonObject);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const provider = buildProvider(
    {
      type: 'deepseek',
      api_key: 'sk-test',
      model_name: 'deepseek-chat',
      thinking_effort: 'high',
      extra_body: { chat_template_kwargs: { thinking: false } },
    },
    fetcher,
  );
  await provider.chat([{ role: 'user', content: 'hi' }]);
  const body = seen[0];
  assert.deepEqual(body?.thinking, { type: 'enabled' }, 'the effort still arms thinking');
  assert.deepEqual(body?.chat_template_kwargs, { thinking: false }, 'and the extra field is there');
  assert.deepEqual(
    provider.dump().extra_body,
    { chat_template_kwargs: { thinking: false } },
    'the row saves what it sends',
  );
});

test('an extra_body that is not a JSON object is refused where the row is built', async () => {
  for (const extra of ['{"top_k": -1}', 'top_k', ['top_k'], 3, true]) {
    assert.throws(
      () => buildProvider(row('https://x.test/v1', extra as unknown as JsonObject), fetch),
      /extra_body must be a JSON object or null/,
      `${JSON.stringify(extra)} is not an object`,
    );
  }
  assert.equal(
    extraBodyOf({ extra_body: {} }),
    null,
    'an empty object means nothing extra, the same as null',
  );
  assert.deepEqual(extraBodyOf({ extra_body: EXTRA }), EXTRA, 'and a real one survives the trip');
});

test('the fields the provider writes itself cannot be set from extra_body', async () => {
  for (const key of ['model', 'messages', 'stream', 'stream_options']) {
    assert.throws(
      () => buildProvider(row('https://x.test/v1', { [key]: 'x' }), fetch),
      new RegExp(`extra_body may not set "${key}"`),
      `${key} is the request's own spine`,
    );
  }
  // The same row is refused before it is saved, so the page can say why.
  const ctx = context(async () => new Response('{}'));
  await assert.rejects(
    run(new ProviderNode(ctx), 'providers', {
      action: 'save',
      name: 'work',
      config: row('https://x.test/v1', { model: 'someone-elses' }),
    }),
    /extra_body may not set "model"/,
  );
});

test('the page keeps the JSON box behind a folded advanced section', async () => {
  const page = await run<string>(
    new ProviderNode(context(async () => new Response('{}'))),
    'ui',
    {},
  );
  const section = /<details id="provider-advanced"[^>]*>([\s\S]*?)<\/details>/.exec(page);
  assert.ok(section, 'the page has an advanced section');
  assert.doesNotMatch(
    section[0],
    /\sopen[\s>]/,
    'and it starts folded: the five everyday fields come first',
  );
  assert.match(
    section[1] ?? '',
    /id="provider-extra-body"/,
    'the extra body lives inside the fold',
  );
  assert.match(page, /form\.advanced/, 'with a sentence of its own');
});

test('a protocol with no chat-completions body refuses extra_body instead of dropping it', async () => {
  for (const type of ['anthropic', 'responses'] as const) {
    assert.throws(
      () =>
        buildProvider(
          { type, api_key: 'sk-test', model_name: 'm', extra_body: { top_k: -1 } },
          fetch,
        ),
      /cannot send extra_body/,
      `${type} has no chat-completions body to merge into`,
    );
    // Nothing extra is still nothing extra: a row without it, or with null, builds as before.
    assert.equal(
      buildProvider({ type, api_key: 'sk-test', model_name: 'm', extra_body: null }, fetch).dump()
        .type,
      type,
    );
  }
});
