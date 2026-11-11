// i18n: which language the user reads, and one sentence written in those languages.
//
// Two things live here, and only two:
//   - the vocabulary of a language tag (Locale, normalizeLocale, resolveLocale, Accept-Language);
//   - `Text`, the value a node wraps around a sentence it already wrote itself.
//
// There is no catalog. The SDK does not know a single word of any node's page: a node writes its own
// sentences where it uses them — `new Text({ en: 'OK', cn: '确认' })` — and the user's language
// (persisted by the system node) decides which one is shown. Nothing here touches fs, process or the
// DOM, so the same `Text` runs in a browser (see i18n-client.js) and in a node.

/** The languages this SDK has a tag for. A text may carry keys for more (see `Text`). */
export const LOCALES = ['zh-CN', 'en'] as const;

/** A language tag the infrastructure can draw: the two the system profile stores. */
export type Locale = (typeof LOCALES)[number];

/** What a page is drawn in when the profile has nothing and Accept-Language matches nothing. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Values a sentence can take: `text.get('en', { name: 'todo' })` fills `{name}`. */
export type TextParams = Readonly<Record<string, string | number>>;

/** The sentence in every language it was written in. `en` is the fallback, so it is required. */
export type TextMessages = Readonly<Record<string, string>> & { readonly en: string };

/** True when value is a tag this SDK knows: one of the two the profile can hold. */
export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

/**
 * A stored or offered tag as one of ours, or null when it is none of them.
 *
 * null is meaningful, not an error: the system profile starts with language: null (the user has never
 * chosen), and a tag from an older version may be `zh`, `zh-Hans-CN` or absent altogether. Matching is
 * on the primary subtag, so every Chinese variant reads as zh-CN (the only Chinese this build has)
 * and every English one as en.
 */
export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase().replace(/_/g, '-');
  if (tag === '') return null;
  const primary = tag.split('-')[0];
  if (primary === 'zh') return 'zh-CN';
  if (primary === 'en') return 'en';
  return null;
}

/** A tag to draw with: the stored or offered one when we can, the default otherwise. Never null. */
export function resolveLocale(value: unknown): Locale {
  return normalizeLocale(value) ?? DEFAULT_LOCALE;
}

/**
 * The tags of an Accept-Language header, best first.
 *
 * The header is a list with quality weights (`zh-CN,zh;q=0.9,en;q=0.8`), so the order written is not
 * quite the order of preference; a q=0 entry meant "not this one" is dropped.
 */
export function acceptLanguageTags(header: unknown): string[] {
  if (typeof header !== 'string' || header.trim() === '') return [];
  const weighted: Array<{ tag: string; quality: number; index: number }> = [];
  header.split(',').forEach((part, index) => {
    const [tag = '', ...parameters] = part.split(';');
    const named = tag.trim();
    if (named === '') return;
    let quality = 1;
    for (const parameter of parameters) {
      const [name = '', value = ''] = parameter.split('=');
      if (name.trim().toLowerCase() !== 'q') continue;
      const parsed = Number(value.trim());
      quality = Number.isFinite(parsed) ? parsed : 0;
    }
    if (quality <= 0) return;
    weighted.push({ tag: named, quality, index });
  });
  // A stable sort on quality: equal weights keep the order the browser wrote them in.
  weighted.sort((a, b) => b.quality - a.quality || a.index - b.index);
  return weighted.map(({ tag }) => tag);
}

/** The language a browser asked for, or fallback when it asked for none of ours. */
export function resolveAcceptLanguage(header: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  for (const tag of acceptLanguageTags(header)) {
    const locale = normalizeLocale(tag);
    if (locale !== null) return locale;
  }
  return fallback;
}

/** The keys a text may carry for one resolved language, best first. `cn` is the short one nodes write. */
const TEXT_KEYS: Readonly<Record<Locale, readonly string[]>> = {
  'zh-CN': ['zh-CN', 'cn', 'zh'],
  en: ['en'],
};

/** {name} becomes params.name. An unknown placeholder stays as written, which a reader can see. */
function interpolate(template: string, params: TextParams | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{([^}]+)\}/g, (whole: string, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * One sentence, as its owner wrote it in each language it has.
 *
 *   const ok = new Text({ en: 'OK', cn: '确认' });
 *   ok.get('zh-CN'); // '确认'
 *   ok.get('en'); // 'OK'
 *   ok.get('zh-CN', { name: 'todo' }); // {name} is filled from the parameters
 *
 * The lookup is: the resolved language's own keys (`zh-CN` / `cn` / `zh`, or `en`), then `en`, then
 * the first value the text has. A sentence written in one language is therefore never blank in the
 * other: the reader gets a foreign word, which is visible, rather than an empty button.
 *
 * A `Text` is immutable and holds no state outside itself: the same instance can be shared, and the
 * language is an argument, not a field, so one process can render two users at once.
 */
export class Text {
  /** The sentence in every language it was written in; frozen at construction. */
  readonly messages: TextMessages;

  constructor(messages: TextMessages | string) {
    const written = typeof messages === 'string' ? { en: messages } : messages;
    const copy: Record<string, string> = {};
    for (const [language, value] of Object.entries(written)) {
      if (typeof value === 'string') copy[language] = value;
    }
    this.messages = Object.freeze(copy) as TextMessages;
  }

  /** The factory form, for a node that prefers not to say `new`: `Text.of({ en: 'OK', cn: '确认' })`. */
  static of(messages: TextMessages | string): Text {
    return new Text(messages);
  }

  /** The sentence in one language: this locale, else `en`, else the first value it has, else ''. */
  get(locale: unknown = DEFAULT_LOCALE, params?: TextParams): string {
    for (const key of TEXT_KEYS[resolveLocale(locale)]) {
      const value = this.messages[key];
      if (typeof value === 'string' && value !== '') return interpolate(value, params);
    }
    const english = this.messages.en;
    if (typeof english === 'string' && english !== '') return interpolate(english, params);
    const first = Object.values(this.messages).find((value) => value !== '');
    return interpolate(first ?? '', params);
  }

  /** True when this text was written in the given language (no fallback applied). */
  has(locale: unknown): boolean {
    return TEXT_KEYS[resolveLocale(locale)].some((key) => {
      const value = this.messages[key];
      return typeof value === 'string' && value !== '';
    });
  }

  /** `${text}` and `String(text)` read the default language: handy in a log line. */
  toString(): string {
    return this.get();
  }
}
