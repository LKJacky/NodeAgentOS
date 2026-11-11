// A client for the tests that start the real entry: it joins the deployment user's space the way a
// node outside the process would -- a private credential for that user -- and then asks the stack
// questions over the bus. Nothing here is a shortcut: every answer is the bus's own, and a refusal is
// the wording a caller in production gets.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocketBusSession } from '@node-agent/sdk';
import { privateNodeToken } from 'node-agent-bus';

export const TOKEN = 'serve-test-token';

/** The bus id of one deployment user: the runtime's fixed namespace and the user name. */
export function userTenantOf(_token, user = 'default') {
  return createHash('sha256').update(`node-agent\u0000${user}`).digest('hex');
}

/** Connect a private node to one user's space and return the two things a test needs. */
export async function connectProbe(port, user = 'default', name = 'probe') {
  const userTenant = userTenantOf(TOKEN, user);
  const session = new WebSocketBusSession();
  await session.connect(`ws://127.0.0.1:${port}`, privateNodeToken(TOKEN, userTenant));
  await session.register({
    packageId: 'test-probe',
    name,
    desc: 'a caller outside the stack',
    version: '0.1.0',
    publisher: 'test',
    icon: '<svg/>',
    caps: {},
  });

  const probe = {
    session,
    user: userTenant,
    /** `agent.chat` reaches the `agent` node's `chat`, and the answer is the bus's outcome. */
    async call(capability, args = {}) {
      const split = capability.lastIndexOf('.');
      const result = await session.call({
        id: randomUUID(),
        type: 'call',
        to: capability.slice(0, split),
        tenantId: userTenant,
        deadline: Date.now() + 20_000,
        payload: { cap: capability.slice(split + 1), args },
      });
      return result.payload;
    },
    /** Every `node.capability` the user's directory offers. */
    async tools() {
      const tools = [];
      for (const node of await session.listNodes(userTenant)) {
        for (const cap of await session.listCapabilities(node.name, userTenant))
          tools.push(`${node.name}.${cap.cap}`);
      }
      return tools;
    },
    async close() {
      await session.close();
    },
  };
  return probe;
}

/** Wait until `check` answers true, or fail with the sentence a test wrote for it. */
export async function until(check, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}
