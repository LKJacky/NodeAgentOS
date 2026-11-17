# node-agent-agent

The agent node: the only node that holds a model. It is one package with one Node class
(`AgentNode`, the default export of `dist/index.js`), and the runtime loads it like any other —
there is no bus here, no host here, and no socket here.

## What it serves

| capability     | what it does                                                                               |
| -------------- | ------------------------------------------------------------------------------------------ |
| `chat`         | hand the agent one message; answers with the lines its turn added                          |
| `chat_no_wait` | hand it one message and do not wait; answers `queued` / `interpreted`                      |
| `history`      | a bounded window of the transcript (`from`, `count`, at most 200 lines)                    |
| `status`       | `idle` / `generating` / `tool` / `stopping`, the queue behind it, cumulative usage, and where the answer being written has got to (`stream`: its id and last seq, no text) |
| `stream`       | the answer being written right now, in full and once (`{stream: {id, messageId, seq, content, reasoning_content, tool_calls}}`, or `{stream: null}`): what a page asks for to fill a gap in the deltas. Hidden from other nodes (`expose: false`, like `ui`): it is the page's own read, not a tool |
| `stop`         | cut that agent's turn short — and nothing else: the sub-agents, the queue behind it and the runtime itself are left alone |
| `provider`     | list the provider rows this agent can use, or select one                                   |
| `settings`     | read what this agent runs on, or save some of it (`action: get` / `update`, or `reset: true`) |
| `answer`       | the page's way back in: the answer to a question the model asked                           |
| `agents`       | the agents this node runs — the main one and its sub-agents, each with its topic and state |
| `ui`           | the page (`slot: 'left'`)                                                                  |

Every capability but `agents` and `ui` takes an optional `agent`: a sub-agent's name, or nothing for
this node's own agent. That is how the page shows, sends to and stops one agent of the family.

`priority` on `chat` / `chat_no_wait` is the queue's order: `queue` (the default: wait for the
running turn to finish) or `interpret` (in at the end of the round that is running).

## The model

One turn is one round at a time: take the highest-priority line waiting, run the model, run the
tools it asked for, go round again until it answers in prose and nothing is left in the `interpret`
lane. The loop lives in `AgentRuntime` (`src/runtime.ts`), which is **one object per (tenant, bus
name) per process**: the SDK builds a fresh `Node` for every invocation, so the transcript, the
queue, the turn and the usage counters cannot live in the node — `stop` from one call must stop the
turn another call opened. They live in one `AgentRuntime` per tenant, kept by the SDK's
**`ctx.bind('agent-runtime', (scope) => new AgentRuntime({ scope, ... }))`**: the host owns the
object, nodes it per tenant, and drops it when it stops. `node.bindings` declares the key, so a
typo or a second key is refused by the host. Two tenants calling `agent` on one bus never meet in a
transcript, a queue, a cache or a provider stream. `agent.stop` cuts the turn and only the turn: it
neither closes the runtime nor drops the binding — when a runtime is created and when it goes is the
host's business, not a button's — and the lines queued behind the turn are turns of their own that run
as they would have.

The factory's `scope` is the important half: `tenantId`, `nodeId`, `call`, `publish`, `subscribe`,
`listNodes`, `listCapabilities`, `fetch`, all served by the host's persistent session. It is not the
invocation's context — that context carries the caller's deadline, their abort signal and a `call`
that dies with the call, so a turn opened by `chat_no_wait` cannot use it. The runtime keeps the
scope and nothing else; each handler passes its request facts explicitly
(`runtime.chat(msg, { from: ctx.from, deadline: ctx.deadline })`), and no module here builds
envelopes or holds a context bus.

The model is reached through a **provider node on the bus** (`local-provider` first, then
`provider`), streamed over `start_stream` / `stream_ready`: the provider hands back an id, the agent
subscribes to `provider.stream.<id>` and only then says the stream may start, so the first delta is
never published before there is a listener. Its rows are the bus names `<node>.<row>`; the first one
is where an agent starts, and `provider` selects.

There is no embedded model and no keyless stand-in: an agent on a bus with no provider node answers
the turn with `no provider on the bus` rather than inventing one. An embedder (tests, a hosted
runtime) may pass `provider` in `RuntimeOptions` to hand the runtime one directly.

## The tools the model gets

`list_nodes`, `list_node_tools`, `run_on_node` (about the bus), `read_cache`, `search_cache` (about
the lines kept instead of sent), and `ask_user` (about the reader). The page is never offered — an
agent cannot call another agent's UI, and it cannot call its own. `ask_user` is left out when the
agent's `allowAskUser` setting is off.

A root agent also gets `create_agent` / `destroy_agent`, unless its `allowSpawn` setting is off. A sub-agent is a runtime of the same
class held by its parent — **not** a node: the bus registers one identity per tenant, and a node
it does not know has no permissions on it, so a sub-agent node used to be refused capabilities
its parent could call. A sub-agent therefore shares the parent's identity (same tenant, same bus
connection, same node name), publishes on its own topic (`agent.<its name>`), files its history
units under its own prefix (`sub.<name>.`) and keeps its own transcript, queue, round budget and
stop. `run_on_node` reaches it through the node's own capabilities, which take `agent` to name
it - `{node: "agent", tool_name: "chat", tool_args: {agent: "helper", msg: {...}}}`: the call is
a frame on the bus like any other node's, and `agent` may name one of its sub-agents but never the
agent the node already is. A sub-agent may not create one of its own. `create_agent` takes an
`icon`, which is required - its tab has to be told apart from the others, and the drawing is
shown on that tab and as the page icon when the agent is selected - and an optional `provider`;
without a provider the child follows the parent's provider. The `subagents` history unit keeps
each child's name, icon and provider, so a parent restart restores them.

A tool answer longer than `NODE_AGENT_MAX_INPUT_LENGTH_PER_TURN` (default 8192 characters) is kept
whole in the **cache** and the model is handed its head, a warning naming the cache entry, and its
tail. The cache is history-backed: one unit per entry (`cache.<n>`), one counter unit (`cache`), and
`cacheSize` entries kept (default 500, `NODE_AGENT_CACHE_SIZE` when it names another number).

## The settings

`settings` is what an operator may change without a restart of the process, `get` by default:

```json
{ "action": "get" }
{ "action": "update", "maxAgents": 8, "cacheSize": 200 }
{ "action": "update", "reset": true }
```

Seven fields, each read by code that was already here — no setting is a knob with nothing behind it:

| setting                 | what it changes                                                                     | in force   |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------- |
| `maxAgents`             | how many sub-agents may run at once (1–64)                                          | next call  |
| `maxInputLengthPerTurn` | the line length past which an answer is cached and trimmed (256–1,000,000)           | next turn  |
| `compressionThreshold`  | the prompt tokens above which the oldest lines are summed up and forgotten (1,024–1,000,000) | next round |
| `compressionTokens`     | how many tokens one compression lets go of at once (256–262,144)                    | next round |
| `cacheSize`             | how many long texts the cache keeps; one more deletes the oldest (1–10,000)         | next turn  |
| `allowSpawn`            | whether the model is offered `create_agent` / `destroy_agent` at all (true/false)    | next round |
| `allowAskUser`          | whether the model is offered `ask_user` (true/false)                                 | next round |

The defaults are what this package already did: 32 sub-agents, 8192 characters, a 128K-token
compression threshold with a 32K-token step (`COMPRESSION_THRESHOLD` / `COMPRESSION_TOKENS` in
`src/model.ts`), a cache of 500 (`DEFAULT_CACHE_SIZE` in `src/cache.ts`), and both switches on.

The answer carries the full settings in force, the `defaults` they fall back to (a sub-agent's
parent, or the package default with `NODE_AGENT_MAX_AGENTS` / `NODE_AGENT_MAX_INPUT_LENGTH_PER_TURN` /
`NODE_AGENT_CACHE_SIZE` over it), the `provider` row in force (read from `provider`, never chosen
here), `live` and `restartRequired`. Every field is live: `restartRequired` is empty because a saved
value is handed to the components that read it — the cache takes a new `cacheSize` and lets go of
what is past it, a model that was already built takes a new compression pair (`setCompression`) — so
nothing here waits for a restart.

What is stored is only what somebody chose: a save writes the fields it was given into history unit
`agent.settings` (`sub.<name>.agent.settings` for a sub-agent), so a field nobody touched keeps
following the deployment's default. A save names the revision this process last saw; when the history
node refuses it because someone else wrote first, the agent reads their unit again and lays its patch
over it, so both writers' fields survive (three attempts, then the refusal is the caller's).
`reset: true` writes the unit empty rather than deleting it, so the same revision rule covers it.
A value out of range is refused with the range in the sentence (`maxAgents must be between 1 and 64
(got 0)`), and so is a name this agent does not have.

A sub-agent starts on its parent's settings and then keeps its own copy: a field it does not set
follows the parent, a field it sets is its own — and its cache and compression pair follow a save,
not only a start.

The two switches are what the model is *offered*, checked per round and again per call: with
`allowSpawn` off the spawn tools stay out of the tool list, a `create_agent` call that arrives anyway
is answered with the refusal, and the children a previous run saved are no longer restored on start
(starting one is starting one). With `allowAskUser` off the same holds for `ask_user`. Neither switch
can turn something on that the runtime was started without: a sub-agent is started with both off, so
its own page shows both off (they are not inherited as on, or the page would offer a switch that does
nothing) and a save that tries to turn one on is refused — as is a runtime an embedder started with
`allowSpawn`/`allowAskUser` false. What a switch can do is narrower than what it was started with,
never wider.

The settings panel hides what a sub-agent has no use for rather than showing it greyed out: the
answer names the agent it is about (`agent: { name, parent }`), and when `parent` is not null the
panel drops `maxAgents`, `allowSpawn` and `allowAskUser` — a cap it cannot reach and two switches it
can neither hold nor use. A hidden field is never named by a save.

## The transcript

`StatedModel` (`src/persist.ts`) writes one history unit per line (`conversation.<n>`) and one unit
that names how many there are (`conversation`, meta `{messages, usage, forgotten}`), advanced with an
expected revision. A turn that ended with an unanswered tool call is closed with `unexpected exit`
on the next start, so the transcript is always valid. Without a `history` node on the bus the agent
runs with an in-memory transcript — a missing history node is not a failed start.

## The page

`src/ui.html` is the whole page; `ui` hands it out with this node's own name filled in (a name
belongs to whoever started the node) and markdown-it inlined, so the page draws Markdown with no
second HTTP route. When markdown-it is not installed the page gets an escaped-text renderer with the
same `window.markdownit(...).render(text)` surface.

The page follows the node over its own topic: transcript lines, the deltas of an answer being written, `{type: 'ask'}` when the model asks a question and `{type: 'ask_timeout'}` when nobody answered in time.

### What an answer costs on the bus

An answer used to be published as a full snapshot of itself on every token — the whole message rebuilt and
serialised per chunk, so one frame per token grew with the length of the answer. What goes out now is the
increment, numbered:

```
{ type: 'stream_start', id, agent, messageId, role: 'assistant', seq: 0 }
{ type: 'stream_delta', id, agent, messageId, seq: 1, content: 'Hel' }
{ type: 'stream_delta', id, agent, messageId, seq: 2, content: 'lo' }
{ type: 'stream_delta', id, agent, messageId, seq: 3, reasoning_content: 'hmm' }
{ type: 'stream_delta', id, agent, messageId, seq: 4, tool_calls: [{ index: 0, id, name, arguments: '{"comm' }] }
{ type: 'stream_end',   id, agent, messageId, seq: 5, canceled: false }
```

- A delta carries only what just arrived (`content` / `reasoning_content` / one call's new fragment) and
the `seq` that orders it. The line so far is never sent as part of it.
- The assembled line is still committed the way every line is — an array of messages on the same topic
(`onCommit`) — and that is what a page draws. `stream_end` says the draft is done; `canceled: true` means
the committed line is the partial answer a stop left behind.
- A page that receives anything but the next `seq` (a lost frame, a reconnected stream, a stream it never
saw start) does **not** append: it asks `status` for the live stream's id/seq and `stream` for the line as
it stands, and adopts that. Nothing is glued together silently. `stream` is `expose: false` (and
`allow_edit_permission: false`), like `ui`: the bus's `authorize` lets the page's own front end (`webui`)
call it, while sibling nodes never see it in the directory and the model is never offered it as a tool —
the one payload that carries the line so far is reachable only by the page it is for.
- `src/stream.ts` holds the protocol and the assembly (`StreamAssembly`); the page carries the same rule in
its own script (`<script id="page-model">`), and `tests/retention.test.mjs` runs both over one set of
deltas so the two cannot drift.

A page also keeps a bounded amount of it: at most 200 messages per agent (`RETENTION.maxMessages`), oldest
first and only when the reader is at the tail, and a page nobody has looked at for five minutes lets go of
its messages, draft and boxes entirely (`RETENTION.idleTtlMs`) and reads its window again when the reader
comes back. Both numbers are the page's own: they are overridden with `globalThis.AGENT_RETENTION` (that
is how the tests run a cap of three and a TTL of milliseconds), and they are **not** settings any more —
the node no longer stores a `retention` pair, so a deployment that needs another policy sets it here.

The settings panel is the cog at the right end of the usage row. It asks `settings` for what is in force,
shows each field with the range it accepts, saves the fields the reader changed (and nothing else), says
what came back — the node's refusal verbatim when one comes back — and resets to the deployment's
defaults. The active provider is shown there but changed with the select beside it: `provider` is the one
place a provider is chosen.

**Compatibility.** The protocol is additive for the node's own page and a break for anything else that
read `{type: 'stream', message}`: an old page draws nothing from the new events (it treats each as
"something changed" and re-reads `history`, so it stays correct but pays a read per token), and the new
page ignores a legacy snapshot for the same reason. Reload the page after upgrading; no other node and no
part of `@node-agent/sdk` reads these events.

## The session and its two owners

The process joins the bus once. `serve.ts` hands the package to the SDK's `servePackage`, which
builds the legacy transport (the wire the Python nodes speak), connects it, and registers the
manifest. That same host owns the
bus for the whole process, and gives each tenant a binding scope over it: the object `ctx.bind`
makes gets `scope.call/publish/subscribe/list*`, with no invocation deadline behind it (a bound
call's own ceiling is 30 minutes). A session carries one identity, so a process that serves two
tenants has two scopes over two sessions — never one scope for every tenant.

`AgentNode` keeps no runtime and no scope in a field: `runtime` is a getter over the current
`this.ctx`, so a stateful host handing the instance a newer context is followed. Nothing on the
runtime is an invocation context — no `ctx`, no `signal` — which the tests check directly, along
with a call that still reaches the bus after the invocation that started it was answered.

## Build, test, run

```bash
# the SDK this package imports (once, from a checkout)
(cd ../../../sdk && npm install && npm run build)

npm run build                      # tsc -> dist/, then ui.html + icon.svg copied next door
npm test                           # node --test tests/*.test.ts tests/*.test.mjs
NODE_AGENT_BUS_URL=ws://127.0.0.1:8788 NODE_AGENT_TOKEN=demo-token node dist/serve.js
NODE_AGENT_BUS_URL=... node dist/serve.js --name agent-2   # a second agent, same package
```

`node dist/serve.js` joins the bus the environment names and serves until SIGINT/SIGTERM. The
package can also be run by the shared runtime (`npx @node-agent/sdk .`), which is what the store and the
shell's `run-node` do.

## Tests

`tests/harness.ts` is a bus in one process: the agent under test, sibling nodes to call, a history
node whose units are a map, an injectable provider and a log of what the agent published.

- `chat.test.ts` — a full tool round, the caller's name in front of the line, `chat_no_wait`, the
  `interpret` / `queue` order, stop (turn cut, runtime kept, transcript survives), usage;
- `subagents.test.ts` — creating, destroying and reaching a sub-agent, and a Stop that cuts the agent
  it was pressed for and leaves the rest of the family (and the queue) running;
- `history.test.ts` — window defaults and clamping, one unit per line, a restart continuing the
  transcript, an unanswered tool call repaired on the next start;
- `cache.test.ts` — numbering across restarts, the oldest entry leaving, search, the trimming
  warning and the two cache tools;
- `settings.test.ts` — the `settings` capability: what an agent starts on, a save that names only the
  fields it was given, the deployment's defaults underneath, a value out of range refused with the
  range in the sentence, a save that lost a race retried on top of the other writer's, a sub-agent's
  copy of its own, the numbers reaching the code behind them (a saved `cacheSize` is the cache's cap,
  a saved compression pair is what a model that was already built compresses with), and the two
  switches deciding what the model is offered from the next round on;
- `wiring.test.ts` — the two numbers a setting is handed to, on their own: a model's compression
  pair (`setCompression`, and the notice a cut writes once the transcript is past it) and the cache's
  cap (`setMaxSize`, and the entries a shrunken cap lets go of);
- `i18n.test.ts` — the page's words and the manifest's: every sentence in both languages, the same
  keys in each, the settings panel naming every field of its capability;
- `provider.test.ts` — row names and selection (stored in history), a streamed provider node,
  `ask_user` answered and timed out;
- `tenants.test.ts` — `ctx.bind` hands one runtime per tenant and `unbind` makes the next call build
  a new one; a scope without a name is refused; two tenants on one host keep transcripts, tools,
  cache, queue and publications apart; and a reused `AgentNode` follows the context it is handed;
- `session_bus.test.ts` — the SDK's long-lived bus: a 30-minute call deadline, errors, the
  directory, publication, and a `chat_no_wait` turn still calling the bus after its call returned;
- `page.test.ts` — the name filled in, every script block parses, the manifest's caps are the ones
  served, the page calls only those, `ui` answers the page;
- `subagents.test.ts` — a sub-agent registers no bus node and shares its parent's identity, calls
  ordinary capabilities as the parent, is reached by `run_on_node` without a frame, keeps its own
  transcript and status, cannot create a sub-agent, and takes its units with it when destroyed;
- `ui.test.mjs`, `ask-card.test.mjs` — the page's own markup, the agent switch row and the question
  card; the deltas of a stream assembled into the tail and a gap resynced (never appended), the end of
  a stream, a reconnected page joining one, the fixed message cap, the viewport rule, the TTL that lets
  an unseen page go, and a streaming page that is never let go;
- `stream.test.ts` — the delta protocol on the bus: consecutive chunks publish only what arrived and no
  frame carries the line so far, the whole line is still committed, two subscribers accumulate the same
  answer, `status`/`stream` say where a stream stands, a stop ends the stream with the partial answer,
  and a sub-agent streams on its own topic;
- `retention.test.mjs` — the page's two pure halves on their own: the cap (`trimPrefix`, with the lines
  that may not go), the TTL (`releaseDue`, `plan`), the delta assembly and the gap rule — and the page's
  assembly run against the node's over the same deltas.

## Diagnostic log

`NODE_AGENT_LOG_LEVEL` controls agent, bus and runtime diagnostics together. It accepts `silent`,
`error`, `warn`, `info` (default) or `debug`, ignoring case and surrounding whitespace. Unset, empty
or invalid values use `info`; the former per-component variables are no longer used. The agent
writes one `[agent]` line per enabled lifecycle event to stderr, beside the other node logs:

```text
[agent] info agent.start agent=... parent=...
[agent] info agent.ready agent=... history=true ms=12
[agent] info model.loaded agent=... provider=... persistent=true
[agent] debug message.queued agent=... priority=queue bytes=42
[agent] debug turn.start agent=... seq=1 priority=queue bytes=42
[agent] debug step.start agent=... tools=12
[agent] debug step.end agent=... canceled=false calls=1 ms=830
[agent] debug tool.start agent=... tool=computer.exec
[agent] debug tool.end agent=... tool=computer.exec ok=true ms=95
[agent] info turn.end agent=... ok=true messages=1234
```

Message text and tool arguments are deliberately absent: lengths, names and timings are enough to
diagnose a stuck turn without copying a transcript. Set `NODE_AGENT_LOG_LEVEL=debug` in the runtime
environment before starting it; the shared runtime passes the setting through to agent and bus
processes. `$NODE_AGENT_HOME/agent/logs/agent.log` holds the agent output. This setting does not
change uvicorn access logs or other pre-existing application loggers.
