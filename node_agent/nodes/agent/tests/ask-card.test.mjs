// The ask card's options are sentences the model wrote, and one of them is easily longer than the card
// it sits in — a thirty-character Chinese choice was 405px wide in a 327px row and the card's overflow
// cut the words off. Whether a label wraps inside its button cannot be read off the stylesheet: it
// depends on how a real engine gives a flex item its width. So the card's own markup is laid out by
// headless Chrome in a frame the size of the webui's (an iframe reads media queries off its own box,
// exactly like the frame the page is drawn in) and measured. A machine with no browser has nothing to
// measure with, and the test says so instead of passing quietly.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

//: The page the browser is handed, built by `npm run build`: the stylesheet measured here is served.
const HTML = readFileSync(new URL('../dist/ui.html', import.meta.url), 'utf8');

//: The page's own stylesheet, so the card is styled by the page itself and not by a copy of its rules.
const STYLE = HTML.slice(HTML.indexOf('<style>') + '<style>'.length, HTML.indexOf('</style>'));

//: The browser to measure with: this machine's Chrome for Testing, or whatever CHROME_PATH names.
const CHROME = process.env.CHROME_PATH ?? '/tmp/chrome/chrome-linux64/chrome';

//: Why these tests are skipped here, or `false` when there is a browser to measure with.
const noChrome = existsSync(CHROME) ? false : `no browser to measure with: set CHROME_PATH (tried ${CHROME})`;

//: The frames the webui hands the agent page: the 400x640 frame the bug was found in, and a phone's
//: narrower one. Both are inside the phone media query, which is where the card has least width.
const FRAMES = [{ width: 400, height: 640 }, { width: 360, height: 740 }];

//: A label of the length that broke the card: thirty CJK characters, which break between characters.
const LONG = '先把今天所有的会议纪要整理成一份摘要然后发到我的邮箱里面去';

//: A label with no space in it at all: only `overflow-wrap` keeps this one inside the card.
const PATH = 'https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all/index.html';

/** The card `askCard` draws for a question nobody has answered yet, in the shapes the page gives it. */
const card = (labels) => [
  '<article class="ask">',
  '<div class="ask-badge">Waiting for your answer</div>',
  '<h4 class="ask-title">Which way should I go?</h4>',
  '<div class="ask-body plain">Pick one, or type your own.</div>',
  '<div class="ask-choices">',
  ...labels.map((label) => `<button class="ask-choice" type="button">${label}</button>`),
  '</div>',
  '</article>',
].join('');

/** The page that carries the card: the real stylesheet and the real markup, inside <body> and <main>, the
 *  two boxes the card is a child of on the page. */
const inner = (labels) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${STYLE}</style></head><body><main id="log">${card(labels)}</main></body></html>`;

/** A page that puts that card in a frame of this size and writes what the browser measured into a
 *  `<pre>`, which `--dump-dom` hands back: the frame's own numbers, not a guess about them. */
const harness = ({ width, height }, labels) => `<!doctype html><html><head><meta charset="utf-8">
<style>html, body { margin: 0 }</style></head><body>
<iframe id="frame" width="${width}" height="${height}" style="border: 0"></iframe><pre id="out"></pre>
<script>
const frame = document.getElementById('frame');
frame.addEventListener('load', () => {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  const round = (value) => Math.round(value * 10) / 10;
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: round(rect.left), right: round(rect.right), top: round(rect.top), bottom: round(rect.bottom),
      width: round(rect.width), height: round(rect.height),
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    };
  };
  const row = doc.querySelector('.ask-choices');
  const report = {
    viewport: { width: win.innerWidth, height: win.innerHeight },
    card: box(doc.querySelector('.ask')),
    row: box(row),
    choices: [...row.children].map((button) => ({ text: button.textContent, ...box(button) })),
  };
  document.getElementById('out').textContent = 'MEASURED ' + JSON.stringify(report);
});
frame.srcdoc = ${JSON.stringify(inner(labels)).replace(/</g, '\\u003c')};
</script></body></html>`;

/** What the browser measured for a card of these options in a frame of this size. */
function measure(frame, labels) {
  const folder = mkdtempSync(join(tmpdir(), 'ask-card-'));
  try {
    const file = join(folder, 'frame.html');
    writeFileSync(file, harness(frame, labels));
    const dom = execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--allow-file-access-from-files', '--window-size=1200,900', '--virtual-time-budget=2000',
      '--dump-dom', `file://${file}`,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const line = dom.split('\n').find((each) => each.includes('MEASURED '));
    assert.ok(line, 'the browser reported what it laid out');
    const json = line.slice(line.indexOf('MEASURED ') + 'MEASURED '.length, line.indexOf('</pre>'))
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return JSON.parse(json);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The same number, rounded to a tenth, so a sub-pixel difference is not a failure. */
const tenth = (value) => Math.round(value * 10) / 10;

// Two things have to hold at once for a long option: the label takes the row it has and wraps inside it,
// and the button grows taller to hold what wrapped. Neither is allowed to hide the label, and the two
// short options around it keep their own line, their own height and the 8px between them.
test('an option longer than its row wraps inside the card, and the button grows to hold it', { skip: noChrome }, () => {
  for (const frame of FRAMES) {
    const page = measure(frame, [LONG, 'short one', 'Ok']);
    const where = `${frame.width}x${frame.height}`;
    const [long, ...short] = page.choices;

    assert.equal(page.viewport.width, frame.width, `${where}: the frame is the box the page asked for`);
    assert.equal(page.card.scrollWidth, page.card.clientWidth, `${where}: the card cuts nothing off`);
    assert.equal(page.row.scrollWidth, page.row.clientWidth, `${where}: nor does the row of options`);
    assert.ok(long.right <= page.card.right + 0.5,
      `${where}: the long option ends inside the card (${long.right} <= ${page.card.right})`);
    assert.ok(long.width <= page.row.width + 0.5,
      `${where}: and is no wider than the row it wraps in (${long.width} <= ${page.row.width})`);
    assert.ok(long.height > short[0].height,
      `${where}: the wrapped label makes a taller button (${long.height} > ${short[0].height})`);
    assert.ok(short[0].top >= long.bottom - 0.5, `${where}: the long option took a line of its own`);
    assert.ok(short.every((each) => Math.abs(each.top - short[0].top) < 0.5),
      `${where}: the short options still share a line`);
    assert.equal(tenth(short[1].left - short[0].right), 8, `${where}: and keep the 8px between them`);
  }
});

// `overflow-wrap` is the half of the fix CJK would hide: a path has no space to break at, so this one only
// fits while the stylesheet breaks a run anywhere.
test('a label with no space in it still breaks inside the card', { skip: noChrome }, () => {
  const page = measure(FRAMES[0], [PATH, 'Ok']);
  const [path, ok] = page.choices;

  assert.equal(page.card.scrollWidth, page.card.clientWidth, 'the card cuts nothing off');
  assert.ok(path.right <= page.card.right + 0.5, 'the path ends inside the card');
  assert.ok(path.height > ok.height, `and takes more than one line (${path.height} > ${ok.height})`);
});
