# @node-agent/local

Run NodeAgentOS locally: one persistent agent, one bus, and the core nodes in a single command.

## Install

```bash
npx @node-agent/local
# open http://127.0.0.1:8790/
```

Node 23.6 or newer is required. Bring an OpenAI-compatible model key; the first run opens the
onboarding page and stores the setup locally.

## Environment

| variable | meaning |
|---|---|
| `NODE_AGENT_BUS_PORT` | bus port; `0` picks a free one |
| `NODE_AGENT_BUS_BIND` | bus bind address, default `127.0.0.1` |
| `NODE_AGENT_NODES` | extra core nodes, comma separated package names |
| `NODE_AGENT_ACCESS_TOKEN` | optional login proxy token; unset keeps the stack local |
| `NODE_AGENT_USER` | deployment user id, default `default` |

## What starts

- the runtime and shared WebSocket bus
- the persistent agent and history
- the optional core nodes: provider, webui, notes, todo, timer, search, introduce

The runtime, the bus and the core nodes are bundled into the launcher, so none of them needs a
separate registry install. Only `@node-agent/sdk` and third-party model/search libraries are ordinary
dependencies. See the repository README for the architecture and Node contract.

## License

MIT
