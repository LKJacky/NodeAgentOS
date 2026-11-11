import assert from 'node:assert/strict';
import { Node, requireBindings } from './dist/index.js';

class EchoNode extends Node {
  handlers = {
    echo: async (args) => ({ tenant: this.ctx.tenantId, text: args.text }),
  };

  disposed = false;

  dispose() {
    this.disposed = true;
  }
}

const calls = [];
const makeContext = () => ({
  nodeId: 'echo',
  tenantId: 'tenant-a',
  from: 'agent',
  cap: 'echo',
  deadline: Date.now() + 10_000,
  signal: new AbortController().signal,
  call: async (node, cap, args) => calls.push([node, cap, args]),
  publish: (topic, value) => calls.push([topic, value]),
});

const a = new EchoNode(makeContext());
const b = new EchoNode(makeContext());
assert.notEqual(a, b);
assert.deepEqual(await a.handlers.echo({ text: 'hi' }), {
  tenant: 'tenant-a',
  text: 'hi',
});
a.dispose();
assert.equal(a.disposed, true);
assert.equal(b.disposed, false);

// Bindings are the host's to give: a context built by hand refuses them, once, by name.
assert.throws(() => requireBindings(a.ctx), /not built by a NodeHost \(node echo\)/);
assert.equal(a.ctx.bind, undefined);
console.log('node smoke ok');
