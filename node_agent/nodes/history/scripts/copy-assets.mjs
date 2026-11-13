// The words travel beside the compiled code: the node reads them at load from `node.i18n`.
import { fileURLToPath } from 'node:url';
import { copyI18n } from '../../../scripts/copy-i18n.mjs';
import { copyFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
copyI18n(root);
copyFileSync(new URL('../src/ui.html', import.meta.url), new URL('../dist/ui.html', import.meta.url));
