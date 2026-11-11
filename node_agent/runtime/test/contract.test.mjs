import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeError, RuntimeServer, nodeName, userName } from '../dist/index.js';

test('the contract names are the same rule the bus and filesystem use', () => {
  assert.equal(userName('alice'), 'alice');
  assert.equal(nodeName('web-ui'), 'web-ui');
  assert.throws(() => userName('Alice'), (error) => error instanceof RuntimeError);
  assert.throws(() => nodeName('Web UI'), (error) => error instanceof RuntimeError);
});

test('the runtime server refuses to start without a service token', () => {
  assert.throws(
    () => new RuntimeServer({ runtime: {}, token: ' ' }),
    (error) => error instanceof RuntimeError && error.code === 'invalid_user',
  );
});
