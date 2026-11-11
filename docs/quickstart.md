# Quickstart

You need Node 23.6 or newer and npm. Node 24 LTS is the version CI uses. No Docker is required for the first part.

## 1. Install and build

```bash
npm install
npm run build
```

`npm install` installs the workspace packages (everything under `node_agent/`, plus
`node_example/hello-node`) plus the published `@node-agent/sdk` from npm. `npm run build` compiles them
in dependency order.

## 2. Give it a token

```bash
cp deploy/node-agent/.env.example deploy/node-agent/.env
# then edit it and replace change-me
openssl rand -hex 32   # a token, if you want one that is actually secret
```

The token is what a node presents to join the bus. Without it, a stack that binds anywhere but
loopback is an open door.

## 3. Start the stack

```bash
node --env-file=deploy/node-agent/.env node_agent/node-agent/dist/serve.js
```

You should see, in order: the bus listening, one `node <name>: worker` line per node as it
registers, then the summary:

```
[bus] info listening bind=127.0.0.1 port=8788
bus: ws://127.0.0.1:8788
[bus] info node.register connection=... node=history scope=shared
node history: worker
...
bus: 127.0.0.1:8788
nodes: history, agent, system, provider, webui, notes, todo, timer, search, init
user: default -> history, agent, system, provider, webui, notes, todo, timer, search, init
webui: http://127.0.0.1:8790/
```

Every node line says `worker`: the bus and all of them share one OS process, each node in its own
worker thread.

Open <http://127.0.0.1:8790/>. Ask it something. The `agent` node answers; if `NODE_AGENT_MODEL_URL`
is empty it answers with a deterministic stand-in, which is enough to check the wiring.

## 4. Ask it to run a command

The `shell` node is not in the default node list — add it and the agent can use it:

```bash
NODE_AGENT_NODES=node-agent-provider,@node-agent/shell,node-agent-webui \
  node --env-file=deploy/node-agent/.env node_agent/node-agent/dist/serve.js
```

Then ask the agent to run `pwd`. The `shell` node runs it in `NODE_AGENT_WORKSPACE` (your current
directory by default) and the output comes back through the bus.

## 5. Restart and check the history

Stop with Ctrl-C, start the same command again, and reopen the page: the transcript is still there.
It lives in `~/.node_agent/history/sqlite` unless `NODE_AGENT_HOME` says otherwise.

Every node keeps its durable files in its own directory under the same root:
`$NODE_AGENT_HOME/<node-name>/`. History is `history/`, shell permissions are `shell/`, the local
provider is `local-provider/`, and each node's logs are `<node-name>/logs/`.

## 6. Call your own node on the bus

```bash
cd node_example/hello-node
NODE_AGENT_TOKEN=<the token in your .env> npx @node-agent/sdk .
```

That is a node joining a bus that is already running, with no store and no publish step involved —
which is how every third-party node is meant to arrive here. It dials `NODE_AGENT_BUS_URL`
(`ws://127.0.0.1:8788` by default) with `NODE_AGENT_TOKEN`, and `npx` finds the `@node-agent/sdk` bin
the workspace installed.

## With Docker

One image, two startup modes — see [deployment.md](deployment.md).

```bash
# local: the stack alone, page on 127.0.0.1:8790
cp deploy/env.example deploy/.env      # put a token in it
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f stack

# public: the same stack, plus Caddy on 80/443
# (set NODE_AGENT_ACCESS_TOKEN and NODE_AGENT_DOMAIN in deploy/.env first)
docker compose -f deploy/docker-compose.yml --profile public up -d
```

## When it does not work

| symptom | likely cause |
|---|---|
| `runtime failed to start (port 8788)` | something else holds the port; set `NODE_AGENT_BUS_PORT` |
| a node exits immediately | run `npm run build` again, then look at the node's line above the exit |
| the page loads but nothing answers | the `agent` node did not register; its line in the log says why |
| `EADDRINUSE` on 8790 | another stack is up; set `NODE_AGENT_WEBUI_PORT` |
