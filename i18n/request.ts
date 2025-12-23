import { getRequestConfig } from 'next-intl/server';
import { notFound } from 'next/navigation';

// List of supported locales
export const locales = ['en', 'he'] as const;
export type Locale = (typeof locales)[number];

export default getRequestConfig(async ({ locale }) => {
  // Validate that the incoming `locale` parameter is valid
  if (!locales.includes(locale as Locale)) notFound();

  return {
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
