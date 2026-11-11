// shell.run-node forwards only the bus URL and token; set TLS before the SDK connects.
process.env.NODE_AGENT_TLS_INSECURE ??= '1';
await import('./dist/serve.js');
