// `whoami`: the name a call that names an agent takes. The family shares one bus node, so a
// sub-agent's name is not the node's - which is exactly the thing the model cannot read out of its
// prompt and must be able to ask for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentBusEnv, type EnvHost } from '../src/env.ts';
import { TOOLS } from '../src/tools.ts';
import type { ToolCall } from '../src/types.ts';

/** An env built only to be asked its name: no bus, no cache, nobody to ask. */
function envFor(selfName: string, busName = 'agent'): AgentBusEnv {
  const host = {
    busName,
    selfName,
    bus: {} as EnvHost['bus'],
    cache: {} as EnvHost['cache'],
    ask: async () => '',
  } as EnvHost;
  return new AgentBusEnv(host);
}

/** One `whoami` call, exactly as a model would make it. */
async function whoami(env: AgentBusEnv): Promise<string> {
  const call: ToolCall = {
    id: 'call_whoami',
    type: 'function',
    function: { name: 'whoami', arguments: '{}' },
  };
  return await env.execute(call);
}

test('whoami is one of the tools the model is offered', () => {
  assert.ok(TOOLS.some((tool) => tool.function.name === 'whoami'));
});

test("whoami names the family's own agent with the node's name", async () => {
  assert.equal(await whoami(envFor('agent')), 'you are "agent"');
});

test('whoami names a sub-agent, and the agent it belongs to', async () => {
  assert.equal(await whoami(envFor('writer')), 'you are "writer", a sub-agent of "agent"');
});
