// Valid locale codes used in the app
export const VALID_LOCALES = ['he', 'en', 'ru'] as const;
export type Locale = (typeof VALID_LOCALES)[number];

const RTL_LOCALES = ['he', 'ar', 'fa'];

/**
 * Validate and normalize a locale code
 * Returns the locale if valid, 'en' as fallback
 */
export function normalizeLocale(locale: string | undefined | null): Locale {
  if (!locale) return 'en';
  if (VALID_LOCALES.includes(locale as Locale)) return locale as Locale;
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
