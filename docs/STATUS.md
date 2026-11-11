# Status

`node-agent` is at `0.1.0`: the build is green, every suite is green, and a complete personal stack
starts, but the project is not production software yet.

## Green

`npm test` builds the workspace and then runs every suite (counts from a full run on 2026-11-11):

```text
node-agent-bus       60/60
@node-agent/runtime  2/2
node-agent           26/26
node-agent-agent     111/111
node-agent-history   19/19
node-agent-introduce 23/23
node-agent-notes     40/40
node-agent-provider  41/41
node-agent-search    19/19
@node-agent/shell    89/89
node-agent-system    40/40
node-agent-timer     2/2
node-agent-todo      47/47
node-agent-webui     42/42
node-agent-example   the demo runs
```

On every pull request the CI workflow runs `npm ci`, `npm run licenses:check`, `npm run build`, and
then `npm test`. `npm run licenses:check` is there because every package carries a copy of the root
`LICENSE` (npm can only pack files inside the package directory); it fails when a copy has drifted.

## What the repair changed

Nothing is hidden behind `continue-on-error`, and no suite was skipped to make this page green. The
test debt that this page used to list was a mix of stale import paths, stale exports, and the retired
legacy bus handshake:

- `npm test` now builds before it tests, so a suite that loads a sibling's `dist` (or a package root
  whose `dist/serve.js` the runtime spawns) finds it. `node-agent-bus` and `node-agent-history`
  gained the `pretest` build their siblings already had.
- The TypeScript suites run through the `test/ts-resolve.mjs` hook (the one the agent and provider
  suites already used): a source file imports `./model.js` for the `model.ts` beside it, which is what
  `tsc` writes and what Node does not guess.
- The legacy bus handshake is gone from the bus, so the fixtures that drove it now use the envelope
  bus: `WebSocketBusSession`, a real user connection (`privateNodeToken`, or a control connection's
  `connect`), and a caller node that relays one call per request. `LegacyBusSession` keeps its own
  coverage against the wire it translates (`node_agent/sdk/test-legacy-bus.mjs`).
- `HttpHistoryStore` is tested against a server double that speaks the documented wire
  (`node_agent/nodes/history/test/server-double.ts`); the deployment's own history server is a
  separate product.
- Two real bugs came out of this: `todo`, `notes` and `search` recognised "no history node" by the
  wording the bus *used* to use, so a stack without history stopped serving instead of staying
  process-local; and the timer manifest's `set`/`cancel`/`list` were opened to every node with a
  wildcard caller, which the manifest test now allows for `timer` alone and on the record: the timer
  is the user's clock, any node may ask it for a wake, and `set` wakes the caller when it names no
  other node.
- A later pass kept that green without moving a product write path: the two `usage` cases in
  `node-agent` wait for the transcript line the agent files behind `chat`'s answer instead of reading
  the file the instant the answer lands, and the todo page no longer repaints an order a drop has
  already drawn when a list read that started before the drop comes back afterwards.
- The first visit is onboarding: `introduce.status` says whether the setup ran, the shell puts the
  introduce page in a full-screen frame until it has, and the page writes the reader's language before
  it calls the one-shot setup. The runtime no longer chooses a language or runs the setup by itself.

## Before the first publish

- **Internal dependencies are version ranges.** The launcher is now `@node-agent/local`; its
  core nodes are ordinary `^0.1.0` dependencies, and the runtime is bundled into the launcher, so the packed tarball is installable from the
  registry. Publish in dependency order: `@node-agent/sdk`, `node-agent-bus`, the node packages, then
  `@node-agent/local`. `@node-agent/runtime` is not a published dependency.
- **Registry state is the remaining publish blocker.** At the time of this status update only
  `@node-agent/sdk@0.1.0` is on npm; the launcher needs `@node-agent/sdk@^0.1.1` and the bus and
  node packages still have to be published. The runtime is already inside the launcher tarball. `npm publish --dry-run` for `@node-agent/local` passes.
- **Licensing is in place.** Every workspace carries `LICENSE` (kept in step by `npm run licenses:sync`,
  verified by `npm run licenses:check`, refreshed in `prepack`), and the Docker image copies it to the
  root of its working directory.
