// The page and the drawing travel beside the compiled code: a package that shipped only dist/*.js
// would hand the browser nothing to draw.
import { copyFileSync, mkdirSync } from 'node:fs';
import { copyI18n } from '../../../scripts/copy-i18n.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(`${root}dist`, { recursive: true });
for (const asset of ['ui.html', 'icon.svg']) {
  copyFileSync(`${root}src/${asset}`, `${root}dist/${asset}`);
}
copyI18n(root);
