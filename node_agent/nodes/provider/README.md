# node-agent-provider

A node that owns the stack's LLM credentials and serves chat to whoever asks. It keeps no
conversation: a caller sends the whole transcript, gets an answer, and the provider remembers nothing
between requests.

The TypeScript implementation lives in src/ and the Python twin remains in python/; they expose the
same capabilities and wire translations. npm install && npm run build builds the TS node, and
npm start runs it against the bus.

Capabilities:

- `provider.providers({ action: list | save | delete, name, config })` — the named rows, never the keys
- `provider.chat({ name, messages, tools?, max_completion_tokens? })` — one finished answer
- `provider.start_stream({ name, messages, tools?, max_completion_tokens? })` → `{ stream_id, topic }` —
  an id for one stream; the model is not dialled yet
- `provider.stream_ready({ stream_id })` — the caller is subscribed to `provider.stream.<stream_id>`;
  the answer now arrives there as `chunk` events and a closing `done` (an `error` event if it fails)
- `provider.cancel_stream({ stream_id })` — stop a stream by the id it was given, started or not,
  and the page (`ui`) that makes the rows

A stream is three calls because an event is only delivered to a node that was already subscribed when
it was published: the id comes back first, the caller subscribes to it, and only then does
`stream_ready` let the model speak. No first delta can be published into an empty room, and the id
is forgotten when the stream ends, fails, is cancelled, or waits more than a minute for a ready.

A row is `{ type, model_name, base_url, timeout, api_key, organization?, thinking_effort? }`, saved in
history and handed
back by `dump`/`build`. Three protocols sit behind that one shape, which is the whole point of the node:
the agent, the page and a transcript never learn which wire an answer came from.

## The three protocols

| | `openai` | `anthropic` | `responses` |
|---|---|---|---|
| speaks | `POST {base}/chat/completions` | `POST {base}/v1/messages` | `POST {base}/responses` |
| base URL to write | `https://api.openai.com/v1` | `https://api.anthropic.com`, or a gateway prefix like `https://api.llm.mioffice.cn:18443/anthropic` | `https://api.openai.com/v1`, or a gateway like `https://api.llm.mioffice.cn:18443/v1` |
| `organization` | sent when set | never | never |
| the system prompt | a message with `role: system` | the `system` field | the `instructions` field |
| a tool call | `tool_calls`, arguments as JSON text | a `tool_use` block, arguments as an object | a `function_call` item, arguments as JSON text |
| a tool's answer | a message with `role: tool` | a `tool_result` block in a user turn | a `function_call_output` item |
| thinking effort | `reasoning_effort`, when set | `thinking` + `output_config.effort`, when set | `reasoning.effort`, when set |
| the limit | `max_completion_tokens`, optional | `max_tokens`, required — 8192 if the caller names none | `max_output_tokens`, 8192 if the caller names none |
| a stream | one delta per chunk | named events, flattened to the same deltas | named events, flattened to the same deltas |

Both non-chat-completions protocols go through their official SDK — `anthropic` for the Messages API
and `openai` for the Responses API. Their own retries are turned off, so the attempts this node
documents are the only ones that happen. `responses` needs `openai>=1.66`, where the Responses
resource arrived.

## Pointing a row at Claude

On the provider page, `Protocol` picks the wire and the rest of the form follows it — Base URL gets
that protocol's placeholder, and `Organization` disappears for a Claude row. For the MIOFFICE gateway,
whose Claude ids are served by its Anthropic surface and not by its OpenAI-shaped one:

- Protocol: **Anthropic (Claude)**
- Base URL: `https://api.llm.mioffice.cn:18443/anthropic`
- Model: `ppio/anthropic/claude-opus-5-5`
- API key: the gateway's key

That gateway does answer OpenAI-shaped requests at `https://api.llm.mioffice.cn:18443/v1`, which is why
the two protocols are both here — but with that model id it refuses (`400 Not supported model`), and
the ids it does list (`anthropic/claude-opus-5-5`) answer `401` asking for a provider prefix. The
Messages API is where the `ppio/`-prefixed ids are routed, so a Claude row that used the `openai`
protocol against this gateway would fail at the first token.

## Pointing a row at an OpenAI Responses model

OpenAI's newer API surface is Responses, and the MIOFFICE gateway follows that: an
`azure_openai/…` id is answered on `/responses` and nowhere else.

- Protocol: **OpenAI (Responses API)**
- Base URL: `https://api.llm.mioffice.cn:18443/v1`
- Model: `azure_openai/gpt-5.6-sol`
- API key: the gateway's key

That row posts to `POST {base}/responses` with `instructions` for the system prompt, an `input` list
of messages, `function_call`s and `function_call_output`s, flat function tools, and
`max_output_tokens`. A `400`/`401` comes back through the node as an error that quotes the
endpoint's own message (this gateway answers `401` with `模型不存在` for an unknown model id), so a
wrong model name is visible in the transcript instead of only a status code.

## Thinking effort

`thinking_effort` is one optional string per row, and blank means the endpoint's own default. The page
is a select beside the protocol's: `Provider default` (empty), the seven usual levels — `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max` — and `Custom…`, which reveals a text field for a
level a gateway knows and this page does not. A saved preset reopens on that preset; any other value
reopens on `Custom…` with the text field filled in.

| row value | `openai` chat | `anthropic` | `responses` |
|---|---|---|---|
| unset / blank | nothing sent | nothing sent | nothing sent |
| `none` | `reasoning_effort: "none"` | `thinking: {"type": "disabled"}`, no `output_config` | `reasoning: {"effort": "none"}` |
| `minimal` | `"minimal"` | adaptive thinking, `effort: "low"` | `"minimal"` |
| `xhigh` | `"xhigh"` | adaptive thinking, `effort: "xhigh"` | `"xhigh"` |
| `low`/`medium`/`high`/`max` | as written | adaptive thinking, `effort` as written | as written |
| anything else | as written | adaptive thinking, `effort` as written | as written |

Only `minimal` needs a name of its own: the Messages API has no such level, so it is sent as `low`.

## State: the agent chooses full context or a delta

The Responses API stores each response and can continue from it with `previous_response_id` (the
MIOFFICE gateway does exactly that: a follow-up carrying only the new question and the previous id
still answers from the earlier turn). The agent owns that policy now:

- the first request, a compression replay and a provider switch carry the whole transcript and no
  `previous_response_id`;
- an ordinary next turn carries only its unsent suffix plus the id the last response returned;
- `store: true` is sent because a response that is not stored has no id to continue from;
- the completed response's `id` is returned as the neutral `previous_response_id` in both the chat and
  streaming shapes;
- thinking/reasoning items the endpoint returns are surfaced as text (`reasoning_content`) and never
  carried back, the same way the Anthropic path treats its thinking blocks.

The Anthropic Messages API has no comparable handle. `AnthropicProvider` accepts the argument for the
common provider interface, ignores it, and returns `previous_response_id: null`; every Claude turn
therefore sends the active transcript in full.

## What is refused, and where

- a row with no `model_name`, or no key (the page says so before saving, `Provider.build` and `_body`
  say it again) — and the blank row a fresh stack starts with fails with the same sentence;
- `type` that is not one of `openai`, `anthropic`, `responses`;
- a timeout that is not a number, and a base URL the page can see is missing `http(s)://`;
- a `tool_calls` entry whose arguments are not a JSON object, named before a request leaves;
- a content part neither protocol can carry (`image_url` is translated; anything else is an error);
- an Anthropic classifier refusal (`stop_reason: "refusal"`): it is raised as an error carrying
  `stop_details.category` and `stop_details.explanation`, never returned as an empty assistant
  message. The same check runs on the `message_delta` event of a stream.

## Retries

One policy, in the base class every protocol extends — `Provider`, the `BaseProvider` of
`src/providers/base.ts`. A provider says how to make **one** attempt and nothing else: which statuses
are retried, how long to wait, when to stop, and how the failure is wrapped are decided in one place.

- **Retried:** any answer that is not a 2xx — `400`, `401`, `403`, `404`, `408`, `409`, `425`, `429`
  and every 5xx — a dropped or refused connection, and an upstream "no slot right now" body. A spent
  concurrency slot usually arrives as a 429, but a gateway also sends it as a 400, a 403 or a 503 with
  `concurrency`, `rate limit`, `overloaded`, `并发` or `限流` in the body, so the body is read too,
  whatever status carries it.
- **Never retried:** a request the caller aborted — before it is sent, while it runs, or while it
  waits out a backoff — and a failure with neither a status nor a dead socket behind it (a malformed
  answer would fail the same way again). A stream is retried only until its first chunk; after that
  the stream fails instead, because a retry would repeat what the reader has already seen.
- **Skipping a status on purpose:** `NODE_AGENT_MODEL_NO_RETRY_STATUSES=401,403` (also `4xx`,
  `400-499`). Nothing is skipped silently — the default is "retry everything", and this variable is
  the only way to say otherwise. A 429 or an upstream limit body is retried even then: it is a wait,
  not a verdict.
- **Waiting:** `NODE_AGENT_MODEL_ATTEMPTS` (8, the first attempt included) attempts;
  `NODE_AGENT_MODEL_BACKOFF` (1 s) doubled per attempt with jitter, capped by
  `NODE_AGENT_MODEL_MAX_DELAY` (60 s). A `Retry-After` header — seconds or a date — wins over both.
- **The failure:** once the attempts are spent, one `ProviderCallError` carries `provider`, `host`,
  `attempts`, `status`, `kind` (`connection` / `rate_limit` / `server` / `http` / `aborted` /
  `unknown`) and `streamStarted`, and its message holds the whole cause chain, so a caller can tell a
  dead socket from a 429 without parsing a sentence.

## Tests

```
cd node_agent/nodes/provider
npm test
```

Tests use a fake provider client, so no real API key is needed and no network call is made.
