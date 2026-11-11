// One shell for a test, driven the way the bus drives it.
//
// The SDK host makes a node per invocation, so the sessions a shell keeps alive between calls live in
// the tenant's process-level service, not on the instance. A test therefore asks for a tenant of its
// own (`sheet(t, root)` makes one), and `t.after` kills anything that tenant left running: without
// that, a leaked process group would outlive the test that started it.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellNode, closeShellService, shellService } from '../dist/index.js';

export { ShellNode, closeShellService, shellService };

/** A NodeContext a test can hand the node: it never dials a bus itself, so `call` and `publish` are
 *  the two things a test that needs them has to replace (`{...context(tenant), call}`). */
export function context(tenant, over = {}) {
  return {
    nodeId: 'shell',
    tenantId: tenant,
    from: 'test-caller',
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    call: async () => {
      throw new Error('this test has no bus to call through');
    },
    publish: () => {},
    fetch: globalThis.fetch,
    ...over,
  };
}

/** A tenant name no other test shares, so one test's sessions cannot answer another's question. */
export function tenant() {
  return `test-${randomUUID()}`;
}

/** A node over `root` on a tenant of its own; the tenant is closed when the test ends. */
export function shell(t, root) {
  const id = tenant();
  t.after(() => closeShellService(id));

  return new ShellNode(context(id), { workspace: root });
}

/** A node-agent home of its own for one test: `NODE_AGENT_HOME` points at a fresh directory, so the
 *  files a node keeps for itself (for the shell, each tenant's permission switches) belong to this
 *  test and go when it ends. Returned so a test can read what the node wrote. */
export async function nodeAgentHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'shell-home-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  withEnv(t, { NODE_AGENT_HOME: dir });
  return dir;
}

/** Set environment variables for one test, and put them back afterwards: `run-node` reads the bus it
 *  hands a child node from the environment the host itself was started with. */
export function withEnv(t, values) {
  const before = new Map();
  for (const [name, value] of Object.entries(values)) {
    before.set(name, process.env[name]);
    process.env[name] = value;
  }

  t.after(() => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
