import { cpSync } from 'node:fs';

cpSync('src/ui.html', 'dist/ui.html');
// The page's words, read at startup by the node and embedded into the page it serves.
cpSync('src/i18n', 'dist/i18n', { recursive: true });
cpSync('src/icon.svg', 'dist/icon.svg');
