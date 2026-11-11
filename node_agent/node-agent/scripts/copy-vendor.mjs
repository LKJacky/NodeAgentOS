// @node-agent/local is the one package a user installs. The runtime, the bus and the core nodes
// travel inside this tarball; only @node-agent/sdk and third-party model/search libraries are
// ordinary registry dependencies. Node packages stay separate roots so the runtime can launch them
// exactly as it does from a workspace.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const targetRoot = join(packageRoot, 'dist');

function copyPackage(source, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true });
  cpSync(join(source, 'package.json'), join(target, 'package.json'));
  const license = join(source, 'LICENSE');
  if (existsSync(license)) cpSync(license, join(target, 'LICENSE'));
  const icon = join(source, 'src', 'icon.svg');
  if (existsSync(icon)) {
    mkdirSync(join(target, 'src'), { recursive: true });
    cpSync(icon, join(target, 'src', 'icon.svg'));
  }
}


/** The runtime and bus are imported as directories, so their dist files sit at the top. */
function copyFlat(source, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'dist'), target, { recursive: true });
  cpSync(join(source, 'package.json'), join(target, 'package.json'));
  const license = join(source, 'LICENSE');
  if (existsSync(license)) cpSync(license, join(target, 'LICENSE'));
}

function patchImports(directory, replacements) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      patchImports(path, replacements);
      continue;
    }
    if (!/\.(?:js|d\.ts)$/.test(entry)) continue;
    let text = readFileSync(path, 'utf8');
    let changed = false;
    for (const [from, to] of replacements) {
      if (text.includes(from)) {
        text = text.split(from).join(to);
        changed = true;
      }
    }
    if (changed) writeFileSync(path, text);
  }
}

copyFlat(join(projectRoot, 'runtime'), join(targetRoot, 'runtime'));
patchImports(join(targetRoot, 'runtime'), [
  ["from 'node-agent-bus'", "from '../bus/index.js'"],
]);

copyFlat(join(projectRoot, 'bus'), join(targetRoot, 'bus'));

for (const name of [
  'agent',
  'history',
  'introduce',
  'notes',
  'provider',
  'search',
  'system',
  'timer',
  'todo',
  'webui',
]) {
  copyPackage(join(projectRoot, 'nodes', name), join(targetRoot, 'nodes', name));
}

// Public launcher exports reach the bundled node entry points through flat shims.
for (const name of ['agent', 'history']) {
  writeFileSync(
    join(targetRoot, 'nodes', `${name}.js`),
    `export * from './${name}/dist/index.js';\n`,
  );
}

// The web UI is the only bundled node that imports the bus directly.
patchImports(join(targetRoot, 'nodes', 'webui'), [
  ["from 'node-agent-bus'", "from '../../../bus/index.js'"],
]);

console.log('copied runtime, bus and core nodes into dist');
