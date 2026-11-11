// The shell page's Files tab, in a real browser: the tree renders what the node lists, a click opens
// the file on the right, an absolute or parent path can be opened, and a binary file is
// described instead of shown. A text file opens in the editor, saves what was typed (the button and
// Cmd/Ctrl+S), and a file that changed under the page is a question: reload it, or keep mine. The page is served on loopback and its `/call` is answered by a real
// ShellNode pointed at a throwaway workspace — no bus, no agent, just the page and the node it talks
// to. Nothing here needs a network: the page carries its own CSS and its own highlighter.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { chromePath, openPage, startChrome } from '../../webui/tests/browser.mjs';
import { shell } from './support.mjs';

//: The page as the build copies it from — tests read src/ on purpose (README.md, "Mobile").
const PAGE = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');

/** The smallest PNG this test can carry in source: 1×1, transparent. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

//: The file the click test opens: two lines, one keyword each to colour, and a size the tree shows.
const HELLO = 'const answer = 42;\nexport default answer;\n';

/** A workspace for the page: text, a nested directory, an image, a binary, and an outside file that
 *  `..` must not reach. */
async function workspace(t) {
  const parent = await mkdtemp(join(tmpdir(), 'shell-page-'));
  const root = join(parent, 'ws');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'hello.ts'), HELLO);
  await writeFile(join(root, 'note.md'), '# note\n');
  await writeFile(join(root, 'sub', 'nested.txt'), 'nested file\n');
  await writeFile(join(root, 'pixel.png'), PNG);
  await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(parent, 'outside.txt'), 'secret');
  await symlink(parent, join(root, 'link'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return root;
}

/** The page on loopback, `/call` handed to the node. The page is the one the node would serve, with
 *  its own name filled in the way `ShellNode.handle('ui')` does. */
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

  /** Wait for one expression to come back truthy, then return it. */
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

test('the Files tab lists, opens, refuses and never previews a binary', { timeout: 120000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome) {
    t.skip('no chrome to drive: set CHROME to a chromium binary');
    return;
  }

  const root = await workspace(t);
  const node = shell(t, root);
  const site = await serve(node);
  const browser = await startChrome(chrome);
  let page;
  try {
    page = await attach(browser.page.webSocketDebuggerUrl);
    const url = `http://127.0.0.1:${site.port}/`;
    await page.send('Page.navigate', { url });

    // --- Console first, as it always was; the Files tab is one click beside it. ---
    await page.until(`document.getElementById('console') && !document.getElementById('console').hidden`);
    assert.equal(
      await page.evaluate(`document.getElementById('files-pane').hidden`),
      true,
      'Files starts closed: the console is what the page opens on',
    );
    await page.evaluate(`document.querySelector('.tabs button[data-tab="files"]').click()`);
    assert.equal(await page.evaluate(`document.getElementById('files-pane').hidden`), false);

    // --- The tree: one row per entry, directories first, sizes where they mean something. ---
    const listed = await page.until(
      `document.querySelectorAll('#tree .row').length >= 5 && [...document.querySelectorAll('#tree .row')].map((row) => row.dataset.path).join(',')`,
    );
    const paths = String(listed).split(',');
    assert.ok(paths.includes('sub'), `the tree is missing the directory: ${paths}`);
    for (const name of ['hello.ts', 'note.md', 'pixel.png', 'blob.bin']) assert.ok(paths.includes(name), `the tree is missing ${name}`);
    assert.ok(paths.indexOf('sub') < paths.indexOf('hello.ts'), 'directories come first');
    const rootDir = await page.evaluate(`document.querySelector('#tree .row[data-path="sub"] .name').textContent`);
    assert.equal(rootDir, 'sub/', 'a directory is shown with a trailing slash');
    const size = await page.evaluate(`document.querySelector('#tree .row[data-path="hello.ts"] .size').textContent`);
    assert.equal(size, `${Buffer.byteLength(HELLO)} B`, 'a file row carries its size');

    // --- A directory opens under itself, one level per call. ---
    await page.evaluate(`document.querySelector('#tree .row[data-path="sub"]').click()`);
    await page.until(`document.querySelector('#tree .row[data-path="sub/nested.txt"]')`);
    await page.evaluate(`document.querySelector('#tree .row[data-path="sub/nested.txt"]').click()`);
    await page.until(`document.getElementById('preview-name').textContent === 'sub/nested.txt'`);
    await page.until(`document.getElementById('editor')?.value.includes('nested file')`);

    // --- Clicking a file opens it on the right, in the editor. ---
    await page.evaluate(`document.querySelector('#tree .row[data-path="hello.ts"]').click()`);
    await page.until(`document.getElementById('preview-name').textContent === 'hello.ts'`);
    await page.until(`document.getElementById('editor')?.value.length > 0`);
    assert.equal(
      await page.evaluate(`document.getElementById('editor').value`),
      HELLO,
      'the editor holds the whole file',
    );
    assert.match(
      await page.evaluate(`getComputedStyle(document.getElementById('editor')).fontFamily`),
      /mono/i,
      'the editor is monospace',
    );
    assert.match(await page.evaluate(`document.getElementById('preview-meta').textContent`), /\d+ lines/);
    assert.equal(await page.evaluate(`document.querySelectorAll('#preview-body img').length`), 0);
    assert.equal(
      await page.evaluate(`document.getElementById('dirty-dot').hidden`),
      true,
      'a just-opened file is clean',
    );
    assert.equal(await page.evaluate(`document.getElementById('save').disabled`), true, 'nothing to save yet');

    // --- An image is shown as an image. ---
    await page.evaluate(`document.querySelector('#tree .row[data-path="pixel.png"]').click()`);
    await page.until(`document.querySelector('#preview-body img')`);
    const source2 = await page.evaluate(`document.querySelector('#preview-body img').src.slice(0, 22)`);
    assert.equal(source2, 'data:image/png;base64,');
    assert.match(await page.evaluate(`document.getElementById('preview-meta').textContent`), /image\/png/);

    // --- A binary file says what it is and is never turned into a preview. ---
    await page.evaluate(`document.querySelector('#tree .row[data-path="blob.bin"]').click()`);
    await page.until(`document.getElementById('preview-body').textContent.includes('not previewable')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#preview-body img, #preview-body .line').length`), 0);
    const notice = await page.evaluate(`document.getElementById('preview-body').textContent`);
    assert.match(notice, /4 bytes of application\/octet-stream \(binary\)/);
    assert.match(await page.evaluate(`document.getElementById('preview-meta').textContent`), /4 B · application\/octet-stream/);

    // --- Parent paths are ordinary local paths and can be opened. ---
    await page.evaluate(`window.shellFiles.openFile('../outside.txt')`);
    await page.until(`document.getElementById('editor')?.value === 'secret'`);
    assert.equal(await page.evaluate(`document.getElementById('preview-name').textContent`), '../outside.txt');

    // --- A phone: the tree is a drawer, opened by its button and closed again by a file tap. ---
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 740,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.send('Page.navigate', { url: `${url}#files` });
    await page.until(`document.querySelectorAll('#tree .row').length > 0`);
    await sleep(250); // the drawer's slide is a transition
    const closed = await page.evaluate(`document.getElementById('tree-pane').getBoundingClientRect().right`);
    assert.ok(closed <= 0, `the drawer starts off the screen: right=${closed}`);
    // A flex item's `inline-block` computes as `block`; what matters is that it is on screen.
    assert.notEqual(
      await page.evaluate(`getComputedStyle(document.getElementById('tree-toggle')).display`),
      'none',
      'the phone has its drawer button',
    );
    await page.evaluate(`document.getElementById('tree-toggle').click()`);
    await sleep(250);
    const opened = await page.evaluate(`document.getElementById('tree-pane').getBoundingClientRect().left`);
    assert.ok(opened >= 0, `the drawer opens over the preview: left=${opened}`);
    await page.evaluate(`document.querySelector('#tree .row[data-path="hello.ts"]').click()`);
    await sleep(250);
    const after = await page.evaluate(`document.getElementById('tree-pane').getBoundingClientRect().right`);
    assert.ok(after <= 0, `picking a file puts the drawer away: right=${after}`);
    assert.equal(
      await page.evaluate(`document.getElementById('preview-name').textContent`),
      'hello.ts',
      'and the file is open behind it',
    );
    assert.ok(
      (await page.evaluate(`document.documentElement.scrollWidth`)) <=
        (await page.evaluate(`document.documentElement.clientWidth`)),
      'the phone is not wider than its screen',
    );
  } finally {
    page?.close();
    browser.chrome.kill('SIGKILL');
    site.server.closeAllConnections();
    site.server.close();
  }
});

test('a typed character is saved, with a status line, Ctrl+S and a conflict to answer', { timeout: 120000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome) {
    t.skip('no chrome to drive: set CHROME to a chromium binary');
    return;
  }

  const root = await workspace(t);
  const node = shell(t, root);
  const site = await serve(node);
  const browser = await startChrome(chrome);
  let page;

  /** The file as the disk has it — the page's save is an HTTP round trip, so this is polled. */
  async function onDisk(name, text, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      if ((await readFile(join(root, name), 'utf8').catch(() => null)) === text) return;
      if (Date.now() > end) throw new Error(`${name} never held the saved text`);
      await sleep(50);
    }
  }

  /** Type the way a person does: put the text in the editor, then let the page hear about it. */
  async function type(value) {
    await page.evaluate(`(() => {
      const editor = document.getElementById('editor');
      editor.value = ${JSON.stringify(value)};
      editor.dispatchEvent(new Event('input'));
    })()`);
  }

  try {
    page = await attach(browser.page.webSocketDebuggerUrl);
    await page.send('Page.navigate', { url: `http://127.0.0.1:${site.port}/#files` });
    await page.until(`document.querySelectorAll('#tree .row[data-path="hello.ts"]').length > 0`);
    await page.evaluate(`document.querySelector('#tree .row[data-path="hello.ts"]').click()`);
    await page.until(`document.getElementById('editor')?.value.length > 0`);

    // --- One character typed: dirty, and the button that saves wakes up. ---
    const edited = HELLO.replace('42', '43');
    await type(edited);
    assert.equal(
      await page.evaluate(`document.getElementById('dirty-dot').hidden`),
      false,
      'a changed file is marked dirty',
    );
    assert.equal(await page.evaluate(`document.getElementById('save').disabled`), false, 'Save is offered');

    // --- Save: the node writes it, and the line beside the name says so. ---
    await page.evaluate(`document.getElementById('save').click()`);
    await page.until(`document.getElementById('save-status').textContent === 'Saved'`);
    await onDisk('hello.ts', edited);
    assert.equal(await page.evaluate(`document.getElementById('dirty-dot').hidden`), true, 'a saved file is clean again');
    assert.equal(await page.evaluate(`document.getElementById('save').disabled`), true);
    assert.match(await page.evaluate(`document.getElementById('save-status').className`), /saved/);

    // --- Cmd/Ctrl+S is the same save, from the keyboard. ---
    const typed = `${edited}// and one more line\n`;
    await type(typed);
    await page.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))`,
    );
    await onDisk('hello.ts', typed);
    await page.until(`document.getElementById('dirty-dot').hidden === true`);

    // --- The file moved under the page: the save is refused, and the bar asks the two questions. ---
    await writeFile(join(root, 'hello.ts'), 'written by somebody else\n');
    await type('mine, from the page\n');
    await page.evaluate(`document.getElementById('save').click()`);
    await page.until(`document.getElementById('conflict').hidden === false`);
    assert.match(
      await page.evaluate(`document.getElementById('save-status').textContent`),
      /^Not saved: the file changed since revision \d+/,
    );
    assert.equal(
      await readFile(join(root, 'hello.ts'), 'utf8'),
      'written by somebody else\n',
      'a refused save writes nothing',
    );
    assert.deepEqual(
      await page.evaluate(`[...document.querySelectorAll('#conflict button')].map((one) => one.textContent)`),
      ['Reload', 'Keep mine'],
    );

    // --- Keep mine: this time the page's text goes over what is there. ---
    await page.evaluate(`document.getElementById('keep-mine').click()`);
    await onDisk('hello.ts', 'mine, from the page\n');
    await page.until(`document.getElementById('conflict').hidden === true`);
    assert.equal(await page.evaluate(`document.getElementById('save-status').textContent`), 'Saved');

    // --- Reload: the editor takes what is on disk instead of what was typed. ---
    await writeFile(join(root, 'hello.ts'), 'the disk wins\n');
    await type('lost anyway\n');
    await page.evaluate(`document.getElementById('save').click()`);
    await page.until(`document.getElementById('conflict').hidden === false`);
    await page.evaluate(`document.getElementById('reload-file').click()`);
    await page.until(`document.getElementById('editor')?.value === ${JSON.stringify('the disk wins\n')}`);
    assert.equal(await page.evaluate(`document.getElementById('conflict').hidden`), true, 'reloading settles it');
    assert.equal(await readFile(join(root, 'hello.ts'), 'utf8'), 'the disk wins\n');

    // --- A deny-list name is refused, and the page says which name it was (what the list holds is
    // the guard's: guard.test.mjs and browse.test.mjs are where its contents are pinned down). ---
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'config'), '[core]\n');
    await page.evaluate(`document.getElementById('tree-refresh').click()`);
    await page.until(`document.querySelector('#tree .row[data-path=".git"]')`);
    await page.evaluate(`document.querySelector('#tree .row[data-path=".git"]').click()`);
    await page.until(`document.querySelector('#tree .row[data-path=".git/config"]')`);
    await page.evaluate(`document.querySelector('#tree .row[data-path=".git/config"]').click()`);
    await page.until(`document.getElementById('editor')?.value === ${JSON.stringify('[core]\n')}`);
    await type('[core]\n\tbare = false\n');
    await page.evaluate(`document.getElementById('save').click()`);
    await page.until(`document.getElementById('save-status').textContent.startsWith('Not saved:')`);
    assert.match(
      await page.evaluate(`document.getElementById('save-status').textContent`),
      /"\.git" is on this node's deny list/,
      'the page says why it refused',
    );
    assert.equal(await page.evaluate(`document.getElementById('conflict').hidden`), true, 'a refusal is not a conflict');
    assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), '[core]\n');
  } finally {
    page?.close();
    browser.chrome.kill('SIGKILL');
    site.server.closeAllConnections();
    site.server.close();
  }
});
