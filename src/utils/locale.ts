const LANGUAGE_TO_LOCALE: Record<string, string> = {
  Hebrew: 'he',
  Russian: 'ru',
  English: 'en',
};

const LOCALE_TO_LANGUAGE: Record<string, string> = {
  he: 'Hebrew',
  ru: 'Russian',
  en: 'English',
};

const RTL_LOCALES = ['he', 'ar', 'fa'];

export function getLocaleFromLanguage(language: string | undefined | null): string {
  if (!language) return 'en';
  // Handle full language names (Hebrew, English, Russian)
  if (LANGUAGE_TO_LOCALE[language]) return LANGUAGE_TO_LOCALE[language];
  // Handle locale codes that might already be in DB (he, en, ru) - for backwards compatibility
  if (LOCALE_TO_LANGUAGE[language]) return language;
  return 'en';
}

export function getLanguageFromLocale(locale: string | undefined | null): string {
  if (!locale) return 'English';
  // Handle locale codes (he, en, ru)
  if (LOCALE_TO_LANGUAGE[locale]) return LOCALE_TO_LANGUAGE[locale];
  // Handle full language names that might already be correct (Hebrew, English, Russian)
  if (LANGUAGE_TO_LOCALE[locale]) return locale;
  return 'English';
}

export function isRtlLocale(locale: string): boolean {
  return RTL_LOCALES.includes(locale);
}

export function getLocaleInfo(language: string | undefined | null): { locale: string; dir: 'rtl' | 'ltr' } {
  const locale = getLocaleFromLanguage(language);
  return { locale, dir: isRtlLocale(locale) ? 'rtl' : 'ltr' };
}
