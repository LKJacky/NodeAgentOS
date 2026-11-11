// Packing one local package for publication: a gzipped tar of the package's own files, at their
// paths inside it (`dist/serve.js`, `package.json`, ...), plus the manifest an installer reads.
//
// This lives in the SDK, not in the store node: packing is a property of a node package, and both
// ends of a publish need it - the shell reads this machine's disk and packs, the store parses what
// arrived. Keeping it here means neither node package has to depend on the other, and there is one
// writer of the format (ustar, regular files only, no links, no devices, no absolute paths) that the
// store's reader accepts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { manifestFromPackage } from './package.js';

/** One file in an archive, at its slash-separated path inside the package. */
export type ArchiveFile = { path: string; data: Uint8Array; mode: number };

/** The manifest a store holds for a published node: the package's `node` block, flattened, with the
 *  capability *names* rather than their schemas. This is the wire shape, not the bus manifest. */
export type PublishedManifest = {
  name: string;
  version: string;
  desc: string;
  caps: string[];
  entry?: string;
  package?: string;
  keywords?: string[];
  /** The node's own mark, inline: an `<svg>` document or a `data:image/...` URL. The published
   *  manifest carries it so a store page can draw a card for a node this machine never unpacked. */
  icon?: string;
};

/** What one upload carries: the manifest, the bytes, and how many files went into them. */
export type PackedPackage = { manifest: PublishedManifest; archive: Uint8Array; files: number };

const BLOCK = 512;

/** Files a package publishes beside its `dist/`: the manifest an installer reads, and the prose that
 *  says what it is. Everything else stays home - `node_modules` in particular, which is a machine's
 *  opinion about a package, not the package. */
const PACKAGE_FILES = ['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'dev_doc.md'];

/** A path inside an archive: relative, slash-separated, and never a way out of the directory it is
 *  extracted into. The store checks the same rule when it parses what arrived. */
export function isArchivePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 512) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** One octal field: `digits` octal digits followed by the NUL tar wants. */
function octal(value: number, digits: number): string {
  return value.toString(8).padStart(digits, '0') + '\0';
}

/** The 512-byte header of one regular file. A path longer than the 100 bytes `name` holds is split
 *  at a slash into ustar's `prefix`; a path that cannot be split is refused rather than truncated. */
function header(file: ArchiveFile): Buffer {
  const block = Buffer.alloc(BLOCK);
  let name = file.path;
  let prefix = '';

  if (byteLength(name) > 100) {
    let split = -1;
    for (let i = name.length - 1; i > 0; i -= 1) {
      if (name.charAt(i) !== '/') continue;
      if (byteLength(name.slice(i + 1)) > 100) continue;
      if (byteLength(name.slice(0, i)) > 155) break;
      split = i;
      break;
    }
    if (split === -1) throw new Error(`archive path is too long for tar: ${file.path}`);
    prefix = name.slice(0, split);
    name = name.slice(split + 1);
  }

  block.write(name, 0, 100, 'utf8');
  block.write(octal(file.mode & 0o7777, 7), 100, 8, 'ascii');
  block.write(octal(0, 7), 108, 8, 'ascii');
  block.write(octal(0, 7), 116, 8, 'ascii');
  block.write(octal(file.data.length, 11), 124, 12, 'ascii');
  block.write(octal(0, 11), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 6) + ' ', 148, 8, 'ascii');
  return block;
}

function padding(size: number): number {
  const rest = size % BLOCK;
  return rest === 0 ? 0 : BLOCK - rest;
}

/** Entries to the bytes of a gzipped tar. Sorted by path, so the same files always produce the same
 *  bytes: the archive's sha256 is the version's identity, and a rebuild should not move it. */
export function writeArchive(files: readonly ArchiveFile[]): Uint8Array {
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : 1));

  for (const file of sorted) {
    if (!isArchivePath(file.path)) throw new Error(`not a path inside an archive: ${file.path}`);
    if (seen.has(file.path)) throw new Error(`archive repeats ${file.path}`);
    seen.add(file.path);

    const data = Buffer.from(file.data);
    chunks.push(header({ path: file.path, data, mode: file.mode }), data);
    const gap = padding(data.length);
    if (gap > 0) chunks.push(Buffer.alloc(gap));
  }

  // Two zero blocks close a tar. One would be enough for some readers; two is what the format says.
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

const MAX_ICON_CHARS = 16_384;

/** The icon a package declares, as something a browser can draw: the inline `<svg>` or data URL in
 *  `node.icon`, or the contents of the file a relative path names. A path out of the package is an
 *  error; a file holding neither form is refused, and so is an icon past the manifest's budget - a
 *  path is not something a page can render, and a listing should not carry a picture-sized payload. */
function declaredIcon(directory: string, source: Record<string, any>): string | undefined {
  const icon = source?.node?.icon;
  if (typeof icon !== 'string' || icon.trim() === '') return undefined;
  const value = icon.trim();
  let inline = value;
  if (!value.startsWith('<svg') && !value.startsWith('data:image/')) {
    const root = resolve(directory);
    const iconPath = resolve(root, value);
    if (iconPath !== root && !iconPath.startsWith(root + sep))
      throw new Error(`node.icon would be read outside ${directory}: ${value}`);
    inline = readFileSync(iconPath, 'utf8').trim();
  }
  const start = inline.startsWith('data:image/') ? 0 : inline.indexOf('<svg');
  if (start === -1)
    throw new Error(`node.icon in ${directory} is not an inline <svg> or data:image/ URL`);
  const text = inline.slice(start);
  if (text.length > MAX_ICON_CHARS)
    throw new Error(
      `node.icon in ${directory} is ${text.length} characters; a manifest carries at most ${MAX_ICON_CHARS}`,
    );
  return text;
}

/** `package.json` as it travels: with the icon file inlined, so the archive carries the picture the
 *  page draws rather than a path only this machine could resolve. */
function packageJsonForArchive(directory: string): Uint8Array {
  const source = readFileSync(join(directory, 'package.json'));
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(source.toString('utf8'));
  } catch {
    return source;
  }
  const declared = parsed?.node?.icon;
  if (typeof declared !== 'string' || declared.trim() === '') return source;
  const inline = declaredIcon(directory, parsed);
  // An inline icon is already in the file; only a path is replaced by what it names.
  if (inline === undefined || inline === declared.trim()) return source;
  parsed.node.icon = inline;
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/** Everything the package publishes: the files above, then every file under `dist/`. */
export function packageFiles(directory: string): ArchiveFile[] {
  const files: ArchiveFile[] = [];

  for (const name of PACKAGE_FILES) {
    const path = join(directory, name);
    try {
      const found = statSync(path);
      if (found.isFile())
        files.push({
          path: name,
          data: name === 'package.json' ? packageJsonForArchive(directory) : readFileSync(path),
          mode: 0o644,
        });
    } catch {
      // Not every package has a README; the manifest is checked by the caller that read it.
    }
  }

  const dist = join(directory, 'dist');
  let distStat;
  try {
    distStat = statSync(dist);
  } catch {
    throw new Error(`${directory} has no dist/: build the package first (npm run build)`);
  }
  if (!distStat.isDirectory()) throw new Error(`${dist} is not a directory`);

  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        const mode = statSync(path).mode & 0o777 || 0o644;
        files.push({
          path: relative(directory, path).split(sep).join('/'),
          data: readFileSync(path),
          mode,
        });
      } else {
        throw new Error(`${path} is a link or a device; an archive holds regular files only`);
      }
    }
  };
  walk(dist);

  return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** Pack one local package for publishing: the manifest its own `package.json` declares, and the
 *  bytes of its build. The store node owns the URL and token; this is only the local half. */
export function packLocalPackage(options: { directory: string; version?: string }): PackedPackage {
  const source = JSON.parse(readFileSync(join(options.directory, 'package.json'), 'utf8'));
  const declared = options.version === undefined ? source : { ...source, version: options.version };
  // The SDK validates the package (bus name, semver, entry, one schema per capability), so the
  // manifest built from it cannot be one the store would refuse for its shape.
  const base = manifestFromPackage(declared, { directory: options.directory });
  const block =
    (declared as { node?: { caps?: Record<string, unknown>; entry?: unknown } }).node ?? {};

  const manifest: PublishedManifest = {
    name: base.name,
    version: base.version,
    desc: base.desc,
    caps: Object.keys(block.caps ?? {}),
  };
  if (typeof block.entry === 'string') manifest.entry = block.entry.replace(/^\.\//, '');
  if (typeof declared.name === 'string') manifest.package = declared.name;
  if (Array.isArray(declared.keywords)) manifest.keywords = declared.keywords as string[];
  const icon = declaredIcon(options.directory, declared);
  if (icon !== undefined) manifest.icon = icon;

  const files = packageFiles(options.directory);
  if (manifest.entry !== undefined && !files.some((file) => file.path === manifest.entry)) {
    throw new Error(
      `${options.directory} has no ${manifest.entry}: build the package first (npm run build)`,
    );
  }
  return { manifest, archive: writeArchive(files), files: files.length };
}
