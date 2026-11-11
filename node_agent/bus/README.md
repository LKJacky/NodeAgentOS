# node-agent-bus

The WebSocket bus every node joins. The entry point prints one `bus: host:port` line on stdout;
diagnostic lines go to stderr so a supervisor can keep them apart.

## Logging

`NODE_AGENT_LOG_LEVEL` controls agent, bus and runtime diagnostics together. Values are
case-insensitive and trimmed; unset, empty or invalid values use `info`. The former per-component
variables are no longer used.

| value | enabled diagnostics |
| --- | --- |
| `silent` | none |
| `error` | errors only |
| `warn` | connection refusals, plus errors |
| `info` (default) | topology and lifecycle events, plus warnings and errors |
| `debug` | call start/refusal/completion, plus all higher-severity events |

Logs never include a bearer token or a manifest body. A stuck call is usually diagnosed with:

```bash
NODE_AGENT_LOG_LEVEL=debug node-agent-bus --url ws://127.0.0.1:8788 --token demo-token
```

Then follow the `call`, `call.refused` and `call.done` lines for one `id`. The runtime starts its
bus with its own stderr in the runtime's terminal (and node logs under `$NODE_AGENT_HOME/<node>/logs/`), so the same setting can be
put in the runtime environment before starting a served stack. Existing protocol/frame error
logging and uvicorn access logs are unchanged.
