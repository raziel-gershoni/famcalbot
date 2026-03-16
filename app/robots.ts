import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/oauth-callback',
        '/oauth-complete',
        '/oauth-success',
        '/refresh-token',
        '/admin',
      ],
    },
    sitemap: 'https://famcal.bot/sitemap.xml',
  };
}
