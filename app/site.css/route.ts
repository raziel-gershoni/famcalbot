import { SITE_CSS, SITE_CSS_VERSION } from '@/src/site/site-css';

// The public site's one style sheet as a file (spec 2026-10-28-public-website §5.1): the (site) layout links it as
// /site.css?v=<its hash>, so a browser keeps it across the site's pages and a new deploy's sheet is a new URL. Outside
// the proxy's matcher (a path with a dot), so no locale is added.
//
// Cached for good only under this build's own version. During a deploy's overlap a request can carry the other build's
// version and reach this one: that answer is never stored (no-store), so no browser or proxy keeps this sheet under the
// other build's URL. The route reads the query, so it runs per request; the sheet itself is built once, at import.

export function GET(request: Request) {
  const current = new URL(request.url).searchParams.get('v') === SITE_CSS_VERSION;
  return new Response(SITE_CSS, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'no-store',
    },
  });
}
