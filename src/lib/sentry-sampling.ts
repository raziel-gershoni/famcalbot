// What the public site's pages send Sentry (Privacy Policy: Sentry gets error reports). A performance trace carries the
// page's address, and the zmanim pages' address names a city, a day and a custom, so:
//
// - The browser traces no page of the public site. The site's root layout marks its <html> data-surface="site"
//   (app/[locale]/(site)/layout.tsx); the Mini App's never does, so it keeps its 1% (instrumentation-client.ts). The
//   two groups have a root layout each, so moving between them is a full page load and the mark never changes in a session.
// - The server traces no zmanim page (sentry.server.config.ts), found by the root span's name or by the path in its
//   attributes or request, in any language and with or without a query. Every other route keeps its 1%.
// - Everything else is as it was with a plain 1% rate: a parent trace's decision is inherited (inheritOrSampleWith, the
//   SDK's way for a tracesSampler).
// Pure: no import, so the browser and the server configs can both take it.

/** The share of traces kept for the Mini App, the API and the jobs. */
export const TRACES_SAMPLE_RATE = 0.01;

/** The part of the SDK's sampling context these samplers read (the SDK's own type has more, and fits this). */
export type SamplerContext = {
  /** The root span's name: "GET /he/zmanim/jerusalem", or "GET /[locale]/zmanim/[city]" once Next names the route. */
  name?: string;
  attributes?: Record<string, unknown>;
  normalizedRequest?: { url?: string };
  inheritOrSampleWith?: (fallbackSampleRate: number) => number;
};

/** The parent trace's decision when there is one, else the rate. */
const inherit = (context: SamplerContext): number => (context.inheritOrSampleWith ? context.inheritOrSampleWith(TRACES_SAMPLE_RATE) : TRACES_SAMPLE_RATE);

/** The browser's sampler: no trace on a page of the public site. */
export function browserTracesSampler(context: SamplerContext): number {
  if (typeof document !== 'undefined' && document.documentElement?.dataset?.surface === 'site') return 0;
  return inherit(context);
}

/** A zmanim page's path, after its locale (the segment, or Next's route name for it): /zmanim, /he/zmanim/haifa, /[locale]/zmanim/[city]. */
const ZMANIM_PATH = /^\/(?:(?:he|ru|en|\[locale\])\/)?zmanim(?:\/|$)/;
/** The span attributes that hold a path or a URL (OpenTelemetry's, old and new, and Next's own route). */
const PATH_ATTRIBUTES = ['http.route', 'next.route', 'url.path', 'http.target', 'url.full', 'http.url'];

/** The path part of a span name ("GET /zmanim/x?date=1"), a URL or a path: no method, no origin, no query, no fragment. */
function pathOf(text: string): string {
  return text
    .replace(/^[A-Z]+\s+/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    .split(/[?#]/)[0];
}

/** Whether this root span is a request for a zmanim page, by its name or by any path the context holds. */
export function isZmanimPage(context: SamplerContext): boolean {
  const candidates = [context.name, context.normalizedRequest?.url, ...PATH_ATTRIBUTES.map((key) => context.attributes?.[key])];
  return candidates.some((candidate) => typeof candidate === 'string' && ZMANIM_PATH.test(pathOf(candidate)));
}

/** The server's sampler: no trace of a zmanim page, a plain 1% for the rest. */
export function serverTracesSampler(context: SamplerContext): number {
  if (isZmanimPage(context)) return 0;
  return inherit(context);
}
