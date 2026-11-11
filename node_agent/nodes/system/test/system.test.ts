import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  Node,
  NodeHost,
  WebSocketBusSession,
  nodeManifestOfPackage,
  type NodeContext,
  type NodeHandlers,
  type NodeManifest,
  type Outcome,
  type ToolArgs,
} from '@node-agent/sdk';
import { Bus, privateNodeToken } from '../../../bus/src/index.ts';
import { HistoryNode } from '../../history/src/index.ts';
import { SystemNode, setSystemScheduler } from '../src/index.ts';
import { SystemScheduler, type PermissionView } from '../src/scheduler.ts';

const token = 'system-test-token';
const controlToken = 'system-test-control-token';
const systemRoot = fileURLToPath(new URL('..', import.meta.url));

/** The history node as this test hosts it: only the four caps the scheduler calls. */
const historyManifest: NodeManifest = {
  packageId: 'test-history',
  name: 'history',
  desc: 'history for the system tests',
  version: '0.0.0',
  publisher: 'test',
  icon: '',
  caps: Object.fromEntries(
    ['load', 'save', 'delete', 'list'].map((cap) => [cap, { type: 'object', properties: {} }]),
  ),
};

const capSets = new Map<string, string[]>();
const records = new Map<string, Array<{ cap: string; args: ToolArgs }>>();

function recordFor(tenant: string, node: string): Array<{ cap: string; args: ToolArgs }> {
  const key = `${tenant}\u0000${node}`;
  const found = records.get(key);
  if (found !== undefined) return found;
  const created: Array<{ cap: string; args: ToolArgs }> = [];
  records.set(key, created);
  return created;
}

function manifestOf(name: string): NodeManifest {
  const caps = capSets.get(name) ?? [];
  return {
    packageId: `test-${name}`,
    name,
    desc: `${name} for the system tests`,
    version: '0.0.0',
    publisher: 'test',
    icon: '',
    caps: Object.fromEntries(caps.map((cap) => [cap, { type: 'object', properties: {} }])),
  };
}

/** A caller the bus can reach under a chosen name: `relay` asks the system node a question, `watch`
 *  subscribes to one of its topics, the rest are the timer callbacks a test waits for. */
class TestNode extends Node {
  readonly handlers: NodeHandlers;

  constructor(ctx: NodeContext) {
    super(ctx);
    const caps = capSets.get(ctx.nodeId) ?? [];
    this.handlers = Object.fromEntries(
      caps.map((cap) => [
        cap,
        async (args: ToolArgs) => {
          recordFor(ctx.tenantId, ctx.nodeId).push({ cap, args });
          if (cap === 'relay')
            return await this.ctx.call(
              String(args.node),
              String(args.cap),
              (args.args ?? {}) as ToolArgs,
            );
          if (cap === 'watch') {
            const subscribe = this.ctx.subscribe;
            if (subscribe === undefined) throw new Error('this host cannot subscribe to topics');
            await subscribe.call(this.ctx, String(args.topic), String(args.target));
          }
          return { ok: true };
        },
      ]),
    );
  }

  /** An event this node was told about lands in the same record as its calls, keyed by the topic. */
  override onEvent(topic: string, value: unknown, from: string): void {
    recordFor(this.ctx.tenantId, this.ctx.nodeId).push({ cap: topic, args: { value, from } });
  }
}

interface Fixture {
  readonly tenant: string;
  /** Call one system capability as `agent` or `bus`, through the bus's permission check. */
  relay(who: 'agent' | 'bus', cap: string, args?: ToolArgs): Promise<Outcome>;
  /** Call one of a caller's own capabilities (the page's own asks: `webui.watch`). */
  invoke(who: 'agent' | 'bus' | 'webui', cap: string, args?: ToolArgs): Promise<Outcome>;
  /** Call the system node directly, bypassing the bus, to exercise the handler's own guard. */
  invokeSystem(from: string, cap: string, args?: ToolArgs): Promise<Outcome>;
  restart(): Promise<void>;
  calls(who: 'agent' | 'bus'): Array<{ cap: string; args: ToolArgs }>;
}

async function withSystem(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'system-test-'));
  const previousHome = process.env.NODE_AGENT_HOME;
  process.env.NODE_AGENT_HOME = directory;

  const bus = await new Bus(token, controlToken).listen();
  const tenant = `system-test-${randomUUID()}`;
  const control = new WebSocketBusSession();
  const callers = new Map<string, NodeHost>();
  let historyHost: NodeHost | undefined;
  let systemHost: NodeHost | undefined;
  let privateHost: NodeHost | undefined;
  let scheduler: SystemScheduler | undefined;

  try {
    await control.connect(bus.url, controlToken);

    historyHost = new NodeHost({
      definition: { manifest: historyManifest, Node: HistoryNode },
      bus: new WebSocketBusSession(),
    });
    await historyHost.start(bus.url, token);

    for (const name of ['agent', 'bus', 'webui'] as const) {
      capSets.set(name, [
        'relay',
        ...(name === 'agent' ? ['wake'] : []),
        // The browser shell is what listens on a node's topic and hands it to /events.
        ...(name === 'webui' ? ['watch'] : []),
      ]);
      const host = new NodeHost({
        definition: { manifest: manifestOf(name), Node: TestNode },
        bus: new WebSocketBusSession(),
      });
      await host.start(bus.url, token);
      callers.set(name, host);
    }

    // A shared node reaches a user only after the control connection connects it, exactly as the
    // runtime supervisor does. Without this the system node could not even read its own history.
    for (const name of ['history', 'agent', 'bus', 'webui'])
      await control.connectNode(tenant, name);

    capSets.set('private-node', ['wake']);
    privateHost = new NodeHost({
      definition: { manifest: manifestOf('private-node'), Node: TestNode },
      bus: new WebSocketBusSession(),
    });
    await privateHost.start(bus.url, privateNodeToken(token, tenant));

    // One session for both halves of the system node: the host registers it, and the scheduler
    // keeps using it after the call that created it is gone (serve.ts does the same).
    const systemSession = new WebSocketBusSession();
    scheduler = new SystemScheduler(systemSession, tenant);
    systemHost = new NodeHost({
      definition: { manifest: nodeManifestOfPackage(systemRoot), Node: SystemNode },
      bus: systemSession,
    });
    setSystemScheduler(scheduler);
    await systemHost.start(bus.url, token);
    await control.connectNode(tenant, 'system');
    await scheduler.start();

    const restart = async (): Promise<void> => {
      assert.ok(scheduler !== undefined && systemHost !== undefined);
      scheduler.stop();
      await systemHost.stop();
      const nextSession = new WebSocketBusSession();
      const nextScheduler = new SystemScheduler(nextSession, tenant);
      const nextHost = new NodeHost({
        definition: { manifest: nodeManifestOfPackage(systemRoot), Node: SystemNode },
        bus: nextSession,
      });
      scheduler = nextScheduler;
      systemHost = nextHost;
      setSystemScheduler(nextScheduler);
      await nextHost.start(bus.url, token);
      await control.connectNode(tenant, 'system');
      await nextScheduler.start();
    };

    const invoke = async (
      who: 'agent' | 'bus' | 'webui',
      cap: string,
      args: ToolArgs = {},
    ): Promise<Outcome> => {
      const host = callers.get(who);
      assert.ok(host !== undefined, `no ${who} host`);
      return await host.invoke({
        id: randomUUID(),
        type: 'call',
        from: who,
        to: who,
        tenantId: tenant,
        deadline: Date.now() + 10_000,
        payload: { cap, args },
      });
    };

    const relay = async (
      who: 'agent' | 'bus' | 'webui',
      cap: string,
      args: ToolArgs = {},
    ): Promise<Outcome> => {
      const host = callers.get(who);
      assert.ok(host !== undefined, `no ${who} host`);
      return await host.invoke({
        id: randomUUID(),
        type: 'call',
        from: who,
        to: who,
        tenantId: tenant,
        deadline: Date.now() + 10_000,
        payload: { cap: 'relay', args: { node: 'system', cap, args } },
      });
    };

    const invokeSystem = async (
      from: string,
      cap: string,
      args: ToolArgs = {},
    ): Promise<Outcome> => {
      assert.ok(systemHost !== undefined);
      return await systemHost.invoke({
        id: randomUUID(),
        type: 'call',
        from,
        to: 'system',
        tenantId: tenant,
        deadline: Date.now() + 10_000,
        payload: { cap, args },
      });
    };

    await run({
      tenant,
      relay,
      invoke,
      invokeSystem,
      restart,
      calls: (who) => recordFor(tenant, who),
    });
  } finally {
    scheduler?.stop();
    setSystemScheduler(null);
    await privateHost?.stop();
    await systemHost?.stop();
    for (const host of callers.values()) await host.stop();
    await historyHost?.stop();
    await control.close();
    bus.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.NODE_AGENT_HOME;
    else process.env.NODE_AGENT_HOME = previousHome;
  }
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function permissionOf(
  rows: readonly PermissionView[],
  target: string,
  cap: string,
): PermissionView {
  const row = rows.find((entry) => entry.target === target && entry.cap === cap);
  assert.ok(row !== undefined, `no permission row for ${target}.${cap}`);
  return row;
}

const authorizeArgs = (tenant: string, caller: string, defaultCallers: string[]): ToolArgs => ({
  caller,
  target: 'agent',
  cap: 'wake',
  tenant,
  defaultCallers,
});

test('language and timezone are persisted strings', async () => {
  await withSystem(async ({ relay }) => {
    // `settings` is the page's write: its manifest names no other caller (the agent reads the
    // language and the timezone through the two open caps below).
    const saved = await relay('webui', 'settings', {
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });
    assert.equal(saved.ok, true, saved.ok ? '' : saved.error);
    const language = await relay('agent', 'language', {});
    const timezone = await relay('agent', 'timezone', {});
    assert.equal(language.ok, true);
    assert.equal(timezone.ok, true);
    assert.equal(language.ok ? language.value : undefined, 'zh-CN');
    assert.equal(timezone.ok ? timezone.value : undefined, 'Asia/Shanghai');
  });
});

test('a browser decides the language once, and a change is announced on the bus', async () => {
  await withSystem(async ({ invoke, relay, calls }) => {
    // What an open page does through the webui: /events?node=system&topic=language subscribes here.
    const watched = await invoke('webui', 'watch', { target: 'system', topic: 'language' });
    assert.equal(watched.ok, true, watched.ok ? '' : watched.error);

    // The first visit: the browser says what its user reads, and the profile takes the answer.
    const first = await relay('webui', 'ensure_language', {
      browser: 'zh-CN,zh;q=0.9,en;q=0.8',
    });
    assert.equal(first.ok, true, first.ok ? '' : first.error);
    assert.deepEqual(first.ok ? first.value : undefined, {
      language: 'zh-CN',
      resolved: 'zh-CN',
      changed: true,
    });
    const language = await relay('agent', 'language', {});
    assert.equal(language.ok ? language.value : undefined, 'zh-CN');
    // `locale` is the page's read, not the agent's: the shell still sees it, a sibling is refused.
    const pageLocale = await relay('webui', 'locale', {});
    assert.deepEqual(pageLocale.ok ? pageLocale.value : undefined, {
      language: 'zh-CN',
      resolved: 'zh-CN',
    });
    const siblingLocale = await relay('agent', 'locale', {});
    assert.equal(siblingLocale.ok, false, 'a sibling node must not read the locale');
    // The cap is open to the runtime alone, which is what the refusal must say.
    assert.match(siblingLocale.ok ? '' : siblingLocale.error, /not allowed to call system\.locale/);

    // The change went out on the `language` topic, and the subscriber heard it.
    await waitFor(
      () => calls('webui').some((entry) => entry.cap === 'language'),
      'the language change was never announced',
    );
    const announced = calls('webui').find((entry) => entry.cap === 'language');
    assert.deepEqual(announced?.args.value, { language: 'zh-CN', resolved: 'zh-CN' });
    assert.equal(announced?.args.from, 'system');

    // A second visit changes nothing: the choice was made once, and the browser does not get a vote.
    const again = await relay('webui', 'ensure_language', { browser: 'en-US,en;q=0.9' });
    assert.deepEqual(again.ok ? again.value : undefined, {
      language: 'zh-CN',
      resolved: 'zh-CN',
      changed: false,
    });

    // The settings page switching the language says so too, once, and the next read agrees.
    const switched = await relay('webui', 'settings', { language: 'en' });
    assert.equal(switched.ok, true, switched.ok ? '' : switched.error);
    await waitFor(
      () => calls('webui').filter((entry) => entry.cap === 'language').length === 2,
      'switching the language was not announced',
    );
    assert.deepEqual(
      calls('webui')
        .filter((entry) => entry.cap === 'language')
        .map((entry) => entry.args.value),
      [
        { language: 'zh-CN', resolved: 'zh-CN' },
        { language: 'en', resolved: 'en' },
      ],
    );
    // The next read agrees — as the page's caller, because a sibling is not allowed to ask.
    const after = await relay('webui', 'locale', {});
    assert.deepEqual(after.ok ? after.value : undefined, { language: 'en', resolved: 'en' });
  });
});

test('the permission table shows the display names the manifests publish', async () => {
  await withSystem(async ({ relay }) => {
    const rows = await relay('webui', 'permissions', {});
    assert.equal(rows.ok, true, rows.ok ? '' : rows.error);
    const list = (rows.ok ? rows.value : []) as PermissionView[];

    const settings = list.find((row) => row.target === 'system' && row.cap === 'settings');
    assert.ok(settings, 'the settings row is in the table');
    // The identifiers stay what a caller sends; only the labels are for a reader.
    assert.equal(settings.target, 'system');
    assert.equal(settings.cap, 'settings');
    assert.equal(settings.nodeLabel, 'System');
    assert.equal(settings.capLabel, 'Settings');
    assert.deepEqual(settings.argLabels, { language: 'Language', timezone: 'Timezone' });

    // Switching the language re-reads them; the rows themselves do not move.
    const switched = await relay('webui', 'settings', { language: 'zh-CN' });
    assert.equal(switched.ok, true, switched.ok ? '' : switched.error);
    const zh = await relay('webui', 'permissions', {});
    const zhSettings = ((zh.ok ? zh.value : []) as PermissionView[]).find(
      (row) => row.target === 'system' && row.cap === 'settings',
    );
    assert.ok(zhSettings);
    assert.equal(zhSettings.cap, 'settings');
    assert.equal(zhSettings.nodeLabel, '系统');
    assert.equal(zhSettings.capLabel, '设置');
    assert.deepEqual(zhSettings.argLabels, { language: '语言', timezone: '时区' });
  });
});

test('the page carries settings, timers and the permission editor', async () => {
  await withSystem(async ({ relay }) => {
    const page = await relay('webui', 'ui', {});
    assert.equal(page.ok, true);
    const html = String(page.ok ? page.value : '');
    assert.match(html, /id="language"/);
    assert.match(html, /id="timers"/);
    assert.match(html, /id="permissions"/);
    // The page is bilingual through its own resource files: the markup carries keys, and the node
    // embeds the words it read from i18n/*.json as one JSON script tag.
    // The words are written in before the page leaves the node: the markup an English reader gets
    // already says "Save settings", so no Chinese default can show while the browser half loads.
    assert.match(html, /data-text-key="settings\.save">Save settings</);
    assert.doesNotMatch(html, /data-text-key="settings\.save">保存设置</);
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html, /data-text-en=|data-text-cn=|MESSAGES|data-i18n="common\./);
    const embedded = /<script type="application\/json" data-i18n-resource>(.*?)<\/script>/.exec(
      html,
    );
    assert.ok(embedded, 'the page carries its resource');
    const resource = JSON.parse(embedded[1] ?? '');
    // Keys are flattened to dots when the node reads its files, so both halves look up the same names.
    assert.equal(resource.en['settings.save'], 'Save settings');
    assert.equal(resource['zh-CN']['settings.save'], '保存设置');
    assert.equal(resource.en['timers.count.waiting'], '{count} waiting');
    // Switching the language paints the next page in it; the markers stay, so the browser half can
    // still redraw a change without a reload.
    assert.equal((await relay('webui', 'settings', { language: 'zh-CN' })).ok, true);
    const zhPage = await relay('webui', 'ui', {});
    const zhHtml = String(zhPage.ok ? zhPage.value : '');
    assert.match(zhHtml, /<html lang="zh-CN">/);
    assert.match(zhHtml, /data-text-key="settings\.save">保存设置</);
    assert.doesNotMatch(zhHtml, /data-text-key="settings\.save">Save settings</);

    // The manifest's display names are read from the same files (`label.*`), and the table draws
    // them: the canonical name goes in the tooltip, the label in the row.
    assert.equal(resource['zh-CN']['label.caps.settings'], '设置');
    assert.match(html, /perm-args/);
    assert.match(html, /row\.capLabel \?\? row\.cap/);
    assert.match(html, /row\.nodeLabel/);
    // The slot the node fills is not left in the answer.
    assert.doesNotMatch(html, /node-agent:i18n-resource/);
    assert.match(html, /from '\/sdk\/i18n-client\.js'/);
    // A profile nobody has chosen yet is drawn in the default, and says so in the tag.
    assert.match(html, /<html lang="en">/);
    assert.match(html, /按目标节点分组/);
    assert.match(html, /全部允许（\*）/);
    assert.match(html, /全部不允许/);
    assert.match(html, /保存本节点/);
    assert.match(html, /恢复默认/);
    assert.match(html, /createElement\('details'\)/);
    assert.match(html, /createElement\('summary'\)/);

    // The same page, once the user has chosen: the tag the browser half draws from follows it.
    const changed = await relay('webui', 'settings', { language: 'zh-CN' });
    assert.equal(changed.ok, true, changed.ok ? '' : changed.error);
    const chinese = await relay('webui', 'ui', {});
    assert.match(String(chinese.ok ? chinese.value : ''), /<html lang="zh-CN">/);
  });
});

test('add_timer calls the caller at the requested time', async () => {
  await withSystem(async ({ relay, calls }) => {
    const at = new Date(Date.now() + 150).toISOString();
    const added = await relay('agent', 'add_timer', {
      id: 't1',
      at,
      callpayload: { cap: 'wake', args: { value: 42 } },
    });
    assert.equal(added.ok, true, added.ok ? '' : added.error);
    await waitFor(
      () => calls('agent').some((entry) => entry.cap === 'wake'),
      'the timer did not call back',
    );
    const wake = calls('agent').find((entry) => entry.cap === 'wake');
    assert.deepEqual(wake?.args, { value: 42 });
  });
});

test('pending timers survive a system restart', async () => {
  await withSystem(async ({ relay, restart, calls }) => {
    const at = new Date(Date.now() + 250).toISOString();
    const added = await relay('agent', 'add_timer', {
      id: 'persisted',
      at,
      callpayload: { cap: 'wake', args: { value: 'after-restart' } },
    });
    assert.equal(added.ok, true, added.ok ? '' : added.error);
    await restart();
    await waitFor(
      () => calls('agent').some((entry) => entry.cap === 'wake'),
      'the restored timer did not call back',
    );
    const wake = calls('agent').find((entry) => entry.cap === 'wake');
    assert.deepEqual(wake?.args, { value: 'after-restart' });
  });
});

test('only the bus may ask, and defaults decide without an override', async () => {
  await withSystem(async ({ relay, invokeSystem, tenant }) => {
    const direct = await invokeSystem('agent', 'authorize', authorizeArgs(tenant, 'agent', ['*']));
    assert.equal(direct.ok, false);
    assert.match(String(direct.ok ? '' : direct.error), /bus/i);

    const wildcard = await relay('bus', 'authorize', authorizeArgs(tenant, 'agent', ['*']));
    assert.equal(wildcard.ok, true, wildcard.ok ? '' : wildcard.error);
    assert.equal(wildcard.ok ? (wildcard.value as { allow: boolean }).allow : undefined, true);

    const restricted = await relay(
      'bus',
      'authorize',
      authorizeArgs(tenant, 'deputy', ['someone-else']),
    );
    assert.equal(restricted.ok, true);
    assert.equal(restricted.ok ? (restricted.value as { allow: boolean }).allow : undefined, false);
    assert.match(
      String(restricted.ok ? (restricted.value as { reason?: string }).reason : ''),
      /not allowed/,
    );

    const wildcardCaller = await relay('bus', 'authorize', authorizeArgs(tenant, '*', []));
    assert.equal(wildcardCaller.ok, true);
    assert.equal(
      wildcardCaller.ok ? (wildcardCaller.value as { allow: boolean }).allow : undefined,
      true,
    );
  });
});

test('an override wins over the default and clearing it restores the default', async () => {
  await withSystem(async ({ relay, tenant }) => {
    const saved = await relay('webui', 'set_permission', {
      target: 'agent',
      cap: 'wake',
      callers: ['deputy'],
    });
    assert.equal(saved.ok, true, saved.ok ? '' : saved.error);
    assert.equal(saved.ok ? (saved.value as PermissionView).source : undefined, 'override');

    const allowed = await relay(
      'bus',
      'authorize',
      authorizeArgs(tenant, 'deputy', ['someone-else']),
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.ok ? (allowed.value as { allow: boolean }).allow : undefined, true);

    const listed = await relay('webui', 'permissions', {});
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error);
    const rows = (listed.ok ? listed.value : []) as PermissionView[];
    const row = permissionOf(rows, 'agent', 'wake');
    assert.equal(row.source, 'override');
    assert.deepEqual([...row.callers], ['deputy']);
    assert.deepEqual([...row.defaultCallers], ['*']);

    const cleared = await relay('webui', 'clear_permission', { target: 'agent', cap: 'wake' });
    assert.equal(cleared.ok, true, cleared.ok ? '' : cleared.error);
    assert.equal(cleared.ok ? cleared.value : undefined, true);

    const denied = await relay(
      'bus',
      'authorize',
      authorizeArgs(tenant, 'deputy', ['someone-else']),
    );
    assert.equal(denied.ok, true);
    assert.equal(denied.ok ? (denied.value as { allow: boolean }).allow : undefined, false);
  });
});

test('a manifest can lock a capability against permission edits', async () => {
  await withSystem(async ({ relay }) => {
    const locked = await relay('webui', 'set_permission', {
      target: 'system',
      cap: 'authorize',
      callers: ['*'],
    });
    assert.equal(locked.ok, false);
    assert.match(String(locked.ok ? '' : locked.error), /does not allow permission edits/);
  });
});

test('a node edits its own caps, and global edits are ordinary capabilities', async () => {
  await withSystem(async ({ relay, tenant }) => {
    const own = await relay('agent', 'set_own_permission', {
      cap: 'wake',
      callers: ['deputy'],
    });
    assert.equal(own.ok, true, own.ok ? '' : own.error);

    const allowed = await relay('bus', 'authorize', authorizeArgs(tenant, 'deputy', []));
    assert.equal(allowed.ok, true);
    assert.equal(allowed.ok ? (allowed.value as { allow: boolean }).allow : undefined, true);

    const denied = await relay('agent', 'set_permission', {
      target: 'agent',
      cap: 'wake',
      callers: ['agent'],
    });
    assert.equal(denied.ok, false);
    assert.match(String(denied.ok ? '' : denied.error), /permission denied/);

    // The global API is just a normal cap: webui can grant another node access to it.
    const grant = await relay('webui', 'set_permission', {
      target: 'system',
      cap: 'set_permission',
      callers: ['agent'],
    });
    assert.equal(grant.ok, true, grant.ok ? '' : grant.error);
    const global = await relay('agent', 'set_permission', {
      target: 'agent',
      cap: 'wake',
      callers: ['agent'],
    });
    assert.equal(global.ok, true, global.ok ? '' : global.error);

    const cleared = await relay('agent', 'clear_own_permission', { cap: 'wake' });
    assert.equal(cleared.ok, true, cleared.ok ? '' : cleared.error);
  });
});

test('overrides are persisted in system.permissions and survive a restart', async () => {
  await withSystem(async ({ relay, restart, tenant }) => {
    const saved = await relay('webui', 'set_permission', {
      target: 'agent',
      cap: 'wake',
      callers: ['agent', 'deputy'],
    });
    assert.equal(saved.ok, true, saved.ok ? '' : saved.error);

    await restart();

    const listed = await relay('webui', 'permissions', {});
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error);
    const row = permissionOf((listed.ok ? listed.value : []) as PermissionView[], 'agent', 'wake');
    assert.equal(row.source, 'override');
    assert.deepEqual([...row.callers], ['agent', 'deputy']);

    const allowed = await relay(
      'bus',
      'authorize',
      authorizeArgs(tenant, 'deputy', ['someone-else']),
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.ok ? (allowed.value as { allow: boolean }).allow : undefined, true);
  });
});

test('system lists private nodes as non-editable default-allow rows', async () => {
  await withSystem(async ({ relay }) => {
    const listed = await relay('webui', 'permissions', {});
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error);
    const rows = (listed.ok ? listed.value : []) as PermissionView[];
    const row = rows.find((one) => one.target === 'private-node' && one.cap === 'wake');
    assert.ok(row, 'the private node is visible to system');
    assert.deepEqual(row.callers, ['*'], 'private nodes default to allow-all');
    assert.equal(row.editable, false, 'private nodes are not editable');
    assert.equal(row.source, 'default');

    const saved = await relay('webui', 'set_permission', {
      target: 'private-node',
      cap: 'wake',
      callers: ['agent'],
    });
    assert.equal(saved.ok, false);
    assert.match(String(saved.ok ? '' : saved.error), /private nodes are not editable/);
  });
});
