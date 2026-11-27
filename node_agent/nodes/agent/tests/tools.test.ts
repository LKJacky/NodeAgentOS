import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentBusEnv, type EnvHost } from '../src/env.ts';
import { TOOLS } from '../src/tools.ts';
import type { ToolCall } from '../src/types.ts';

function env(options: { allowSearchCache?: boolean } = {}): AgentBusEnv {
  const host = {
    busName: 'agent',
    selfName: 'agent',
    bus: {} as EnvHost['bus'],
    cache: {} as EnvHost['cache'],
    ask: async () => '',
  } as EnvHost;
  return new AgentBusEnv(host, options);
}

const call: ToolCall = {
  id: 'call_tools',
  type: 'function',
  function: { name: 'read_all_tools', arguments: '{}' },
};

test('read_all_tools is one of the tools the model is offered', () => {
  assert.ok(TOOLS.some((tool) => tool.function.name === 'read_all_tools'));
});

test('read_all_tools names every offered tool first, then gives the full definitions', async () => {
  const agent = env();
  const answer = await agent.execute(call);
  const [index, details] = answer.split('\nFULL TOOL DEFINITIONS\n');
  assert.ok(index !== undefined && details !== undefined, 'the index comes before the details');
  const names = [...index.matchAll(/^\d+\. ([a-z_]+)\(/gm)].map((match) => match[1]);
  assert.deepEqual(
    names,
    agent.tools.map((tool) => tool.function.name),
    'the prefix names every tool in the order it is offered',
  );
  assert.match(index, /^TOOLS \(\d+\)/);
  assert.match(
    index,
    /run_on_node\(node: string, tool_name: string, tool_args: object\)/,
    'every argument is listed with its type',
  );
  assert.match(
    index,
    /ask_user\(title: string, content\?: string, selections\?: array<string>, input\?: string, timeout_seconds\?: number, default\?: string\)/,
    'optional arguments carry a question mark',
  );
  for (const line of index.split('\n').slice(1)) {
    const description = line.split(' — ')[1] ?? '';
    assert.ok([...description].length <= 51, `summary stays short: ${line}`);
  }
  assert.ok(index.length < 4096, 'the whole index fits well inside the default input limit');
  assert.match(details, /"name": "whoami"/, 'the full definitions follow the index');
});

test('allowSearchCache off hides search_cache and refuses it if called', async () => {
  const envWithNoSearch = env({ allowSearchCache: false });
  const toolsText = envWithNoSearch.readAllTools();
  assert.doesNotMatch(toolsText, /search_cache/);
  const answer = await envWithNoSearch.execute({
    id: 'call_search',
    type: 'function',
    function: { name: 'search_cache', arguments: '{"entry":1,"pattern":"x"}' },
  });
  assert.match(answer, /switched off/);
});
