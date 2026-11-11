// Every page the browser front end can hand to a phone carries the same mobile scaffolding, and every
// page the shell can put in a frame carries the same framed shape. These are the loose checks that
// both are still there: a page fits a phone only while its meta, its media query and its safe-area
// padding are present, and it fills its frame only while it asks for the frame's box rather than the
// window's. A page that loses either breaks silently in a hand, not here. It reads src/ on purpose —
// `npm run build` copies the pages to dist/.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

//: The repository root, three levels up from webui/tests/.
const ROOT = new URL('../../../', import.meta.url);

//: Every page that can be served inside the webui shell's frame, i.e. every page there is. A page born
//: without the framed shape (the inline `self !== top` mark, `html, body { height: 100% }` and the
//: `:root.framed` rule that overrides the phone block) belongs on this list, with the shape copied in
//: — see "Mobile" in README.md. The webui page itself is on it too: it is the shell, and a page.
const PAGES = [
  'agent/src/ui.html',
  'node-agent-nodes/src/ui.html',
  'node-agent-debug/src/ui.html',
  'node-agent-search/src/ui.html',
  'node-agent-notes/src/ui.html',
  'node-agent-mindmap/src/ui.html',
  '@node-agent/shell/src/ui.html',
  'store/src/ui.html',
  'node-agent-timer/src/ui.html',
  'node-agent-todo/src/ui.html',
  'webui/src/webui.html',
];

//: A page that deliberately never runs on a phone goes here, with the reason, and the recipe is not
//: required of it. Today there is none: every page the shell serves is one the user opens in a hand.
const NO_PHONE_RECIPE = new Set([
  // An authoring surface for people writing their own nodes: opened at a desk, not in a hand. The
  // framed shape it does carry keeps it usable inside the shell's iframe.
  'node-agent-nodes/src/ui.html',
]);

//: The pages that exist on disk, so a page that merges later cannot slip past this file unnoticed.
const ON_DISK = [
  ...readdirSync(new URL('packages', ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('node-agent-'))
    .map((entry) => `${entry.name}/src/ui.html`)
    .filter((path) => {
      try {
        readFileSync(new URL(path, ROOT));
        return true;
      } catch {
        return false;
      }
    }),
  'webui/src/webui.html',
];

// The list is what a merged page lands on; this fails until someone gives it the shape and adds it,
// which is the point — the recipe is copied by hand into every page, so the gate has to say where.
test('test_every_page_on_disk_carries_the_framed_shape', () => {
  assert.deepEqual(
    [...ON_DISK].sort(),
    [...PAGES].sort(),
    'a page that merged later has to be given the framed shape and listed in PAGES',
  );
});

for (const path of PAGES) {
  const name = path.split('/')[1];

  // Every page is handed out twice: raw as /panel/<node>, and inside the webui shell's iframe. The
  // second one is where a window-sized height goes wrong — a page that asks for the window is taller
  // than the frame it was given.
  test(`test_the_page_${name}_fills_the_box_it_is_given`, () => {
    const html = readFileSync(new URL(path, ROOT), 'utf8');
    // The class is set in the head, before <style>, so nothing is ever laid out at the wrong height.
    assert.match(html, /if \(self !== top\) document\.documentElement\.classList\.add\('framed'\)/);
    assert.ok(
      html.indexOf("classList.add('framed')") < html.indexOf('<style>'),
      'the framed class has to be set before the stylesheet is parsed',
    );
    // 100% follows the initial containing block, which is the frame's box inside the shell…
    assert.match(html, /html,\s*body\s*\{[^}]*height:\s*100%/);
    // …and the base body rule must not ask for the window.
    assert.doesNotMatch(html, /body\s*\{[^}]*height:\s*100vh/);
    // In a frame the box wins at every width: the framed rule sits AFTER the phone block, so the
    // `100dvh` in there cannot reach a framed page, and it is 100% of the iframe's box. (`min-height:
    // 0` is required of the page further down; `store` keeps it on its scrolling child rather than in
    // this rule, and either shape is fine as long as the rule that overrides the phone block is here.)
    assert.match(html, /:root\.framed [^{]+\{[^}]*height:\s*100%/);
    const phoneBlock = html.indexOf('@media (max-width: 640px)');
    // The rule itself, not the first mention of its name: a comment may well name it (the one in
    // `todo` does, to say what the block below is for).
    const framedRule = html.search(/:root\.framed[^{}]*\{/);
    assert.ok(framedRule > phoneBlock, 'the framed rules have to override the phone block');
    // The pin against a window-sized page coming back: every viewport height in the file has to sit
    // inside the phone block (where it means the phone's own screen) and BEFORE the framed rule that
    // overrides it. A `100dvh` anywhere else — or after it — is a framed page asking for the window.
    for (const match of html.matchAll(/height:\s*100(?:d|s|l)?vh/g)) {
      assert.ok(
        match.index > phoneBlock,
        'a viewport height outside the phone block is a window-sized page',
      );
      assert.ok(
        match.index < framedRule,
        'a viewport height after the framed rule would win inside a frame',
      );
    }
    // A scrolling flex child with the default `min-height:auto` refuses to shrink and pushes the
    // input off the bottom instead of scrolling: the pages that scroll in place all say so.
    assert.match(html, /min-height:\s*0/);
  });

  if (NO_PHONE_RECIPE.has(path)) continue;

  test(`test_the_page_${name}_carries_the_mobile_scaffolding`, () => {
    const html = readFileSync(new URL(path, ROOT), 'utf8');
    // viewport-fit=cover is what lets a page use the notch's pixels and see env(safe-area-inset-*).
    assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
    // One breakpoint for a phone, matched by height too so a phone held sideways is included.
    assert.match(
      html,
      /@media \(max-width: 640px\), \(orientation: landscape\) and \(max-height: 480px\)/,
    );
    // The bottom input has to clear the home indicator…
    assert.match(html, /env\(safe-area-inset-bottom\)/);
    // …and a collapsing URL bar must not crop it. (The framed shape above is what keeps that unit
    // away from a page inside a frame.)
    assert.match(html, /100dvh/);
    // 44px is the smallest target a thumb hits reliably, so at least one rule has to say so.
    assert.match(html, /44px/);
    // The phone block has to come LAST among the width breakpoints, or a wider one written after it
    // wins on the phone again — the failure is invisible until someone opens it in a hand.
    const widths = [...html.matchAll(/@media \(max-width: (\d+)px\)/g)];
    assert.equal(widths.at(-1)?.[1], '640', 'the 640px mobile block must come last');
  });
}

// The agent page is the one with a growing input and a scrolling transcript, so its height chain is
// pinned by name: the two faults that were actually seen in a hand were a 140px input inside a 213px
// frame and a single `nowrap` label forcing the whole page wider than the phone.
test('test_the_agent_page_grows_its_input_within_the_box_it_has', () => {
  const html = readFileSync(new URL('agent/src/ui.html', ROOT), 'utf8');
  assert.match(
    html,
    /max-height:\s*min\(140px,\s*30dvh\)/,
    'the input is capped by the box, not by a fixed 140px',
  );
  assert.match(
    html,
    /\.usage-counts\s*\{[^}]*flex-wrap:\s*wrap/,
    'the token counts have to be allowed to wrap on a phone',
  );
  assert.match(
    html,
    /\.usage-counts\s*\{[^}]*min-width:\s*0/,
    'the group gives way to the provider switch instead of widening the page',
  );
  assert.match(
    html,
    /main \{[^}]*min-height:\s*0/s,
    'the transcript scrolls instead of pushing the composer out',
  );
  // The inline height is a measurement of one moment: it has to be capped by the stylesheet's own
  // cap (read as the px it is now) and cleared when the box is empty, or a change of width leaves a
  // box taller (blank space inside it) or shorter (a scrollbar) than its text until the next key.
  assert.match(
    html,
    /getComputedStyle\(box\)\.maxHeight/,
    'the inline height has to respect the stylesheet cap',
  );
  assert.match(
    html,
    /Math\.min\(box\.scrollHeight, cap\)/,
    'and it is capped, never a bare scrollHeight',
  );
  assert.match(html, /box\.style\.height = ''/, 'an empty box leaves no inline height behind');
  // And it is measured again when the box the page is drawn in changes: rotate, keyboard, URL bar.
  assert.match(html, /window\.addEventListener\('resize', regrowBoxes\)/);
  assert.match(html, /window\.addEventListener\('orientationchange', regrowBoxes\)/);
  assert.match(html, /visualViewport[^\n]*addEventListener\('resize', regrowBoxes\)/);
});

// The bytes the browser is actually handed: the node reads dist/ui.html in (with markdown-it inlined
// by the build), so a broken copy there would be broken in the hand no matter what src/ says.
// `npm run build` runs before the tests in the repo's gate, the same way page.test.mjs needs it.
test('test_the_served_agent_page_carries_the_loading_context_rules', () => {
  const served = readFileSync(new URL('agent/dist/ui.html', ROOT), 'utf8');
  assert.match(served, /if \(self !== top\) document\.documentElement\.classList\.add\('framed'\)/);
  assert.match(served, /html,\s*body\s*\{[^}]*height:\s*100%/);
  assert.match(served, /:root\.framed body\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/s);
  assert.match(
    served,
    /@media \(max-width: 640px\), \(orientation: landscape\) and \(max-height: 480px\)/,
  );
  assert.match(served, /max-height:\s*min\(140px,\s*30dvh\)/);
  assert.match(served, /getComputedStyle\(box\)\.maxHeight/);
  assert.match(served, /window\.addEventListener\('resize', regrowBoxes\)/);
  assert.match(served, /visualViewport[^\n]*addEventListener\('resize', regrowBoxes\)/);
});
