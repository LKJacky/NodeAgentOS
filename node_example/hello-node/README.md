# @node-agent/sdk example

A minimal node that uses `@node-agent/sdk`, plus a test proving another node can call it.

## Install

The SDK is a local package:

```bash
cd node_example/hello-node
npm install
npm run build
```

`package.json` depends on the published `@node-agent/sdk` (`^0.1.0`).

The node package has no `serve.ts` and never constructs `NodeHost`: `src/index.ts` only
default-exports the `Node` class, and the SDK's `@node-agent/sdk` runtime loads the package,
reads `package.json#node`, builds the host and joins the bus.

## Test

```bash
npm test
```

It starts main's old `Bus` in-process, joins two SDK nodes (`example` and `upstream`), then calls:

- `example.echo` directly
- `example.call`, which internally calls `upstream.ping`

## Run against a bus

```bash
NODE_AGENT_BUS_URL=ws://127.0.0.1:8788 \
NODE_AGENT_TOKEN=demo-token \
NODE_AGENT_TENANT=default \
npm start
```

It registers:

```text
example.echo
example.call
```

## Call from another SDK node

```ts
const result = await this.ctx.call('example', 'echo', { value: 42 });
```

## Call from a plain bus client

The old bus address is the same:

```text
example.echo { "value": 42 }
```

`example.call` takes `{ node, cap, args }` and calls that node through `ctx.call`:

```json
{ "node": "upstream", "cap": "ping", "args": { "value": 7 } }
```

## Files

- `src/index.ts` — default-exports `ExampleNode` with `echo` and `call`; no host code
- `icon.svg` — the node icon carried in the manifest
- `test/demo.mjs` — old-bus integration test
