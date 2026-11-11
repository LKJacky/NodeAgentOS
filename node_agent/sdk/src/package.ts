// One node package is an ordinary npm package with a `node` block in package.json. The block is the
// source of truth for the bus manifest: its id, description, entry point and capability schemas.
// package.json's version becomes manifest.version, and the block's id *is* the package id: there is
// no second identity in package.json to drift from it.
//
// This file deliberately validates rather than merely reads. A package that cannot name itself,
// point at a bin it actually ships, or describe its capabilities is not a node package yet.
import { readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadResource } from './i18n-node.js';
import { manifestLabels, type NodeLabels } from './i18n-resource.js';
import type { NodeManifest, ToolArgs } from './envelope.js';
import type { NodeClass } from './node.js';

export interface NodePackageBlock {
  /** Bus address and namespace prefix, e.g. history -> history.load - and the package identity: it
   *  is the `id` half of `publisher/id`, so one package carries exactly one. */
  id: string;
  desc: string;
  /** Module entry exporting the Node class as its default export, relative to the package root. */
  entry: string;
  /** Capability name -> argument JSON Schema. */
  caps: Record<string, ToolArgs>;
  /** The keys the node may keep an object under (`ctx.bind`). Omitted means it keeps none. */
  bindings?: string[];
  /** Icon: an SVG file path relative to the package root, or the SVG/data URL itself. */
  icon: string;
}

const ID = /^[a-z][a-z0-9-]{0,62}$/;

/** Is this a key a node may keep an object under? The rule `node.bindings` is held to, exported so
 *  a host refuses at runtime exactly the keys the package schema would have refused. */
export function isBindingKey(value: string): boolean {
  return BINDING.test(value);
}

/** Is this a bus name a node may register under? The rule `node.id` is held to, exported so a
 *  runtime that takes an id from its caller (serve --local) refuses the same values it would. */
export function isNodeId(value: string): boolean {
  return ID.test(value);
}
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAP = /^[a-z][a-z0-9_-]*$/;
const BINDING = /^[a-z][a-z0-9_-]{0,62}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function relativePath(value: unknown, field: string): string {
  const path = text(value, field).replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes('..') || path.split('/').some((part) => part === ''))
    throw new Error(`${field} must be a relative path inside the package`);
  return path;
}

function capsOf(value: unknown): Record<string, ToolArgs> {
  // A front end such as webui is a node with no callable capability: it joins the bus, serves
  // pages, and is still installable from the store. Everything else must describe each cap.
  if (!record(value)) throw new Error('node.caps must be an object');
  const caps: Record<string, ToolArgs> = {};
  for (const [name, schema] of Object.entries(value)) {
    if (!CAP.test(name)) throw new Error(`node.caps.${name} is not a capability name`);
    if (!record(schema) || typeof schema.type !== 'string')
      throw new Error(`node.caps.${name} must be a JSON Schema object with a type`);
    caps[name] = schema as ToolArgs;
  }
  return caps;
}

/** The bindings a node declares: a list of names, not a flag. Omitting the field means none;
 *  declaring it empty, repeated or malformed is a mistake rather than a shorthand. */
function bindingsOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('node.bindings must be an array of binding names');
  if (value.length === 0) throw new Error('node.bindings must name at least one binding');
  const names: string[] = [];
  for (const [index, name] of value.entries()) {
    if (typeof name !== 'string' || !BINDING.test(name))
      throw new Error(`node.bindings[${index}] is not a binding name: ${String(name)}`);
    if (names.includes(name)) throw new Error(`node.bindings names ${name} twice`);
    names.push(name);
  }
  return names;
}

/** Validate a parsed package.json and project it onto the bus manifest shape. */
export function manifestFromPackage(
  packageJson: unknown,
  options: { directory?: string } = {},
): NodeManifest {
  if (!record(packageJson)) throw new Error('package.json is not an object');
  const version = text(packageJson.version, 'version');
  if (!VERSION.test(version)) throw new Error(`version is not semver: ${version}`);
  if (packageJson.type !== 'module') throw new Error('a node package must have "type": "module"');
  const publisher = text(packageJson.publisher, 'publisher');
  if (!PACKAGE_ID.test(publisher)) throw new Error(`publisher is not a stable name: ${publisher}`);

  if (!record(packageJson.node)) throw new Error('package.json has no node block');
  const block = packageJson.node;
  const id = text(block.id, 'node.id');
  if (!ID.test(id)) throw new Error(`node.id is not a bus name: ${id}`);
  // The package id is the node id, not a second field: a package has one identity (`publisher/id`),
  // and a value that could disagree with the id it registers under is one value too many.
  const packageId = id;
  const desc = text(block.desc, 'node.desc');
  const entry = relativePath(block.entry, 'node.entry');
  const caps = capsOf(block.caps);
  const bindings = bindingsOf(block.bindings);
  // Display names, if the package keeps its words in files. `node.i18n` names the folder (usually
  // src/i18n) that holds one resource file per language; the `label.*` keys in those files become
  // the manifest's labels. The identifiers never change — a label is what a page shows.
  const labels = labelsOf(block.i18n, options.directory);

  // `bin` is optional now: a node is a module the shared runtime loads, not an executable that
  // builds its own NodeHost. Packages that do expose a bin keep the old check that it points at
  // the same entry, so an executable node cannot silently name a different file.
  if (packageJson.bin !== undefined) {
    if (!record(packageJson.bin) || Object.keys(packageJson.bin).length === 0)
      throw new Error('package.json#bin must name at least one entry');
    const targets = Object.values(packageJson.bin).map((target) =>
      String(target).replace(/^\.\//, '').replaceAll('\\', '/'),
    );
    if (!targets.includes(entry))
      throw new Error(`node.entry ${entry} is not one of the package's bin targets`);
  }

  if (typeof block.icon !== 'string' || block.icon.trim() === '')
    throw new Error('node.icon is required and must be a non-empty string');
  let icon: string;
  // A package being packed already carries the icon inline. That is the form the archive and the
  // bus manifest use, so it needs no directory and no second read.
  const inline = block.icon.trim();
  if (inline.startsWith('<svg') || inline.startsWith('data:image/')) {
    icon = inline;
  } else {
    const iconPath = relativePath(block.icon, 'node.icon');
    if (options.directory === undefined)
      throw new Error('node.icon needs the package directory to be read');
    const absolute = join(options.directory, normalize(iconPath.split('/').join(sep)));
    try {
      icon = readFileSync(absolute, 'utf8');
    } catch (error) {
      throw new Error(`node.icon ${iconPath} is not readable: ${String(error)}`);
    }
  }

  return {
    packageId,
    name: id,
    caps,
    desc,
    version,
    publisher,
    icon,
    ...(bindings === undefined ? {} : { bindings }),
    ...(labels === undefined ? {} : { labels }),
  };
}

/**
 * The labels a package's i18n folder declares, or undefined when it declares none.
 *
 * `block.i18n` is the folder, relative to the package; a package being read from disk has it, and a
 * packed one can carry the labels inline in its manifest instead. A folder that is named but
 * unreadable is an error — a translator who fixed a typo in the path should hear about the path, not
 * silently get canonical names on every page.
 */
function labelsOf(field: unknown, directory: string | undefined): NodeLabels | undefined {
  if (field === undefined) return undefined;
  const folder = relativePath(field, 'node.i18n');
  if (directory === undefined) return undefined;
  return manifestLabels(loadResource(join(directory, normalize(folder.split('/').join(sep)))));
}

/** Read `<directory>/package.json` and validate that the entry and icon it names exist. */
export function nodeManifestOfPackage(directory: string): NodeManifest {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`${directory} has no readable package.json: ${String(error)}`);
  }
  const manifest = manifestFromPackage(packageJson, { directory });
  if (!record(packageJson) || !record(packageJson.node))
    throw new Error('package.json has no node block');
  const entry = relativePath(packageJson.node.entry, 'node.entry');
  const absolute = join(directory, normalize(entry.split('/').join(sep)));
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new Error(`node.entry ${entry} does not exist`);
  }
  if (!stat.isFile()) throw new Error(`node.entry ${entry} is not a file`);
  return manifest;
}

/** A package loaded as a node definition: its validated manifest and the class a runtime hosts. */
export interface LoadedNodePackage {
  readonly directory: string;
  readonly manifest: NodeManifest;
  readonly Node: NodeClass;
}

/** Load `<directory>/package.json`'s node entry and take its default export as the Node class. */
export async function loadNodePackage(directory: string): Promise<LoadedNodePackage> {
  const manifest = nodeManifestOfPackage(directory);
  const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    node?: { entry?: unknown };
  };
  const entry = relativePath(packageJson.node?.entry, 'node.entry');
  const module = (await import(pathToFileURL(join(directory, entry)).href)) as {
    default?: unknown;
  };
  if (typeof module.default !== 'function')
    throw new Error(`${entry} must default-export the Node class`);
  return { directory, manifest, Node: module.default as NodeClass };
}
