#!/usr/bin/env node
// Keep the MIT LICENSE inside every package npm can pack.
//
// The license itself lives once, at the repository root. npm can only pack files that sit inside the
// package directory, so each workspace carries a copy of LICENSE:
//
//   npm run licenses:sync     rewrite the copies from the root files
//   npm run licenses:check    fail when a copy is missing or has drifted (CI runs this)
//
// The copies are committed, so a tarball is legal even when scripts are skipped (`npm pack
// --ignore-scripts`); every publishable package also refreshes them in `prepack`, so a changed root
// license cannot be published stale.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = ['LICENSE'];
const CHECK = process.argv.includes('--check');

/** Every workspace package directory, in a stable order. */
function packageDirs() {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const dirs = [];
  for (const pattern of root.workspaces ?? []) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      dirs.push(pattern);
      continue;
    }
    if (!pattern.endsWith('/*')) throw new Error(`unsupported workspace pattern: ${pattern}`);
    const parent = pattern.slice(0, star).replace(/\/$/, '');
    for (const name of readdirSync(join(ROOT, parent)).sort()) {
      if (existsSync(join(ROOT, parent, name, 'package.json'))) dirs.push(`${parent}/${name}`);
    }
  }
  return dirs;
}

const source = new Map(FILES.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]));
const dirs = packageDirs();

const drifted = [];
let written = 0;
for (const dir of dirs) {
  for (const file of FILES) {
    const target = join(ROOT, dir, file);
    const wanted = source.get(file);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current === wanted) continue;
    if (CHECK) {
      drifted.push(`${dir}/${file}${current === null ? ' (missing)' : ' (differs)'}`);
      continue;
    }
    writeFileSync(target, wanted);
    written += 1;
  }
}

if (drifted.length > 0) {
  console.error('license copies are out of date with the root LICENSE:');
  for (const line of drifted) console.error(`  ${line}`);
  console.error('run `npm run licenses:sync` and commit the result');
  process.exit(1);
}

console.log(
  CHECK
    ? `licenses: ${dirs.length} packages carry the root LICENSE`
    : `licenses: ${written} file(s) written across ${dirs.length} packages`,
);
