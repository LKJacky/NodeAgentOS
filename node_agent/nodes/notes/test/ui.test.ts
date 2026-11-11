import assert from 'node:assert/strict';
import test from 'node:test';
import { pageOf } from './support.ts';

test('notes page listens only to its injected node topic', async () => {
  const page = await pageOf();

  assert.equal(typeof page, 'string');
  assert.match(page as string, /const INJECTED = "notes";/);
  assert.equal((page as string).includes('__NODE__'), false);
  assert.match(
    page as string,
    /window\.NodeAgentEvents\.connect\('\/events\?topic=' \+ encodeURIComponent\(NODE\)\)/,
  );
  assert.doesNotMatch(page as string, /events\?topic=notes/);
});

test('the page calls itself Notes and still reads the drafts of the old memory page', async () => {
  const page = (await pageOf()) as string;

  assert.match(page, /<title data-text-key="title">Notes · node_agent<\/title>/);
  assert.match(page, /const DRAFT = `notes\.draft\.\$\{NODE\}`;/, 'drafts are written here');
  assert.match(page, /'memory\.draft\.memory'/, 'and the old keys are still read');
  assert.match(page, /'memory\.open\.memory'/);
});

/** The body of one CSS rule, as the page writes it. */
function ruleBody(page: string, selector: string): string {
  const at = page.indexOf(`${selector} {`);
  assert.ok(at >= 0, `the page has no \`${selector}\` rule`);
  const open = page.indexOf('{', at);
  return page.slice(open + 1, page.indexOf('}', open));
}

/** The tracks of a grid template: `minmax(0, 1fr)` is one of them, not two. */
function tracks(value: string): string[] {
  return value
    .replace(/\([^()]*\)/g, 'T')
    .trim()
    .split(/\s+/)
    .filter((each) => each !== '');
}

test('the library and the editor sit side by side, the list on the left', async () => {
  const page = (await pageOf()) as string;

  assert.match(page, /<section class="panel editor"/);
  assert.match(page, /<section class="panel library"/);
  assert.ok(
    page.indexOf('<section class="panel library"') < page.indexOf('<section class="panel editor"'),
    'the left pane is also first in the document, so reading and tab order follow the eye',
  );

  const workspace = ruleBody(page, '.workspace');
  const columns = /grid-template-columns:([^;]+);/.exec(workspace)?.[1] ?? '';
  const rows = /grid-template-rows:([^;]+);/.exec(workspace)?.[1] ?? '';
  const areas = /grid-template-areas:([^;]+);/.exec(workspace)?.[1] ?? '';
  assert.equal(tracks(columns).length, 2, 'two columns: the index beside the page');
  assert.equal(tracks(rows).length, 1, 'one row: both panes share the height');
  assert.match(areas, /library editor/, 'the list is the left pane and the memo the right');
});

test('a narrow page keeps one pane and offers the way back', async () => {
  const page = (await pageOf()) as string;

  assert.match(page, /@media \(max-width: 760px\)/);
  assert.match(page, /\.workspace\[data-panel='library'\] \.editor/);
  assert.match(page, /\.workspace\[data-panel='editor'\] \.library/);
  assert.match(page, /id="back"/);
  assert.match(page, /id="newMemo"/);
});

test('the page draws a note as Markdown, with the renderer inside it', async () => {
  const page = (await pageOf()) as string;

  // The node fills the renderer in where it hands the page out: the preview fetches nothing.
  assert.equal(page.includes('/*__MARKDOWN_IT__*/'), false, 'the node filled the renderer in');
  // The one script the page loads is the SDK's browser half for its words, which the shell serves
  // itself; every other asset travels inside the page, so the preview still fetches nothing.
  const sources = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((one) => String(one[1]));
  assert.deepEqual(
    sources,
    ['/webui/events-client.js', '/webui/events-broker.js', '/sdk/i18n-client.js'],
    'nothing but the SDK is fetched',
  );
  assert.match(page, /window\.markdownit\(/);
  assert.match(page, /html: false,/, 'raw HTML stays disabled: a note is text, never markup');

  // The switch, and the pane it swaps the textarea for.
  assert.match(page, /id="previewToggle"/);
  assert.match(page, /aria-pressed="false"/);
  assert.match(page, /<div class="preview markdown" id="preview" hidden><\/div>/);
  assert.match(page, /box\.innerHTML = markdown\.render\(source\)/);
});
