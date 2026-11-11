// The page and its installable shell travel beside the compiled code, and so do the shell's own
// words: the page is drawn from `dist/i18n` at startup (`node.i18n` names the same folder), so a
// build that left the folder behind is a node that will not start, not a shell in one language.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { copyI18n } from '../../../scripts/copy-i18n.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(`${root}dist`, { recursive: true });
for (const asset of ['webui.html', 'icon.svg', 'manifest.webmanifest', 'sw.js', 'events-client.js', 'events-broker.js', 'events-shared-worker.js']) {
  copyFileSync(`${root}src/${asset}`, `${root}dist/${asset}`);
}
copyI18n(root);
