import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { copyI18n } from '../../../scripts/copy-i18n.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
copyFileSync(join(root, 'src', 'ui.html'), join(root, 'dist', 'ui.html'));
copyFileSync(join(root, 'src', 'icon.svg'), join(root, 'dist', 'icon.svg'));
copyI18n(root);
