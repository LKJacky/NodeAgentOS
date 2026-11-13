// @node-agent/runtime: the runtime contract and its HTTP surface.
//
//   base.ts    the interface (a bus, nodes, users as access relations)
//   server.ts  RuntimeServer: the same interface over HTTP, so a runtime can live elsewhere
//
// The local, single-user implementation lives in the `node-agent` package.
export * from './base.js';
export * from './server.js';
export * from './client.js';
