// The example package, driven end to end: the node this package ships, a second node beside it, and
// a caller that talks to it over a real bus. Everything here is what a deployment does -- the package
// is registered from its own directory, all three nodes join one user's space, and every answer comes
// back over the wire.
//
// The example's own manifest names one caller for each capability (`agent`), the way a node that is
// meant for the model does; the caller in this demo is that node.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Node, NodeHost, WebSocketBusSession, servePackage } from '@node-agent/sdk';
import { Bus, privateNodeToken } from '../../../node_agent/bus/dist/index.js';

const TOKEN = 'demo-token';

const manifest = (name, caps) => ({
  packageId: `pkg_${name}`,
  name,
  caps,
  desc: `${name} demo node`,
  version: '0.1.0',
  publisher: 'node-agent',
  icon: '<svg></svg>',
});

const bus = await new Bus(TOKEN).listen(0, '127.0.0.1');
const user = `example-demo-${randomUUID()}`;
const joinToken = privateNodeToken(TOKEN, user);
// One credential for one user's space, which is what a node outside the process is handed
// (`@node-agent/sdk .` reads it from its environment): everything below joins as that user's own.

// The package is loaded by the SDK runtime: it registers from its own directory.
const example = await servePackage(fileURLToPath(new URL('..', import.meta.url)), {
  url: bus.url,
  token: joinToken,
});
assert.match(example.manifest.icon ?? '', /^<svg/);

// A second node on the same bus: example.call will call this one.
class Upstream extends Node {
  handlers = { ping: (args) => ({ from: 'upstream', args }) };
}
const upstream = new NodeHost({
  definition: {
    manifest: manifest('upstream', { ping: { type: 'object' } }),
    Node: Upstream,
  },
  bus: new WebSocketBusSession(),
});
await upstream.start(bus.url, joinToken);

// The caller takes the name the example's manifest names, and relays one call per request.
class Caller extends Node {
  handlers = {
    relay: async (args) =>
      await this.ctx.call(String(args.node), String(args.cap), args.args ?? {}),
  };
}
const callerHost = new NodeHost({
  definition: {
    manifest: manifest('agent', { relay: { type: 'object' } }),
    Node: Caller,
  },
  bus: new WebSocketBusSession(),
});
await callerHost.start(bus.url, joinToken);

const call = async (node, cap, args) =>
  await callerHost.invoke({
    id: randomUUID(),
    type: 'call',
    from: 'agent',
    to: 'agent',
    tenantId: user,
    deadline: Date.now() + 5_000,
    payload: { cap: 'relay', args: { node, cap, args } },
  });

const echo = await call('example', 'echo', { value: 42 });
assert.deepEqual(echo, { ok: true, value: { node: 'agent', args: { value: 42 } } });

const relayed = await call('example', 'call', {
  node: 'upstream',
  cap: 'ping',
  args: { value: 7 },
});
assert.deepEqual(relayed, { ok: true, value: { from: 'upstream', args: { value: 7 } } });

console.log('example demo ok');
await callerHost.stop();
await upstream.stop();
await example.stop();
bus.close();
