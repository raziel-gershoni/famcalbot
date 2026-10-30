import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/src/site/config';

// Search engines read the public site and nothing behind it: not the API, and not the Google connect pages. The Mini
// App's pages say noindex themselves (app/[locale]/(app)/layout.tsx). A zmanim city page with a day or a community in
// its query is kept out in every language (spec 2026-10-30-public-zmanim §4.3): a calendar is an endless set of URLs,
// and each such page names its clean URL as canonical.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/oauth-callback', '/oauth-complete', '/refresh-token', '/zmanim/*?', '/he/zmanim/*?', '/ru/zmanim/*?'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
