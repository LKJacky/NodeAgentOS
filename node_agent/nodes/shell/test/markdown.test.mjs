// The markdown renderer the Files tab reads a `.md` file with. It is part of the page — the page
// carries its own CSS, its own highlighter and now its own renderer, so nothing is fetched and no
// dependency is added — which is why the test lifts the marked region out of src/ui.html and runs it
// the way the browser does. What it pins down is the two promises the page makes: the file is text
// on the screen and never markup, and a link is only a link when the browser would read it as
// http(s), mailto or a path relative to the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

//: The page as it is served — tests read src/ on purpose (README.md, "Mobile").
const PAGE = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');

const START = '// #region markdown';
const END = '// #endregion markdown';
const FROM = PAGE.indexOf(START);
const TO = PAGE.indexOf(END);
assert.ok(FROM !== -1 && TO > FROM, 'the page marks its renderer with the region markers');

const BLOCK = PAGE.slice(FROM + START.length, TO);
const { renderMarkdown, escapeHtml, safeUrl, isMarkdown } = new Function(
  `${BLOCK}\nreturn { renderMarkdown, escapeHtml, safeUrl, isMarkdown };`,
)();

/** Every tag the renderer is allowed to write — the whole of its vocabulary. */
const OURS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr', 'strong', 'em', 'code', 'pre', 'a', 'span',
  'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

/** Assert that a rendered file holds no tag but the renderer's own, and no stray angle bracket: an
 *  escaped file shows its `<` as `&lt;`, so anything left that looks like a tag is one this renderer
 *  wrote. That is the whole safety claim in one assertion. */
function onlyOurTags(html, where) {
  const rest = String(html).replace(/<\/?([a-zA-Z][\w-]*)((?:\s[^<>]*)?)>/g, (whole, name) => {
    assert.ok(OURS.has(name.toLowerCase()), `${where}: a <${name}> came out of the renderer`);
    return '';
  });
  assert.ok(!rest.includes('<') && !rest.includes('>'), `${where}: a bare angle bracket stayed: ${rest.slice(0, 200)}`);
  return String(html);
}

//: Things a file can contain and a page must survive. Each is rendered on its own below.
const NASTY = [
  '<script>window.pwned = 1</script>',
  '<img src=x onerror="window.pwned = 1">',
  '<iframe src="https://example.com"></iframe>',
  '<a href="javascript:window.pwned=1">x</a>',
  '<svg onload=window.pwned=1>',
  '</p><script>x</script><p>',
  '<style>body{display:none}</style>',
  '<!-- comment -->',
  '<div onmouseover="x">',
];

// --- What the file says, and never what it claims to be ------------------------------------

test('a script tag in a file is characters on the screen, not markup', () => {
  for (const nasty of NASTY) {
    const html = onlyOurTags(renderMarkdown(nasty), nasty);
    assert.ok(!/<script|<iframe|<img|<svg|<style|<div|<a /i.test(html), `${nasty}: nothing survived as a tag`);
  }

  const escaped = renderMarkdown('<script>window.pwned = 1</script>');
  assert.match(escaped, /&lt;script&gt;/, 'the tag is on the screen as its own text');
  assert.match(escaped, /&lt;\/script&gt;/);

  // Inside a fence, in a heading, in a list item: escaping happens before any block rule looks.
  for (const source of ['```\n<script>x</script>\n```', '# <script>x</script>', '- <script>x</script>', '> <script>x</script>']) {
    assert.doesNotMatch(onlyOurTags(renderMarkdown(source), source), /<script/i, source);
  }

  assert.equal(escapeHtml('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
  onlyOurTags(renderMarkdown(NASTY.join('\n\n')), 'all of it at once');
});

// --- A link is a link only when the browser would read it as one ----------------------------

test('a javascript: link is refused, and only http(s), mailto or a relative path is followed', () => {
  const refused = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'javascript&colon;alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:msgbox(1)',
    '//evil.example.com/x',
    '\\\\evil.example.com\\x',
    'java\tscript:alert(1)',
  ];
  for (const target of refused) {
    assert.equal(safeUrl(target), null, `${target} is not a link this page follows`);
    const html = onlyOurTags(renderMarkdown(`[click](${target})`), target);
    assert.doesNotMatch(html, /<a /i, `${target} must not become an anchor`);
    assert.match(html, /click/, 'the words stay on the screen');
  }

  // A target is judged after the escapes in it are read back, so the entity form of a colon is the
  // colon: it is refused as a scheme, and what comes out is inert text either way.
  const entity = onlyOurTags(renderMarkdown(String.fromCharCode(91)+"click](javascript&#58;alert(1))"), "entity colon");
  assert.doesNotMatch(entity, /<a /i, "no anchor for an entity-written scheme");
  assert.doesNotMatch(entity, /<script/i);

  // The forms that are followed, each one through the renderer.
  assert.equal(safeUrl("mailto:" + "me@example.com"), "mailto:" + "me@example.com");
  const followed = [
    ["[x](https://example.com/a?b=1)", "https://example.com/a?b=1"],
    ["[x](./rel/file.md)", "./rel/file.md"],
    ["[x](#anchor)", "#anchor"],
  ];
  for (const [source, href] of followed) {
    const html = onlyOurTags(renderMarkdown(source), source);
    assert.match(html, /<a /, `${source} is a link`);
    assert.ok(html.includes(`href="${href}"`), `${source} carries ${href}: ${html}`);
    assert.match(html, /rel="noopener noreferrer"/, 'a followed link opens alone');
  }

  // `<https://…>` is a link because the brackets say so.
  assert.match(onlyOurTags(renderMarkdown('<https://example.com/x>'), 'autolink'), /<a href="https:\/\/example\.com\/x"/);
});

// --- The blocks a reader of a readme expects -------------------------------------------------

test('headings, fences, lists, quotes, rules and tables render as the tags they stand for', () => {
  assert.equal(renderMarkdown('# Title'), '<h1>Title</h1>');
  assert.equal(renderMarkdown('### Deep ###'), '<h3>Deep</h3>');
  assert.equal(renderMarkdown('###### six'), '<h6>six</h6>');
  assert.equal(renderMarkdown('####### seven'), '<p>####### seven</p>', 'seven hashes is a paragraph');

  // A fence: the language rides along, the body is code and nothing else.
  assert.equal(
    renderMarkdown('```js\nconst a = 1 < 2;\n```'),
    '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>',
  );
  assert.equal(
    renderMarkdown('```\n# not a heading\n*not emphasis*\n```'),
    '<pre><code># not a heading\n*not emphasis*</code></pre>',
    'nothing inside a fence is read as markdown',
  );
  assert.equal(renderMarkdown('~~~\ntilde\n~~~'), '<pre><code>tilde</code></pre>');

  // Lists: flat, nested, and numbered from where the file says.
  assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(
    renderMarkdown('- one\n  - inner\n- two'),
    '<ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul>',
  );
  assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(renderMarkdown('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');

  // Quotes, rules, tables — and the table's colons are the alignment.
  assert.equal(renderMarkdown('> quoted'), '<blockquote><p>quoted</p></blockquote>');
  assert.equal(renderMarkdown('---'), '<hr>');
  assert.equal(renderMarkdown('***'), '<hr>');
  assert.equal(
    renderMarkdown('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |'),
    '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th><th style="text-align:right">c</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:center">2</td><td style="text-align:right">3</td></tr></tbody></table>',
  );
  assert.equal(renderMarkdown('| a |\n| nope |'), '<p>| a |\n| nope |</p>', 'no dashes, no table');

  // Prose: one paragraph for consecutive lines, a hard break where the file asks for one.
  assert.equal(renderMarkdown('one\ntwo'), '<p>one\ntwo</p>');
  assert.equal(renderMarkdown('one  \ntwo'), '<p>one<br>\ntwo</p>');
  assert.equal(renderMarkdown('one\n\ntwo'), '<p>one</p>\n<p>two</p>');
});

test('emphasis, inline code and text keep their characters', () => {
  assert.equal(renderMarkdown('**bold**'), '<p><strong>bold</strong></p>');
  assert.equal(renderMarkdown('__bold__'), '<p><strong>bold</strong></p>');
  assert.equal(renderMarkdown('*it*'), '<p><em>it</em></p>');
  assert.equal(renderMarkdown('_it_'), '<p><em>it</em></p>');
  assert.equal(renderMarkdown('`a * b`'), '<p><code>a * b</code></p>', 'a star in code is a character');
  assert.equal(renderMarkdown('a < b & c > d'), '<p>a &lt; b &amp; c &gt; d</p>');
  assert.equal(renderMarkdown('**a `b` c**'), '<p><strong>a <code>b</code> c</strong></p>');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('\r\n# Windows\r\n'), '<h1>Windows</h1>', 'CRLF is a line ending too');
});

// --- Which files get the switch at all -------------------------------------------------------

test('only .md and .markdown are markdown', () => {
  for (const path of ['note.md', 'README.MD', 'a/b/doc.markdown', 'x.MarkDown']) assert.equal(isMarkdown(path), true, path);
  for (const path of ['hello.ts', 'notes.txt', 'a.md.txt', 'dir.md/x', 'md', 'x.md/']) assert.equal(isMarkdown(path), false, path);
});
