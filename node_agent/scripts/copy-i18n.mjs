// One place for the copy every page-bearing (and label-bearing) package needs: the words the node
// reads at load (`src/i18n/*.json`) have to sit beside the compiled code, where `node.i18n` points.
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Copy `<root>/src/i18n` to `<root>/dist/i18n`, when the package has one. */
export function copyI18n(root) {
  const from = join(root, 'src', 'i18n');
  if (!existsSync(from)) return;
  cpSync(from, join(root, 'dist', 'i18n'), { recursive: true });
}
