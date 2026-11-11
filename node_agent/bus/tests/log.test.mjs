import assert from 'node:assert/strict';
import { test } from 'node:test';
import { busLog } from '../dist/log.js';

const LEVELS = ['error', 'warn', 'info', 'debug'];

test('bus diagnostics use only the shared log level with consistent defaults', (t) => {
  const names = ['NODE_AGENT_LOG_LEVEL', 'NODE_AGENT_BUS_LOG'];
  const saved = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    }),
  );
  process.env.NODE_AGENT_BUS_LOG = 'silent';
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));

  for (const [value, count] of [
    [undefined, 3],
    ['silent', 0],
    ['error', 1],
    ['warn', 2],
    ['info', 3],
    [' DEBUG ', 4],
    ['', 3],
    ['invalid', 3],
    ['constructor', 3],
  ]) {
    if (value === undefined) delete process.env.NODE_AGENT_LOG_LEVEL;
    else process.env.NODE_AGENT_LOG_LEVEL = value;
    lines.length = 0;
    for (const level of LEVELS) busLog(level, 'test');
    assert.deepEqual(
      lines.map((line) => line.split(' ')[1]),
      LEVELS.slice(0, count),
      String(value),
    );
  }
});

test('bus diagnostics keep fields on one line and omit absent values', (t) => {
  const saved = process.env.NODE_AGENT_LOG_LEVEL;
  t.after(() => {
    if (saved === undefined) delete process.env.NODE_AGENT_LOG_LEVEL;
    else process.env.NODE_AGENT_LOG_LEVEL = saved;
  });
  process.env.NODE_AGENT_LOG_LEVEL = 'debug';
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  busLog('error', 'failed', { error: new Error('one\ntwo'), missing: null, absent: undefined });
  assert.deepEqual(lines, ['[bus] error failed error="one\\ntwo"']);
});
