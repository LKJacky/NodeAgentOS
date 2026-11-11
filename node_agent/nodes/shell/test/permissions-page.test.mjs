// The shell page's Permissions tab, in a real browser: one row per group (READ / WRITE / EXEC /
// EXEC_CUSTOM), a switch that saves, the refusal the Console then shows, and the commands the user
// keeps — added, edited and deleted from the form. `/call` is answered by a real ShellNode on a throwaway workspace. The two settings are kept in
// two places (`settings.ts`): the switches in a file per tenant under the `NODE_AGENT_HOME` this test
// points at a temp directory, the commands still in a history unit — so a reload reads the switches
// back from that file, and the commands from the fake history a closure stands in for.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { chromePath, openPage, startChrome } from '../../webui/tests/browser.mjs';
import { EFFECTS, permissionsFile } from '../dist/index.js';
import { fakeHistory } from './history-double.mjs';
import { ShellNode, closeShellService, context, nodeAgentHome, tenant } from './support.mjs';

//: The page as the build copies it from — tests read src/ on purpose (README.md, "Mobile").
const PAGE = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A workspace for the page, a node-agent home of its own, and a shell whose history is a closure. */
async function shellWithHistory(t) {
  const root = await mkdtemp(join(tmpdir(), 'shell-perm-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await nodeAgentHome(t);

  const history = fakeHistory();
  const id = tenant();
  t.after(() => closeShellService(id));
  const node = new ShellNode(context(id, { from: 'webui', call: history.call }), {
    workspace: root,
  });

  return { root, history, node, file: permissionsFile(id) };
}

/** The switches as the node's own file holds them: what a restart and a page reload both read. */
async function savedSwitches(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** The page on loopback, `/call` handed to the node — the way the webui forwards it. */
async function serve(node) {
  const page = PAGE.replaceAll('__NODE__', 'shell');
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/call') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        try {
          const { tool, args } = JSON.parse(body);
          const value = await node.handle(String(tool).replace(/^shell\./, ''), args ?? {});
          res.end(JSON.stringify({ ok: true, value }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    if (url === '/' || url.startsWith('/panel/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    res.writeHead(404);
    res.end('');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, port: server.address().port };
}

/** One talkative socket to the page, plus what these tests read from it. */
async function attach(wsUrl) {
  const { send, close } = await openPage(wsUrl);

  async function evaluate(expression) {
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.result?.exceptionDetails)
      throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 600));
    return reply.result.result.value;
  }

  async function until(expression, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      const value = await evaluate(expression);
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${expression}`);
      await sleep(100);
    }
  }

  return { send, evaluate, until, close };
}

test(
  'the Permissions tab switches a group off, and the shell honours it',
  { timeout: 120000 },
  async (t) => {
    const chrome = chromePath();
    if (!chrome) {
      t.skip('no chrome to drive: set CHROME to a chromium binary');
      return;
    }

    const { file, node } = await shellWithHistory(t);
    const site = await serve(node);
    const browser = await startChrome(chrome);
    let page;
    try {
      page = await attach(browser.page.webSocketDebuggerUrl);
      const url = `http://127.0.0.1:${site.port}/`;
      await page.send('Page.navigate', { url });
      await page.until(
        `document.getElementById('console') && !document.getElementById('console').hidden`,
      );

      // --- The tab exists beside the others, and the pane starts closed. ---
      await page.evaluate(`document.querySelector('.tabs button[data-tab="permissions"]').click()`);
      assert.equal(
        await page.evaluate(`document.getElementById('permissions-pane').hidden`),
        false,
      );

      // --- Four rows: one switch per group, the page itself not among them. ---
      assert.equal(await page.until(`window.shellPermissions?.rows().length`), 4);
      const names = await page.evaluate(`window.shellPermissions.rows().join(',')`);
      assert.equal(names, 'READ,WRITE,EXEC,EXEC_CUSTOM');
      assert.ok(!names.includes('UI'), 'the page is not a switch');

      // Management switches are ordinary controls: webui bypasses them, but the switch can still
      // restrict every other caller, so it is not disabled.
      assert.equal(
        await page.evaluate(
          `[...document.querySelectorAll('#perm-list input')].filter((i) => i.disabled).length`,
        ),
        0,
      );

      // --- Flipping one switch is a draft: nothing is saved until Save. ---
      assert.equal(await page.evaluate(`window.shellPermissions.toggle('EXEC', false)`), true);
      assert.equal(await page.evaluate(`document.getElementById('perm-save').disabled`), false);
      assert.equal(
        await page.evaluate(`document.getElementById('perm-status').textContent`),
        'unsaved changes',
      );
      assert.equal(existsSync(file), false, 'a draft is not a save');
      assert.equal(
        await page.evaluate(
          `document.querySelector('#perm-list .perm-row[data-group="EXEC"]').className`,
        ),
        'perm-row off',
      );

      await page.evaluate(`document.getElementById('perm-save').click()`);
      await page.until(`document.getElementById('perm-status').textContent === 'saved'`);
      // One switch, one group: every capability the group covers is written as refused.
      const saved = await savedSwitches(file);
      assert.equal(saved.version, 1);
      assert.deepEqual(
        saved.rules.map((rule) => rule.cap).sort(),
        Object.keys(EFFECTS)
          .filter((cap) => cap !== 'set-permissions' && cap !== 'run-custom' && EFFECTS[cap] === 'exec')
          .sort(),
      );
      assert.ok(saved.rules.every((rule) => rule.callers.length === 0));
      assert.equal(await page.evaluate(`document.getElementById('perm-denied').textContent`), '1');

      // --- The Console is where a caller meets it: the same refusal, in the output line. ---
      await page.evaluate(`document.querySelector('.tabs button[data-tab="console"]').click()`);
      await page.evaluate(`(() => {
      document.getElementById('cmd').value = 'echo hello';
      document.getElementById('exec').requestSubmit();
      return true;
    })()`);
      await page.until(`/disabled/.test(document.getElementById('out').textContent)`);
      assert.equal(
        await page.evaluate(`document.getElementById('out').textContent`),
        'Failed: shell.exec is disabled by the user for node "webui"',
      );

      // --- A reload reads the switches back from the node's own file, not from the page. ---
      await page.send('Page.navigate', { url });
      await page.until(
        `window.shellPermissions && document.getElementById('console') && !document.getElementById('console').hidden`,
      );
      await page.evaluate(`document.querySelector('.tabs button[data-tab="permissions"]').click()`);
      await page.until(`window.shellPermissions?.rows().length > 0`);
      await sleep(300);
      assert.equal(
        await page.evaluate(
          `document.querySelector('#perm-list .perm-row[data-group="EXEC"] input').checked`,
        ),
        false,
      );
      assert.equal(await page.evaluate(`document.getElementById('perm-denied').textContent`), '1');

      // Switching it back on saves again, and the rules are gone (unconfigured, not `['*']`).
      assert.equal(await page.evaluate(`window.shellPermissions.toggle('EXEC', true)`), true);
      await page.evaluate(`document.getElementById('perm-save').click()`);
      await page.until(`document.getElementById('perm-status').textContent === 'saved'`);
      assert.deepEqual(await savedSwitches(file), { version: 1, rules: [] });

      // --- The fourth switch is its own: EXEC_CUSTOM covers the saved commands, nobody else. ---
      assert.equal(await page.evaluate(`window.shellPermissions.toggle('EXEC_CUSTOM', false)`), true);
      await page.evaluate(`document.getElementById('perm-save').click()`);
      await page.until(`document.getElementById('perm-status').textContent === 'saved'`);
      assert.deepEqual(await savedSwitches(file), {
        version: 1,
        rules: [{ cap: 'run-custom', callers: [] }],
      });
      assert.equal(await page.evaluate(`window.shellPermissions.toggle('EXEC_CUSTOM', true)`), true);
      await page.evaluate(`document.getElementById('perm-save').click()`);
      await page.until(`document.getElementById('perm-status').textContent === 'saved'`);
      assert.deepEqual(await savedSwitches(file), { version: 1, rules: [] });
    } finally {
      await page?.close();
      browser.chrome.kill('SIGKILL');
      site.server.close();
    }
  },
);

test(
  'the Permissions tab adds, edits and deletes a custom command',
  { timeout: 120000 },
  async (t) => {
    const chrome = chromePath();
    if (!chrome) {
      t.skip('no chrome to drive: set CHROME to a chromium binary');
      return;
    }

    const { history, node } = await shellWithHistory(t);
    const site = await serve(node);
    const browser = await startChrome(chrome);
    let page;
    try {
      page = await attach(browser.page.webSocketDebuggerUrl);
      await page.send('Page.navigate', { url: `http://127.0.0.1:${site.port}/#permissions` });

      // `#permissions` is a link to the tab, the way `#files` is.
      await page.until(
        `window.shellPermissions && document.getElementById('permissions-pane').hidden === false`,
      );
      await page.until(
        `document.getElementById('cc-list').textContent.includes('No custom command yet')`,
      );

      // --- Add: the form's fields are the command's fields. ---
      await page.evaluate(`(() => {
      document.getElementById('cc-name').value = 'echoes';
      document.getElementById('cc-description').value = 'print the arguments';
      document.getElementById('cc-command').value = 'echo "$@"';
      document.getElementById('cc-cwd').value = '.';
      document.getElementById('cc-form').requestSubmit();
      return true;
    })()`);
      await page.until(`document.querySelector('#cc-list .perm-row[data-id="echoes"]')`);
      assert.equal(await page.evaluate(`document.getElementById('cc-count').textContent`), '1');
      const saved = history.units.get('shell.custom_commands').meta.commands[0];
      assert.equal(saved.name, 'echoes');
      assert.equal(saved.command, 'echo "$@"');
      assert.equal(saved.description, 'print the arguments');

      // --- The command runs: the tab says it was allowed, and the agent's call answers. ---
      const ran = await page.evaluate(
        `window.shellPermissions.call('shell.run-custom', { name: 'echoes', args: ['a b', 'c'] })`,
      );
      assert.equal(ran.ok, true);
      assert.match(String(ran.value), /a b c/);

      // --- Edit: the form fills from the row, and Save changes the command in place. ---
      await page.evaluate(
        `document.querySelector('#cc-list .perm-row[data-id="echoes"] .acts button').click()`,
      );
      assert.equal(await page.evaluate(`document.getElementById('cc-name').value`), 'echoes');
      assert.equal(await page.evaluate(`document.getElementById('cc-submit').textContent`), 'Save');
      await page.evaluate(`(() => {
      document.getElementById('cc-command').value = 'echo changed';
      document.getElementById('cc-form').requestSubmit();
      return true;
    })()`);
      await page.until(`document.getElementById('cc-status').textContent === 'saved'`);
      assert.equal(history.units.get('shell.custom_commands').meta.commands.length, 1);
      assert.equal(
        history.units.get('shell.custom_commands').meta.commands[0].command,
        'echo changed',
      );

      // --- A script the node refuses says why, in the form's own line. ---
      await page.evaluate(`(() => {
      document.getElementById('cc-name').value = 'token-thief';
      document.getElementById('cc-command').value = 'echo x';
      document.getElementById('cc-env').value = 'NODE_AGENT_TOKEN';
      document.getElementById('cc-form').requestSubmit();
      return true;
    })()`);
      await page.until(
        `/credential family/.test(document.getElementById('cc-status').textContent)`,
      );
      assert.equal(history.units.get('shell.custom_commands').meta.commands.length, 1);

      // --- Delete: the row goes, and so does the unit's copy of it. ---
      await page.evaluate(`window.shellPermissions.reset()`);
      await page.evaluate(
        `document.querySelector('#cc-list .perm-row[data-id="echoes"] .acts button.danger').click()`,
      );
      await page.until(
        `document.getElementById('cc-list').textContent.includes('No custom command yet')`,
      );
      assert.deepEqual(history.units.get('shell.custom_commands').meta.commands, []);

      // --- And the switches still say everything is allowed, so the tab did not lock itself out. ---
      assert.equal(
        await page.evaluate(`document.getElementById('perm-status').textContent`),
        'everything is allowed',
      );
    } finally {
      await page?.close();
      browser.chrome.kill('SIGKILL');
      site.server.close();
    }
  },
);
