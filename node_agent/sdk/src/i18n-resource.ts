import { DEFAULT_LOCALE, Text, isLocale, resolveLocale, type TextMessages } from './i18n.js';

/**
 * A node's words, kept in files: one entry per language, one key per sentence.
 *
 *   i18n/en.json      { "save": "Save settings", "counts": { "waiting": "{count} waiting" } }
 *   i18n/zh-CN.json   { "save": "保存设置",     "counts": { "waiting": "{count}个等待中" } }
 *
 * The SDK holds no resource of its own — it only knows how to read the node's, turn every key into a
 * `Text`, and put the same resource inside a page so the browser half draws from it. Nested objects
 * are flattened with dots (`counts.waiting`), so a file can group its sentences the way it likes.
 */
export type Resource = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The element a page carries its resource in; the browser half looks for exactly this. */
export const RESOURCE_ATTRIBUTE = 'data-i18n-resource';

/** { a: { b: 'x' } } → { 'a.b': 'x' }, keeping the order the file was written in. */
function flatten(
  value: Record<string, unknown>,
  prefix = '',
  into: Record<string, string> = {},
): Record<string, string> {
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof entry === 'string') into[name] = entry;
    else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      flatten(entry as Record<string, unknown>, name, into);
  }
  return into;
}

/** One language's file as a flat map; entries that are not strings (or nested maps) are dropped. */
export function flattenResource(entries: unknown): Record<string, string> {
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return {};
  return flatten(entries as Record<string, unknown>);
}

/**
 * Every key of a resource as a `Text`: `resourceTexts(resource).save.get('zh-CN')`.
 *
 * The sentences of one key are the languages that wrote it; English is required, because it is the
 * fallback every other language falls back to — a key without it would have nothing to show a
 * reader of a language the file does not carry. The error names the keys, which is the whole point
 * of validating a file at startup rather than discovering it on a page.
 */
export function resourceTexts(resource: Resource): Record<string, Text> {
  const keys = new Set<string>();
  const flattened: Record<string, Record<string, string>> = {};
  for (const [locale, entries] of Object.entries(resource)) {
    const flat = flattenResource(entries);
    flattened[locale] = flat;
    for (const key of Object.keys(flat)) keys.add(key);
  }

  const missing: string[] = [];
  const texts: Record<string, Text> = {};
  for (const key of keys) {
    const messages: Record<string, string> = {};
    for (const [locale, flat] of Object.entries(flattened)) {
      const value = flat[key];
      if (typeof value === 'string' && value !== '') messages[locale] = value;
    }
    const english = messages[DEFAULT_LOCALE];
    if (english === undefined) {
      missing.push(key);
      continue;
    }
    texts[key] = new Text(messages as TextMessages);
  }
  if (missing.length > 0)
    throw new Error(
      `i18n resource is missing English for ${missing.length} key(s): ${missing.join(', ')}`,
    );
  return texts;
}

/**
 * The same resource, inside a page: one JSON script tag the browser half reads on load.
 *
 * `<` is escaped so a sentence can never close the tag early; the JSON itself stays JSON.
 */
export function resourceScript(resource: Resource): string {
  const json = JSON.stringify(resource)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/json" ${RESOURCE_ATTRIBUTE}>${json}</script>`;
}

/**
 * Display names for the things a package calls by identifier.
 *
 * The bus and the agent only ever use the canonical names — `system`, `add_timer`, `browser` —
 * because those are the addresses in a call and the keys in a manifest. A *page*, though, should
 * say what the user reads: these are the same identifiers with a sentence per language, published
 * beside the manifest so a directory can show them without knowing any node's words.
 *
 * Every entry is a `LocalizedText`: locale tag in, the name to show out. A locale that is missing
 * falls back to English, then to the canonical identifier — a reader never sees a blank label.
 */
export type LocalizedText = Readonly<Record<string, string>>;

/** A node's labels: its own name, its capabilities' names, and their arguments' names. */
export interface NodeLabels {
  readonly node?: LocalizedText;
  /** What this node's page is for, per language: the one line a shell shows beside (or instead of)
   *  the canonical `desc` of the manifest. */
  readonly desc?: LocalizedText;
  readonly caps?: Readonly<Record<string, LocalizedText>>;
  readonly args?: Readonly<Record<string, Readonly<Record<string, LocalizedText>>>>;
}

/** The label keys a resource file may carry: `label.node`, `label.desc`, `label.caps.<cap>`,
 *  `label.args.<cap>.<arg>`. */
const LABEL_PREFIX = 'label.';

/**
 * The labels a node's resource files declare, in the manifest shape a directory carries.
 *
 * They live in the same per-language files as the sentences (`i18n/en.json`, `i18n/zh-CN.json`), so
 * a translator edits one file per language and nothing is written twice:
 *
 *   { "label": { "node": "System", "caps": { "add_timer": "Add timer" },
 *                "args": { "ensure_language": { "browser": "Browser language" } } } }
 *
 * A node without a `label` section simply has no labels: the directory then shows the canonical
 * names, which is what it showed before this existed.
 */
export function manifestLabels(resource: Resource): NodeLabels | undefined {
  const node: Record<string, string> = {};
  const desc: Record<string, string> = {};
  const caps: Record<string, Record<string, string>> = {};
  const args: Record<string, Record<string, Record<string, string>>> = {};

  for (const [locale, entries] of Object.entries(resource)) {
    for (const [key, value] of Object.entries(flattenResource(entries))) {
      if (typeof value !== 'string' || value === '') continue;
      if (key === `${LABEL_PREFIX}node`) {
        node[locale] = value;
        continue;
      }
      if (key === `${LABEL_PREFIX}desc`) {
        desc[locale] = value;
        continue;
      }
      if (!key.startsWith(LABEL_PREFIX)) continue;
      const parts = key.slice(LABEL_PREFIX.length).split('.');
      const [kind, name, field] = parts;
      if (kind === 'caps' && parts.length === 2 && name !== undefined) {
        (caps[name] ??= {})[locale] = value;
      } else if (
        kind === 'args' &&
        parts.length === 3 &&
        name !== undefined &&
        field !== undefined
      ) {
        (((args[name] ??= {})[field] ??= {}) as Record<string, string>)[locale] = value;
      }
    }
  }

  const labels: NodeLabels = {
    ...(Object.keys(node).length > 0 ? { node } : {}),
    ...(Object.keys(desc).length > 0 ? { desc } : {}),
    ...(Object.keys(caps).length > 0 ? { caps } : {}),
    ...(Object.keys(args).length > 0 ? { args } : {}),
  };
  return Object.keys(labels).length === 0 ? undefined : labels;
}

/** The spellings a language may use for its labels, best first. */
function labelKeys(tag: string): readonly string[] {
  return tag === 'zh-CN' ? ['zh-CN', 'cn', 'zh'] : ['en'];
}

/**
 * The text to show for one label, or undefined when nobody wrote one.
 *
 * A caller with a canonical identifier in hand does `labelText(labels, locale) ?? canonical`, so a
 * missing translation degrades to the name the bus uses rather than to nothing.
 */
export function labelText(labels: LocalizedText | undefined, locale: unknown): string | undefined {
  if (labels === undefined) return undefined;
  for (const key of labelKeys(resolveLocale(locale))) {
    const value = labels[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  for (const value of Object.values(labels)) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * One element whose whole content is the words for one key: `<tag … data-text-key="k">…</tag>`.
 *
 * Only the text is touched, never the attributes, and only when the content has no child elements —
 * a marker on a container is left for the browser half to fill.
 */
const LABELLED_ELEMENT =
  /(<([a-zA-Z][\w-]*)\b[^>]*?\sdata-text-key="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g;

/**
 * Write the words of one language into a page before it leaves the node.
 *
 * A page whose markup carries `data-text-key` markers is redrawn in the browser as soon as the
 * SDK's browser half runs — but *before* that it shows whatever text the marker was written with,
 * so a page authored in one language flashes that language at a reader of the other. Filling the
 * text here makes the first paint the right one; the markers stay, so a later language change is
 * still redrawn by the client without a reload.
 */
export function paintResource(
  html: string,
  texts: Readonly<Record<string, Text>>,
  locale: string,
): string {
  const painted = html.replace(LABELLED_ELEMENT, (whole, open, tag, key, inner, close) => {
    const text = texts[key]?.get(locale);
    return text === undefined ? whole : `${open}${text}${close}`;
  });
  // Attributes are painted tag by tag: the whole start tag is in hand, so an attribute that is
  // already there has its value replaced and one that is missing is added before the tag closes.
  // A tag may carry more than one marker (a field's placeholder and its aria-label), so every
  // marker on it is read, not just the first.
  return painted.replace(TAG, (tag) => {
    let out = tag;
    for (const marker of out.matchAll(ATTRIBUTE_MARKER)) {
      const kind = marker[1];
      const key = marker[2] ?? '';
      const text = texts[key]?.get(locale);
      if (text === undefined) continue;
      const attribute = kind === 'placeholder' ? 'placeholder' : kind === 'title' ? 'title' : 'aria-label';
      const quoted = `${attribute}="${escapeAttribute(text)}"`;
      const existing = new RegExp(`\\b${attribute}="[^"]*"`);
      out = existing.test(out)
        ? out.replace(existing, () => quoted)
        : out.replace(/\s*\/?>$/, (finish) => ` ${quoted}${finish}`);
    }
    return out;
  });
}

/** `data-text-placeholder-key`, `data-text-title-key` and `data-text-label-key`: the words a tag
 *  carries as an attribute. */
/** One start tag, without its attributes being interpreted. */
const TAG = /<[a-zA-Z][\w-]*\b[^>]*>/g;

/** A tag's markers: `data-text-placeholder-key` fills `placeholder`, `data-text-title-key` the hover
 *  tooltip, `data-text-label-key` the accessible name. */
const ATTRIBUTE_MARKER = /\bdata-text-(placeholder|label|title)-key="([^"]+)"/g;

/** Put a sentence into an attribute without letting it end the attribute or the tag. */
function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The slot a page puts in its `<head>` where the resource script (and its words) belong. */
export const RESOURCE_SLOT = '<!-- node-agent:i18n-resource -->';

/**
 * The language a page should be drawn in, from the arguments the shell sends with its request.
 *
 * The shell knows the reader's language and passes it when it asks a node for a page; a node that is
 * asked directly (tests, a fetch without the shell) gets the resource's own default.
 */
export function pageLanguage(args: unknown): string {
  const asked = (args as { language?: unknown } | null | undefined)?.language;
  return typeof asked === 'string' && isLocale(asked) ? asked : DEFAULT_LOCALE;
}

/**
 * A page in the visit's language, ready to send.
 *
 * Three things happen in one place, so no page can forget one of them: the words of the request's
 * language are written into the `data-text-key` / `data-text-placeholder-key` / `data-text-label-key`
 * markers (the first paint is already right, with no script involved), the resource goes in as one
 * JSON script tag the browser half reads, and the markers stay so a later change is redrawn live.
 */
export function paintPage(html: string, resource: Resource, args: unknown): string {
  const language = pageLanguage(args);
  return paintResource(html, resourceTexts(resource), language)
    .replace(/<html lang="[^"]*"/, () => `<html lang="${language}"`)
    .replace(RESOURCE_SLOT, () => resourceScript(resource));
}
