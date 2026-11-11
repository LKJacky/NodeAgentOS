// The two PNG tiles: what the manifest promises, what the build draws, and what the node does when
// nothing could be drawn.
//
// The whole point of the step is that it cannot fail — a machine without a rasterizer is a legitimate
// build — so the tests here are as much about the missing case as about the drawn one. No test asks this
// machine for a real tool: a stub on a PATH of our own is what "has rsvg-convert" looks like, and an
// empty directory is what "has nothing" looks like. The one thing that cannot be stubbed is the bytes a
// real tool would draw, which is the one test that skips here and passes where one is installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SIZES, availableRasterizers, findRasterizer, rasterize } from '../../../scripts/png-icons.mjs';
import { WebuiNode } from '../src/index.ts';

/** The repository root, three levels up from webui/tests/. */
const ROOT = new URL('../../../', import.meta.url);

/** A file where the build copies it to — the bytes a browser is handed. */
const served = (name) => new URL(`webui/dist/${name}`, ROOT);

/** The same file where it is written. */
const source = (name) => new URL(`webui/src/${name}`, ROOT);

/** dist/ is git-ignored and only exists after a build; the tests that need it skip rather than fail, so
 *  nobody mistakes "not built" for "wrong". */
const built = (t) => {
  if (existsSync(served('index.js'))) return true;
  t.skip('dist/ is only there after `npm run build`');
  return false;
};

/** One 1x1 PNG, in base64 so this file stays text: the repository keeps no binaries, stubs included. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** A throwaway directory; the test runner clears it afterwards. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pwa-icons-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A rasterizer that does not exist: a script that reads the `-o`/`--out`/`--screenshot=` argument and
 *  writes the PNG above to it, recording the argv it was handed next to itself. `draw: false` is the
 *  `sips` case — exits 0, draws nothing — which is the one `rasterize` must not be taken in by. */
function stub(dir, name, { draw = true } = {}) {
  const file = join(dir, name);
  const body = [
    `#!${process.execPath}`,
    "const { appendFileSync, writeFileSync } = require('node:fs');",
    'const a = process.argv.slice(2);',
    'const flag = (name) => { const i = a.indexOf(name); return i < 0 ? undefined : a[i + 1]; };',
    'const shot = a.find((arg) => arg.startsWith(\'--screenshot=\'));',
    "const out = shot ? shot.slice('--screenshot='.length) : flag('-o') ?? flag('--out');",
    `appendFileSync(${JSON.stringify(join(dir, 'calls'))}, ${JSON.stringify(name)} + ' ' + a.join(' ') + '\\n');`,
    draw
      ? `writeFileSync(out, Buffer.from(${JSON.stringify(PNG)}, 'base64'));`
      : '// nothing drawn, exactly like sips with an SVG',
  ].join('\n');
  writeFileSync(file, body + '\n', { mode: 0o755 });
  return file;
}

/** Enough of a ServerResponse for the webui's own `send`. */
function answer() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      return this;
    },
    end(body = '') {
      this.body = body;
      return this;
    },
  };
}

/** One request through the real router, on the module the browser is given (dist/). */
async function get(Webui, url) {
  const res = answer();
  await new Webui().onRequest({ method: 'GET', url }, res);
  return res;
}

test('test_the_manifest_names_a_png_of_the_size_it_promises', () => {
  const manifest = JSON.parse(readFileSync(source('manifest.webmanifest'), 'utf8'));
  const pngs = manifest.icons.filter((icon) => icon.type === 'image/png');

  // Two, and they are the two sizes a launcher and a splash screen ask for — a size in the manifest that
  // no file has is a tile that silently does not exist.
  assert.deepEqual(
    pngs.map((icon) => icon.sizes),
    ['192x192', '512x512'],
    'two PNGs, at the sizes the manifest promises',
  );
  for (const icon of pngs) {
    const [width, height] = icon.sizes.split('x');
    assert.equal(width, height, 'a launcher tile is square');
    assert.equal(icon.src, `/icon-${width}.png`, 'the file the build draws carries its size in its name');
  }

  // One drawing serves both purposes: `maskable` only asks that the picture sit inside the middle 60% of
  // the tile, which is what the 0.72 scale in src/icon.svg is for — so the 512 is the maskable one (a
  // cropping platform scales from the biggest it has) and the 192 the plain one, with no second file.
  assert.deepEqual(pngs.map((icon) => icon.purpose), ['any', 'maskable']);
  assert.match(
    readFileSync(source('icon.svg'), 'utf8'),
    /scale\(0\.72\)/,
    'the drawing is padded for the tile a platform crops',
  );

  // The vector stays declared for both purposes, so a build that drew no PNG still says what its tile is.
  assert.equal(manifest.icons.filter((icon) => icon.type === 'image/svg+xml').length, 2);
});

test('test_the_worker_keeps_the_two_tiles_and_adds_nothing_else', () => {
  const shell = /const SHELL = \[([^\]]*)\]/.exec(readFileSync(source('sw.js'), 'utf8'))[1];
  assert.deepEqual(
    shell.split(',').map((path) => path.trim().replaceAll("'", '')),
    ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'],
    'the two tiles, and no widening of what the worker answers for',
  );
});

test('test_the_page_gives_ios_a_png_for_its_tile', () => {
  const html = readFileSync(source('webui.html'), 'utf8');
  assert.match(html, /<link rel="apple-touch-icon"[^>]*href="\/icon-192\.png"[^>]*\/>/);
  // …and it is one of the two the build draws, not a third file nothing makes.
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest" \/>/);
});

test('test_a_build_with_no_rasterizer_warns_and_still_succeeds', (t) => {
  if (!built(t)) return;

  // A PATH with one empty directory in it: no rsvg-convert, no magick, no sips, no browser. This is the
  // machine the step must survive, and it is what the CI of a lean container looks like.
  const bare = scratch(t);
  const run = spawnSync(process.execPath, ['scripts/copy-assets.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: bare, HOME: bare },
  });

  assert.equal(run.status, 0, `the build must not fail over a decoration: ${run.stderr}`);
  assert.match(run.stderr, /no rasterizer found/);
  for (const tool of ['rsvg-convert', 'magick', 'convert', 'sips', 'chromium']) {
    assert.match(run.stderr, new RegExp(tool), 'the warning says what it looked for');
  }
  assert.equal(findRasterizer({ PATH: bare }), undefined);
});

test('test_the_probe_takes_the_first_rasterizer_this_path_has', (t) => {
  const dir = scratch(t);

  // Nothing here: not an error, just no tool.
  assert.deepEqual(availableRasterizers({ PATH: dir }), []);
  assert.equal(findRasterizer({ PATH: dir }), undefined);

  stub(dir, 'convert');
  assert.equal(findRasterizer({ PATH: dir }).tool, 'convert');
  assert.equal(findRasterizer({ PATH: dir }).bin, join(dir, 'convert'), 'an absolute path, so nothing re-searches');

  stub(dir, 'chromium');
  assert.deepEqual(availableRasterizers({ PATH: dir }).map((tool) => tool.tool), ['convert', 'chromium']);

  stub(dir, 'rsvg-convert');
  assert.equal(findRasterizer({ PATH: dir }).tool, 'rsvg-convert', 'the best one wins, not the first found');

  // A file nobody can run is not a tool: the probe asks the filesystem, not `which`.
  const plain = scratch(t);
  writeFileSync(join(plain, 'magick'), '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(findRasterizer({ PATH: plain }), undefined);

  // A directory named after a tool is not one either.
  const trap = scratch(t);
  mkdirSync(join(trap, 'rsvg-convert'));
  assert.equal(findRasterizer({ PATH: trap }), undefined);
});

test('test_the_step_draws_one_png_per_size_when_a_tool_is_there', (t) => {
  const dir = scratch(t);
  const out = scratch(t);
  stub(dir, 'rsvg-convert');

  const made = rasterize(fileURLToPath(source('icon.svg')), out, { env: { PATH: dir } });

  assert.ok(made, 'a tool that draws is all the step needs');
  assert.equal(made.tool, 'rsvg-convert');
  assert.deepEqual(
    made.files,
    SIZES.map((size) => join(out, `icon-${size}.png`)),
  );
  const called = readFileSync(join(dir, 'calls'), 'utf8');
  for (const size of SIZES) {
    const file = join(out, `icon-${size}.png`);
    assert.ok(statSync(file).size > 0, `${size} came out with something in it`);
    assert.match(called, new RegExp(`-w ${size} -h ${size}`), 'the size asked for is in the argv');
  }
});

test('test_a_tool_that_draws_nothing_is_not_believed', (t) => {
  const dir = scratch(t);
  const out = scratch(t);
  // sips exits 0 and leaves no file behind for an SVG: that must cost one process, not the tiles.
  stub(dir, 'sips', { draw: false });
  stub(dir, 'chromium');

  const made = rasterize(fileURLToPath(source('icon.svg')), out, { env: { PATH: dir } });

  assert.ok(made);
  assert.equal(made.tool, 'chromium', 'a successful exit is not a drawing');
  for (const size of SIZES) {
    assert.ok(existsSync(join(out, `icon-${size}.png`)), 'the next tool gets its turn');
  }
});

test('test_two_tiles_that_were_never_drawn_are_a_missing_path_not_a_broken_node', async () => {
  // src/ has no PNG and the build never writes one there, so this is the shape of a machine without a
  // rasterizer: the node starts, and those two decorative paths are 404 like any path nobody serves.
  assert.equal(existsSync(source('icon-192.png')), false);
  for (const size of SIZES) {
    const res = await get(WebuiNode, `/icon-${size}.png`);
    assert.equal(res.status, 404, `/icon-${size}.png is not in the package`);
  }

  // The shell it cannot draw a tile for is whole: the page and the drawing it is made of are still there.
  assert.equal((await get(WebuiNode, '/')).status, 200);
  const svg = await get(WebuiNode, '/icon.svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers['content-type'], /^image\/svg\+xml/);
});

test('test_the_node_serves_a_tile_the_build_drew', async (t) => {
  if (!built(t)) return;
  if (!SIZES.every((size) => existsSync(served(`icon-${size}.png`)))) {
    t.skip('no rasterizer on this machine, so the build drew no PNG (see scripts/png-icons.mjs)');
    return;
  }

  // The module the browser gets, not the source: dist/index.js reads the tiles beside itself.
  const { WebuiNode: Built } = await import(served('index.js').href);
  for (const size of SIZES) {
    const res = await get(Built, `/icon-${size}.png`);
    assert.equal(res.status, 200, `/icon-${size}.png has to be served`);
    assert.equal(res.headers['content-type'], 'image/png', 'a PNG, or the browser gives up on it');
    assert.deepEqual(Buffer.from(res.body), readFileSync(served(`icon-${size}.png`)), 'the bytes drawn');
  }
});
