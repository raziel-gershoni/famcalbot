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
  return (language && LANGUAGE_TO_LOCALE[language]) || 'en';
}

export function getLanguageFromLocale(locale: string | undefined | null): string {
  return (locale && LOCALE_TO_LANGUAGE[locale]) || 'English';
}

export function isRtlLocale(locale: string): boolean {
  return RTL_LOCALES.includes(locale);
}

export function getLocaleInfo(language: string | undefined | null): { locale: string; dir: 'rtl' | 'ltr' } {
  const locale = getLocaleFromLanguage(language);
  return { locale, dir: isRtlLocale(locale) ? 'rtl' : 'ltr' };
}
