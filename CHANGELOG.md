# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `NodeContext.nodeAgentHome` and `NodeContext.home`: the SDK now hands every node its home from
  `$NODE_AGENT_HOME` (default `~/.node_agent`), with the node's own directory at
  `<node-agent-home>/<node-name>/`.

### Changed

- the history node prints its storage target when it starts, so a local SQLite path or a remote
  history URL is visible in the node log. A runtime-generated bus token is kept at
  `<node-agent-home>/runtime/bus-token` (0600) and reused. User bus identities are a fixed namespace
  hash of the user name, independent of the token, so restarting or rotating `NODE_AGENT_TOKEN` does
  not move a user to a new history partition.
- all node-owned durable files use that one layout: history, shell permissions, the local provider,
  and node logs now live under `<node-agent-home>/<node-name>/`. Runtime-owned state (users and
  installed packages) lives under `<node-agent-home>/runtime`; `NODE_AGENT_RUNTIME_HOME` and
  `RUNTIME_HOME` are gone. The history database no longer takes an environment variable: it is always
  `<node-agent-home>/history/sqlite`; `NODE_AGENT_HISTORY_DB` is gone.

- the `memory` node is now `notes`: package `node-agent-notes`, node id `notes`, class `NotesNode`,
  page title "Notes", and `notes.*` everywhere a capability, event topic or default node list named
  the old one. `npm run build`, `NODE_AGENT_NODES` and every document follow.

### Removed

- `deploy/public`, its `node-agent-gateway` workspace and the duplicate `deploy/home` tree: there is now
  one `deploy/Dockerfile`, one `deploy/docker-compose.yml` and one env file. The compose file has two
  services — `stack`, and `caddy` behind the `public` profile — so a local start never brings up a proxy.
  The token login page lives on as the built-in door of the stack (`NODE_AGENT_ACCESS_TOKEN`), which is
  what the `public` profile points Caddy at.

### Migration

- the memos themselves stay where they are: the history unit is still `memos` / `memos.<id>`, with
  the revisions it had. Only the node name the history node files them under changed, so run
  `node node_agent/nodes/notes/scripts/migrate-memos-from-memory.mjs` once (stack stopped) to copy
  the `memory` units across to `notes`. It keeps the old units, and does nothing on a second run.
- drafts the page kept in the browser under `memory.draft.*` / `memory.open.*` are read once and
  moved to the `notes.*` keys, so unsaved text survives the rename.
- the event topic is the node's name, so a listener that subscribed to `memory` has to subscribe to
  `notes`: the bus keys an event by (publishing node, topic), and publishing under the old name
  would take a second node registered at `memory`.

## [0.1.0] - 2026-11-10

### Added

- one shared WebSocket bus and a node SDK for capabilities, events and permissions
- a personal stack: history, agent, provider, shell, memory, todo, timer, search and Web UI
- one-process runtime: the bus and default nodes run in the same OS process as worker threads
- `deploy/home` for a loopback-only personal container and `deploy/public` for the token-gated door
- node authoring documentation and a minimal example node
- MIT licensing: root `LICENSE`, the same file inside every package npm can pack, both Docker images,
  and `npm run licenses:check` in CI to keep the copies honest
- CI that builds every workspace and runs the full test suite (see `docs/STATUS.md`)

[Unreleased]: https://github.com/LKJacky/NodeAgentOS/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LKJacky/NodeAgentOS/releases/tag/v0.1.0
