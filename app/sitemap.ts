import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { getAllSlugs } from '@/src/lib/blog';
import { CITIES } from '@/src/site/cities';
import { SITE_CONTENT_UPDATED } from '@/src/site/config';
import { LEGAL_UPDATED } from '@/src/site/legal';
import { languageAlternates, pageUrl } from '@/src/site/seo';

// The public site's sitemap (spec 2026-10-28-public-website §6.4): every indexed page in every language, at the URL it
// is served at (English unprefixed, never a redirect), each with its other languages and x-default, and the day its
// content last changed (never "now"). The share page is noindex and the Mini App is private: neither is listed.
// The zmanim pages (spec 2026-10-30-public-zmanim §4.3) are the index and every city of src/site/cities.ts, at their
// clean URLs only (robots.txt keeps out a day or a community in the query). Their times change daily, their content
// with the site's, so they carry SITE_CONTENT_UPDATED.

export default function sitemap(): MetadataRoute.Sitemap {
  const pages: { path: string; lastModified: string; changeFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; priority: number }[] = [
    { path: '/', lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'weekly', priority: 1 },
    { path: '/blog', lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'monthly', priority: 0.7 },
    ...getAllSlugs().map((slug) => ({ path: `/blog/${slug}`, lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'monthly' as const, priority: 0.7 })),
    { path: '/zmanim', lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'monthly', priority: 0.8 },
    ...CITIES.map((city) => ({ path: `/zmanim/${city.slug}`, lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'daily' as const, priority: 0.6 })),
    { path: '/privacy', lastModified: LEGAL_UPDATED.privacy, changeFrequency: 'yearly', priority: 0.3 },
    { path: '/terms', lastModified: LEGAL_UPDATED.terms, changeFrequency: 'yearly', priority: 0.3 },
  ];
  return pages.flatMap((page) =>
    routing.locales.map((locale) => ({
      url: pageUrl(locale, page.path),
      lastModified: page.lastModified,
      changeFrequency: page.changeFrequency,
      priority: page.priority,
      alternates: { languages: languageAlternates(page.path) },
    })),
  );
}
