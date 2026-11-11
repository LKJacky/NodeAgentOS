import { serveEventAssets } from './browser.mjs';
// Every node owns its own tab drawing: `src/icon.svg` lives in the node's own package and is handed to
// the webui as a whole `<svg>` string in that node's `ui` schema. The shell keeps no pictures and no
// name→picture map, so the only way a tab can show one is for its node to say it — and the only place
// to fix a wrong drawing is the package that owns it. This file also runs the real page in a browser,
// because "the node hands over a drawing" and "the shell draws it" are two different promises and the
// second one is only true if `innerHTML` never gets a string that runs.
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { AgentNode } from '../../agent/src/agent.ts';
import { DebugNode } from '../../node-agent-debug/src/index.ts';
import { DeepSeekSearchNode } from '../../search/src/index.ts';
import { NotesNode } from '../../notes/src/index.ts';
import { MindMapNode } from '../../node-agent-mindmap/src/index.ts';
import { ShellNode } from '../../shell/src/index.ts';
import { StoreNode } from '../../store/src/index.ts';
import { TimerNode } from '../../timer/src/index.ts';
import { TodoNode } from '../../todo/src/index.ts';
import { chromePath, openPage, startChrome } from './browser.mjs';

//: The repository root, three levels up from webui/tests/.
const ROOT = new URL('../../../', import.meta.url);

//: Every package that draws a tab: the rule is "each node carries its own", so a package without a
//: drawing here is one whose tab would come out blank.
const PACKAGES = [
  'node-agent-agent',
  'node-agent-debug',
  'node-agent-search',
  'node-agent-notes',
  'node-agent-mindmap',
  '@node-agent/shell',
  'node-agent-store',
  'node-agent-timer',
  'node-agent-todo',
];

const drawing = (name) =>
  readFileSync(new URL(`${name}/src/icon.svg`, ROOT), 'utf8').trim();

//: A drawing the shell would refuse is worse than none: the tab would be blank and nothing would say
//: why. The checks are the shell's own (see `glyph()` in webui.html), read the other way round.
const RUNS = /<script\b|[\s"'/]on[a-z]+\s*=|javascript:/i;

test('test_every_package_carries_its_own_drawing', () => {
  for (const name of PACKAGES) {
    const path = new URL(`${name}/src/icon.svg`, ROOT);
    // "Its own" is the point of this direction, so a link to one shared file does not count.
    assert.equal(
      lstatSync(path).isSymbolicLink(),
      false,
      `${name} has to own the file, not link it`,
    );
    const svg = drawing(name);
    assert.match(svg, /^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name}/icon.svg`);
    assert.match(svg, /viewBox="0 0 24 24"/, `${name} draws in the pages' 24-unit box`);
    assert.match(svg, /<(path|circle|rect|line|polyline)\b/, `${name} has something to draw`);
    assert.doesNotMatch(svg, RUNS, `${name} hands over a drawing, not a script`);
  }
});

// The node's half: it reads its own file and puts it in its own `ui` schema — no table anywhere maps a
// name to a picture, so this is the only place a tab's drawing can come from.
test('test_every_typescript_node_hands_its_own_drawing_over', () => {
  const nodes = {
    'node-agent-agent': new AgentNode(),
    'node-agent-debug': new DebugNode(),
    'node-agent-search': new DeepSeekSearchNode(),
    'node-agent-notes': new NotesNode(),
    'node-agent-mindmap': new MindMapNode(),
    '@node-agent/shell': new ShellNode(),
    'node-agent-store': new StoreNode(),
    'node-agent-timer': new TimerNode(),
    'node-agent-todo': new TodoNode(),
  };
  for (const [name, node] of Object.entries(nodes)) {
    const icon = node.schemas.ui?.icon;
    assert.equal(typeof icon, 'string', `${name} hands over a drawing with its ui schema`);
    assert.match(String(icon).trim(), /^<svg\s/, `${name} hands over a whole <svg>`);
    assert.equal(
      String(icon).trim(),
      drawing(name),
      `${name} hands over the drawing in its own package`,
    );
  }
});

// The Python twins: they run the same node from the other stack, so they read the same drawing beside
// the same page instead of keeping a second copy that can drift. Their own suites check the value;
// this pins that the picture is the package's file and not a string written into the schema.
test('test_the_python_nodes_take_their_drawing_from_the_package_too', () => {
  for (const [name, path] of [
    ['node-agent-agent', 'python/node_agent_agent/ui.py'],
  ]) {
    const source = readFileSync(new URL(`${name}/${path}`, ROOT), 'utf8');
    assert.match(source, /def icon\(\)/, `${name}'s python side reads icon() from the package`);
    assert.match(source, /with_name\("icon\.svg"\)/, `${name} reads the file beside the page`);
  }
});

//: A stub bus for the page: the shell asks /panels for its tabs and keeps one /events stream. The
//: icons are the point — one real drawing, three strings that must not become drawings.
function stubBus(html, panels) {
  const server = createServer((req, res) => {
    if (serveEventAssets(req, res)) return;
    const url = req.url ?? '/';
    if (url === '/panels') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ panels }));
      return;
    }
    if (url.startsWith('/events')) {
      // An open stream is what a real bus hands over, and the shell never has to hear from it.
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': open\n\n');
      return;
    }
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end('');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })),
  );
}

test('test_the_shell_draws_the_drawing_it_is_given_and_nothing_that_runs', async (t) => {
  const chrome = chromePath();
  if (!chrome) return t.skip('no browser on this machine to run the page in');

  const panels = [
    {
      node: 'drawn',
      desc: 'a node that brought its own drawing',
      slot: 'left',
      icon: drawing('node-agent-todo'),
    },
    // A drawing with anything that runs in it is no drawing: the tab draws nothing rather than
    // handing the string to `innerHTML` and hoping.
    {
      node: 'scripted',
      desc: 'a drawing with a script inside',
      slot: 'right',
      icon: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    },
    {
      node: 'linked',
      desc: 'a drawing that links to script',
      slot: 'right',
      icon: '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><path d="M4 4h9"/></a></svg>',
    },
    {
      node: 'handled',
      desc: 'a drawing with an event handler',
      slot: 'right',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M4 4h9"/></svg>',
    },
    { node: 'bare', desc: 'a node that brought nothing', slot: 'right' },
  ];

  const html = readFileSync(new URL('webui/src/webui.html', ROOT), 'utf8');
  const { server, port } = await stubBus(html, panels);
  const { chrome: running, page } = await startChrome(chrome);
  const { send, close } = await openPage(page.webSocketDebuggerUrl);

  try {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    // The page asks /panels and paints the tabs from the answer, so one moment has to pass.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const expression = `JSON.stringify((() => ({
      icons: document.querySelectorAll('.ico').length,
      // The tab strips only: .sides is the phone's column switch, not a node's tab.
      tabs: [...document.querySelectorAll('#pinned-nav button, #nav button')].map((button) => {
        // The drawing is an <img> over a data: URL, so its shapes are counted after decoding it —
        // and no svg element in the tab is what says the drawing itself is not in the document.
        const picture = button.querySelector('.ico img');
        const source = picture ? atob(picture.src.slice(picture.src.indexOf(',') + 1)) : '';
        return {
          name: button.textContent.trim(),
          drawn: picture !== null,
          inlined: button.querySelector('.ico svg') !== null,
          shapes: (source.match(/<(path|circle|rect|line|polyline)\\b/g) ?? []).length,
        };
      }),
    }))())`;
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (reply.result?.exceptionDetails) {
      throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 400));
    }
    const seen = JSON.parse(reply.result.result.value);

    // Four bad strings, one good one: exactly one glyph, and it is the node that brought it.
    assert.equal(seen.icons, 1, 'only the real drawing is drawn');
    assert.deepEqual(
      seen.tabs.map((tab) => tab.name),
      panels.map((panel) => panel.node),
      'a tab with no drawing is still a tab: every name is there',
    );
    const drawn = seen.tabs.filter((tab) => tab.drawn);
    assert.deepEqual(
      drawn.map((tab) => tab.name),
      ['drawn'],
      "the drawing is the node's own, and nothing that runs gets drawn",
    );
    assert.ok(drawn[0].shapes > 0, 'the drawing keeps its shapes, not just its wrapper');
    assert.equal(
      seen.tabs.filter((tab) => tab.inlined).length,
      0,
      'no drawing is inlined into the shell\'s own document — an <img> is what runs nothing',
    );
  } finally {
    close();
    running.kill();
    server.close();
  }
});
