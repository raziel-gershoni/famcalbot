// Smoke test for the two root layouts under app/[locale] (plan docs/superpowers/plans/2026-10-29-public-website.md,
// Task 2; spec 2026-10-28-public-website §6.1): the public pages in the (site) route group and the Mini App's in (app),
// each with a root layout of its own. URLs don't change (a route group adds nothing to the path).
//
//  - L1 the split: exactly two layouts under app/[locale], one per group, and none above them; the public pages are in
//    (site), every Mini App page with PageGate, the 404 and the catch-all in (app); nothing else sits at the top.
//  - L2 the Mini App's layout as it was: the Telegram SDK before the app (beforeInteractive), no zoom, the 16 px input
//    rule and touch-action: manipulation, the whole message catalogue, and noindex for every page under it.
//  - L3 the site's layout: no Telegram SDK, zoom allowed, light and dark from the device (color-scheme), no Tailwind sheet, no web font, only the site's client namespaces reach the
//    client, the page's language and direction on <html>, it renders statically (setRequestLocale), and it links the
//    site's one style sheet (/site.css, versioned by its content, cached for good under its own version, never under
//    another).
//  - L4 the site's metadata comes from messages, per language: the title, its template, the description, the keywords
//    and the share image's alt text.
//  - L5 a partner's invite link unfurls: the invite page's own title and words, the share image of its language, noindex.
//
// The layouts run as Next runs them (the layout as a function), with next-intl's server API over the real messages.
// No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-site-layouts.ts

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createElement as h, type ReactElement } from 'react';
import { assert, check, elementsOf, expand, finish, LOCALES, load, messages, readSource, request, ROOT, show, stubIntlServer, type Row } from './lib/site-harness';

const LOCALE_DIR = 'app/[locale]';
const SITE_PAGES = ['page.tsx', 'blog', 'privacy', 'terms', 'share'];
const APP_PAGES = ['PageGate.tsx', 'not-found.tsx', '[...rest]', 'admin-panel', 'calendars', 'dashboard', 'feedback', 'invite', 'pair', 'select-calendars', 'settings', 'share-story', 'subscription'];
/** The namespaces the spec lets reach the site's client (§6.1, plan Task 2): the site's own, and what the live parts read. */
const SITE_NAMESPACES = ['site', 'landing', 'legal', 'blog', 'share'];

const layoutsUnder = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return layoutsUnder(rel);
    return /^layout\.tsx?$/.test(entry.name) ? [rel] : [];
  });

async function main() {
  stubIntlServer();

  await check('L1 the split: one root layout per group under app/[locale] and none above them; the public pages in (site), the Mini App pages, PageGate, the 404 and the catch-all in (app)', () => {
    assert(!fs.existsSync(path.join(ROOT, 'app/layout.tsx')) && !fs.existsSync(path.join(ROOT, `${LOCALE_DIR}/layout.tsx`)), 'a layout above the groups');
    const layouts = layoutsUnder(LOCALE_DIR).sort();
    assert(show(layouts) === show([`${LOCALE_DIR}/(app)/layout.tsx`, `${LOCALE_DIR}/(site)/layout.tsx`]), `layouts: ${show(layouts)}`);
    const top = fs.readdirSync(path.join(ROOT, LOCALE_DIR)).sort();
    assert(show(top) === show(['(app)', '(site)']), `app/[locale] holds ${show(top)}`);
    for (const page of SITE_PAGES) assert(fs.existsSync(path.join(ROOT, `${LOCALE_DIR}/(site)/${page}`)), `(site) has no ${page}`);
    for (const page of APP_PAGES) assert(fs.existsSync(path.join(ROOT, `${LOCALE_DIR}/(app)/${page}`)), `(app) has no ${page}`);
    const strays = fs.readdirSync(path.join(ROOT, `${LOCALE_DIR}/(app)`)).filter((name) => ![...APP_PAGES, 'layout.tsx'].includes(name));
    assert(strays.length === 0, `(app) also holds ${show(strays)}`);
    assert(fs.existsSync(path.join(ROOT, 'app/(connect)/layout.tsx')), 'the connect pages lost their root layout');
  });

  const { default: AppLayout, viewport: appViewport, metadata: appMetadata } = await load(`${LOCALE_DIR}/(app)/layout.tsx`);
  const { default: SiteLayout, viewport: siteViewport, generateMetadata, generateStaticParams } = await load(`${LOCALE_DIR}/(site)/layout.tsx`);
  // Either build of each module (the layouts' own imports may be the CommonJS or the ESM copy)
  const nodeRequire = createRequire(__filename);
  const providers = new Set<unknown>([nodeRequire('next-intl').NextIntlClientProvider, (await import('next-intl')).NextIntlClientProvider]);
  const scriptTypes = new Set<unknown>([nodeRequire('next/script').default, (await import('next/script')).default]);
  const isScript = (e: ReactElement) => scriptTypes.has(e.type);

  const tree = async (Layout: (props: Row) => Promise<ReactElement>, locale: string): Promise<ReactElement[]> => {
    const el = await expand(h(Layout as never, { params: Promise.resolve({ locale }), children: h('main', { id: 'page' }) }));
    return elementsOf(el);
  };
  const providerOf = (els: ReactElement[]) => els.find((e) => providers.has(e.type));

  await check('L2 the Mini App layout as it was: the Telegram SDK beforeInteractive in <head>, no zoom (maximumScale 1, userScalable false), the 16 px input rule and touch-action: manipulation, the whole catalogue, and noindex', async () => {
    assert(appViewport.maximumScale === 1 && appViewport.userScalable === false, `viewport ${show(appViewport)}`);
    assert(appMetadata.robots?.index === false && appMetadata.robots?.follow === false, `robots ${show(appMetadata.robots)}`);
    for (const locale of LOCALES) {
      // The proxy put the locale on the request; getMessages() reads it there
      request.locale = locale;
      const els = await tree(AppLayout, locale);
      const html = els[0];
      assert(html.type === 'html' && (html.props as Row).lang === locale && (html.props as Row).dir === (locale === 'he' ? 'rtl' : 'ltr'), `${locale}: <html> ${show(html.props)}`);
      const head = els.find((e) => e.type === 'head');
      assert(head, `${locale}: no <head>`);
      const scripts = elementsOf((head.props as Row).children).filter(isScript);
      assert(scripts.length === 1 && (scripts[0].props as Row).src === 'https://telegram.org/js/telegram-web-app.js' && (scripts[0].props as Row).strategy === 'beforeInteractive', `${locale}: the SDK ${show(scripts.map((s) => s.props))}`);
      const style = String((elementsOf((head.props as Row).children).find((e) => e.type === 'style')?.props as Row | undefined)?.children ?? '');
      assert(/input, select, textarea \{\s*font-size: 16px !important;/.test(style) && /html \{\s*touch-action: manipulation;/.test(style), `${locale}: the zoom rules: ${style}`);
      const provider = providerOf(els);
      assert(provider && (provider.props as Row).messages === messages[locale], `${locale}: the provider is not handed the whole catalogue`);
    }
  });

  await check('L3 the site layout: no Telegram SDK and no web font (in its source or its tree), zoom allowed, only the site\'s client namespaces reach the client, <html> in the page\'s language and direction, the request locale set for static rendering, a static page per locale', async () => {
    const src = readSource(`${LOCALE_DIR}/(site)/layout.tsx`).replace(/^\s*\/\/.*$/gm, '');
    assert(!/telegram-web-app|next\/script/.test(src), 'the site layout loads the Telegram SDK');
    assert(!/fonts\.(googleapis|gstatic)\.com|next\/font/.test(src), 'the site layout loads a web font');
    assert(!('maximumScale' in siteViewport) && !('userScalable' in siteViewport), `viewport ${show(siteViewport)}`);
    assert(siteViewport.colorScheme === 'light dark', `color-scheme ${siteViewport.colorScheme}`);
    assert(!/globals\.css|tailwind/i.test(src), 'the site layout loads the app\'s Tailwind sheet');
    assert(show(generateStaticParams()) === show(LOCALES.map((locale) => ({ locale }))), `static params ${show(generateStaticParams())}`);
    for (const locale of LOCALES) {
      request.locale = 'en';
      const els = await tree(SiteLayout, locale);
      assert((request.locale as string) === locale, `${locale}: setRequestLocale was not called`);
      const html = els[0];
      assert(html.type === 'html' && (html.props as Row).lang === locale && (html.props as Row).dir === (locale === 'he' ? 'rtl' : 'ltr'), `${locale}: <html> ${show(html.props)}`);
      assert(!els.some((e) => isScript(e) || (e.type === 'script' && /telegram/.test(String((e.props as Row).src ?? '')))), `${locale}: a script in the layout`);
      assert(!els.some((e) => e.type === 'link' && /fonts\./.test(String((e.props as Row).href ?? ''))), `${locale}: a font link`);
      const provider = providerOf(els);
      assert(provider, `${locale}: no provider`);
      const passed = Object.keys((provider.props as Row).messages ?? {});
      assert(passed.length > 0 && passed.every((ns) => SITE_NAMESPACES.includes(ns)), `${locale}: the client gets ${show(passed)}`);
      for (const ns of passed) assert((provider.props as Row).messages[ns] === messages[locale][ns], `${locale}: ${ns} is not the catalogue's`);
      assert((provider.props as Row).locale === locale, `${locale}: the provider's locale is ${(provider.props as Row).locale}`);
      const sheets = els.filter((e) => e.type === 'link' && (e.props as Row).rel === 'stylesheet').map((e) => String((e.props as Row).href));
      assert(sheets.length === 1 && /^\/site\.css\?v=[0-9a-f]{12}$/.test(sheets[0]), `${locale}: the style sheets ${show(sheets)}`);
    }
    // The sheet itself: the site's CSS, as CSS, cached for good under its own version only (its URL changes with its
    // content); any other version (a deploy's overlap: the other build's hash) is never stored
    const { GET, dynamic } = await load('app/site.css/route.ts');
    const { SITE_CSS, SITE_CSS_HREF } = await load('src/site/site-css.ts');
    const res: Response = GET(new Request(`https://famcal.bot${SITE_CSS_HREF}`));
    assert(dynamic !== 'force-static' && res.headers.get('content-type') === 'text/css; charset=utf-8' && res.headers.get('cache-control') === 'public, max-age=31536000, immutable', `the sheet's headers: ${dynamic}, ${res.headers.get('content-type')}, ${res.headers.get('cache-control')}`);
    assert((await res.text()) === SITE_CSS, 'the sheet is not SITE_CSS');
    for (const url of ['https://famcal.bot/site.css?v=000000000000', 'https://famcal.bot/site.css', `https://famcal.bot${SITE_CSS_HREF}0`]) {
      const other: Response = GET(new Request(url));
      assert(other.headers.get('cache-control') === 'no-store' && (await other.text()) === SITE_CSS, `${url}: ${other.headers.get('cache-control')}`);
    }
    const { createHash } = await import('node:crypto');
    assert(SITE_CSS_HREF === `/site.css?v=${createHash('sha256').update(SITE_CSS).digest('hex').slice(0, 12)}`, `the sheet's version ${SITE_CSS_HREF}`);
  });

  await check('L4 the site metadata from messages in en, he and ru: the title and its "%s | FamCal" template, the description, the keywords and the share image\'s alt; the site URL as metadataBase', async () => {
    for (const locale of LOCALES) {
      const m = await generateMetadata({ params: Promise.resolve({ locale }) });
      const l = messages[locale];
      assert(m.title?.default === l.landing.meta.title && m.title?.template === '%s | FamCal', `${locale}: title ${show(m.title)}`);
      assert(m.description === l.landing.meta.description, `${locale}: description ${m.description}`);
      assert(m.keywords === l.site.meta.keywords, `${locale}: keywords ${m.keywords}`);
      assert(m.openGraph?.images?.[0]?.alt === l.landing.meta.ogImageAlt, `${locale}: og alt ${show(m.openGraph?.images)}`);
      assert(String(m.metadataBase) === 'https://famcal.bot/', `${locale}: metadataBase ${m.metadataBase}`);
    }
  });

  await check('L5 a partner\'s invite link unfurls where it is pasted: the invite page\'s title and words from messages and the site\'s share image in the page\'s language (absolute), with nothing about the inviter, and still noindex', async () => {
    const { generateMetadata: inviteMetadata } = await load(`${LOCALE_DIR}/(app)/invite/[token]/page.tsx`);
    for (const locale of LOCALES) {
      const m = await inviteMetadata({ params: Promise.resolve({ locale, token: 'a'.repeat(32) }) });
      const l = messages[locale];
      assert(m.title === l.invite.metaTitle && m.description === l.invite.subtitle, `${locale}: title ${show(m.title)}, description ${show(m.description)}`);
      assert(m.robots?.index === false && m.robots?.follow === false, `${locale}: robots ${show(m.robots)}`);
      for (const card of [m.openGraph, m.twitter]) {
        const image = card?.images?.[0];
        assert(card?.title === m.title && image?.url === `https://famcal.bot/og/${locale}.png` && image?.alt === l.landing.meta.ogImageAlt, `${locale}: the card ${show(card)}`);
      }
      assert(m.twitter?.card === 'summary_large_image' && m.openGraph?.images?.[0]?.width === 1200, `${locale}: the image's size or card ${show(m.twitter)}`);
    }
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
