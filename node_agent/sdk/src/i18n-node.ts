// Reading a node's resource files: the one part of i18n that touches the disk, kept beside the
// pure half so a browser (or a test) can import `i18n.js` without dragging `node:fs` along.
//
// A node keeps its words in a folder it owns — `i18n/en.json`, `i18n/zh-CN.json` — and reads that
// folder at startup:
//
//   const resource = loadResource(new URL('./i18n/', import.meta.url));
//   const texts = resourceTexts(resource);
//   texts.save?.get(userLanguage);
//
// Nothing here is cached or watched: files are read when asked, so a node can reload if it wants to.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeLocale } from './i18n.js';
import { flattenResource, type Resource } from './i18n-resource.js';

/** The file names a language may use, best first: the tag, its underscore form, the short one. */
const FILE_NAMES: Readonly<Record<string, readonly string[]>> = {
  en: ['en.json'],
  'zh-CN': ['zh-CN.json', 'zh_CN.json', 'cn.json', 'zh.json'],
};

/** The folder a `file:` URL points at (Node keeps it in `pathname`). */
function folderOf(dir: string | URL): string {
  return typeof dir === 'string' ? dir : decodeURIComponent(dir.pathname);
}

/**
 * The resource a folder holds: one flat map per language file it finds.
 *
 * A folder with only `en.json` is a valid resource (nothing translated yet); a folder with no
 * language file at all is an error — a node that meant to have words and has none is worth hearing
 * about at startup rather than on a page. A file that is not JSON names itself in the error.
 */
export function loadResource(dir: string | URL): Resource {
  const base = folderOf(dir);
  const resource: Record<string, Record<string, string>> = {};
  for (const [locale, names] of Object.entries(FILE_NAMES)) {
    for (const name of names) {
      let raw: string;
      try {
        raw = readFileSync(join(base, name), 'utf8');
      } catch {
        continue; // try the next spelling; a folder need not have every language
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e: unknown) {
        throw new Error(
          `i18n resource ${name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      resource[locale] = flattenResource(parsed);
      break;
    }
  }
  if (Object.keys(resource).length === 0)
    throw new Error(
      `no i18n resource files (${Object.values(FILE_NAMES).flat().join(', ')}) in ${base}`,
    );
  return resource;
}

/** One key of a resource, in a language, or the key itself when the resource has no such sentence. */
export function resourceValue(resource: Resource, key: string, locale: unknown): string {
  const wanted = normalizeLocale(locale);
  const order = wanted === 'zh-CN' ? ['zh-CN', 'cn', 'zh', 'en'] : ['en'];
  for (const language of order) {
    const value = resource[language]?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  for (const entries of Object.values(resource)) {
    const value = entries[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return key;
}
