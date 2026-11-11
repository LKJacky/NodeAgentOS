import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  AnthropicProvider,
  buildProvider,
  HttpError,
  OpenAIProvider,
  ResponsesProvider,
  ProviderCallError,
  RETRY_ATTEMPTS,
  retryAfterMsOf,
  retryDelaySeconds,
  retryPause,
  retryPolicy,
  type RetryPolicy,
  type StreamOutput,
  UnreachableError,
} from '../src/providers/index.ts';

type Seen = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sse(events: string[]): Response {
  return new Response(
    events.map((event) => `event: ${JSON.parse(event).type}\ndata: ${event}\n\n`).join(''),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

test('openai chat sends the neutral transcript and returns a neutral message', async () => {
  const seen: Seen[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return json({
      choices: [
        { message: { role: 'assistant', content: 'hello', tool_calls: [{ id: 'call_1' }] } },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }) as typeof fetch;
  const provider = OpenAIProvider.build(
    {
      type: 'openai',
      api_key: 'sk-test',
      organization: 'org_1',
      model_name: 'gpt-test',
      base_url: 'https://example.test/v1/',
      thinking_effort: 'high',
    },
    fetcher,
  );
  const out = await provider.chat([{ role: 'user', content: 'hi', usage: 1 }], null, 12);
  assert.equal(seen[0]?.url, 'https://example.test/v1/chat/completions');
  const headers = new Headers(seen[0]?.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer sk-test');
  assert.equal(headers.get('openai-organization'), 'org_1');
  const body = JSON.parse(String(seen[0]?.init.body));
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.max_completion_tokens, 12);
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.messages[0].usage, undefined, 'local timing fields do not reach the wire');
  assert.equal(out.message.content, 'hello');
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('anthropic uses the official client and the Messages translation', async () => {
  const seen: Seen[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'a' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 4, output_tokens: 3 },
    });
  }) as typeof fetch;
  const provider = AnthropicProvider.build(
    {
      type: 'anthropic',
      api_key: 'sk-ant',
      model_name: 'claude-test',
      base_url: 'https://claude.test/v1',
    },
    fetcher,
  );
  const out = await provider.chat(
    [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tool_0', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tool_0', content: 'file' },
    ],
    [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  );
  assert.equal(seen[0]?.url, 'https://claude.test/v1/messages');
  const headers = new Headers(seen[0]?.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer sk-ant');
  assert.ok(headers.get('anthropic-version'));
  const body = JSON.parse(String(seen[0]?.init.body));
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.messages[0].role, 'user');
  assert.deepEqual(body.messages[0].content[0], { type: 'text', text: 'SYSTEM MESSAGE：be brief' });
  assert.deepEqual(body.messages[0].content[1], { type: 'text', text: 'hi' });
  assert.equal(body.messages[1].content[0].type, 'tool_use');
  assert.equal(body.messages[2].content[0].type, 'tool_result');
  assert.equal(out.message.content, 'hello');
  assert.deepEqual(out.message.tool_calls?.[0]?.function, {
    name: 'read',
    arguments: '{"path":"a"}',
  });
  assert.deepEqual(out.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
});

test('anthropic stream events become neutral deltas and a provider state', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  const fetcher = (async () => sse(events.map((event) => JSON.stringify(event)))) as typeof fetch;
  const provider = AnthropicProvider.build(
    { type: 'anthropic', api_key: 'sk-ant', model_name: 'claude-test' },
    fetcher,
  );
  const chunks = [];
  for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }]))
    chunks.push(chunk);
  assert.equal(chunks[0]?.usage?.prompt_tokens, 2);
  assert.equal(chunks[1]?.delta.reasoning_content, 'plan');
  assert.equal(chunks[2]?.delta.content, 'hello');
  const last = chunks.at(-1);
  assert.equal(last?.delta ? Object.keys(last.delta).length : -1, 0);
  assert.equal((last?.provider_state?.content as unknown[]).length, 2);
});

test('responses sends instructions and items, and keeps the response handle', async () => {
  const seen: Seen[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return json({
      id: 'resp_1',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  }) as typeof fetch;
  const provider = ResponsesProvider.build(
    {
      type: 'responses',
      api_key: 'sk-test',
      model_name: 'gpt-5',
      base_url: 'https://example.test/v1',
    },
    fetcher,
  );
  const out = await provider.chat(
    [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    null,
    null,
    'resp_0',
  );
  assert.equal(seen[0]?.url, 'https://example.test/v1/responses');
  const body = JSON.parse(String(seen[0]?.init.body));
  assert.equal(body.instructions, 'be brief');
  assert.equal(body.previous_response_id, 'resp_0');
  assert.equal(body.max_output_tokens, 8192);
  assert.equal(body.store, true);
  assert.equal(out.previous_response_id, 'resp_1');
  assert.equal(out.message.tool_calls?.[0]?.id, 'call_1');
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('responses streams text, a tool call and the response handle as neutral chunks', async () => {
  const seen: Seen[] = [];
  const events = [
    { type: 'response.created', response: { id: 'resp_2' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, delta: 'he' },
    { type: 'response.output_text.delta', output_index: 0, delta: 'llo' },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', call_id: 'call_9', name: 'read', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path"' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: ':"a"}' },
    {
      type: 'response.completed',
      response: { id: 'resp_2', usage: { input_tokens: 5, output_tokens: 3 } },
    },
  ];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return sse(events.map((event) => JSON.stringify(event)));
  }) as typeof fetch;
  const provider = ResponsesProvider.build(
    {
      type: 'responses',
      api_key: 'sk-test',
      model_name: 'gpt-5',
      base_url: 'https://example.test/v1',
    },
    fetcher,
  );
  const chunks: StreamOutput[] = [];
  for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], null, 64))
    chunks.push(chunk);
  assert.equal(seen[0]?.url, 'https://example.test/v1/responses');
  const body = JSON.parse(String(seen[0]?.init.body));
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, 64);
  assert.equal(chunks.map((chunk) => chunk.delta.content ?? '').join(''), 'hello');
  const calls = chunks.flatMap((chunk) => chunk.delta.tool_calls ?? []);
  assert.deepEqual(calls[0], {
    index: 1,
    id: 'call_9',
    type: 'function',
    function: { name: 'read', arguments: '' },
  });
  assert.equal(calls[1]?.function?.arguments, '{"path"');
  assert.equal(calls[2]?.function?.arguments, ':"a"}');
  const last = chunks.at(-1);
  assert.deepEqual(last?.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  assert.equal(last?.previous_response_id, 'resp_2');
});

test('a gateway that buries its own message in the error body still reaches the caller', async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: '400',
          message: 'Request Error',
          param: JSON.stringify({
            error: {
              message: 'One of "input" or "previous_response_id" must be provided.',
              code: 'missing_required_parameter',
            },
          }),
          type: '',
        },
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_abc' },
      },
    )) as typeof fetch;
  const provider = ResponsesProvider.build(
    {
      type: 'responses',
      api_key: 'sk-test',
      model_name: 'gpt-5',
      base_url: 'https://example.test/v1',
    },
    fetcher,
  );
  provider.policy = { ...provider.policy, attempts: 1 };
  await assert.rejects(provider.chat([], null, 16), (error: ProviderCallError) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /Request Error/);
    assert.match(error.message, /must be provided/);
    assert.match(error.message, /missing_required_parameter/);
    assert.match(error.message, /request_id=req_abc/);
    return true;
  });
});

type Seen = { url: string; init: RequestInit };

/** A chat-completions stream of `contents`, as the endpoint sends it. */
function chatStreamOf(contents: string[]): Response {
  const events = contents.map((content) =>
    JSON.stringify({ choices: [{ index: 0, delta: { content } }] }),
  );
  const usage = JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const body = [...events, usage].map((event) => `data: ${event}\n\n`).join('');
  return new Response(`${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A stream whose body carries one chunk and then breaks, the way a dropped connection does. */
function streamThatDiesAfterOneChunk(): Response {
  const chunk = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'he' } }] })}\n\n`;
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
      // A tick, so the reader takes the chunk before the socket goes away: `error` after an
      // `enqueue` throws the queued bytes away, and this stream has to deliver one first.
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A fetcher whose socket never opens; the real reason lives in `cause`, as undici puts it there. */
function unreachableFetcher(calls: { count: number }): typeof fetch {
  return (async () => {
    calls.count += 1;
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    throw new TypeError('fetch failed', { cause });
  }) as typeof fetch;
}

function withoutPauses(): () => void {
  const pause = retryPause.for;
  retryPause.for = async () => {};
  return () => {
    retryPause.for = pause;
  };
}

const ROW = {
  type: 'openai',
  api_key: 'sk-test',
  model_name: 'gpt-test',
  base_url: 'https://example.test/v1',
};
/** One answer carrying `status`, with the body a gateway would send, counted per call. */
function statusFetcher(
  status: number,
  body: unknown,
  calls: { count: number },
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () => {
    calls.count += 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
}

/** Every status the request asked to retry, and the kind its failure is finally reported as. */
const RETRIED_STATUSES: Array<[number, string]> = [
  [400, 'http'],
  [401, 'http'],
  [403, 'http'],
  [404, 'http'],
  [408, 'http'],
  [409, 'http'],
  [425, 'http'],
  [429, 'rate_limit'],
  [500, 'server'],
  [502, 'server'],
  [503, 'server'],
  [529, 'server'],
];

type PolicyChange = {
  attempts?: number;
  backoffSeconds?: number;
  maxDelaySeconds?: number;
  random?: () => number;
  excludedStatuses?: Iterable<number>;
};

/** Run `work` under a policy a deployment could configure, then put the shared policy back. */
async function withPolicy(change: PolicyChange, work: () => Promise<void>): Promise<void> {
  const before: RetryPolicy = { ...retryPolicy, excludedStatuses: retryPolicy.excludedStatuses };
  retryPolicy.attempts = change.attempts ?? before.attempts;
  retryPolicy.backoffSeconds = change.backoffSeconds ?? before.backoffSeconds;
  retryPolicy.maxDelaySeconds = change.maxDelaySeconds ?? before.maxDelaySeconds;
  retryPolicy.random = change.random ?? before.random;
  if (change.excludedStatuses !== undefined)
    retryPolicy.excludedStatuses = new Set(change.excludedStatuses);
  try {
    await work();
  } finally {
    retryPolicy.attempts = before.attempts;
    retryPolicy.backoffSeconds = before.backoffSeconds;
    retryPolicy.maxDelaySeconds = before.maxDelaySeconds;
    retryPolicy.random = before.random;
    retryPolicy.excludedStatuses = before.excludedStatuses;
  }
}

/** Replace the pause with a recorder: the wait is asserted, never slept through. */
function recordedPauses(waits: number[]): () => void {
  const pause = retryPause.for;
  retryPause.for = async (seconds: number) => {
    waits.push(seconds);
  };
  return () => {
    retryPause.for = pause;
  };
}

test('a connection that dropped is retried, and the answer still arrives', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const fetcher = (async () => {
      calls.count += 1;
      if (calls.count < 3) throw new TypeError('fetch failed');
      return json({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });
    }) as typeof fetch;
    const provider = OpenAIProvider.build(ROW, fetcher);

    const out = await provider.chat([{ role: 'user', content: 'hi' }]);

    assert.equal(calls.count, 3);
    assert.equal(out.message.content, 'hello');
  } finally {
    restore();
  }
});

test('a connection that never comes back names the provider, the host and the attempts', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const provider = buildProvider(ROW, unreachableFetcher(calls), 'work');

    await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
      assert.ok(error instanceof UnreachableError);
      // The bare "Connection error." the SDK writes is not an answer anybody can act on.
      assert.match(
        error.message,
        new RegExp(
          `^provider "work" cannot reach the model endpoint example[.]test after ${RETRY_ATTEMPTS} attempts: `,
        ),
      );
      assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
      return true;
    });
    assert.equal(calls.count, RETRY_ATTEMPTS);
  } finally {
    restore();
  }
});

test('every HTTP failure is retried by default, and the spent policy says so once', async () => {
  const restore = withoutPauses();
  try {
    for (const [status, kind] of RETRIED_STATUSES) {
      const calls = { count: 0 };
      const provider = buildProvider(
        ROW,
        statusFetcher(status, { error: { message: `the endpoint said ${status}` } }, calls),
        'work',
      );

      await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
        assert.ok(error instanceof ProviderCallError, `${status}: wrapped`);
        assert.equal(error.provider, 'work', `${status}: provider`);
        assert.equal(error.host, 'example.test', `${status}: host`);
        assert.equal(error.status, status, `${status}: status`);
        assert.equal(error.kind, kind, `${status}: kind`);
        assert.equal(error.attempts, RETRY_ATTEMPTS, `${status}: attempts`);
        return true;
      });
      assert.equal(calls.count, RETRY_ATTEMPTS, `${status}: attempts made`);
    }
  } finally {
    restore();
  }
});

test('a status is skipped only when the deployment excluded it, never quietly', async () => {
  const restore = withoutPauses();
  try {
    await withPolicy({ excludedStatuses: [401, 403] }, async () => {
      for (const status of [401, 403]) {
        const calls = { count: 0 };
        const provider = buildProvider(
          ROW,
          statusFetcher(status, { error: { message: `the endpoint said ${status}` } }, calls),
          'work',
        );

        await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
          assert.ok(error instanceof ProviderCallError, `${status}: wrapped`);
          assert.equal(error.status, status, `${status}: status`);
          assert.equal(error.attempts, 1, `${status}: one attempt`);
          assert.match(error.message, /after 1 attempt:/);
          return true;
        });
        assert.equal(calls.count, 1, `${status}: sent once`);
      }
      // A status nobody excluded keeps retrying in the same run: the exclusion is per status.
      const calls = { count: 0 };
      const provider = buildProvider(
        ROW,
        statusFetcher(404, { error: { message: 'no route' } }, calls),
        'work',
      );
      await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]));
      assert.equal(calls.count, RETRY_ATTEMPTS);
    });
  } finally {
    restore();
  }
});

test('a 429 with Retry-After waits exactly what the endpoint asked for', async () => {
  const waits: number[] = [];
  const restore = recordedPauses(waits);
  try {
    const calls = { count: 0 };
    const fetcher = (async () => {
      calls.count += 1;
      if (calls.count === 1)
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
        });
      return json({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });
    }) as typeof fetch;
    const provider = buildProvider(ROW, fetcher, 'work');

    const out = await provider.chat([{ role: 'user', content: 'hi' }]);

    assert.equal(out.message.content, 'hello');
    assert.equal(calls.count, 2);
    assert.deepEqual(waits, [2], 'the header wins over the computed backoff');
  } finally {
    restore();
  }
});

test('an upstream concurrency body is retried whatever status carries it', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const busy = {
      error: {
        code: 'concurrency_limit_exceeded',
        message: 'Concurrent requests limit reached for this model',
      },
    };
    const fetcher = (async () => {
      calls.count += 1;
      if (calls.count === 1) return json(busy, 400);
      return json({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });
    }) as typeof fetch;
    const provider = buildProvider(ROW, fetcher, 'work');

    const out = await provider.chat([{ role: 'user', content: 'hi' }]);

    assert.equal(out.message.content, 'hello');
    assert.equal(calls.count, 2);
  } finally {
    restore();
  }
});

test('a concurrency body a gateway says in Chinese, on a 403, is retried too', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const fetcher = (async () => {
      calls.count += 1;
      if (calls.count === 1)
        return json({ error: { code: '403', message: '当前并发数已超出限制，请稍后重试' } }, 403);
      return json({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });
    }) as typeof fetch;
    const provider = buildProvider(ROW, fetcher, 'work');

    const out = await provider.chat([{ role: 'user', content: 'hi' }]);

    assert.equal(out.message.content, 'hello');
    assert.equal(calls.count, 2);
  } finally {
    restore();
  }
});

test('a concurrency slot that never frees up is reported as a rate limit, not a plain 400', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const provider = buildProvider(
      ROW,
      statusFetcher(
        400,
        { error: { code: 'concurrency_limit_exceeded', message: 'too many concurrent requests' } },
        calls,
      ),
      'work',
    );

    await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
      assert.ok(error instanceof ProviderCallError);
      assert.equal(error.kind, 'rate_limit');
      assert.equal(error.status, 400);
      assert.match(error.message, /kind=rate_limit, status=400/);
      return true;
    });
    assert.equal(calls.count, RETRY_ATTEMPTS);
  } finally {
    restore();
  }
});

test('an excluded status does not silence a concurrency answer: a wait is not a verdict', async () => {
  const restore = withoutPauses();
  try {
    await withPolicy({ excludedStatuses: [400, 429] }, async () => {
      const calls = { count: 0 };
      const provider = buildProvider(
        ROW,
        statusFetcher(400, { error: { code: 'concurrency_limit_exceeded' } }, calls),
        'work',
      );
      await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]));
      assert.equal(calls.count, RETRY_ATTEMPTS);
    });
  } finally {
    restore();
  }
});

test('the attempt ceiling is the policy, not the wire', async () => {
  const restore = withoutPauses();
  try {
    await withPolicy({ attempts: 3 }, async () => {
      const calls = { count: 0 };
      const provider = buildProvider(
        ROW,
        statusFetcher(503, { error: { message: 'busy' } }, calls),
        'work',
      );

      await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.attempts, 3);
        assert.match(error.message, /after 3 attempts:/);
        return true;
      });
      assert.equal(calls.count, 3);
    });
  } finally {
    restore();
  }
});

test('the backoff doubles from the base, is jittered, and is capped', () => {
  const policy: RetryPolicy = {
    attempts: 8,
    backoffSeconds: 1,
    maxDelaySeconds: 60,
    excludedStatuses: new Set(),
    random: () => 0,
  };
  assert.equal(retryDelaySeconds(1, policy), 0.5);
  assert.equal(retryDelaySeconds(2, policy), 1);
  assert.equal(retryDelaySeconds(3, policy), 2);
  assert.equal(retryDelaySeconds(4, policy), 4);
  const longest: RetryPolicy = { ...policy, random: () => 1 };
  assert.equal(retryDelaySeconds(1, longest), 1);
  assert.equal(retryDelaySeconds(5, longest), 16);
  assert.equal(retryDelaySeconds(20, longest), 60, 'never longer than the cap');
  assert.equal(retryDelaySeconds(20, policy), 30, 'the jittered wait respects the cap too');
});

test('a stream that cannot connect is retried until its first chunk', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const fetcher = (async () => {
      calls.count += 1;
      if (calls.count === 1) throw new TypeError('fetch failed');
      return chatStreamOf(['he', 'llo']);
    }) as typeof fetch;
    const provider = OpenAIProvider.build(ROW, fetcher);

    const contents: string[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }])) {
      if (typeof chunk.delta.content === 'string') contents.push(chunk.delta.content);
    }

    assert.equal(calls.count, 2);
    assert.deepEqual(contents, ['he', 'llo']);
  } finally {
    restore();
  }
});

test('a stream refused with a status before its first chunk is retried', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const fetcher = (async () => {
      calls.count += 1;
      if (calls.count === 1) return json({ error: { message: 'busy' } }, 503);
      return chatStreamOf(['he', 'llo']);
    }) as typeof fetch;
    const provider = OpenAIProvider.build(ROW, fetcher);

    const contents: string[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }])) {
      if (typeof chunk.delta.content === 'string') contents.push(chunk.delta.content);
    }

    assert.equal(calls.count, 2);
    assert.deepEqual(contents, ['he', 'llo']);
  } finally {
    restore();
  }
});

test('a stream that broke after a chunk is not retried and says where it broke', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const fetcher = (async () => {
      calls.count += 1;
      return streamThatDiesAfterOneChunk();
    }) as typeof fetch;
    const provider = buildProvider(ROW, fetcher, 'work');

    const seen: unknown[] = [];
    await assert.rejects(
      (async () => {
        for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }]))
          seen.push(chunk.delta.content);
      })(),
      (error: unknown) => {
        assert.ok(error instanceof UnreachableError);
        assert.equal(error.streamStarted, true);
        assert.match(
          error.message,
          /^provider "work" failed while streaming from the model endpoint example[.]test after 1 attempt: /,
        );
        return true;
      },
    );
    // The part already read is out; a retry would repeat it, so the stream fails instead.
    assert.deepEqual(seen, ['he']);
    assert.equal(calls.count, 1);
  } finally {
    restore();
  }
});

test('an upstream 429 is retried, then reported with kind, status and the original type', async () => {
  const restore = withoutPauses();
  try {
    const calls = { count: 0 };
    const fetcher = (async () => {
      calls.count += 1;
      return new Response('{"error":{"message":"slow down"}}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }) as typeof fetch;
    const provider = buildProvider(ROW, fetcher, 'work');

    await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
      assert.ok(error instanceof ProviderCallError);
      assert.equal(error.kind, 'rate_limit');
      assert.equal(error.status, 429);
      assert.match(error.message, /after 8 attempts:/);
      assert.match(error.message, /RateLimitError|429/);
      assert.match(error.message, /kind=rate_limit, status=429/);
      return true;
    });
    assert.equal(calls.count, RETRY_ATTEMPTS);
  } finally {
    restore();
  }
});

test('a parsed Retry-After survives to the retry wait', () => {
  assert.equal(retryAfterMsOf(new HttpError(429, 'wait', 2_500)), 2_500);
  assert.equal(
    retryAfterMsOf(
      Object.assign(new Error('rate limited'), {
        headers: new Headers({ 'retry-after': '3' }),
      }),
    ),
    3_000,
  );
});

test('a cancelled request is not retried and is not called a connection failure', async () => {
  const calls = { count: 0 };
  const fetcher = (async () => {
    calls.count += 1;
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    throw aborted;
  }) as typeof fetch;
  const provider = buildProvider(ROW, fetcher, 'work');

  await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), (error: unknown) => {
    // The SDK wraps the abort in its own connection error; the cancel in the chain is what says
    // not to retry, and it is not a host that could not be reached either.
    assert.ok(!(error instanceof UnreachableError));
    assert.ok(error instanceof ProviderCallError);
    assert.equal(error.kind, 'aborted');
    return true;
  });
  assert.equal(calls.count, 1);
});

test('a cancel that lands while the request waits sends no second request', async () => {
  const controller = new AbortController();
  const pause = retryPause.for;
  retryPause.for = async () => {
    controller.abort();
  };
  try {
    const calls = { count: 0 };
    const provider = buildProvider(ROW, unreachableFetcher(calls), 'work');

    await assert.rejects(
      (async () => {
        for await (const chunk of provider.chatStream(
          [{ role: 'user', content: 'hi' }],
          null,
          null,
          null,
          controller.signal,
        ))
          assert.fail(`no chunk should arrive on a cancelled stream: ${JSON.stringify(chunk)}`);
      })(),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.kind, 'aborted');
        assert.equal(error.attempts, 1);
        return true;
      },
    );
    assert.equal(calls.count, 1);
  } finally {
    retryPause.for = pause;
  }
});

test('the retry environment is read once, and ranges and classes are understood', () => {
  const source = new URL('../src/providers/base.ts', import.meta.url).href;
  const read = (env: Record<string, string>, body: string): string =>
    execFileSync(process.execPath, ['--input-type=module', '-e', body.replace('SOURCE', source)], {
      env: { ...process.env, NODE_AGENT_MODEL_NO_RETRY_STATUSES: '', ...env },
      encoding: 'utf8',
    }).trim();

  assert.equal(
    read(
      { NODE_AGENT_MODEL_NO_RETRY_STATUSES: '401,403,400-402' },
      'import { RETRY_EXCLUDED_STATUSES } from "SOURCE";\n' +
        'console.log([...RETRY_EXCLUDED_STATUSES].sort((a, b) => a - b).join(","));',
    ),
    '400,401,402,403',
  );
  assert.equal(
    read(
      {
        NODE_AGENT_MODEL_ATTEMPTS: '3',
        NODE_AGENT_MODEL_BACKOFF: '2',
        NODE_AGENT_MODEL_MAX_DELAY: '5',
      },
      'import { retryPolicy } from "SOURCE";\n' +
        'console.log([retryPolicy.attempts, retryPolicy.backoffSeconds, retryPolicy.maxDelaySeconds].join(","));',
    ),
    '3,2,5',
  );
});
