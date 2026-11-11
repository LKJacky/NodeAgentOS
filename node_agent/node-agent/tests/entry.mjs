// The entry, started the way a deployment starts it: a child process, its environment stripped of
// every NODE_AGENT_* variable first, its stdin on /dev/null (what a detached container hands it).
// Each test gets a throwaway state directory, so nothing writes into the real ~/.node_agent.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { TOKEN } from './probe.mjs';

export const ENTRY = fileURLToPath(new URL('../dist/serve.js', import.meta.url));

/** A throwaway state directory, removed when the test ends. */
export function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'na-serve-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Start the entry and collect its output lines. */
export function start(env = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_AGENT_')),
  );
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...clean,
      NODE_AGENT_BUS_PORT: '0',
      NODE_AGENT_TOKEN: TOKEN,
      NODE_AGENT_WEBUI_PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines = [];
  const errors = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    lines.push(...parts);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => errors.push(chunk));

  return { child, lines, errors };
}

/** Wait for whichever line arrives first that the caller is looking for. */
export async function line(entry, prefix, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = entry.lines.find((l) => l.startsWith(prefix));
    if (found !== undefined) return found;
    if (entry.child.exitCode !== null) throw new Error(`exited before ${prefix}: ${entry.errors}`);
    await delay(25);
  }
  throw new Error(`no line ${prefix} within ${timeout}ms`);
}

export const portOf = (busLine) => Number(busLine.slice(busLine.lastIndexOf(':') + 1));

/** Every test that starts the entry needs a bus port and a place for the history database. */
export function tenant(t, env = {}) {
  const state = stateDir(t);
  const entry = start({
    NODE_AGENT_HOME: state,
    ...env,
  });
  t.after(() => entry.child.kill('SIGKILL'));
  return { ...entry, home: state };
}
