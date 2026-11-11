// The package as the store mounts it: package.json says what the node is, the SDK host makes one node
// per call, and a caller talks to it over a real bus. What this file pins down is the thing a unit
// test cannot: an `exec` that outlives its call is still there in the *next* call, because the
// sessions live on the tenant's process-level service and not on the node instance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  Node,
  NodeHost,
  WebSocketBusSession,
  nodeManifestOfPackage,
  type ToolArgs,
} from '@node-agent/sdk';
import { Bus, privateNodeToken } from '../../../bus/src/index.ts';
import ShellNode, { closeShellService } from '../src/index.ts';

const token = 'shell-host-token';

type Reply = { ok: boolean; value?: unknown; error?: string };

/** A local caller capability: its body is the actual shell call, so invoke() drives a real bus call. */
class CallerNode extends Node {
  readonly handlers = {
    relay: async (args: ToolArgs) =>
      await this.ctx.call('shell', String(args.cap), (args.args ?? {}) as ToolArgs),
  };
}

const callerManifest = {
  packageId: 'test-caller',
  name: 'webui',
  desc: 'test caller',
  version: '1.0.0',
  icon: '',
  caps: { relay: { type: 'object', properties: {} } },
};

/**
 * One bus, one hosted shell, one caller, and a workspace of the test's own.
 *
 * The workspace is handed over the way a deployment hands it over -- `NODE_AGENT_WORKSPACE`, read when
 * a tenant's service is made -- rather than through `ShellNode`'s options, because the host is the one
 * that makes the node and it passes no options at all.
 */
async function open(t: { after: (fn: () => Promise<void>) => void }) {
  const workspace = await mkdtemp(join(tmpdir(), 'shell-host-'));
  const tenant = `host-${randomUUID()}`;
  const before = process.env.NODE_AGENT_WORKSPACE;
  process.env.NODE_AGENT_WORKSPACE = workspace;

  const bus = await new Bus(token).listen();
  const privateToken = privateNodeToken(token, tenant);
  const host = new NodeHost({
    definition: {
      manifest: nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url))),
      Node: ShellNode,
    },
    bus: new WebSocketBusSession(),
  });
  await host.start(bus.url, privateToken);
  const callerHost = new NodeHost({
    definition: { manifest: callerManifest, Node: CallerNode },
    bus: new WebSocketBusSession(),
  });
  await callerHost.start(bus.url, privateToken);

  t.after(async () => {
    await callerHost.stop();
    await host.stop();
    bus.close();
    closeShellService(tenant);
    if (before === undefined) delete process.env.NODE_AGENT_WORKSPACE;
    else process.env.NODE_AGENT_WORKSPACE = before;
    await rm(workspace, { recursive: true, force: true });
  });

  /** One capability call, as a caller makes it: the value, or the refusal. */
  const call = async (cap: string, args: ToolArgs = {}): Promise<Reply> =>
    (await callerHost.invoke({
      id: randomUUID(),
      type: 'call',
      from: 'webui',
      to: 'webui',
      tenantId: tenant,
      deadline: Date.now() + 10_000,
      payload: { cap: 'relay', args: { cap, args } },
    })) as Reply;

  return { bus, host, callerHost, workspace, tenant, call };
}

test('the manifest names every capability the package answers to', async (t) => {
  const { call } = await open(t);

  const reply = await call('read', { path: 'missing.txt' });
  assert.equal(reply.ok, false);
  assert.match(String(reply.error), /no such file|ENOENT/);

  const manifest = nodeManifestOfPackage(fileURLToPath(new URL('..', import.meta.url)));
  assert.deepEqual(Object.keys(manifest.caps), [
    'read',
    'write',
    'edit',
    'list',
    'glob',
    'grep',
    'files-tree',
    'files-read',
    'files-write',
    'publish',
    'exec',
    'run-node',
    'list-local-running-nodes',
    'kill-node',
    'write-stdin',
    'sessions',
    'kill-session',
    'permissions',
    'set-permissions',
    'custom-commands',
    'run-custom',
    'ui',
  ]);
  assert.equal(manifest.name, 'shell');
  assert.equal(manifest.publisher, 'node-agent');
});

test('a capability the manifest does not carry is refused by the host', async (t) => {
  const { call } = await open(t);

  // The page's dotted names are gone: nothing answers to `shell.files.tree` any more, and the host
  // says so rather than routing it to a node that has no handler for it.
  const reply = await call('files.tree', { path: '.' });
  assert.equal(reply.ok, false);
  assert.match(String(reply.error), /no node provides|unknown capability/);
});

test('a session started in one call is there in the next', async (t) => {
  const { call, workspace } = await open(t);

  const started = await call('exec', { command: 'echo first; sleep 30', yield_ms: 300 });
  assert.equal(started.ok, true);
  assert.match(String(started.value), /^running: session s1/);
  assert.match(String(started.value), /stdout:\nfirst/);

  // A new node instance, the same tenant: the command is still running.
  const listed = await call('sessions', {});
  assert.match(String(listed.value), /^s1 {2}running/m);

  const killed = await call('kill-session', { session_id: 's1' });
  assert.match(String(killed.value), /sent SIGTERM/);

  const written = await call('write', { path: 'note.txt', content: 'kept\n' });
  assert.match(String(written.value), /^wrote note\.txt/);
  assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'kept\n');
  assert.equal((await call('read', { path: 'note.txt' })).value, 'kept\n');

  const tree = await call('files-tree', { path: '.', depth: 1 });
  assert.equal(tree.ok, true);
  assert.match(String(tree.value), /note\.txt/);

  const page = await call('ui', {});
  assert.equal(page.ok, true);
  assert.ok(String(page.value).includes('\"shell\"'), 'the page carries this node name');
});
