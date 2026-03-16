import { MetadataRoute } from 'next';

const locales = ['en', 'he', 'ru'];
const baseUrl = 'https://famcal.bot';

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [
    { path: '', changeFrequency: 'weekly' as const, priority: 1.0 },
    { path: '/blog', changeFrequency: 'weekly' as const, priority: 0.8 },
    { path: '/how-it-works', changeFrequency: 'monthly' as const, priority: 0.7 },
  ];

  return pages.flatMap((page) =>
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
}
