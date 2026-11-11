# Security model

## The credentials

`NODE_AGENT_TOKEN` is the one credential a node uses. When it is unset the runtime generates one and
keeps it at `$NODE_AGENT_HOME/runtime/bus-token` (0600). User bus identities are a fixed namespace
hash of the user name, independent of the token, so rotating the token does not change history
partitions. A node presents it to join the bus; the Web UI presents it to attach. A browser that is
not on this machine goes through the built-in door instead, which has a token of its own
(`NODE_AGENT_ACCESS_TOKEN`, off unless set). Everything below follows from that choice:

- rotate the token, restart the stack, and every client is out — there is no per-client revocation
- there are no accounts, so there is no way to give someone "read-only" access: it is one person
- losing the token means starting over with a new one, not recovering

## What binds where

The default is loopback, everywhere:

| process | default bind | variable |
|---|---|---|
| bus | `127.0.0.1:8788` | `NODE_AGENT_BUS_BIND`, `NODE_AGENT_BUS_PORT` |
| Web UI | `127.0.0.1:8790` | `NODE_AGENT_WEBUI_BIND`, `NODE_AGENT_WEBUI_PORT` |
| built-in door (off by default) | `127.0.0.1:8080` | `NODE_AGENT_PROXY_BIND`, `NODE_AGENT_PROXY_PORT` |

Widening one without a token is the one mistake that matters. The door refuses to start with an empty
token; the bus and the page do not, because they are meant to be reachable only from the machine
itself.

## Capability permissions

Every capability in a node manifest may name its `callers`. The bus enforces that list, so a node that
says `"callers": []` is one nobody may call, and `"callers": ["agent"]` is one only the agent may
call — not the user, not another node. The default for a third-party node is: it asks for what it needs,
and you can read exactly what that is in its manifest.

## The shell node

The `shell` node runs commands as whoever started it, in `NODE_AGENT_WORKSPACE`. That is the feature.
Two consequences worth stating plainly:

- a prompt injection that reaches the agent can reach the shell; the permission list is the boundary,
  and so is what you let the agent see
- `NODE_AGENT_SHELL_DENY_WRITE` is a deny list, not a sandbox: paths outside the workspace are still
  readable unless you deny them

If you need isolation, run the stack in the container from `deploy/` and mount only what the agent
may touch. Do not describe this as a sandbox in your own docs; it is a permissioned shell.

## The model provider

Conversations, file contents the agent reads and command output it observes go to whatever
`NODE_AGENT_MODEL_URL` names. A local endpoint keeps them on the machine. There is no redaction layer
and no per-turn filtering.

## The door, and TLS

`NODE_AGENT_ACCESS_TOKEN` opens the built-in door (`node_agent/node-agent/src/proxy.ts`), the only
piece of this stack that is meant to face a network you do not control:

- the cookie holds `sha256(token)`, never the token, and is compared in constant time
- it is `HttpOnly`, `SameSite=Lax`, 30 days, and `Secure` when `NODE_AGENT_PROXY_SECURE=1`
- proxied requests drop the browser's `Cookie` header before they reach the stack
- the upstream is the Web UI this process started, fixed at boot — it cannot be used as an open proxy
- WebSocket upgrades are gated by the same cookie and then piped byte for byte

TLS is not part of it. In the `public` profile of `deploy/docker-compose.yml` Caddy terminates it and
hands plain HTTP to the door on the compose network; `NODE_AGENT_PROXY_SECURE=1` is what marks the
cookie `Secure` there.

Not there yet: rate limiting, lockout after failed attempts, audit logging, per-request tokens. If you
expose it, put it behind something that has those, or accept the trade-off knowingly.

## Data at rest

All node-owned durable files live under `NODE_AGENT_HOME` (default `~/.node_agent`), one directory
per node: `history/`, `shell/`, `local-provider/`, and `<node>/logs/`. History is SQLite, unencrypted,
owned by the user running the stack. Back it up by copying the directory while the stack is stopped.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
