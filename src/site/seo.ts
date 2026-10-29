// The public site's metadata, one shape for every page (spec 2026-10-28-public-website §6.4): a canonical URL and the
// page in each language (English unprefixed, with x-default), the title and description from messages, the share
// image of the page's language (/og/<locale>.png, app/og/[file]/route.tsx) and its alt text, for Open Graph and X.

import type { Metadata } from 'next';
import { getPathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { SITE_URL } from './config';

export const OG_SIZE = { width: 1200, height: 630 } as const;
const OG_LOCALE: Record<string, string> = { en: 'en_US', he: 'he_IL', ru: 'ru_RU' };

/** A page's absolute URL in a language: English unprefixed ("https://famcal.bot/blog"), the home with no slash. */
export function pageUrl(locale: string, path: string): string {
  const pathname = getPathname({ locale, href: path });
  return pathname === '/' ? SITE_URL : `${SITE_URL}${pathname}`;
}

/** The page in every language, and x-default (the English one). */
export function languageAlternates(path: string): Record<string, string> {
  return { ...Object.fromEntries(routing.locales.map((l) => [l, pageUrl(l, path)])), 'x-default': pageUrl(routing.defaultLocale, path) };
}

export function siteMetadata(a: {
  locale: string;
  path: string;
  title: string;
  description: string;
  /** The share image's alt text: landing.meta.ogImageAlt. */
  imageAlt: string;
  /** The landing's title stands alone (no "| FamCal"). */
  absoluteTitle?: boolean;
  /** Open Graph's own title, when it differs from the page's. */
  ogTitle?: string;
  type?: 'website' | 'article';
}): Metadata {
  const url = pageUrl(a.locale, a.path);
  const image = { url: `/og/${a.locale}.png`, ...OG_SIZE, alt: a.imageAlt };
  return {
    title: a.absoluteTitle ? { absolute: a.title } : a.title,
    description: a.description,
    alternates: { canonical: url, languages: languageAlternates(a.path) },
    openGraph: {
      type: a.type ?? 'website',
      siteName: 'FamCal',
      locale: OG_LOCALE[a.locale] ?? OG_LOCALE.en,
      url,
      title: a.ogTitle ?? a.title,
      description: a.description,
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: a.ogTitle ?? a.title, description: a.description, images: [image] },
  };
}
