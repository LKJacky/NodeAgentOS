# Contributing

This repository is one person's agent, opened up. Small, focused changes are welcome; large redesigns
are worth an issue first, so we can agree on the shape before you spend a weekend on it.

## Ground rules

- **Sign off your commits** (`git commit -s`). Contributions are accepted under the Developer
  Certificate of Origin 1.1 — you are saying you wrote it, or that you have the right to send it.
- **License.** By contributing, you agree that your contribution is licensed under MIT, the same license as this repository.
- **One change, one reason.** Structure-only commits stay structure-only: no unrelated fixes riding
  along.
- **No new runtime dependencies without a reason.** The bus, the runtime and the nodes use Node's
  standard library; `provider`, `agent` (markdown-it) and the SDK runner are the exceptions.
- **The SDK is the public surface.** Changing `node_agent/sdk` changes what every third-party node builds
  against; say so in the pull request if you do.

## Before you open a pull request

```bash
npm install
npm run build
npm run licenses:check   # LICENSE copies still match the root file
npm test
```

`npm run build` must pass. `npm test` builds first and then runs every workspace suite; it must
pass too. If a test fails for a reason unrelated to your change, say so in the pull request rather
than deleting the test. See [docs/STATUS.md](docs/STATUS.md) for the per-suite counts.

## Writing a node

See [docs/node-authoring.md](docs/node-authoring.md). A node that is only useful to you belongs in your
own repository — this one keeps the core nodes and one example.
