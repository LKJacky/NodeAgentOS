# Architecture

Four layers, and a rule that keeps them apart: a node never imports another node.

```
        Web UI / your script / another agent
                        |
                    +-------+
                    |  bus  |   one WebSocket endpoint, one token
                    +-------+
                     /  |  \
              history agent  shell ...      every node is a worker thread
                        |
                    +-------+
                    |runtime|   starts the bus, starts nodes, tables who may use what
                    +-------+
```

## The bus

`node_agent/bus` is one WebSocket server. A connection introduces itself (a token, a node name, or a user),
and after that it can send envelopes and receive them. Everything else — call a capability, hand over a
message, subscribe to a stream — is an envelope on that bus. There is no REST API between nodes.

Because every connection is a client, nothing special is needed for the Web UI to talk to the same
nodes your script does; it is one more client with its own table entry.

## The runtime

`node_agent/runtime` defines the runtime contract and its HTTP surface. The local, single-user
implementation lives in `node_agent/node-agent/src/local.ts`: it creates the bus, starts one worker per
node package inside the runtime process, waits for the manifest that node publishes, and keeps a table:
which user may use which node. A *user* here is an access relation, not a second copy of anything — starting a second user
does not start a second agent.

`LocalRuntime` does it with worker threads: one OS process holds the bus and every default node, each
with its own module graph and event loop. `isolation: 'process'` starts nodes as child processes
instead for callers who want the older shape; `RuntimeServer` exposes the same interface over HTTP.
That split is the reason the interface has no product in it: a future deployment can put a runtime on
another machine without touching a node.

## Nodes

A node is a package with a `node` field in `package.json`:

```json
"node": {
  "id": "shell",
  "entry": "dist/index.js",
  "caps": { "exec": { "type": "object", "properties": { "command": { "type": "string" } } } },
  "icon": "src/icon.svg"
}
```

The runtime starts `dist/serve.js` (or the entry the SDK runner provides) as a worker thread, and the
node registers its capabilities. Callers reach it by node name and capability name; the schema in the
manifest is what the agent is told, and what the bus enforces.

Default nodes — `history`, `agent` and `system` are core, the rest are the default `NODE_AGENT_NODES`:

| node | what it does |
|---|---|
| `agent` | the only node that holds a model; turns, tool calls, transcript |
| `history` | durable JSON units per node and user, each at a named revision (SQLite on disk) |
| `system` | privileged: language and timezone, permissions, timers and system settings |
| `provider` | model endpoints: OpenAI, Anthropic and Responses behind one row |
| `webui` | the page and its WebSocket to the bus |
| `notes` | persistent memos: read, add, update, delete, search |
| `todo` | today's card with free text and model-written buttons, plus a tickable list |
| `timer` | pending timers, how long is left, repeats |
| `search` | web search and page retrieval |
| `init` | the stack's own setup: runs once as the stack starts, then leaves the bus |

`shell` is not in the default list: it runs commands on your machine, so it is opt-in via
`NODE_AGENT_NODES` (see [quickstart](quickstart.md)).

## The SDK

`node_agent/sdk` is what a node author writes against: `Node`, `NodeHost`, the envelope types, the manifest
schema, the bus session and the runner that turns a package into a running node. It is the only package a
third-party node depends on.

## The meta package

`node_agent/node-agent` is the one-command entry. It creates a `LocalRuntime`, launches the bus, starts the
core nodes (`history`, `agent`, `system`) plus whatever `NODE_AGENT_NODES` names — by default
`provider`, `webui`, `notes`, `todo`, `timer`, `search` and `init` — creates one user and connects it.
That is the whole of "starting node-agent": one process, one bus, the default nodes as worker threads.

## What is deliberately absent

- a store: third-party nodes connect to the local bus themselves
- multi-tenancy: one token, one person
- a database server: SQLite, one file
