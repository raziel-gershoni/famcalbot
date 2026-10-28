// Valid locale codes used in the app
export const VALID_LOCALES = ['he', 'en', 'ru'] as const;
export type Locale = (typeof VALID_LOCALES)[number];

const RTL_LOCALES = ['he', 'ar', 'fa'];

/**
 * Validate and normalize a locale code
 * Only accepts valid locale codes ('he', 'en', 'ru')
 * Returns 'en' as fallback for any invalid value (including legacy 'Hebrew', 'Russian')
 */
export function normalizeLocale(locale: string | undefined | null): Locale {
  if (!locale) return 'en';
  if (VALID_LOCALES.includes(locale as Locale)) return locale as Locale;
  return 'en';
}

/**
 * The language a message is written in, from its letters: any Hebrew letter gives 'he', else any Cyrillic letter
 * gives 'ru', else 'en'. For a first message from someone we know nothing else about (a new WhatsApp contact);
 * it only starts them off, they can change the language afterwards.
 */
export function guessLanguageFromText(text: string): Locale {
  if (/[\u05D0-\u05EA]/.test(text)) return 'he';
  if (/\p{Script=Cyrillic}/u.test(text)) return 'ru';
  return 'en';
}

/**
 * The first app locale a browser asks for in its Accept-Language header, by q-value
 * ('he-IL' counts as 'he'; 'iw' is the old code for Hebrew), else 'en'.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  const ranked = (header ?? '')
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
      return { lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter(r => r.lang && r.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { lang } of ranked) {
    const code = lang === 'iw' ? 'he' : lang;
    if (VALID_LOCALES.includes(code as Locale)) return code as Locale;
  }
  return 'en';
}

/**
 * Check if a locale uses right-to-left text direction
 */
export function isRtlLocale(locale: string): boolean {
  return RTL_LOCALES.includes(locale);
}

/**
 * Get locale info including text direction
 */
export function getLocaleInfo(locale: string | undefined | null): { locale: Locale; dir: 'rtl' | 'ltr' } {
  const normalized = normalizeLocale(locale);
  return { locale: normalized, dir: isRtlLocale(normalized) ? 'rtl' : 'ltr' };
}
