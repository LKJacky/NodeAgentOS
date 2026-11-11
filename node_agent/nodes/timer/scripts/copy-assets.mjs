import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { copyI18n } from '../../../scripts/copy-i18n.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
// The directory is `tsc`'s to create, but a build that was already up to date (a stale .tsbuildinfo
// with no dist) emits nothing, and the page still has to land there.
mkdirSync(join(root, 'dist'), { recursive: true });
copyFileSync(join(root, 'src', 'ui.html'), join(root, 'dist', 'ui.html'));
copyFileSync(join(root, 'src', 'icon.svg'), join(root, 'dist', 'icon.svg'));
copyI18n(root);
