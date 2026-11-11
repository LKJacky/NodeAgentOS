import { Node, type ToolArgs } from '@node-agent/sdk';

/** One node with two capabilities: one answers directly, one calls another node. */
export default class ExampleNode extends Node {
  readonly handlers = {
    echo: async (args: ToolArgs) => ({ node: this.ctx.from, args }),

    call: async (args: ToolArgs) => {
      const node = String(args.node ?? '').trim();
      const cap = String(args.cap ?? '').trim();
      if (node === '' || cap === '') throw new Error('call needs node and cap');
      const forwarded = (args.args ?? {}) as ToolArgs;
      // ctx.call fills sender identity, tenant and deadline; the caller only names the address.
      return await this.ctx.call(node, cap, forwarded);
    },
  };
}
