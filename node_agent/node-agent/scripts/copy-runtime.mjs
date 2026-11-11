// The launcher ships the runtime with it, so installing @node-agent/local does not require a
// separately published @node-agent/runtime. The runtime still uses node-agent-bus externally.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../runtime/dist', import.meta.url));
const target = fileURLToPath(new URL('../dist/runtime', import.meta.url));
if (!existsSync(source)) {
  throw new Error(`runtime build not found at ${source}; build @node-agent/runtime first`);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
const license = fileURLToPath(new URL('../../runtime/LICENSE', import.meta.url));
if (existsSync(license)) cpSync(license, target + '/LICENSE');
console.log(`copied runtime into ${target}`);
