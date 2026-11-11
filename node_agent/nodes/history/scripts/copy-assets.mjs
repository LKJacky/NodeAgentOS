// The words travel beside the compiled code: the node reads them at load from `node.i18n`.
import { fileURLToPath } from 'node:url';
import { copyI18n } from '../../../scripts/copy-i18n.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
copyI18n(root);
