// Smoke test for the public site's other pages (plan docs/superpowers/plans/2026-10-29-public-website.md, Task 5; spec
// 2026-10-28-public-website §3.3, §7).
//
//  - P1 /how-it-works is gone: a permanent redirect to the landing's #how in the visitor's language, in one hop (English
//    unprefixed, /en/how-it-works too, Hebrew and Russian to their own landing), for every locale of i18n/routing.ts;
//    the page and its messages (howItWorksPage) are gone.
//  - P2 the blog's index and post in en, he and ru: the site's chrome, the post's title, the byline from messages, the
//    way back to the blog, and at the end the two start buttons (one class list, Telegram first) with the honest line;
//    no emoji, no early access, no inline start links left in the post.
//  - P3 Privacy and Terms in en, he and ru: the title, a real "last updated" date in the page's language, and the
//    approved text's sections (its `##` headings), in its order, each with its id and heading; the same sections and
//    the same shape of blocks (paragraphs, lists, nested lists, sub-headings) in every language; the anchors other pages
//    link to (/terms#cancel on an h3, /privacy#google); every mark drawn (bold, code, links), none left raw; addresses
//    and "Privacy Policy" linked, the bot's /paysupport and /feedback plain text kept left to right; the seller's
//    details from src/lib/seller.ts (the same arguments in every language, the "to be added" words for a missing one,
//    the value, linked where it is an email or a phone, once given).
//  - P4 the share page in en, he and ru: the site's chrome, its words from messages (the Copy label too), the three
//    messages, the QR codes and the three links; kept out of search.
//  - P5 a page that doesn't exist under the site (a blog post) gets the site's own 404, in the page's language, with the
//    way home.
//
// The pages run as Next runs them on the server (the page as a function, next-intl's server API over the real
// messages). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-site-pages.ts

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { assert, check, decodeEntities, EMOJI, finish, LOCALES, load, messages, request, render, ROOT, show, stub, stubIntlServer, stubMdx, strayLtrTokens, textOf, UNTRUE, type Locale, type Row } from './lib/site-harness';

const nodeRequire = createRequire(__filename);
const { NextIntlClientProvider } = nodeRequire('next-intl');
const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };

const PRIVACY_SECTIONS = ['who', 'required', 'keep', 'notKeep', 'sensitive', 'use', 'google', 'processors', 'partner', 'cookies', 'retention', 'rights', 'euUk', 'children', 'security', 'changes', 'contact'];
const TERMS_SECTIONS = ['about', 'operator', 'service', 'eligibility', 'account', 'plans', 'ai', 'delivery', 'fairUse', 'suspension', 'changes', 'liability', 'law', 'contact'];
const POST = 'why-i-built-famcal';

const attrs = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => m[1]);
const attr = (a: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(a)?.[1];
const prefix = (l: Locale) => (l === 'en' ? '' : `/${l}`);

async function main() {
  stubIntlServer();
  // notFound() as Next throws it; the page's own call is what the check sees
  class NotFound extends Error {}
  stub(nodeRequire.resolve('next/navigation'), { ...nodeRequire('next/navigation'), notFound: () => { throw new NotFound('NEXT_NOT_FOUND'); } });
  stubMdx();

  const wrap = (locale: Locale, el: ReactElement) =>
    render(h(AppRouterContext.Provider, { value: router }, h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, el) as unknown as ReactElement));
  const page = async (rel: string, locale: Locale, extra: Row = {}) => {
    request.locale = locale;
    const { default: Page } = await load(rel);
    const el = (await Page({ params: Promise.resolve({ locale, ...extra }) })) as ReactElement;
    return wrap(locale, el);
  };
  const common = (locale: Locale, html: string, where: string) => {
    assert(html.includes('class="site-header"') && html.includes('class="site-footer"'), `${where} ${locale}: not in the site's chrome`);
    assert(!EMOJI.test(html.replace(/https:\/\/wa\.me\/[^"\s]+/g, '')), `${where} ${locale}: an emoji: ${html.match(EMOJI)?.[0]}`);
    const text = decodeEntities(html);
    for (const [claim, pattern] of UNTRUE) assert(!pattern.test(text), `${where} ${locale}: ${claim}: ${text.match(pattern)?.[0]}`);
    assert(!/\b(?:landing|site|blog|share|legal|ui)\.[a-z]+[A-Za-z.]*\b/.test(textOf(html).replace(/famcal\.bot|t\.me\/\S+|wa\.me\/\S+/g, '')), `${where} ${locale}: a raw key`);
  };

  await check('P1 /how-it-works: a permanent redirect to the landing\'s #how per language in one hop (English unprefixed, /en too), for every locale; the page and its messages are gone', async () => {
    const config = nodeRequire(path.join(ROOT, 'next.config.js'));
    const redirects: Row[] = await config.redirects();
    const { routing } = await load('i18n/routing.ts');
    const want = (from: string) => {
      for (const r of redirects) {
        const pattern = new RegExp(`^${r.source.replace(/:locale\(([^)]+)\)/, '(?<locale>$1)')}$`);
        const m = pattern.exec(from);
        if (m) return { to: r.destination.replace(':locale', m.groups?.locale ?? ''), permanent: r.permanent };
      }
      return null;
    };
    for (const locale of routing.locales as Locale[]) {
      const paths = locale === 'en' ? ['/how-it-works', '/en/how-it-works'] : [`/${locale}/how-it-works`];
      for (const from of paths) {
        const r = want(from);
        const to = locale === 'en' ? '/#how' : `/${locale}#how`;
        assert(r && r.to === to && r.permanent === true, `${from} → ${show(r)}, want ${to} (permanent)`);
      }
    }
    assert(!fs.existsSync(path.join(ROOT, 'app/[locale]/(site)/how-it-works')), 'the page is still there');
    for (const locale of LOCALES) assert(!('howItWorksPage' in messages[locale]), `${locale}: howItWorksPage is still in messages`);
  });

  await check('P2 the blog in en, he and ru: the index lists the post; the post has its title, the byline from messages, the way back, and ends with the two start buttons (one class list, Telegram first) and the honest line; no inline start links', async () => {
    const { getPostBySlug } = await load('src/lib/blog.ts');
    for (const locale of LOCALES) {
      const post = getPostBySlug(POST, locale);
      const index = await page('app/[locale]/(site)/blog/page.tsx', locale);
      common(locale, index, 'blog');
      assert(decodeEntities(index).includes(post.title) && attrs(index, 'a').some((a) => attr(a, 'href') === `${prefix(locale)}/blog/${POST}`), `${locale}: the index has no link to the post`);
      const html = await page('app/[locale]/(site)/blog/[slug]/page.tsx', locale, { slug: POST });
      common(locale, html, 'post');
      const text = decodeEntities(textOf(html));
      const b = messages[locale].blog;
      assert(text.includes(post.title) && text.includes(b.byline.replace('{author}', post.author)), `${locale}: the title and byline`);
      assert(attrs(html, 'a').some((a) => attr(a, 'href') === `${prefix(locale)}/blog`) && text.includes(b.backToBlog), `${locale}: the way back`);
      const cta = html.slice(html.indexOf('<aside class="site-cta"'));
      const starts = attrs(cta, 'a').filter((a) => attr(a, 'class') === 'site-start');
      assert(starts.length === 2 && attr(starts[0], 'data-channel') === 'telegram' && attr(starts[1], 'data-channel') === 'whatsapp', `${locale}: the post's start buttons ${show(starts)}`);
      assert(decodeEntities(cta).includes(messages[locale].site.cta.honest) && decodeEntities(cta).includes(b.tryFamcal) && decodeEntities(cta).includes(b.ctaText), `${locale}: the post's end`);
      const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
      assert(!/t\.me\/family_calendar_telegram_bot|wa\.me\//.test(article), `${locale}: a start link left in the post`);
    }
  });

  await check('P3 Privacy and Terms in en, he and ru: the title, the date, the approved sections in order (ids and headings), the same block shapes in every language, the #cancel and #google anchors, every mark drawn, links and plain commands, the seller\'s details', async () => {
    const { LEGAL_UPDATED, linkParts, inlineParts, SELLER_ARGS } = await load('src/site/legal.ts');
    const { SELLER } = await load('src/lib/seller.ts');
    // A block's shape: p (a paragraph), h or h:<id> (a sub-heading), or a list of items (s, or [its items, paragraphs after])
    const item = (i: unknown): unknown => (typeof i === 'string' ? 's' : [(i as Row).items.map(item), ((i as Row).after ?? []).length]);
    const block = (b: unknown): unknown => (typeof b === 'string' ? 'p' : Array.isArray(b) ? b.map(item) : `h${(b as Row).id ? `:${(b as Row).id}` : ''}`);
    const shape = (locale: Locale, doc: string) => JSON.stringify(Object.entries(messages[locale].legal[doc].sections).map(([id, s]) => [id, (s as Row).blocks.map(block)]));
    const strings = (node: unknown, at: string): [string, string][] =>
      typeof node === 'string' ? [[at, node]] : node && typeof node === 'object' ? Object.entries(node).flatMap(([k, v]) => strings(v, `${at}.${k}`)) : [];
    const args = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(' ');
    const article = (html: string) => html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    for (const [doc, ids] of [['privacy', PRIVACY_SECTIONS], ['terms', TERMS_SECTIONS]] as const) {
      assert(/^\d{4}-\d{2}-\d{2}$/.test(LEGAL_UPDATED[doc]) && !Number.isNaN(Date.parse(LEGAL_UPDATED[doc])), `${doc}: the date ${LEGAL_UPDATED[doc]}`);
      const en = Object.fromEntries(strings(messages.en.legal[doc], doc));
      for (const locale of LOCALES) {
        const html = await page(`app/[locale]/(site)/${doc}/page.tsx`, locale);
        common(locale, html, doc);
        const site = messages[locale].site.meta[doc];
        const legal = messages[locale].legal;
        assert(html.includes(`<h1 class="site-h1 site-page-title">${site.title}</h1>`), `${doc} ${locale}: the title`);
        const date = new Date(`${LEGAL_UPDATED[doc]}T12:00:00Z`).toLocaleDateString({ en: 'en-GB', he: 'he-IL', ru: 'ru-RU' }[locale], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
        assert(decodeEntities(textOf(html)).includes(legal.lastUpdated.replace('{date}', date)), `${doc} ${locale}: the date line`);
        const found = [...html.matchAll(/<section id="([^"]+)" class="site-legal-section"/g)].map((m) => m[1]);
        assert(show(found) === show(ids), `${doc} ${locale}: the sections ${show(found)}, the approved text's ${show(ids)}`);
        for (const id of found) assert(html.includes(`<h2 id="${id}-title" class="site-h3">`), `${doc} ${locale}: ${id} has no heading`);
        assert(shape(locale, doc) === shape('en', doc), `${doc} ${locale}: its sections differ from English's`);
        // The seller's arguments: only SELLER_ARGS, and the same in every string as English's
        for (const [at, text] of strings(legal[doc], doc)) {
          for (const name of args(text).split(' ').filter(Boolean)) assert(SELLER_ARGS.includes(name), `${locale} ${at}: {${name}} is not a seller argument`);
          assert(args(text) === args(en[at] ?? ''), `${locale} ${at}: the arguments [${args(text)}], English has [${args(en[at] ?? '')}]`);
        }
        const body = article(html);
        const text = decodeEntities(textOf(body));
        assert(!/\*\*|`|\]\(|[{}]/.test(text), `${doc} ${locale}: a mark left raw: ${text.match(/.{0,30}(?:\*\*|`|\]\(|[{}]).{0,30}/)?.[0]}`);
        assert(/<li>(?:(?!<\/li>).)*?<ul class="site-legal-list">/.test(body) && body.includes('<strong>'), `${doc} ${locale}: no nested list or no bold`);
        for (const command of ['/feedback', ...(doc === 'terms' ? ['/paysupport'] : [])]) assert(body.includes(`<bdi dir="ltr">${command}</bdi>`), `${doc} ${locale}: ${command} is not plain text kept left to right`);
        // Every command and @handle, each time it appears: inside its isolate, so its slash or @ stays on its own side in Hebrew
        assert(strayLtrTokens(body).length === 0, `${doc} ${locale}: not kept left to right: ${show(strayLtrTokens(body))}`);
        assert(!attrs(body, 'a').some((a) => /paysupport|feedback/.test(attr(a, 'href') ?? '')), `${doc} ${locale}: a bot command became a link`);
        const hrefs = attrs(body, 'a').map((a) => decodeEntities(attr(a, 'href') ?? ''));
        assert(hrefs.includes(`mailto:${SELLER.email}`), `${doc} ${locale}: the email isn't linked`);
        if (doc === 'privacy') {
          assert(hrefs.includes('https://developers.google.com/terms/api-services-user-data-policy'), `privacy ${locale}: the Google policy isn't linked`);
          assert(html.includes('<section id="google" class="site-legal-section"'), `privacy ${locale}: no #google`);
          assert(/<code dir="ltr">famcal_session<\/code>/.test(body), `privacy ${locale}: the cookie's name isn't code`);
        } else {
          assert(hrefs.filter((h) => h === `${prefix(locale)}/privacy`).length === 2, `terms ${locale}: "Privacy Policy" is not linked twice to ${prefix(locale)}/privacy: ${show(hrefs)}`);
          const cancel = html.indexOf('<h3 id="cancel" class="site-legal-h3">');
          assert(cancel > html.indexOf('<section id="plans"') && cancel < html.indexOf('<section id="ai"'), `terms ${locale}: no h3#cancel inside the plans`);
          assert(text.includes(SELLER.name[locale]), `terms ${locale}: no seller's name`);
          for (const field of ['idNumber', 'postalAddress', 'phone'] as const) {
            if (!SELLER[field]) assert(body.includes(`<span class="site-legal-missing">${legal.sellerMissing}</span>`), `terms ${locale}: no "${legal.sellerMissing}" for the missing ${field}`);
          }
        }
      }
    }
    // Once the owner gives the details: the values on the page, the phone a tap to call, an address isolated
    const real = { idNumber: SELLER.idNumber, postalAddress: SELLER.postalAddress, phone: SELLER.phone };
    try {
      Object.assign(SELLER, { idNumber: '012345678', postalAddress: 'רחוב הדוגמה 1, תל אביב', phone: '+972 50-000-0000' });
      for (const locale of LOCALES) {
        const body = article(await page('app/[locale]/(site)/terms/page.tsx', locale));
        assert(body.includes('<bdi>012345678</bdi>') && body.includes('<bdi>רחוב הדוגמה 1, תל אביב</bdi>'), `terms ${locale}: the ID and address once given`);
        assert(body.includes('<a href="tel:+972500000000" dir="ltr">+972 50-000-0000</a>'), `terms ${locale}: the phone once given`);
        assert(!body.includes('site-legal-missing'), `terms ${locale}: "to be added" with every detail given`);
      }
    } finally {
      Object.assign(SELLER, real);
    }
    const parts = linkParts('Write to privacy@famcal.bot or https://famcal.bot/privacy, or t.me/family_calendar_telegram_bot?start=feedback.');
    assert(show(parts.filter((p: Row) => p.href).map((p: Row) => p.href)) === show(['mailto:privacy@famcal.bot', 'https://famcal.bot/privacy', 'https://t.me/family_calendar_telegram_bot?start=feedback']), `the links ${show(parts)}`);
    const kinds = inlineParts('**Email:** {email}, see [Privacy Policy](/privacy), send /paysupport over HTTPS/TLS, `NEXT_LOCALE`.').map((p: Row) => p.kind + (p.name ? `:${p.name}` : ''));
    assert(show(kinds) === show(['strong', 'text', 'arg:email', 'text', 'link', 'text', 'command', 'text', 'code', 'text']), `the marks ${show(kinds)}`);
    const handle = inlineParts('the name (@username), not privacy@famcal.bot').map((p: Row) => `${p.kind}:${p.text}`);
    assert(show(handle) === show(['text:the name (', 'handle:@username', 'text:), not ', 'link:privacy@famcal.bot']), `an @handle ${show(handle)}`);
    let thrown = false;
    try {
      inlineParts('call {nobody}');
    } catch {
      thrown = true;
    }
    assert(thrown, 'an argument that is not the seller\'s passes');
  });

  await check('P4 the share page in en, he and ru: the site\'s chrome, its words from messages, the three messages with a Copy button each, the QR codes and the three links; noindex', async () => {
    const { generateMetadata } = await load('app/[locale]/(site)/share/page.tsx');
    for (const locale of LOCALES) {
      const html = await page('app/[locale]/(site)/share/page.tsx', locale);
      common(locale, html, 'share');
      const s = messages[locale].share;
      const text = decodeEntities(textOf(html));
      for (const key of ['pageTitle', 'pageSubtitle', 'messagesTitle', 'msgShort', 'msgMedium', 'msgParent', 'qrTitle', 'downloadQr', 'botLinkTitle', 'whatsappLinkTitle', 'siteLinkTitle']) assert(text.includes(s[key]), `${locale}: no share.${key}`);
      assert((html.match(new RegExp(`<span aria-live="polite">${s.copy}</span>`, 'g')) ?? []).length === 6, `${locale}: the Copy buttons`);
      assert(html.includes('https://famcal.bot') && html.includes('https://t.me/family_calendar_telegram_bot'), `${locale}: the links`);
      const meta = await generateMetadata({ params: Promise.resolve({ locale }) });
      assert(meta.robots?.index === false && meta.title === messages[locale].site.meta.share.title, `${locale}: the metadata ${show(meta)}`);
    }
  });

  await check('P5 a post that doesn\'t exist: the page calls notFound(), and the site\'s 404 shows "Page not found" in the page\'s language with the way home', async () => {
    const { default: Post } = await load('app/[locale]/(site)/blog/[slug]/page.tsx');
    const { default: SiteNotFound } = await load('app/[locale]/(site)/not-found.tsx');
    for (const locale of LOCALES) {
      let thrown: unknown = null;
      try {
        await Post({ params: Promise.resolve({ locale, slug: 'no-such-post' }) });
      } catch (err) {
        thrown = err;
      }
      assert(thrown instanceof NotFound, `${locale}: no notFound() for a missing post`);
      request.locale = locale;
      const html = await wrap(locale, (await SiteNotFound()) as ReactElement);
      common(locale, html, '404');
      const text = decodeEntities(textOf(html));
      assert(text.includes(messages[locale].ui.notFound.title) && text.includes(messages[locale].site.notFound.home), `${locale}: the 404's words`);
      const more = html.slice(html.indexOf('<p class="site-more">'));
      assert(attrs(more, 'a').some((a) => attr(a, 'href') === (prefix(locale) || '/')), `${locale}: the way home`);
    }
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
