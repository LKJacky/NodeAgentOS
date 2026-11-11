// The Files tab also reads markdown, so this is the browser end of that: a `.md` file opens as the
// rendered page (unless the reader last chose source), a script tag in it is text and a `javascript:`
// link has no anchor, the blocks a readme is made of come out as the tags they stand for, and a file
// that is not markdown has no switch at all. The page is served on loopback with a real ShellNode
// behind `/call` — no bus, no agent. The harness below is copied from files-page.test.mjs rather than
// shared: that file belongs to another branch, and a test that reached into it would break it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { chromePath, openPage, startChrome } from '../../webui/tests/browser.mjs';
import { shell } from './support.mjs';

//: The page as the build copies it from — tests read src/ on purpose (README.md, "Mobile").
const PAGE = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

//: The file that is a readme: one of everything the renderer claims, and two links — one it follows
//: and one it must not.
const DOC = [
  '# Title',
  '',
  'Some **bold** text, an *italic* one and a code span: `answer = 42`.',
  '',
  '## A list',
  '',
  '- one',
  '- two',
  '  - inner',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted',
  '',
  '| name | value |',
  '| :--- | ----: |',
  '| a | 1 |',
  '',
  '```js',
  'const answer = 42;',
  'if (answer < 43) console.log(answer);',
  '```',
  '',
  '---',
  '',
  '[good](https://example.com/page) and [bad](javascript:window.pwned=2) and [rel](./note.md)',
  '',
].join('\n');

//: The file that is an attack: four ways to get a page to run something, all of them text here.
const EVIL = [
  '# Evil',
  '',
  '<script>window.pwned = 1</script>',
  '',
  '<img src=x onerror="window.pwned = 1">',
  '',
  '<a href="javascript:window.pwned=3">click</a>',
  '',
  '[run](javascript:window.pwned=2)',
  '',
].join('\n');

const HELLO = 'const answer = 42;\nexport default answer;\n';

/** A workspace for the page: two markdown files (one of each extension), and one file that is not
 *  markdown, so the switch can be looked for where it must not be. */
async function workspace(t) {
  const parent = await mkdtemp(join(tmpdir(), 'shell-md-'));
  const root = join(parent, 'ws');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'doc.md'), DOC);
  await writeFile(join(root, 'evil.md'), EVIL);
  await writeFile(join(root, 'note.markdown'), '# note\n');
  await writeFile(join(root, 'hello.ts'), HELLO);
  await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
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

test('a markdown file opens as the page, and nothing in it is executed', { timeout: 120000 }, async (t) => {
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
    const url = `http://127.0.0.1:${site.port}/#files`;
    await page.send('Page.navigate', { url });
    await page.until(`document.querySelectorAll('#tree .row[data-path="doc.md"]').length > 0`);

    // --- A markdown file is previewed, not shown as bytes: the switch is there, the textarea is not. ---
    await page.evaluate(`document.querySelector('#tree .row[data-path="doc.md"]').click()`);
    await page.until(`document.querySelectorAll('#markdown h1').length > 0`);
    assert.equal(await page.evaluate(`document.getElementById('mode').hidden`), false, 'markdown has the switch');
    assert.equal(await page.evaluate(`window.shellFiles.mode()`), 'preview', 'preview is the default');
    assert.equal(await page.evaluate(`document.getElementById('editor').hidden`), true, 'the source is out of sight');
    assert.equal(await page.evaluate(`document.getElementById('markdown').hidden`), false);
    assert.equal(
      await page.evaluate(`document.querySelector('#mode button[data-mode="preview"]').getAttribute('aria-pressed')`),
      'true',
      'the switch says which way it is',
    );

    // --- The blocks a readme is made of, as the tags they stand for. ---
    assert.equal(await page.evaluate(`document.querySelector('#markdown h1').textContent`), 'Title');
    assert.equal(await page.evaluate(`document.querySelector('#markdown h2').textContent`), 'A list');
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown p strong').length`), 1);
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown p em').length`), 1);
    assert.equal(
      await page.evaluate(`document.querySelector('#markdown p code').textContent`),
      'answer = 42',
      'an inline code span keeps its text',
    );
    // Lists: two unordered (one nested) and two ordered items.
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown > ul > li').length`), 2);
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown ul ul > li').length`), 1, 'the nested one');
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown ol > li').length`), 2);
    assert.equal(await page.evaluate(`document.querySelector('#markdown blockquote').textContent.trim()`), 'quoted');
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown hr').length`), 1);
    // The table: a head, a body, and the second column aligned right by the file's own colons.
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown table thead th').length`), 2);
    assert.equal(await page.evaluate(`document.querySelector('#markdown table tbody td').textContent`), 'a');
    assert.equal(
      await page.evaluate(`document.querySelectorAll('#markdown th')[1].style.textAlign`),
      'right',
      'the colons under the column set the alignment',
    );
    // The code block: its language, and its own text — `<` is a character, not a tag.
    assert.equal(await page.evaluate(`document.querySelector('#markdown pre code').className`), 'language-js');
    const code = await page.evaluate(`document.querySelector('#markdown pre code').textContent`);
    assert.match(String(code), /if \(answer < 43\) console\.log\(answer\);/, 'the block is read verbatim');

    // --- Links: the two the page follows, and nothing for the one it refuses. ---
    const hrefs = await page.evaluate(
      `[...document.querySelectorAll('#markdown a')].map((a) => a.getAttribute('href')).join(',')`,
    );
    assert.equal(
      String(hrefs),
      'https://example.com/page,./note.md',
      'http(s) and a relative path are followed, javascript: is not',
    );
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown a[href^="javascript"]').length`), 0);
    assert.equal(
      await page.evaluate(`document.querySelector('#markdown .refused').textContent`),
      'bad',
      'the refused link keeps its words',
    );

    // --- Wide things stay inside the pane: a code block scrolls, the page does not widen. ---
    assert.ok(
      (await page.evaluate(`document.getElementById('preview-body').scrollWidth`)) <=
        (await page.evaluate(`document.getElementById('preview-body').clientWidth`)) + 1,
      'the preview body has nothing hanging out of it',
    );

    // --- The attack: every one of those four lines is text on the screen, and nothing ran. ---
    await page.evaluate(`document.querySelector('#tree .row[data-path="evil.md"]').click()`);
    await page.until(
      `document.querySelectorAll('#markdown h1').length > 0 && document.querySelector('#markdown h1').textContent === 'Evil'`,
    );
    assert.equal(await page.evaluate(`window.pwned`), undefined, 'no script ran');
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown script').length`), 0, 'no script element');
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown img').length`), 0, 'no image element');
    assert.equal(
      await page.evaluate(`document.querySelectorAll('#markdown a').length`),
      0,
      'not even the a-tag in the file is an anchor',
    );
    const shown = await page.evaluate(`document.getElementById('markdown').textContent`);
    assert.match(String(shown), /<script>window\.pwned = 1<\/script>/, 'the tag is characters on the screen');
    assert.match(String(shown), /<img src=x onerror="window\.pwned = 1">/);

    // --- A phone: prose reads at 360px, and the page is never wider than the screen. ---
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 740,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.send('Page.navigate', { url });
    await page.until(`document.querySelectorAll('#tree .row[data-path="doc.md"]').length > 0`);
    await page.evaluate(`document.querySelector('#tree .row[data-path="doc.md"]').click()`);
    await page.until(`document.querySelectorAll('#markdown h1').length > 0`);
    assert.ok(
      (await page.evaluate(`document.documentElement.scrollWidth`)) <=
        (await page.evaluate(`document.documentElement.clientWidth`)),
      'the phone is not wider than its screen',
    );
    assert.ok(
      (await page.evaluate(`document.getElementById('markdown').getBoundingClientRect().width`)) <= 360,
      'the rendered page fits the phone',
    );
  } finally {
    page?.close();
    browser.chrome.kill('SIGKILL');
    site.server.closeAllConnections();
    site.server.close();
  }
});

test('the switch is remembered across a reload, and only markdown has one', { timeout: 120000 }, async (t) => {
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
  const url = `http://127.0.0.1:${site.port}/#files`;

  /** Open one file from the tree and wait until the pane holds it. What is waited for is the file, not
   *  a tag: the rendered page is only built when it is shown, so a reader in source mode has none. */
  async function open(name) {
    await page.until(`document.querySelectorAll('#tree .row[data-path="${name}"]').length > 0`);
    await page.evaluate(`document.querySelector('#tree .row[data-path="${name}"]').click()`);
    await page.until(
      `document.getElementById('preview-name').textContent === '${name}' && window.shellFiles.state() !== null`,
    );
  }

  try {
    page = await attach(browser.page.webSocketDebuggerUrl);
    await page.send('Page.navigate', { url });

    // --- Nothing remembered yet: a markdown file opens as its page. ---
    await open('doc.md');
    assert.equal(await page.evaluate(`window.shellFiles.mode()`), 'preview', 'preview is where a first reader starts');
    assert.equal(await page.evaluate(`localStorage.getItem('shell.markdown.mode')`), null);

    // --- Source: the textarea comes back, with the file in it, and the choice is written down. ---
    await page.evaluate(`document.querySelector('#mode button[data-mode="source"]').click()`);
    assert.equal(await page.evaluate(`document.getElementById('editor').hidden`), false, 'the source is on screen');
    assert.equal(await page.evaluate(`document.getElementById('markdown').hidden`), true, 'the page is not');
    assert.match(String(await page.evaluate(`document.getElementById('editor').value`)), /^# Title/);
    assert.equal(await page.evaluate(`localStorage.getItem('shell.markdown.mode')`), 'source');

    // --- A reload: the choice outlives the tab. ---
    await page.send('Page.navigate', { url });
    await open('doc.md');
    assert.equal(await page.evaluate(`window.shellFiles.mode()`), 'source', 'the reader is still in source');
    assert.equal(await page.evaluate(`document.getElementById('editor').hidden`), false);

    // --- A file that is not markdown: no switch, and the editor as it always was. ---
    await open('hello.ts');
    assert.equal(await page.evaluate(`document.getElementById('mode').hidden`), true, 'a .ts file has one way');
    assert.equal(await page.evaluate(`document.querySelectorAll('#markdown').length`), 0, 'and no rendered page');
    assert.equal(await page.evaluate(`document.getElementById('editor').hidden`), false);
    assert.match(String(await page.evaluate(`document.getElementById('editor').value`)), /export default answer/);

    // --- A file with no text at all: the switch goes with the file that had one. ---
    // A binary never fills the pane with text, so this one is clicked and waited for by hand.
    await page.until(`document.querySelectorAll('#tree .row[data-path="blob.bin"]').length > 0`);
    await page.evaluate(`document.querySelector('#tree .row[data-path="blob.bin"]').click()`);
    await page.until(`document.querySelectorAll('#preview-body .notice').length > 0`);
    assert.equal(await page.evaluate(`document.getElementById('mode').hidden`), true, 'a binary has no source mode either');
    assert.equal(await page.evaluate(`document.querySelectorAll('#preview-body .notice').length`), 1);

    // --- `.markdown` is markdown too. ---
    await open('note.markdown');
    assert.equal(await page.evaluate(`document.getElementById('mode').hidden`), false);

    // --- A browser that refuses storage is not an error: the switch still works, it just forgets. ---
    await page.evaluate(`localStorage.removeItem('shell.markdown.mode')`);
    await page.evaluate(`Storage.prototype.setItem = () => { throw new Error('refused'); }`);
    await page.evaluate(`document.querySelector('#mode button[data-mode="preview"]').click()`);
    assert.equal(await page.evaluate(`window.shellFiles.mode()`), 'preview', 'the click still switched');
    assert.equal(await page.evaluate(`document.getElementById('editor').hidden`), true);
    assert.equal(await page.evaluate(`localStorage.getItem('shell.markdown.mode')`), null, 'and nothing was stored');
  } finally {
    page?.close();
    browser.chrome.kill('SIGKILL');
    site.server.closeAllConnections();
    site.server.close();
  }
});
