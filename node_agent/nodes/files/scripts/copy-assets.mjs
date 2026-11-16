import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { copyI18n } from '../../../scripts/copy-i18n.mjs';

/** The page and its words travel beside the compiled code: the node reads both at load. */
const root = fileURLToPath(new URL('..', import.meta.url));
copyFileSync(join(root, 'src', 'ui.html'), join(root, 'dist', 'ui.html'));
copyI18n(root);
