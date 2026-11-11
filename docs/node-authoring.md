# Writing a node

A node is a package that registers capabilities on the bus. `node_example/hello-node` is the smallest
real one; this page is what it demonstrates.

## 1. The manifest

In `package.json`:

```json
{
  "name": "hello-node",
  "type": "module",
  "dependencies": { "@node-agent/sdk": "^0.1.0" },
  "node": {
    "id": "hello",
    "desc": "Says hello",
    "entry": "dist/index.js",
    "caps": {
      "echo": {
        "type": "object",
        "required": ["value"],
        "properties": { "value": {} },
        "callers": ["agent"],
        "description": "echo one value back"
      }
    }
  }
}
```

`id` is the name callers use. `entry` is what the runtime starts (as a worker thread, or a child
process under `isolation: 'process'`). `caps` is both documentation (the agent is shown this) and the
contract (arguments are checked against it). `callers` lists who may call it — `agent` is the usual
answer, and leaving it empty means nobody may.

## 2. The implementation

```ts
import { Node, type ToolArgs } from '@node-agent/sdk';

export class HelloNode extends Node {
  readonly id = 'hello';

  constructor() {
    super({
      caps: { echo: (args: ToolArgs) => ({ value: args.value ?? null }) },
    });
  }
}

export default HelloNode;
```

## 3. Build and run it

```bash
npm install && npm run build            # in the node's directory, or from the repo root
NODE_AGENT_BUS_URL=ws://127.0.0.1:8788 NODE_AGENT_TOKEN=<token> npx @node-agent/sdk .
```

There is no publish step and no store: the node dials the bus it was given. Restarting it is the whole
upgrade story, which is what makes a personal deployment simple.

## 4. Call it

Ask the agent in the Web UI to use `hello.echo`, or call it from any bus client by node id and
capability name. The bus answers with the tool result the runtime wrapped.

## Rules that are worth knowing

- **One node, one worker.** A node that crashes takes only itself down — its worker thread stops, the
  bus and the other nodes keep running, and the runtime reports the exit. (A node launched with
  `isolation: 'process'` is a child process instead; either way the failure is contained.)
- **No node imports another node.** If two nodes need the same code, it belongs in the SDK or in a
  library, not in a sideways import.
- **The model never calls you directly.** It calls the `agent` node, which makes a bus call; your node
  sees a normal request with a caller, and can refuse it.
- **UI belongs to the node.** A node that wants a page or a tab carries its own `ui` schema and its own
  `icon.svg`; the Web UI draws whatever the node hands over.
