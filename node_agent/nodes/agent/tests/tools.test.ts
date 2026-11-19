import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentBusEnv, type EnvHost } from '../src/env.ts';
import { TOOLS } from '../src/tools.ts';
import type { ToolCall } from '../src/types.ts';

function env(): AgentBusEnv {
  const host = {
    busName: 'agent',
    selfName: 'agent',
    bus: {} as EnvHost['bus'],
    cache: {} as EnvHost['cache'],
    ask: async () => '',
  } as EnvHost;
  return new AgentBusEnv(host);
}

const call: ToolCall = {
  id: 'call_tools',
  type: 'function',
  function: { name: 'read_all_tools', arguments: '{}' },
};

test('read_all_tools is one of the tools the model is offered', () => {
  assert.ok(TOOLS.some((tool) => tool.function.name === 'read_all_tools'));
});

test('read_all_tools returns every offered definition as JSON', async () => {
  const answer = await env().execute(call);
  const defs = JSON.parse(answer) as { function: { name: string } }[];
  assert.ok(Array.isArray(defs));
  const names = defs.map((tool) => tool.function.name);
  assert.ok(names.includes('read_all_tools'));
  assert.ok(names.includes('whoami'));
  assert.ok(names.includes('ask_user'));
});
