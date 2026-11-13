# @node-agent/runtime

The runtime contract and its HTTP surface. It owns no process table and no product.

| file | what it is |
|---|---|
| `src/base.ts` | the contract: `Runtime`, `RuntimeState`, `BusOptions`, `NodeOptions`, `RuntimeError` |
| `src/server.ts` | `RuntimeServer`: the same contract over a small HTTP surface |
| `src/client.ts` | `RuntimeClient`: that HTTP surface as a `Runtime` implementation |

The local, single-user implementation (`LocalRuntime`) lives in
`node_agent/node-agent/src/local.ts`. The meta package starts one behind a `RuntimeServer`, then
uses a `RuntimeClient` to create users and launch nodes by name. A future edge or cloud adapter
implements the same `Runtime` interface without a child process in sight.

Build:

```bash
npm run build -w @node-agent/runtime
```
