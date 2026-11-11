// The browser half of the i18n module is JavaScript already: nothing to compile, but it has to sit
// beside the compiled `i18n.js` it imports, because a page fetches both from the same place (the
// webui serves them as /sdk/i18n.js and /sdk/i18n-client.js).
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(`${root}dist`, { recursive: true });
copyFileSync(`${root}src/i18n-client.js`, `${root}dist/i18n-client.js`);
