// What the stack does with the numbers a model reports: the turn that ran keeps them (and they are
// durable, so the next process reads them back), the request that follows never sends them back, and
// a zero a model really reported is not the same as a model that said nothing. The entry is started
// for real -- its own process, its own bus, its own history file -- with the model a deployment names
// through the environment, and a stub stands where that model would be.
//
// The finer cases -- a tool round charging only the new input, a reused response not being mutated,
// usage that survives a model error, and the bounds of a history window -- are the agent's own and
// live with it (nodes/agent/tests/chat.test.ts, history.test.ts), driven through the same public
// capabilities this file uses.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteHistoryStore } from 'node-agent-history';
import { line, portOf, start, stateDir } from './entry.mjs';
import { TOKEN, connectProbe, until, userTenantOf } from './probe.mjs';

const usage = (input, output) => ({
  prompt_tokens: input,
  completion_tokens: output,
  total_tokens: input + output,
});

/** A model standing where the deployment's model would be: OpenAI's wire, both shapes of it. A
 *  turn streams (`stream: true`, the usage in a last chunk with no choices); a request that carries
 *  `max_completion_tokens` is the agent measuring the transcript, not a turn, and answers without
 *  usage so the numbers a test reads are the turn's own. */
function modelStub(replies) {
  const turns = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const measuring = body.max_completion_tokens !== undefined;
    if (!measuring) turns.push(body);
    const next = measuring ? { content: '' } : replies.length > 1 ? replies.shift() : replies[0];
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (payload) => response.write('data: ' + JSON.stringify(payload) + '\n\n');
      if (next.content !== '') send({ choices: [{ delta: { content: next.content } }] });
      send({
        choices: [],
        ...(next.usage === undefined ? {} : { usage: next.usage }),
      });
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: next.content } }],
        ...(next.usage === undefined ? {} : { usage: next.usage }),
      }),
    );
  });
  return {
    turns,
    async listen(t) {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      return `http://127.0.0.1:${server.address().port}/v1`;
    },
  };
}

/** The entry with that model configured, a probe joined to the deployment user, and the file the
 *  agent files its conversation into. */
async function stack(t, replies) {
  const stub = modelStub(replies);
  const url = await stub.listen(t);
  const home = stateDir(t);
  const database = join(home, 'history', 'sqlite');
  const entry = start({
    NODE_AGENT_HOME: home,
    NODE_AGENT_MODEL_URL: url,
    NODE_AGENT_MODEL_KEY: 'test-key',
    NODE_AGENT_MODEL_NAME: 'test-model',
  });
  t.after(() => entry.child.kill('SIGKILL'));
  const port = portOf(await line(entry, 'bus: '));
  await line(entry, 'nodes: ');
  const probe = await connectProbe(port);
  t.after(() => probe.close());
  return { entry, probe, stub, database };
}

/** The answers the agent filed, in order, with the usage each one kept -- and only once the file
 *  holds `count` of them. Two things a fixed index gets wrong: `agent.chat` answers when the turn is
 *  over while the agent writes the line behind that answer (so a read straight after the answer can
 *  come too early), and the setup queues its introduction into the same transcript (so the turn's own
 *  index depends on that line). This polls the file for a bounded moment (2s) and reads by role,
 *  which is fast when the write is already there and fails a broken agent instead of hiding it. */
async function answers(database, count) {
  const filed = () => {
    const store = new SqliteHistoryStore(database);
    try {
      const tenant = userTenantOf(TOKEN);
      const found = [];
      for (let index = 0; ; index += 1) {
        const unit = store.load(tenant, 'agent', `conversation.${index}`);
        if (unit === null) break;
        if (unit.meta?.role === 'assistant') found.push(unit.meta);
      }
      return found;
    } finally {
      store.close();
    }
  };
  await until(() => filed().length >= count, `${count} answer(s) filed in ${database}`, 2_000);
  return filed();
}

test('adjusted usage is recorded in history and excluded from the next API request', async (t) => {
  const { probe, stub, database } = await stack(t, [{ content: 'hello', usage: usage(100, 20) }]);

  const first = await probe.call('agent.chat', { msg: { role: 'user', content: 'hello' } });
  assert.equal(first.ok, true, first.ok ? '' : first.error);
  const second = await probe.call('agent.chat', { msg: { role: 'user', content: 'again' } });
  assert.equal(second.ok, true, second.ok ? '' : second.error);

  // The first answer keeps what the model reported; the second is charged only the new output,
  // because the input it repeated was already counted.
  const [firstAnswer, secondAnswer] = await answers(database, 2);
  assert.deepEqual(firstAnswer.usage, usage(100, 20));
  assert.deepEqual(secondAnswer.usage, usage(0, 20));

  // The request that followed carries the earlier answer, and no `usage` field anywhere.
  const [, request] = stub.turns;
  assert.equal(request.messages.some((message) => 'usage' in message), false);
  assert.ok(request.messages.some((message) => message.content === 'hello'));

  // And the totals are the agent's own: every call counted, both reports taken.
  const status = await probe.call('agent.status', {});
  assert.equal(status.ok, true, status.ok ? '' : status.error);
  assert.equal(status.value.usage.model_calls, 2);
  assert.equal(status.value.usage.reported_calls, 2);
  assert.equal(status.value.usage.completion_tokens, 40);
});

test('a reported zero is not the same as a model that reported nothing', async (t) => {
  // The first answer carries no usage at all, the second a real zero on both counts.
  const { probe, database } = await stack(t, [
    { content: 'first' },
    { content: 'second', usage: usage(0, 0) },
  ]);

  const first = await probe.call('agent.chat', { msg: { role: 'user', content: 'one' } });
  assert.equal(first.ok, true, first.ok ? '' : first.error);
  const afterFirst = await probe.call('agent.status', {});
  assert.equal(afterFirst.value.usage.model_calls, 1);
  assert.equal(afterFirst.value.usage.reported_calls, 0);
  assert.equal(afterFirst.value.usage.total_tokens, 0);
  const [firstAnswer] = await answers(database, 1);
  assert.equal(firstAnswer.usage, undefined, 'a line nobody counted carries no usage');

  const second = await probe.call('agent.chat', { msg: { role: 'user', content: 'two' } });
  assert.equal(second.ok, true, second.ok ? '' : second.error);
  const afterSecond = await probe.call('agent.status', {});
  assert.equal(afterSecond.value.usage.model_calls, 2);
  assert.equal(afterSecond.value.usage.reported_calls, 1);
  assert.equal(afterSecond.value.usage.total_tokens, 0);
  const [, secondAnswer] = await answers(database, 2);
  assert.deepEqual(secondAnswer.usage, usage(0, 0), 'a reported zero is kept as a zero');
});
