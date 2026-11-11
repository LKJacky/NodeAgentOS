// The shell is the one page the webui draws itself, and three things there are easy to lose in a
// refactor and impossible to notice until it is in a hand: the favicon (a blank tab), the drawing a
// node hands over for its tab (the shell keeps no pictures of its own, so nothing else can supply
// one), and a tab that stays a name instead of growing a second line of prose. It reads src/ on
// purpose — `npm run build` copies the page to dist/, and a page built without it hands the browser
// the old one.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

//: The repository root, three levels up from webui/tests/.
const ROOT = new URL('../../../', import.meta.url);

//: The page the shell serves, in the place the build copies it from.
const SHELL = new URL('node_agent/nodes/webui/src/webui.html', ROOT);

const page = () => readFileSync(SHELL, 'utf8');

/** One glyph box: 16px twice over, and never left to the flex row to size — a drawing allowed to
 *  shrink is squashed the moment the name beside it grows. */
function assertGlyphBox(html, selector) {
  const start = html.indexOf(`${selector} {`);
  assert.ok(start > 0, `${selector} has a rule of its own`);
  const rule = html.slice(start, html.indexOf('}', start));
  for (const line of ['width: 16px;', 'height: 16px;', 'flex: none;']) {
    assert.ok(rule.includes(line), `${selector} keeps ${line}`);
  }
}

test('test_the_shell_names_an_inline_favicon', () => {
  const html = page();
  const head = html.slice(0, html.indexOf('</head>'));
  // A data URI and not a file: nothing to fetch, nothing to lose offline, nothing binary in the repo.
  const icon = head.match(/<link\s+rel="icon"\s+href="data:image\/svg\+xml,([^"]+)"/);
  assert.ok(icon, 'the head has to carry <link rel="icon" href="data:image/svg+xml,…">');
  // Decoded, it has to be a real drawing in the same 24-unit box the pages draw in: a link the
  // browser cannot parse leaves the tab exactly as blank as having no link at all.
  const drawing = decodeURIComponent(icon[1]);
  assert.match(
    drawing,
    /^<svg [^>]*viewBox='0 0 24 24'/,
    "the favicon is an svg in the pages' box",
  );
  assert.match(drawing, /<circle |<path /, 'and it has something to draw');
});

test('test_the_shell_draws_what_it_is_handed_and_keeps_no_pictures_itself', () => {
  const html = page();

  // The direction of this page: a node brings its own `<svg>` and the shell draws it. A drawing table
  // here — a name mapped to a picture — would be the same centralisation back again, and a node whose
  // word was not in the table would silently lose its tab. So: no table, and not one shape on the page
  // itself (the favicon is a data URI, encoded, and stays out of this check).
  assert.doesNotMatch(html, /GLYPHS/);
  assert.doesNotMatch(html, /<(path|circle|rect|line|polyline)\b/);

  // What arrives in `panel.icon` came off the wire, and it is going into the shell's own document, so
  // the shape is checked rather than trusted: an `<svg>` and nothing in it that runs. (What that
  // guard does with a hostile string is checked for real in icon.test.mjs, in a browser.)
  assert.match(html, /const IS_SVG = \/\^<svg\[\\s>\]\/;/);
  assert.match(html, /if \(!IS_SVG\.test\(svg\) \|\| RUNS\.test\(svg\)\) return null;/);
  const guard = html.slice(
    html.indexOf('const RUNS ='),
    html.indexOf('\n', html.indexOf('const RUNS =')),
  );
  for (const refused of ['<script', 'javascript:'])
    assert.ok(guard.includes(refused), `the guard has to refuse ${refused}`);

  // The drawing goes in as an <img> over a data: URL, and never through `innerHTML`: an inlined SVG
  // is part of this document and one that runs is a script with the page's own rights, while an
  // <img> draws and runs nothing (icon.test.mjs proves it in a browser).
  assert.match(html, /picture\.src = dataUrl\(svg\);/);
  assert.match(html, /return 'data:image\/svg\+xml;base64,' \+ btoa\(binary\);/);
  assert.doesNotMatch(html, /\.innerHTML = svg/, 'the node\'s string never reaches innerHTML');

  // And a node that hands over nothing (or something that is not a drawing) draws nothing — no
  // stand-in, because a generic picture would claim a drawing that node never made.
  assert.match(
    html,
    /const drawing = glyph\(panel\.icon\);\n\s+if \(drawing\) label\.append\(drawing\);/,
  );
  assert.doesNotMatch(html, /GLYPHS\.page|\?\?\s*\.ico/);

  // 16px both ways: the label is a flex row inside a phone's 44px tab, where a drawing given only a
  // width is squashed by its neighbours instead of keeping its shape. The drawing is an <img>, which
  // is what keeps the SVG out of this document — see the checks above.
  assertGlyphBox(html, '.tab .ico');
  assertGlyphBox(html, '.tab .ico img');
  assert.doesNotMatch(html, /.tab \.ico svg \{/, 'the drawing is no longer an inline svg');
});

test('test_a_tab_is_a_glyph_and_a_name_not_a_sentence', () => {
  const html = page();
  // What the node says its page is for is kept — as the tab's hover title, not as an 11px second
  // line that doubles the height of every tab in the strip.
  assert.match(html, /tab\.title = panel\.desc/);
  assert.doesNotMatch(html, /sub\.textContent = panel\.desc/);
  assert.doesNotMatch(html, /.tab span \{/, 'the second-line rule has no reader left');
});

// The webui reads `./webui.html` next to its own compiled file, so a running node serves
// dist/webui.html while this suite reads src/: a build that has not been re-run hands the browser
// the old page.
test('test_the_served_copy_is_the_page_in_src', (t) => {
  const built = new URL('node_agent/nodes/webui/dist/webui.html', ROOT);
  if (!existsSync(built)) return t.skip('dist/ is only there after `npm run build`');
  assert.equal(
    readFileSync(built, 'utf8'),
    page(),
    'run `npm run build`: the page in dist/ is copied from src/, not compiled',
  );
});
