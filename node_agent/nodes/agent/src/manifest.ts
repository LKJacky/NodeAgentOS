// The package manifest is the one description of what this node offers. Capability names, their
// JSON schemas and their descriptions live there; the runtime and the page read the same file
// instead of keeping hand-written copies that drift.
import { readFileSync } from 'node:fs';

/** One capability as `package.json`'s `node.caps` declares it. */
export type ManifestCapability = {
  description?: unknown;
  callers?: unknown;
  expose?: unknown;
  [key: string]: unknown;
};

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  node?: { caps?: Record<string, ManifestCapability>; icon?: unknown };
};

/** The capabilities this node serves, in the manifest's order. */
export const CAPS: Readonly<Record<string, ManifestCapability>> = manifest.node?.caps ?? {};

/** The same names as a list, for the places that iterate over the capabilities. */
export const CAPABILITY_NAMES: readonly string[] = Object.keys(CAPS);

/** The package's own drawing, inline or read from the file `node.icon` names. It is the main
 *  agent's icon until an embedder hands the runtime a different one. */
export const PACKAGE_ICON: string | undefined = (() => {
  const icon = manifest.node?.icon;
  if (typeof icon !== 'string' || icon.trim() === '') return undefined;
  const named = icon.trim();
  if (named.startsWith('<svg') || named.startsWith('data:image/')) return named;
  try {
    return readFileSync(new URL(`../${named}`, import.meta.url), 'utf8');
  } catch {
    return undefined;
  }
})();
