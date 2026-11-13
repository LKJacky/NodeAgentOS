# node-agent-history

A standalone TypeScript node that gives every bus node durable units. A unit is identified by
`(tenant, calling node name, unitId)`, and the node derives two of those three itself: the calling
node from the bus caller, and the tenant/user from the bus frame. A node on the bus can therefore
neither read another tenant's units nor switch to another person's — it names only the unit it means.

One history process serves every tenant on its bus. A local SQLite file keeps the tenants in one
schema and takes the tenant as the query namespace; an HTTP history store gets one client per tenant,
and presents that tenant's token as its bearer.

A unit is one value of any JSON shape, and the revision it is at.

Capabilities:

- `history.load({ unitId })` — `{ unit: null }` when there is no such unit
- `history.save({ unitId, meta, expectedRevision? })`
- `history.delete({ unitId, expectedRevision })`
- `history.list({})`

There is no `userId` argument, on purpose: the user is the bus tenant, and an older caller that still
sends `userId` has it ignored rather than obeyed. `NODE_AGENT_HISTORY_USER` is only the fallback for a
hand-built context (tests, startup helpers), not something a bus caller can select.

`save` is the one way to write: it creates the unit, or replaces what it holds. Naming
`expectedRevision` makes it an update of exactly that revision instead, so a writer whose copy has
moved on is refused rather than overwriting — and a unit that is missing is then an error too.
`delete` always names a revision, so a unit cannot be dropped without having been read. `list` says
which units exist, never what they hold.

**A rename is not a migration.** Units stay filed under the name a node had when it wrote them,
and nothing moves them: a renamed node starts with its own (empty) name, and a person saves
again whatever matters. `adopt` used to be here for exactly that case and was removed — the
old data is simply left alone.

A node keeps several units when one is not enough, and a dot is just a character: the agents keep the
transcript as one unit that says how many messages there are (`conversation`) plus one unit per
message (`conversation.0`, `conversation.1`, …), which is what lets a turn write only the lines it
added. That layout is the agent's convention, not this node's.

## Three layers, one identity each

```
history-serve   { user, node, key, value }     user = the bearer token itself
      ↑   HTTP + Authorization: Bearer <token>
history node       { key, value }                   user = this process's, fixed at startup
      ↑   bus (the caller's node name is the namespace)
other nodes        key and value only
```

Each layer adds the one thing the layer above cannot be trusted with: a node may not choose its user,
and a client may not choose whose history its token reaches. So one shared server can hold several
people's histories, and one person's token cannot read another's however it spells a URL — there is
no user anywhere in the API to spell.

## Storage page and usage

The node exposes `usage` — units and UTF-8 JSON bytes grouped by calling node for the current user —
and `ui`, a small page that reads it. The page is served through the normal `/call` path, so it works
inside the webui shell and never needs a second listener. `usage` is also what a cloud deployment uses
to enforce a per-user storage ceiling before a write.

## Two backends

Where the units live is a setting, not a second kind of node. `src/store.ts` defines one contract —
`HistoryStore`, with `load` / `save` / `delete` / `list` — and both implementations keep every rule
above, including what a stale writer is told:

- **local (`SqliteHistoryStore`)** — a SQLite file in this process. Answers at once (the interface
  allows a promise, this backend returns values), needs nothing else running, and is what every
  deployment had before there was a choice. It is the one backend that holds several users at once
  (the `user` argument of the store), because the file is this machine's.
- **network (`HttpHistoryStore`)** — a history server holds the units, and the bearer token a client
  presents _is_ its user.
  `serve/history-serve/` at the repository root is that server — its own code, in its own directory,
  wrapping the same SQLite store — and it answers the JSON API in `serve/history-serve/src/server.ts`.
  The store's methods still take a `user` argument to satisfy the interface, and a network client
  drops it: its token is its user.

Which one is used is decided when the node starts:

| variable                   | meaning                                                                                                           | default                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `NODE_AGENT_HISTORY_USER`  | fallback user for a hand-built context; bus invocations use the bus tenant instead                                | `default`                                      |
| `NODE_AGENT_HISTORY_URL`   | an `http://` or `https://` URL: the units are kept on that server. Set but blank counts as unset                  | unset → local                                  |
| `NODE_AGENT_HISTORY_TOKEN` | fallback bearer for direct `openHistoryStore()` use; a bus invocation presents the calling tenant's token instead | unset (a server refuses a request without one) |
| `NODE_AGENT_HOME`          | the directory for all persistent node-agent files                                                                 | `~/.node_agent`                                |

```sh
# local (unchanged default), one person's file
node history/dist/serve.js --url ws://127.0.0.1:8788 --token demo-token

# network: the units live on the server, under the user this token *is*
NODE_AGENT_HISTORY_URL=http://history.internal:8791 \
NODE_AGENT_HISTORY_TOKEN=<this process's token> \
  node history/dist/serve.js --url ws://127.0.0.1:8788 --token demo-token
```

With a URL the token decides the user, and in a multi-tenant bus each tenant gets its own
`HttpHistoryStore` carrying that tenant's token. The token is stored by the server as the user id, in
clear: it is a secret as much as an identity, so keep it out of logs and images. A deployment with one
account needs nothing configured on the server side at all.

Something that is neither an `http(s)` URL nor a file path (`ws://…`, a `node-agent-bus` address by
mistake) is refused at startup rather than becoming a file with a strange name.

**A URL is not a fallback.** When the server is unreachable the call fails with a line naming the
address; it never quietly writes to a local file instead, because two stores would then be two
histories and nobody would know which one a conversation was in. Point every process at the same
URL, or at none.

Over the network the rules are the same ones: a write naming a stale revision still fails (its
revision conflict arrives as the same error a local store throws), a `delete` still has to name the
revision it read, and `list` still says only which units exist. The store decides what a unit is, so
the server cannot disagree with the local backend about it.

The SQLite side keeps migrating older databases on open: schema 1 conversation rows, schema 2 blobs
and schema 3 item rows all come out as a count plus a unit per message, and a unit that never held a
list of messages keeps its value as it was. A network deployment inherits that from the server's own
SQLite file.

Start this node before nodes that require persistence. Python supervisors can use
`launch_history(...)`, then join `node_agent_agent.AgentNode(..., history_required=True)`. Both the
TypeScript and Python agents keep the same `conversation` + `conversation.<n>` layout, and both start
the same TypeScript node. `NODE_AGENT_HISTORY_URL` / `NODE_AGENT_HOME` reach
it unchanged; `NODE_AGENT_HISTORY_USER` is only the hand-built-context fallback, and a bus caller's
tenant token is the HTTP identity.

## Starting a server

`serve/history-serve/` is the network backend as a service: one SQLite file behind the JSON API, where a
caller's bearer token is its user, plus a request size limit, health checks and a graceful shutdown. It
has a Dockerfile of its own (repository root as the build context) and a README:

```sh
# nothing to configure: each caller's token is its user
node serve/history-serve/src/serve.ts

# alice's token is alice; bob's is bob; neither can read the other's units
curl -H 'authorization: Bearer alice' 'http://127.0.0.1:8791/v1/units?node=agent'
docker build -f serve/history-serve/Dockerfile -t node-agent-history-store .
```

The API, its error codes, what a token is (a secret the server stores as the user id) and the Docker
usage are documented there.
