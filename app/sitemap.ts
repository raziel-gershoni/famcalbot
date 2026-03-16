import { MetadataRoute } from 'next';
import { getAllSlugs } from '@/src/lib/blog';

const locales = ['en', 'he', 'ru'];
const baseUrl = 'https://famcal.bot';

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages = [
    { path: '', changeFrequency: 'weekly' as const, priority: 1.0 },
    { path: '/blog', changeFrequency: 'weekly' as const, priority: 0.8 },
  ];

  const staticEntries = staticPages.flatMap((page) =>
    locales.map((locale) => ({
      url: `${baseUrl}/${locale}${page.path}`,
      lastModified: new Date(),
      changeFrequency: page.changeFrequency,
      priority: page.priority,
      alternates: {
        languages: Object.fromEntries(
          locales.map((l) => [l, `${baseUrl}/${l}${page.path}`])
        ),
      },
    }))
  );

  const blogSlugs = getAllSlugs();
  const blogEntries = blogSlugs.flatMap((slug) =>
    locales.map((locale) => ({
      url: `${baseUrl}/${locale}/blog/${slug}`,
      lastModified: new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
      alternates: {
        languages: Object.fromEntries(
          locales.map((l) => [l, `${baseUrl}/${l}/blog/${slug}`])
        ),
      },
    }))
  );

  return [...staticEntries, ...blogEntries];
}
