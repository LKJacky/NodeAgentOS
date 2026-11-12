// The browser half of the SDK's i18n: the same `Text`, the same resource, applied to a live page.
//
// The webui serves this file as `/sdk/i18n-client.js` and the compiled `i18n.js` / `i18n-resource.js`
// beside it, so a page and the node that drew it resolve a language the same way. There is no
// dictionary in the SDK: the words are the node's own, in one of two shapes.
//
//   Inline, for a sentence that never leaves this element:
//     <button data-text-en="OK" data-text-cn="确认"></button>
//
//   From the node's resource files (i18n/en.json, i18n/zh-CN.json), embedded by the node that drew
//   the page as `<script type="application/json" data-i18n-resource>{…}</script>`:
//     <button data-text-key="save"></button>
//     <span data-text-key="counts.waiting" data-text-params='{"count":3}'></span>
//
// On load this module draws every marked element, then follows the user's language: it listens on
// the system node's `language` topic, redraws on every change, and announces each one as a
// `node-agent:language` event so a page can do more than swap strings. A script that needs a
// sentence of its own builds one with the same resource: `resourceTexts(resource).save.get(locale)`.
// The whole surface is also on `window.nodeAgentI18n`, for scripts that cannot import.
import { DEFAULT_LOCALE, Text, resolveLocale } from './i18n.js';
import { RESOURCE_ATTRIBUTE, flattenResource, resourceTexts } from './i18n-resource.js';

export { Text, resourceTexts };

/** The event a page may listen for (`document.addEventListener('node-agent:language', …)`). */
export const LANGUAGE_EVENT = 'node-agent:language';

/** Where the system node publishes a language change; the webui forwards it as Server-Sent Events. */
export const LANGUAGE_URL = '/events?node=system&topic=language';

/** The current locale. A page reads it through `currentLocale()`; nothing else writes it. */
let locale = initialLocale();

/** The node's resource, when the page carries one. Keys in the markup are looked up here. */
let textResource = null;

/** The language this page was drawn in: what the shell declared, else what the browser prefers. */
function initialLocale() {
  const declared = globalThis.__NODE_AGENT_LANGUAGE__;
  if (typeof declared === 'string' && declared.trim() !== '') return resolveLocale(declared);
  if (typeof document !== 'undefined') {
    const documentLang = document.documentElement?.lang ?? '';
    if (documentLang.trim() !== '') return resolveLocale(documentLang);
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string')
    return resolveLocale(navigator.language);
  return DEFAULT_LOCALE;
}

/** The keys a language may use in a resource, best first. `cn` is the short spelling a file may pick. */
function languageKeys(tag) {
  return tag === 'zh-CN' ? ['zh-CN', 'cn', 'zh'] : ['en'];
}

/** The locale the page is currently drawn in. */
export function currentLocale() {
  return locale;
}

/**
 * The resource this page draws from: the JSON script tag the node embedded, or null when the page
 * carries none (an inline `data-text-en` / `data-text-cn` page does not need one).
 */
export function resourceFromDocument(root = typeof document === 'undefined' ? null : document) {
  if (root === null || typeof root.querySelector !== 'function') return null;
  const element = root.querySelector(`script[${RESOURCE_ATTRIBUTE}]`);
  if (element === null || typeof element.textContent !== 'string') return null;
  try {
    const parsed = JSON.parse(element.textContent);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** {name} becomes params.name; an unknown placeholder stays as written, which a reader can see. */
function interpolate(template, params) {
  if (params === null || typeof params !== 'object') return template;
  return template.replace(/\{([^}]+)\}/g, (whole, name) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * One key of the page's resource, in one language (the page's by default), or null when the resource
 * has no such sentence — a missing key shows nothing rather than the key itself.
 */
export function keyText(key, tag = locale, params) {
  if (textResource === null) return null;
  for (const language of languageKeys(resolveLocale(tag))) {
    const value = textResource[language]?.[key];
    if (typeof value === 'string' && value !== '') return interpolate(value, params);
  }
  const english = textResource.en?.[key];
  if (typeof english === 'string' && english !== '') return interpolate(english, params);
  for (const entries of Object.values(textResource)) {
    const value = entries?.[key];
    if (typeof value === 'string' && value !== '') return interpolate(value, params);
  }
  return null;
}

/** The parameters an element passes to its sentence: `data-text-params='{"count":3}'`. */
function paramsOf(element) {
  const raw = element.getAttribute?.('data-text-params');
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The attributes of an element, as a list: a DOM hands out a NamedNodeMap, a double out a map. */
function attributeList(element) {
  const attributes = element.attributes;
  if (attributes === null || typeof attributes !== 'object') return [];
  if (typeof attributes[Symbol.iterator] === 'function') return [...attributes];
  const list = [];
  for (let index = 0; index < (attributes.length ?? 0); index += 1)
    list.push(attributes[index] ?? attributes.item?.(index));
  return list.filter((attribute) => attribute !== undefined && attribute !== null);
}

/**
 * The sentence one element carries inline, in one language (the page's by default).
 *
 * `prefix` is what makes the same rule serve both markers: the text of an element
 * (`data-text-en`) and its placeholder (`data-text-placeholder-en`).
 *
 * The order is the same as `Text.get`: the language's own markers, then English, then whatever the
 * element has — a sentence written only once is never blank.
 */
export function textOf(element, tag = locale, prefix = 'data-text-') {
  if (element === null || typeof element?.getAttribute !== 'function') return null;
  const read = (name) => {
    const value = element.getAttribute(`${prefix}${name}`);
    return typeof value === 'string' && value !== '' ? value : null;
  };
  for (const key of languageKeys(resolveLocale(tag))) {
    const value = read(key);
    if (value !== null) return value;
  }
  const english = read('en');
  if (english !== null) return english;
  for (const attribute of attributeList(element)) {
    if (typeof attribute.name === 'string' && attribute.name.startsWith(prefix))
      return attribute.value;
  }
  return null;
}

/**
 * Switch the page to a language. Usually called by the stream below, not by a page: the user's
 * language lives in the system profile, so a page that wants to change it calls system.settings and
 * waits for the event to come back.
 */
export function setLocale(value) {
  locale = resolveLocale(value);
  applyTranslations();
  return locale;
}

/**
 * Draw the page from a resource: `applyResource(resource)` before the first paint, or again when a
 * node sends a new set of words. Null drops the resource and leaves inline markers to speak.
 *
 * `resource` is the JSON the node embedded, as it wrote it: nested groups are flattened to dotted
 * keys here (`counts.waiting`), the same way the node's own `resourceTexts` reads it.
 */
export function applyResource(resource, root) {
  const parsed = resource !== null && typeof resource === 'object' ? resource : null;
  textResource = parsed === null ? null : Object.fromEntries(
    Object.entries(parsed).map(([language, entries]) => [language, flattenResource(entries)]),
  );
  applyTranslations(root);
  return textResource;
}

/**
 * Draw every marked element under `root` (the document by default):
 *   - `data-text-key` — the page's resource, in the current language (`data-text-params` fills it);
 *   - `data-text-en` / `data-text-cn` — the sentence written on the element itself;
 *   - the same two with a `-placeholder` suffix set the `placeholder` attribute instead.
 */
export function applyTranslations(root = typeof document === 'undefined' ? null : document) {
  if (root === null || typeof root.querySelectorAll !== 'function') return;

  for (const element of root.querySelectorAll('[data-text-key]')) {
    const key = element.getAttribute('data-text-key');
    if (typeof key !== 'string' || key === '') continue;
    const text = keyText(key, locale, paramsOf(element));
    if (text !== null) element.textContent = text;
  }
  for (const element of root.querySelectorAll('[data-text-placeholder-key]')) {
    const key = element.getAttribute('data-text-placeholder-key');
    if (typeof key !== 'string' || key === '') continue;
    const text = keyText(key, locale, paramsOf(element));
    if (text !== null) element.setAttribute('placeholder', text);
  }
  for (const element of root.querySelectorAll('[data-text-label-key]')) {
    const key = element.getAttribute('data-text-label-key');
    if (typeof key !== 'string' || key === '') continue;
    const text = keyText(key, locale, paramsOf(element));
    if (text !== null) element.setAttribute('aria-label', text);
  }
  for (const element of root.querySelectorAll('[data-text-title-key]')) {
    const key = element.getAttribute('data-text-title-key');
    if (typeof key !== 'string' || key === '') continue;
    const text = keyText(key, locale, paramsOf(element));
    if (text !== null) element.setAttribute('title', text);
  }

  for (const element of root.querySelectorAll('[data-text-en], [data-text-cn], [data-text-zh-CN]')) {
    const text = textOf(element);
    if (text !== null) element.textContent = text;
  }
  for (const element of root.querySelectorAll(
    '[data-text-placeholder-en], [data-text-placeholder-cn]',
  )) {
    const text = textOf(element, locale, 'data-text-placeholder-');
    if (text !== null) element.setAttribute('placeholder', text);
  }

  if (typeof document !== 'undefined' && root === document)
    document.documentElement.lang = locale;
}


/**
 * One key of the page's resource, in the current language (`{name}` placeholders filled from `params`).
 *
 * A page that builds a sentence at run time writes `t('key', { count })`. A key nobody translated
 * shows up as the key itself: on the page it is findable, while an empty string would look like a
 * bug in the page.
 */
export function t(key, params) {
  return keyText(key, locale, params) ?? key;
}

/** Tell whoever is listening that the page just changed language. */
function announce(value) {
  if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
  if (typeof CustomEvent !== 'function') return;
  document.dispatchEvent(new CustomEvent(LANGUAGE_EVENT, { detail: { language: locale, value } }));
}

/**
 * Follow the user's language: one Server-Sent Events stream off the webui, which forwards the system
 * node's `language` topic. Returns the function that stops following.
 *
 * Both halves are injectable so the module can be exercised without a browser or a bus.
 */
export function watchLanguage(options = {}) {
  const url = options.url ?? LANGUAGE_URL;
  const Source = options.source ?? globalThis.EventSource;
  const shared = options.source === undefined ? globalThis.NodeAgentEvents : undefined;
  if (typeof Source !== 'function' && !shared) return () => {};

  // The webui shell and its panels share the same physical SSE, including language updates.
  // Other SDK consumers (and injectable test sources) keep the standalone behavior.
  const stream = shared ? shared.connect(url) : new Source(url);
  stream.onmessage = (message) => {
    let frame;
    try {
      frame = JSON.parse(message.data);
    } catch {
      return; // a keep-alive comment or something that is not ours
    }
    // The webui wraps a bus event as { node, topic, from, value }; a bare payload is accepted too.
    const value = frame !== null && typeof frame === 'object' ? (frame.value ?? frame) : null;
    if (value === null || typeof value !== 'object') return;
    const next = resolveLocale(value.resolved ?? value.language ?? value.locale);
    if (next === locale) return;
    setLocale(next);
    announce(value);
  };

  return () => {
    stream.close?.();
  };
}

// In a browser this file is the whole setup: take the page's resource, draw once, then follow
// changes. Outside one (a test, a build step) it is a library and nothing runs.
if (typeof document !== 'undefined') {
  const api = {
    Text,
    resourceTexts,
    currentLocale,
    setLocale,
    t,
    textOf,
    keyText,
    applyResource,
    applyTranslations,
    resourceFromDocument,
    watchLanguage,
  };
  globalThis.nodeAgentI18n = api;
  const start = () => {
    applyResource(resourceFromDocument(), document);
    watchLanguage();
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
