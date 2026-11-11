// What is not TypeScript tsc leaves alone, so it is copied beside the build by hand: `dist/index.js`
// reads its page as ./ui.html, its words as ./i18n (see `node.i18n`) and the two texts the setup
// files as ./setup-i18n. The icon is copied too, so a published `dist/` carries the picture its
// manifest names; `copyI18n` puts `src/i18n` where `node.i18n` points.
import { copyFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyI18n } from '../../../scripts/copy-i18n.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
copyFileSync(join(root, 'src', 'ui.html'), join(root, 'dist', 'ui.html'));
copyFileSync(join(root, 'src', 'onboarding.html'), join(root, 'dist', 'onboarding.html'));
copyFileSync(join(root, 'src', 'intro-animation.html'), join(root, 'dist', 'intro-animation.html'));
copyFileSync(join(root, 'src', 'icon.svg'), join(root, 'dist', 'icon.svg'));
copyI18n(root);
cpSync(join(root, 'src', 'setup-i18n'), join(root, 'dist', 'setup-i18n'), { recursive: true });
