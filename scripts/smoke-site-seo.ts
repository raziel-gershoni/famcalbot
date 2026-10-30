// Smoke test for the public site's SEO (plan docs/superpowers/plans/2026-10-29-public-website.md, Task 6; spec
// 2026-10-28-public-website §6.4).
//
//  - S1 every public page in en, he and ru has a canonical URL, its other languages and x-default, English unprefixed
//    and never /en; the title and description from messages; the share image of its language with its alt text, for
//    Open Graph and X; the landing's title stands alone; the share page stays noindex, with no canonical or languages;
//    a zmanim city page with a day and a community in its query still names the clean URL.
//  - S2 the sitemap: every indexed page in every language at the URL it is served at (no /en, no how-it-works, no
//    share page, no Mini App), Privacy and Terms included, the zmanim index and every city of src/site/cities.ts, each
//    with its languages and x-default, and the day its content changed, never the build's "now".
//  - S3 robots: the API and the Google connect pages kept out, no /admin, the zmanim pages with a query kept out in
//    every language while the clean ones stay open, the sitemap at the site's URL.
//  - S4 the share image answers per language: a 1200 x 630 PNG for en, he and ru, a 404 for anything else.
//
// The pages' metadata and the routes run as Next runs them (next-intl's server API over the real messages). No network.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-site-seo.ts

import { createRequire } from 'node:module';
import { assert, check, finish, LOCALES, load, messages, show, stubIntlServer, stubMdx, type Locale, type Row } from './lib/site-harness';

const SITE = 'https://famcal.bot';
const url = (locale: Locale, path: string) => `${SITE}${locale === 'en' ? '' : `/${locale}`}${path === '/' ? '' : path}`;
const POST = '/blog/why-i-built-famcal';
const CITY = 'jerusalem';
const { createTranslator } = createRequire(__filename)('next-intl');
/** A message with its arguments, as the page's translator words it. */
const word = (l: Locale, key: string, values: Record<string, string | number> = {}): string => createTranslator({ locale: l, messages: messages[l] })(key, values);

async function main() {
  stubIntlServer();
  stubMdx();
  const { getPostBySlug } = await load('src/lib/blog.ts');

  await check('S1 every public page in en, he and ru: canonical, its languages and x-default (English unprefixed), title and description from messages, the share image of its language with its alt, for Open Graph and X; the landing\'s title alone; the share page noindex, with no alternates; a zmanim city page with a query names the clean URL', async () => {
    const { CITIES } = await load('src/site/cities.ts');
    const pages: { rel: string; path: string; title: (l: Locale) => string; description: (l: Locale) => string; params?: Row }[] = [
      { rel: 'app/[locale]/(site)/page.tsx', path: '/', title: (l) => messages[l].landing.meta.title, description: (l) => messages[l].landing.meta.description },
      { rel: 'app/[locale]/(site)/blog/page.tsx', path: '/blog', title: (l) => messages[l].site.meta.blog.title, description: (l) => messages[l].site.meta.blog.description },
      { rel: 'app/[locale]/(site)/blog/[slug]/page.tsx', path: POST, params: { slug: 'why-i-built-famcal' }, title: (l) => getPostBySlug('why-i-built-famcal', l).title, description: (l) => getPostBySlug('why-i-built-famcal', l).description },
      { rel: 'app/[locale]/(site)/privacy/page.tsx', path: '/privacy', title: (l) => messages[l].site.meta.privacy.title, description: (l) => messages[l].site.meta.privacy.description },
      { rel: 'app/[locale]/(site)/terms/page.tsx', path: '/terms', title: (l) => messages[l].site.meta.terms.title, description: (l) => messages[l].site.meta.terms.description },
      { rel: 'app/[locale]/(site)/share/page.tsx', path: '/share', title: (l) => messages[l].site.meta.share.title, description: (l) => messages[l].site.meta.share.description },
      { rel: 'app/[locale]/(site)/zmanim/page.tsx', path: '/zmanim', title: (l) => word(l, 'zmanimSite.index.metaTitle'), description: (l) => word(l, 'zmanimSite.index.description', { count: CITIES.length }) },
      { rel: 'app/[locale]/(site)/zmanim/[city]/page.tsx', path: `/zmanim/${CITY}`, params: { city: CITY }, title: (l) => word(l, 'zmanimSite.city.metaTitle', { city: messages[l].cities[CITY] }), description: (l) => word(l, 'zmanimSite.city.description', { city: messages[l].cities[CITY] }) },
    ];
    for (const page of pages) {
      const { generateMetadata } = await load(page.rel);
      for (const locale of LOCALES) {
        const m: Row = await generateMetadata({ params: Promise.resolve({ locale, ...(page.params ?? {}) }), searchParams: Promise.resolve({}) });
        const where = `${page.path} ${locale}`;
        if (page.path === '/share') {
          // Kept out of search: no canonical and no languages to index
          assert(m.alternates === undefined, `${where}: alternates on a noindex page ${show(m.alternates)}`);
        } else {
          assert(m.alternates?.canonical === url(locale, page.path), `${where}: canonical ${m.alternates?.canonical}`);
          const langs = m.alternates?.languages ?? {};
          assert(show(langs) === show({ en: url('en', page.path), he: url('he', page.path), ru: url('ru', page.path), 'x-default': url('en', page.path) }), `${where}: languages ${show(langs)}`);
        }
        assert(!JSON.stringify(m).includes(`${SITE}/en`), `${where}: an /en URL`);
        const title = page.path === '/' ? m.title?.absolute : m.title;
        assert(title === page.title(locale) && m.description === page.description(locale), `${where}: title ${show(m.title)}, description ${m.description}`);
        const image = m.openGraph?.images?.[0];
        assert(image?.url === `/og/${locale}.png` && image.width === 1200 && image.height === 630 && image.alt === messages[locale].landing.meta.ogImageAlt, `${where}: the share image ${show(image)}`);
        assert(m.twitter?.card === 'summary_large_image' && m.twitter.images?.[0]?.url === `/og/${locale}.png`, `${where}: X's card ${show(m.twitter)}`);
        assert(m.openGraph?.url === url(locale, page.path), `${where}: og:url ${m.openGraph?.url}`);
        if (page.path === '/share') assert(m.robots?.index === false, `${where}: indexed`);
        else assert(!m.robots, `${where}: robots ${show(m.robots)}`);
      }
    }
    // A day and a community travel in the query; the canonical, the languages and og:url stay the clean city URL
    const { generateMetadata: cityMetadata } = await load('app/[locale]/(site)/zmanim/[city]/page.tsx');
    for (const locale of LOCALES) {
      const m: Row = await cityMetadata({ params: Promise.resolve({ locale, city: CITY }), searchParams: Promise.resolve({ date: '2027-04-22', community: 'chabad' }) });
      const urls = [m.alternates?.canonical, ...Object.values(m.alternates?.languages ?? {}), m.openGraph?.url];
      assert(m.alternates?.canonical === url(locale, `/zmanim/${CITY}`) && urls.every((u) => typeof u === 'string' && !u.includes('?')), `${locale}: a city page with a query names ${show(urls)}`);
    }
  });

  await check('S2 the sitemap: every indexed page in every language at its own URL (no /en, no how-it-works, no share page, no Mini App), Privacy and Terms in, the zmanim index and every city, each with its languages and x-default, and the day its content changed', async () => {
    const { default: sitemap } = await load('app/sitemap.ts');
    const { LEGAL_UPDATED } = await load('src/site/legal.ts');
    const { SITE_CONTENT_UPDATED } = await load('src/site/config.ts');
    const entries: Row[] = sitemap();
    const urls = entries.map((e) => e.url);
    const { CITIES } = await load('src/site/cities.ts');
    const want = ['/', '/blog', POST, '/privacy', '/terms', '/zmanim', ...CITIES.map((c: Row) => `/zmanim/${c.slug}`)].flatMap((p) => LOCALES.map((l) => url(l, p)));
    assert(show([...urls].sort()) === show([...want].sort()), `the URLs ${show(urls)}`);
    assert(!urls.some((u) => /\/en(\/|$)|how-it-works|\/share|dashboard|settings|admin/.test(u)), `a URL that redirects or is private: ${show(urls)}`);
    // The dates are the content's: the sitemap reads no clock (a "now" would equal the content's date on the day it changed)
    const src = (await import('node:fs')).readFileSync(require.resolve('../app/sitemap.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert(!/new Date\(|Date\.now/.test(src), 'the sitemap reads the clock');
    const today = new Date().toISOString().slice(0, 10);
    for (const e of entries) {
      const path = e.url.replace(SITE, '').replace(/^\/(he|ru)(?=\/|$)/, '') || '/';
      const day = /\/privacy$/.test(path) ? LEGAL_UPDATED.privacy : /\/terms$/.test(path) ? LEGAL_UPDATED.terms : SITE_CONTENT_UPDATED;
      assert(e.lastModified === day, `${e.url}: lastModified ${e.lastModified}, want ${day}`);
      assert(typeof e.lastModified === 'string' && (e.lastModified !== today || day === today), `${e.url}: lastModified is the build day`);
      assert(show(e.alternates?.languages) === show({ en: url('en', path), he: url('he', path), ru: url('ru', path), 'x-default': url('en', path) }), `${e.url}: languages ${show(e.alternates?.languages)}`);
    }
  });

  await check('S3 robots: the API and the Google connect pages kept out, no /admin, the zmanim pages with a query kept out in every language and the clean ones open, the sitemap at the site\'s URL', async () => {
    const { default: robots } = await load('app/robots.ts');
    const r: Row = robots();
    const disallow: string[] = r.rules.disallow;
    for (const path of ['/api/', '/oauth-callback', '/oauth-complete', '/refresh-token', '/zmanim/*?', '/he/zmanim/*?', '/ru/zmanim/*?']) assert(disallow.includes(path), `${path} is not kept out`);
    assert(!disallow.some((p) => p.startsWith('/admin')), `robots names /admin: ${show(disallow)}`);
    // A rule as a crawler reads it: a prefix of the path and query, * for any run of characters
    const blocks = (rule: string, target: string) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`).test(target);
    for (const target of ['/zmanim/jerusalem?date=2027-04-22', '/he/zmanim/haifa?community=chabad', '/ru/zmanim/moscow?date=2027-06-11&community=ashkenazi']) assert(disallow.some((p) => blocks(p, target)), `${target} is open to crawlers`);
    for (const target of ['/zmanim', '/zmanim/jerusalem', '/he/zmanim', '/he/zmanim/jerusalem', '/ru/zmanim/moscow']) assert(!disallow.some((p) => blocks(p, target)), `${target} is kept out: ${show(disallow)}`);
    assert(r.sitemap === `${SITE}/sitemap.xml`, `the sitemap ${r.sitemap}`);
  });

  await check('S4 the share image answers per language: a 1200 x 630 PNG for en, he and ru, built statically; a 404 for anything else', async () => {
    const route = await load('app/og/[file]/route.tsx');
    assert(route.dynamic === 'force-static' && route.dynamicParams === false, `the route is not static: ${route.dynamic}, ${route.dynamicParams}`);
    assert(show(route.generateStaticParams()) === show(LOCALES.map((l) => ({ file: `${l}.png` }))), `its files ${show(route.generateStaticParams())}`);
    for (const locale of LOCALES) {
      const res: Response = await route.GET(new Request(`${SITE}/og/${locale}.png`), { params: Promise.resolve({ file: `${locale}.png` }) });
      const body = Buffer.from(await res.arrayBuffer());
      assert(res.status === 200 && res.headers.get('content-type') === 'image/png', `${locale}: ${res.status} ${res.headers.get('content-type')}`);
      assert(body.subarray(1, 4).toString() === 'PNG' && body.readUInt32BE(16) === 1200 && body.readUInt32BE(20) === 630, `${locale}: not a 1200 x 630 PNG`);
    }
    const res: Response = await route.GET(new Request(`${SITE}/og/fr.png`), { params: Promise.resolve({ file: 'fr.png' }) });
    assert(res.status === 404, `fr: ${res.status}`);
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
