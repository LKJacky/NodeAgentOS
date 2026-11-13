# NodeAgent Python

Two small packages:

- `node_agent_sdk`: connect to the bus, register a node, call and list. No pages, no i18n.
- `node_agent_runtime`: the runtime HTTP client plus a `runtime` bus bridge.

The runtime client uses only the standard library. The bus SDK needs `aiohttp` for its WebSocket
(`pip install -e '.[bus]'`).

## Bus SDK

A node subclasses `Node` and maps capability names to handlers, matching the TypeScript shape.
`Host` registers the manifest and creates a fresh node instance for every call; `dispose()` runs
in a `finally` block. Nothing stored on `self` survives the call.

```python
import asyncio
from node_agent_sdk import Host, Node

class Echo(Node):
    name = "echo"
    desc = "echo one argument"
    caps = {
        "say": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        }
    }

    def __init__(self, ctx):
        super().__init__(ctx)
        self.handlers = {"say": self.say}

    async def say(self, args):
        return {"text": args["text"], "tenant": self.ctx.tenant_id}

asyncio.run(Host(Echo, "ws://127.0.0.1:8788", "bus-token").run())
```

`ctx` is a `NodeContext` with `tenant_id`, `from_node`, `node_id`, `deadline`, `signal`,
`node_agent_home`, `home`, and bus helpers such as `await ctx.call(node, capability, args)`.
`Node` also has optional `on_event(topic, value, from_node)` and `dispose()` hooks.

## Serving

`serve.py` starts the NodeAgent runtime and a Python node against the bus it prints.

```python
from node_agent_sdk import launch_node, launch_node_agent

runtime = await launch_node_agent(home="/tmp/node-agent")
node = await launch_node(Echo, runtime.bus_url, runtime.bus_token)
print(runtime.runtime_url, runtime.webui_url)
await node.stop()
await runtime.stop()
```

The lower-level `BusClient` is available when a node wants to manage the socket itself:

```python
from node_agent_sdk import BusClient

bus = BusClient("ws://127.0.0.1:8788", "bus-token")
await bus.connect()
await bus.register({
    "packageId": "my-node",
    "name": "echo",
    "desc": "echo one argument",
    "version": "0.1.0",
    "publisher": "me",
    "icon": "<svg/>",
    "caps": {"say": {"type": "object", "properties": {"text": {"type": "string"}}}},
})
value = await bus.call("history", "list", {"unitId": "notes"}, tenant="alice")
await bus.close()
```

## Runtime client

An async, standard-library client for the runtime HTTP API (`RuntimeServer`). It mirrors the
TypeScript `RuntimeClient` in `../node_agent/runtime/src/client.ts`: users, bus, nodes, sessions
and the small discovery helpers. Each blocking HTTP request runs in `asyncio.to_thread`, so the
package has no aiohttp dependency for HTTP.

```python
from node_agent_runtime import AsyncRuntimeClient

runtime = AsyncRuntimeClient("http://127.0.0.1:8793", "service-token")
await runtime.create_user("alice")
webui = await runtime.launch_node("webui")
await runtime.connect("alice", "webui")
print(await runtime.tenant("alice"))
print(await runtime.sessions("alice"))
await webui.stop()
await runtime.stop_bus()
```

## Methods

| method | route |
|---|---|
| `healthz()` / `whoami()` | `GET /healthz`, `GET /whoami` |
| `create_user(user)` / `destroy_user(user)` | `POST /users/create`, `POST /users/destroy` |
| `tenant(user)` | `GET /users/tenant?user=` |
| `launch_bus()` / `stop_bus()` | `POST /bus/launch`, `POST /bus/stop` |
| `launch_node(node, options?)` / `stop_node(node)` | `POST /node/launch`, `POST /node/stop` |
| `has_node(node)` / `output(node)` | `GET /node/has`, `GET /node/output` |
| `connect(user, node, options?)` / `disconnect(user, node)` | `POST /connect`, `POST /disconnect` |
| `sessions(user?)` | `GET /sessions` |

A runtime refusal raises `RuntimeError` with `status` and `code` preserved from the server. A
transport failure uses `code="runtime_unavailable"`.

## Tests

```bash
python3 -m unittest discover -s python/tests -v
```
## Runtime bus helper

`RuntimeNode` is not registered on the bus and exposes no capabilities. It wraps an existing
`NodeContext` for code that wants to operate bus content:

```python
from node_agent_runtime import RuntimeNode

runtime = RuntimeNode(ctx)
nodes = await runtime.nodes()
caps = await runtime.capabilities("history")
value = await runtime.call("history", "list", {"unitId": "notes"})
await runtime.publish("topic", {"value": 1})
await runtime.subscribe("history", "topic")
```
