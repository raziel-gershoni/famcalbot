import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/src/site/config';

// Search engines read the public site and nothing behind it: not the API, and not the Google connect pages. The Mini
// App's pages say noindex themselves (app/[locale]/(app)/layout.tsx).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/oauth-callback', '/oauth-complete', '/refresh-token'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
