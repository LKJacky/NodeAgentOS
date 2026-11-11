# node-agent

[English](README.md) | [中文](README.zh-CN.md)

![node-agent: one point, many nodes, your agent](docs/assets/hero.svg)

**A complete agent you run yourself.** One bus, small tool nodes, and a Web UI that stays out of
your way. It is for one person — your machine, or your own network. No sign-up, no tenancy, no
billing. Bring your own model key (any OpenAI-compatible endpoint).

## ⚡ 30 seconds

Node 23.6 or newer (`.nvmrc` and CI use 24) and npm.

```bash
npx @node-agent/local
# open http://127.0.0.1:8790/
```

One image, two ways to start it — local first, the internet only if you mean it:

```bash
# local: the stack alone, page on 127.0.0.1:8790
cp deploy/env.example deploy/.env                            # put a token in it
docker compose -f deploy/docker-compose.yml up -d --build

# public: the same stack, plus Caddy on 80/443 with a certificate
# (needs NODE_AGENT_ACCESS_TOKEN and NODE_AGENT_DOMAIN in deploy/.env)
docker compose -f deploy/docker-compose.yml --profile public up -d
```

## 🧠 What it is

| layer | what it means |
|---|---|
| **bus** (`node_agent/bus`) | one WebSocket bus; every node and the UI are clients of it |
| **runtime** (`node_agent/runtime`) | the runtime contract (`Runtime`: a bus, nodes, users as access relations) and `RuntimeServer`, the same interface over HTTP, so a runtime can live elsewhere |
| **nodes** (`node_agent/nodes/*`, the node packages) | small packages: `agent`, `history`, `provider`, `shell`, `search`, `webui`, `notes`, `todo`, `timer`, `system`, `introduce` |
| **sdk** (`node_agent/sdk`) | what a node author writes against: envelopes, manifests, the runner |
| **node-agent** (`node_agent/node-agent`) | `LocalRuntime`: the bus and one worker thread per node in this process, and the one-command entry that starts the whole stack |

A node is a package with a `node` manifest and an entry file; the bus is the only thing nodes share.
`node_example/hello-node` is the smallest one that does something, and
[docs/node-authoring.md](docs/node-authoring.md) walks through writing your own.

## 🧩 Why it feels different

- 🧠 **One agent, not one chat per tab.** The agent sees the same history, notes, todos and tools from
every page.
- 🧰 **Tools are nodes.** Add a capability by adding a package; the agent discovers it at runtime.
- 🖥️ **Local-first.** Files, shell, timers and search run where you do; the model is the only remote
part unless you choose otherwise.
- 🔌 **No lock-in.** Any OpenAI-compatible endpoint, a plain WebSocket bus, and a Web UI you can
replace.

## 🚫 What it is not

- not a hosted service: there is no server to sign up for
- not multi-tenant: one deployment is one person with one token (the built-in login page adds a door,
  not accounts)
- not a node store: third-party nodes connect to your local bus themselves (`npx @node-agent/sdk .`)
- not a sandbox: the `shell` node runs commands on your machine, because that is what it is for

## 🗂 Layout

```text
node_agent/
  sdk/         wire types, manifest schema, node runner
  bus/         the WebSocket bus
  runtime/     the runtime contract, and RuntimeServer over HTTP for a runtime elsewhere
  node-agent/  LocalRuntime (the bus and one worker per node here) and the entry, bin: node-agent
  nodes/       the node packages
    agent/ history/ provider/ shell/ search/ webui/
    notes/ todo/ timer/ system/ introduce/
deploy/        one Dockerfile, one compose file: `stack`, and `caddy` in the public profile
node_example/hello-node/
docs/
```

## 🛠 Development

```bash
npm install          # workspace packages + @node-agent/sdk from npm
npm run build        # builds the workspaces in dependency order
npm test             # builds first, then runs every workspace suite; all green (see docs/STATUS.md)
```

See [docs/quickstart.md](docs/quickstart.md), [docs/architecture.md](docs/architecture.md),
[docs/security.md](docs/security.md) and [docs/deployment.md](docs/deployment.md).

## 📊 Status

This is an early `0.1.0` project, not production software. `npm run build` is the supported gate;
CI also runs `npm test`, which builds first and then runs every workspace suite; both are green.
[docs/STATUS.md](docs/STATUS.md) lists the per-suite counts.

## 📄 License

MIT License. See [LICENSE](LICENSE).

Every published workspace package carries the license copy npm needs. `npm run licenses:check` fails
when a copy drifts.
