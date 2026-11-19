// The settings an agent runs on: what it starts with, what a save writes, what it refuses, and what
// a save that lost a race does. The behaviour behind each field is tested where it lives (the input
// limit below, the compression pair and the cache cap in `wiring.test.ts`, `ask_user` in
// `provider.test.ts`); this file is about the capability that reads and writes them, and about the
// four things a stored unit has to get right: tenant isolation, the agent the call names, the
// revision rule, and the deployment's defaults underneath.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, SETTINGS_NAMES, SETTINGS_UNIT } from '../src/settings.ts';
import { COMPRESSION_THRESHOLD, COMPRESSION_TOKENS } from '../src/model.ts';
import { FakeNet, startAgent } from './harness.ts';
import { ScriptedProvider } from './scripted_model.ts';

/** One settings answer, as a test reads it. */
type SettingsAnswer = {
  agent: { name: string; parent: string | null };
  settings: typeof DEFAULT_SETTINGS;
  defaults: typeof DEFAULT_SETTINGS;
  provider: { active: string };
  live: string[];
  restartRequired: string[];
  persistent: boolean;
};

type Caller = { call: (cap: string, args: Record<string, unknown>) => Promise<unknown> };

async function settingsOf(
  agent: Caller,
  args: Record<string, unknown> = {},
): Promise<SettingsAnswer> {
  return (await agent.call('settings', args)) as SettingsAnswer;
}

test('an agent starts on the settings this deployment gives it', async () => {
  const agent = await startAgent({ net: new FakeNet().withHistory() });
  try {
    const answer = await settingsOf(agent);
    assert.deepEqual(answer.settings, DEFAULT_SETTINGS, 'nothing stored is nothing changed');
    assert.deepEqual(answer.defaults, DEFAULT_SETTINGS, 'and the fallback is the package default');
    // The numbers this package already ran on: a deployment that saves nothing behaves as before.
    assert.equal(answer.settings.compressionThreshold, COMPRESSION_THRESHOLD);
    assert.equal(answer.settings.compressionThreshold, 128 * 1024);
    assert.equal(answer.settings.compressionTokens, COMPRESSION_TOKENS);
    assert.equal(answer.settings.compressionTokens, 32 * 1024);
    assert.equal(answer.settings.cacheSize, 500);
    // The two switches start on: what an agent could do before they existed.
    assert.equal(answer.settings.allowSpawn, true);
    assert.equal(answer.settings.allowAskUser, true);
    assert.equal(answer.settings.allowSearchCache, true);
    assert.equal(answer.settings.radicalForget, false);
    assert.deepEqual(
      answer.restartRequired,
      [],
      'no field is read once and kept: none needs a restart',
    );
    assert.deepEqual(
      [...answer.live].sort(),
      [...SETTINGS_NAMES].sort(),
      'every field is in force from the next turn',
    );
    assert.deepEqual(
      answer.agent,
      { name: 'agent', parent: null },
      'the answer says which agent it is for: its page hides what a sub-agent has no use for',
    );
    assert.equal(answer.persistent, true, 'history is on, so a save outlives the process');
    assert.deepEqual(answer.provider, { active: '' }, 'no provider node is on this bus');
  } finally {
    await agent.stop();
  }
});

test('the six fields this release removed are not settings any more', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'removed' });
  try {
    const answer = await settingsOf(agent);
    for (const gone of [
      'systemPrompt',
      'streamIdleMs',
      'askTimeoutSeconds',
      'restoreAgents',
      'retention',
      'retention.maxMessages',
      'retention.ttlMs',
    ]) {
      assert.equal(
        Object.hasOwn(answer.settings, gone),
        false,
        `${gone} is not in the settings in force`,
      );
      assert.equal(answer.live.includes(gone), false, `${gone} is not a live field`);
    }
    // A unit written by an older release is read for the fields this one has and nothing else.
    net.putUnit(
      SETTINGS_UNIT,
      {
        version: 1,
        values: {
          maxAgents: 4,
          systemPrompt: 'be terse',
          retention: { maxMessages: 10 },
          cacheSize: 7,
        },
      },
      'removed',
    );
    const again = await startAgent({ net, tenantId: 'removed' });
    try {
      const read = await settingsOf(again);
      assert.equal(read.settings.maxAgents, 4, 'a field this release still has is kept');
      assert.equal(read.settings.cacheSize, 7, 'and so is a field it gained');
      assert.equal(Object.hasOwn(read.settings, 'systemPrompt'), false);
      assert.equal(Object.hasOwn(read.settings, 'retention'), false);
    } finally {
      await again.stop();
    }
  } finally {
    await agent.stop();
  }
});

test('a compression notice that cannot say how many go is refused', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'notice-one' });
  try {
    await assert.rejects(
      () => settingsOf(agent, { action: 'update', compressionNotice: 'dropping some' }),
      /it must say \{count\}/,
    );
    const held = await settingsOf(agent, { action: 'get' });
    assert.equal(held.settings.compressionNotice, DEFAULT_SETTINGS.compressionNotice);
    const kept = await settingsOf(agent, { action: 'update', compressionNotice: '{count} go now' });
    assert.equal(kept.settings.compressionNotice, '{count} go now');
  } finally {
    await agent.stop();
  }
});

test('a save writes the fields it was given and leaves the others alone', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'save-one' });
  try {
    const first = await settingsOf(agent, { action: 'update', maxAgents: 8 });
    assert.equal(first.settings.maxAgents, 8);
    assert.equal(first.settings.maxInputLengthPerTurn, DEFAULT_SETTINGS.maxInputLengthPerTurn);

    // Only what was named is stored: a field nobody chose keeps following the deployment.
    assert.deepEqual(net.unit(SETTINGS_UNIT, 'save-one'), { version: 1, values: { maxAgents: 8 } });

    const second = await settingsOf(agent, { action: 'update', cacheSize: 50 });
    assert.equal(second.settings.maxAgents, 8, 'the earlier field is still there');
    assert.equal(second.settings.cacheSize, 50);
    assert.deepEqual(net.unit(SETTINGS_UNIT, 'save-one'), {
      version: 1,
      values: { maxAgents: 8, cacheSize: 50 },
    });

    // A whole settings object comes back, whether or not the caller asked for one field.
    assert.equal(Object.keys(second.settings).length, Object.keys(DEFAULT_SETTINGS).length);
    assert.equal(Object.keys(second.settings).length, 11, 'eleven fields, and no more');
  } finally {
    await agent.stop();
  }
});

test('a saved setting is what the next run starts on', async () => {
  const net = new FakeNet().withHistory();
  const first = await startAgent({ net, tenantId: 'tenant-a' });
  try {
    await settingsOf(first, {
      action: 'update',
      compressionThreshold: 4_096,
      compressionTokens: 1_024,
    });
  } finally {
    await first.stop();
  }
  const second = await startAgent({ net, tenantId: 'tenant-a' });
  try {
    const answer = await settingsOf(second);
    assert.equal(answer.settings.compressionThreshold, 4_096);
    assert.equal(answer.settings.compressionTokens, 1_024);
    assert.equal(answer.settings.cacheSize, DEFAULT_SETTINGS.cacheSize);
  } finally {
    await second.stop();
  }
});

test('a value outside the range it may have is refused, with the reason', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'refused' });
  try {
    await assert.rejects(
      () => agent.call('settings', { action: 'update', maxAgents: 0 }),
      /maxAgents must be between 1 and 64 \(got 0\)/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'update', maxAgents: '8' }),
      /maxAgents must be a whole number between 1 and 64 \(got "8"\)/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'update', compressionThreshold: 4.5 }),
      /compressionThreshold must be a whole number between 1024 and 1000000 \(got 4.5\)/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'update', compressionThreshold: 100 }),
      /compressionThreshold must be between 1024 and 1000000 \(got 100\)/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'update', compressionTokens: 262_145 }),
      /compressionTokens must be between 256 and 262144 \(got 262145\)/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'update', cacheSize: 0 }),
      /cacheSize must be between 1 and 10000 \(got 0\)/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'update', cacheSize: 10_001 }),
      /cacheSize must be between 1 and 10000 \(got 10001\)/,
    );
    // A switch is `true` or `false` and nothing else: `"no"` is a typo, not a way to say it.
    await assert.rejects(
      () => agent.call('settings', { action: 'update', allowSpawn: 'no' }),
      /allowSpawn must be true or false \(got "no"\)/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'update', allowAskUser: 1 }),
      /allowAskUser must be true or false \(got 1\)/,
    );
    // The six fields this release dropped are refused like any other name it does not have: an old
    // page, or an operator's script, must not look as if it saved something.
    for (const gone of ['systemPrompt', 'streamIdleMs', 'askTimeoutSeconds', 'restoreAgents']) {
      await assert.rejects(
        () => agent.call('settings', { action: 'update', [gone]: 'anything' }),
        new RegExp(`unknown setting "${gone}"`),
      );
    }
    await assert.rejects(
      () => agent.call('settings', { action: 'update', retention: { maxMessages: -1 } }),
      /unknown setting "retention"/,
    );
    // A typo is a refusal and not a silent no-op: a setting nobody reads would otherwise look saved.
    await assert.rejects(
      () => agent.call('settings', { action: 'update', maxAgent: 4 }),
      /unknown setting "maxAgent"/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'update' }),
      /cannot save settings: no setting was given/,
    );
    await assert.rejects(
      () => agent.call('settings', { action: 'delete' }),
      /unknown settings action "delete"/,
    );
    // Nothing was written by any of them.
    assert.deepEqual(net.unitIds('refused'), []);
  } finally {
    await agent.stop();
  }
});

test('a save that lost the race is retried on top of what the other writer wrote', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'race' });
  try {
    await settingsOf(agent, { action: 'update', cacheSize: 40 });
    const history = net.siblings.get('history');
    assert.ok(history !== undefined, 'the test bus has a history node');
    const save = history.caps.save;
    let refused = false;
    history.caps.save = (args, call) => {
      if (!refused) {
        refused = true;
        // Someone else saved first: a compression pair, on top of what this process had.
        net.putUnit(
          SETTINGS_UNIT,
          {
            version: 1,
            values: { cacheSize: 40, compressionThreshold: 2_048, compressionTokens: 1_024 },
          },
          call.tenantId,
        );
        throw new Error(`revision conflict on ${String(args.unitId)}`);
      }
      return save(args, call);
    };

    const answer = await settingsOf(agent, { action: 'update', maxAgents: 4 });
    assert.equal(refused, true, 'the first save was refused');
    assert.equal(answer.settings.maxAgents, 4, 'this writer\u2019s field survived the retry');
    assert.equal(answer.settings.compressionThreshold, 2_048, 'and so did the other writer\u2019s');
    assert.equal(answer.settings.compressionTokens, 1_024);
    assert.equal(answer.settings.cacheSize, 40, 'and what was there before both');
    assert.deepEqual(net.unit(SETTINGS_UNIT, 'race'), {
      version: 1,
      values: {
        cacheSize: 40,
        compressionThreshold: 2_048,
        compressionTokens: 1_024,
        maxAgents: 4,
      },
    });
  } finally {
    await agent.stop();
  }
});

test('a reset forgets every stored value and falls back to the defaults', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'reset' });
  try {
    await settingsOf(agent, { action: 'update', maxAgents: 4, cacheSize: 20 });
    const answer = await settingsOf(agent, { action: 'update', reset: true });
    assert.deepEqual(answer.settings, DEFAULT_SETTINGS);
    assert.deepEqual(net.unit(SETTINGS_UNIT, 'reset'), { version: 1, values: {} });
  } finally {
    await agent.stop();
  }
});

test('one agent\u2019s settings are its own, and a sub-agent copies its parent\u2019s', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'family' });
  try {
    await settingsOf(agent, { action: 'update', maxAgents: 5, compressionTokens: 2_048 });
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await agent.runtime.spawnAgent('kid', icon);
    const inherited = (await agent.call('settings', { agent: 'kid' })) as SettingsAnswer;
    assert.equal(
      inherited.settings.maxAgents,
      5,
      'a field the child did not set follows the parent',
    );
    assert.equal(inherited.settings.compressionTokens, 2_048);
    assert.equal(inherited.settings.allowSpawn, false, 'the two switches are not inherited as on');
    assert.equal(inherited.settings.allowAskUser, false);

    const own = (await agent.call('settings', {
      agent: 'kid',
      action: 'update',
      cacheSize: 9,
    })) as SettingsAnswer;
    assert.equal(own.settings.cacheSize, 9);
    assert.equal(own.settings.maxAgents, 5, 'a field the child did not set stays inherited');
    assert.deepEqual(net.unit(`sub.kid.${SETTINGS_UNIT}`, 'family'), {
      version: 1,
      values: { cacheSize: 9 },
    });
    const parent = await settingsOf(agent);
    assert.equal(
      parent.settings.cacheSize,
      DEFAULT_SETTINGS.cacheSize,
      'and the parent is untouched',
    );
  } finally {
    await agent.stop();
  }
});

test('a sub-agent that inherited a number follows the parent when the parent saves it', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'family-live' });
  try {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await agent.runtime.spawnAgent('kid', icon);
    const kid = agent.runtime.agent('kid');
    assert.equal(kid.cache.maxSize, DEFAULT_SETTINGS.cacheSize, 'the child started on the default');

    await settingsOf(agent, { action: 'update', cacheSize: 3, compressionThreshold: 4_096 });
    assert.equal(
      kid.cache.maxSize,
      3,
      'a child that did not set a cap runs on the parent\u2019s new one',
    );
    assert.equal(kid.settings.compressionThreshold, 4_096);

    // A child that has a value of its own keeps it, whatever the parent saves afterwards.
    await settingsOf(agent, { agent: 'kid', action: 'update', cacheSize: 11 });
    assert.equal(kid.cache.maxSize, 11);
    await settingsOf(agent, { action: 'update', cacheSize: 4 });
    assert.equal(kid.cache.maxSize, 11, 'the child\u2019s own cap is its own');
  } finally {
    await agent.stop();
  }
});

test('the two switches decide what the model is offered, from the turn they are saved on', async () => {
  const net = new FakeNet().withHistory();
  const icon = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const agent = await startAgent({ net, tenantId: 'switches' });
  try {
    const offered = (): string[] =>
      (agent.runtime.env?.tools ?? []).map((tool) => tool.function.name);
    assert.ok(offered().includes('ask_user'), 'a question is offered by default');
    assert.ok(offered().includes('create_agent'), 'and so is a sub-agent');
    assert.ok(offered().includes('search_cache'), 'and searching the cache');

    const answer = await settingsOf(agent, {
      action: 'update',
      allowSpawn: false,
      allowAskUser: false,
      allowSearchCache: false,
      radicalForget: true,
    });
    assert.equal(answer.settings.allowSpawn, false);
    assert.equal(answer.settings.allowAskUser, false);
    assert.equal(answer.settings.allowSearchCache, false);
    assert.equal(answer.settings.radicalForget, true);
    assert.deepEqual(
      offered().filter(
        (name) => name === 'ask_user' || name === 'create_agent' || name === 'search_cache',
      ),
      [],
      'the environment the turn reads no longer offers them',
    );
    assert.equal(agent.runtime.allowSpawn(), false, 'and the runtime agrees');

    // A call that arrives anyway is refused, rather than left to look like it worked.
    const env = agent.runtime.env as NonNullable<typeof agent.runtime.env>;
    const call = (name: string, args: Record<string, unknown>) => ({
      id: 'call-1',
      type: 'function' as const,
      function: { name, arguments: JSON.stringify(args) },
    });
    assert.match(
      await env.execute(call('create_agent', { name: 'kid', icon })),
      /may not create sub-agents/,
    );
    assert.match(await env.execute(call('ask_user', { title: 'well?' })), /switched off/);
    assert.match(
      await env.execute(call('search_cache', { entry: 1, pattern: 'x' })),
      /switched off/,
    );
    assert.match(await agent.runtime.ask(undefined, { title: 'well?' }), /switched off/);

    // Off for spawning, a saved child is not restored either: starting one is starting one.
    net.putUnit('subagents', { names: ['kid'], agents: [{ name: 'kid', icon }] }, 'switches');
  } finally {
    await agent.stop();
  }
  const again = await startAgent({ net, tenantId: 'switches' });
  try {
    const rows = (await again.call('agents', {})) as { agents: { name: string }[] };
    assert.deepEqual(
      rows.agents.map((row) => row.name),
      ['agent'],
      'nothing came back',
    );
    const read = await settingsOf(again);
    assert.equal(read.settings.allowSpawn, false, 'the switch outlived the process');
    assert.equal(read.settings.allowAskUser, false);
    assert.equal(read.settings.allowSearchCache, false);
    assert.equal(read.settings.radicalForget, true);
  } finally {
    await again.stop();
  }
});

test('the children a previous run saved come back by default', async () => {
  const net = new FakeNet().withHistory();
  const icon = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const first = await startAgent({ net, tenantId: 'restart' });
  try {
    net.putUnit('subagents', { names: ['kid'], agents: [{ name: 'kid', icon }] }, 'restart');
  } finally {
    await first.stop();
  }

  const second = await startAgent({ net, tenantId: 'restart' });
  try {
    const rows = (await second.call('agents', {})) as { agents: { name: string }[] };
    assert.deepEqual(
      rows.agents.map((row) => row.name),
      ['agent', 'kid'],
      'nothing has to be switched on: a saved child is running again',
    );
  } finally {
    await second.stop();
  }
});

test('a sub-agent never spawns one of its own and never asks, whatever its settings say', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'floor' });
  try {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await agent.runtime.spawnAgent('kid', icon);
    const kid = agent.runtime.agent('kid');
    // The parent is on, and its own switches are on: the child's page still shows both off, because
    // that is what the child may do - a switch that is on and does nothing is a lie.
    const parent = await settingsOf(agent, {
      action: 'update',
      allowSpawn: true,
      allowAskUser: true,
    });
    assert.equal(parent.settings.allowSpawn, true);
    const kidSettings = (await agent.call('settings', { agent: 'kid' })) as SettingsAnswer;
    assert.deepEqual(kidSettings.agent, { name: 'kid', parent: 'agent' });
    assert.equal(kidSettings.settings.allowSpawn, false, 'the child was started unable to spawn');
    assert.equal(kidSettings.settings.allowAskUser, false, 'and with nobody to ask');
    assert.equal(kidSettings.defaults.allowSpawn, false, 'and that is its own default, too');
    assert.equal(kid.allowSpawn(), false);
    assert.equal(kid.allowAskUser, false);
    const offered = (kid.env?.tools ?? []).map((tool) => tool.function.name);
    assert.equal(offered.includes('create_agent'), false);
    assert.equal(offered.includes('ask_user'), false);

    // Nor can a save turn either one on: it would be a value nothing reads.
    await assert.rejects(
      () => agent.call('settings', { agent: 'kid', action: 'update', allowSpawn: true }),
      /allowSpawn cannot be turned on: this agent was started unable to start sub-agents/,
    );
    await assert.rejects(
      () => agent.call('settings', { agent: 'kid', action: 'update', allowAskUser: true }),
      /allowAskUser cannot be turned on: this agent was started with nobody to ask/,
    );
    assert.deepEqual(
      net.unit(`sub.kid.${SETTINGS_UNIT}`, 'floor'),
      undefined,
      'nothing was written',
    );
  } finally {
    await agent.stop();
  }
});

test('the input limit in force is the one a saved setting names', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'limit', provider: new ScriptedProvider() });
  try {
    await settingsOf(agent, { action: 'update', maxInputLengthPerTurn: 300 });
    assert.equal(agent.runtime.settings.maxInputLengthPerTurn, 300);
    assert.equal(agent.runtime.settings.maxAgents, DEFAULT_SETTINGS.maxAgents);
    const long = 'x'.repeat(600);
    await agent.call('chat', { msg: { role: 'user', content: long } });
    const window = (await agent.call('history', { count: 10 })) as {
      messages: { role: string; content: string }[];
    };
    const line = window.messages.find((message) => message.role === 'user');
    assert.ok(line !== undefined);
    assert.ok(line.content.length < long.length, 'the line was handed over trimmed');
  } finally {
    await agent.stop();
  }
});

test('a saved cache size is the cap the cache runs on, without a restart', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'cache-cap' });
  try {
    assert.equal(agent.runtime.cache.maxSize, DEFAULT_SETTINGS.cacheSize, 'built on the default');
    await agent.runtime.cache.add('first');
    await agent.runtime.cache.add('second');
    await settingsOf(agent, { action: 'update', cacheSize: 1 });
    assert.equal(agent.runtime.cache.maxSize, 1, 'the cache that was already built takes the cap');
    assert.deepEqual(await agent.runtime.cache.ids(), [2], 'and lets go of what is past it');
    await settingsOf(agent, { action: 'update', reset: true });
    assert.equal(
      agent.runtime.cache.maxSize,
      DEFAULT_SETTINGS.cacheSize,
      'a reset is the default again',
    );
  } finally {
    await agent.stop();
  }
});

test('a saved compression pair is what a model that was already built compresses with', async () => {
  const net = new FakeNet().withHistory();
  const agent = await startAgent({ net, tenantId: 'compress', provider: new ScriptedProvider() });
  try {
    await agent.call('chat', { msg: { role: 'user', content: 'hello' } });
    const model = agent.runtime.model;
    assert.ok(model !== null, 'the first turn built the model');
    assert.equal(model.compressionThreshold, COMPRESSION_THRESHOLD, 'built on the package default');
    assert.equal(model.compressionTokens, COMPRESSION_TOKENS);

    await settingsOf(agent, {
      action: 'update',
      compressionThreshold: 2_048,
      compressionTokens: 512,
    });
    assert.equal(
      agent.runtime.model?.compressionThreshold,
      2_048,
      'the model already in the runtime takes the new threshold',
    );
    assert.equal(agent.runtime.model?.compressionTokens, 512);
  } finally {
    await agent.stop();
  }
});
