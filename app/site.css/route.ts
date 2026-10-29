import { SITE_CSS } from '@/src/site/site-css';

// The public site's one style sheet as a file (spec 2026-10-28-public-website §5.1): the (site) layout links it as
// /site.css?v=<its hash>, so a browser keeps it across the site's pages and a new deploy's sheet is a new URL. Built
// once, at build time. Outside the proxy's matcher (a path with a dot), so no locale is added.

export const dynamic = 'force-static';

export function GET() {
  return new Response(SITE_CSS, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
