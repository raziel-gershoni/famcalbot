// Smoke test for the public site's header, phone menu and footer (plan docs/superpowers/plans/2026-10-29-public-website.md,
// Task 3; spec 2026-10-28-public-website §3.1, §3.4, §6.2).
//
//  - H1 the header in en, he and ru: the logo to the home, How it works and Plans to the landing's sections, Blog, the
//    two compact start buttons (one class list, Telegram first, the full words as their name), the phone's Start to
//    the start section and its menu button; English links unprefixed, Hebrew and Russian prefixed; every word from
//    messages, no raw key, no emoji.
//  - H2 the language switcher on a page (the blog post): the same page in each language, each name in its own
//    language and lang; the current one marked and unprefixed for English; the others carry their prefix (English's
//    too: the proxy stores the choice, then lands on the unprefixed page).
//  - H3 the footer: How it works, Plans, Blog, Privacy, Terms, Cancel a payment (the Terms' #cancel) and Contact (the
//    bot's feedback chat), the switcher, "Made in Israel" and the years kept left to right in Hebrew.
//  - H4 the phone menu in real React on the small fake DOM: closed at first; the button opens the app's sheet, focus
//    moves into it, and Escape, the scrim, the Close button and a link each close it with focus back on the button;
//    the sheet holds the links and the switcher.
//  - H5 the chrome's CSS: the kit's lint (sizes in px, logical properties only, no hover, colours only in token
//    blocks), every tap target (the chrome's and the pages' links and buttons) at least 44 px, the wide and phone parts swap at one width, and the sheet doesn't slide.
//
// The chrome runs as Next runs it on the server (next-intl's server API over the real messages), and the menu as a
// browser runs it. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-site-chrome.ts

import { createRequire } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { lintCss } from './lib/css-lint';
import { elements, fakeDocument, FakeElement, installWindow, mount } from './lib/fake-dom';
import { assert, check, decodeEntities, EMOJI, finish, LOCALES, load, messages, render, show, stubIntlServer, textOf, type Locale, type Row } from './lib/site-harness';

const nodeRequire = createRequire(__filename);
const { NextIntlClientProvider } = nodeRequire('next-intl');
const prefix = (l: Locale) => (l === 'en' ? '' : `/${l}`);
const attrs = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => m[1]);
const attr = (a: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(a)?.[1];
const decode = decodeEntities;

async function main() {
  stubIntlServer();
  const { SiteHeader } = await load('components/site/SiteHeader.tsx');
  const { SiteFooter } = await load('components/site/SiteFooter.tsx');
  const { SiteMenu } = await load('components/site/SiteMenu.tsx');
  const { SITE_CSS } = await load('src/site/site-css.ts');
  const { APP_THEME_CSS } = await load('components/app-ui/theme.ts');

  const withIntl = (locale: Locale, el: ReactElement) => h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, el) as unknown as ReactElement;
  const header = (locale: Locale, path = '/') => render(withIntl(locale, h(SiteHeader, { locale, path })));
  const footer = (locale: Locale, path = '/') => render(withIntl(locale, h(SiteFooter, { locale, path })));

  await check('H1 the header in en, he and ru: the logo, the section links, Blog, two equal compact start buttons (Telegram first, the full words as their name), the phone\'s Start and menu button; English unprefixed; words from messages; no raw key, no emoji', async () => {
    for (const locale of LOCALES) {
      const html = await header(locale);
      const site = messages[locale].site;
      const anchors = attrs(html, 'a');
      const hrefs = anchors.map((a) => decode(attr(a, 'href') ?? ''));
      const p = prefix(locale);
      for (const want of [p || '/', `${p || '/'}#how`, `${p || '/'}#plans`, `${p}/blog`, `${p || '/'}#start`]) assert(hrefs.includes(want), `${locale}: no link to ${want} in ${show(hrefs)}`);
      assert(!hrefs.some((href) => href.startsWith('/en')) || locale !== 'en', `${locale}: an /en link in ${show(hrefs)}`);
      const logo = anchors.find((a) => attr(a, 'class') === 'site-logo');
      assert(logo && attr(logo, 'aria-label') === site.header.homeLabel && attr(logo, 'href') === (p || '/'), `${locale}: the logo ${logo}`);
      const starts = anchors.filter((a) => /\bsite-start\b/.test(attr(a, 'class') ?? ''));
      assert(starts.length === 2, `${locale}: ${starts.length} start buttons`);
      assert(attr(starts[0], 'class') === attr(starts[1], 'class'), `${locale}: the start buttons' classes differ: ${show(starts.map((s) => attr(s, 'class')))}`);
      assert(attr(starts[0], 'data-channel') === 'telegram' && attr(starts[1], 'data-channel') === 'whatsapp', `${locale}: the order ${show(starts.map((s) => attr(s, 'data-channel')))}`);
      assert(attr(starts[0], 'aria-label') === site.cta.telegram && attr(starts[1], 'aria-label') === site.cta.whatsapp, `${locale}: the buttons' names`);
      assert(attr(starts[0], 'href') === 'https://t.me/family_calendar_telegram_bot', `${locale}: Telegram's link ${attr(starts[0], 'href')}`);
      const wa = decode(attr(starts[1], 'href') ?? '');
      assert(wa === `https://wa.me/972548524687?text=${encodeURIComponent(messages[locale].bot.whatsapp.greeting)}`, `${locale}: WhatsApp's link ${wa}`);
      const text = textOf(html);
      for (const word of [site.nav.howItWorks, site.nav.plans, site.nav.blog, site.cta.telegramShort, site.cta.whatsappShort, site.header.start]) assert(text.includes(word), `${locale}: no "${word}" in ${text}`);
      const menuButton = attrs(html, 'button').find((b) => /site-menu-button/.test(attr(b, 'class') ?? ''));
      assert(menuButton && attr(menuButton, 'aria-label') === site.menu.open && attr(menuButton, 'aria-expanded') === 'false', `${locale}: the menu button ${menuButton}`);
      assert(!/\b(?:site|landing)\.[a-z]+\.[a-zA-Z]/.test(text), `${locale}: a raw key in ${text}`);
      assert(!EMOJI.test(html), `${locale}: an emoji`);
    }
  });

  await check('H2 the language switcher on the blog post: the same page in each language, the names in their own language and lang, the current one marked (English unprefixed), the others carrying their prefix', async () => {
    const path = '/blog/why-i-built-famcal';
    for (const locale of LOCALES) {
      const html = await header(locale, path);
      const langs = attrs(html, 'a').filter((a) => /hreflang=|aria-current="true"/i.test(a));
      const byLang = (l: Locale) => langs.find((a) => attr(a, 'hreflang') === l || (l === locale && attr(a, 'aria-current') === 'true'));
      for (const l of LOCALES) {
        const a = byLang(l);
        assert(a, `${locale}: no link to ${l} in ${show(langs)}`);
        const href = attr(a, 'href');
        const want = l === locale ? `${prefix(l)}${path}` : `/${l}${path}`;
        assert(href === want, `${locale}: ${l} links to ${href}, want ${want}`);
      }
      for (const l of LOCALES) {
        const name = messages[locale].site.language.names[l];
        assert(html.includes(`<span lang="${l}" dir="${l === 'he' ? 'rtl' : 'ltr'}">${name}</span>`), `${locale}: ${l}'s name ${name} with its lang`);
      }
    }
  });

  await check('H3 the footer in en, he and ru: How it works, Plans, Blog, Privacy, Terms, Cancel a payment and Contact, the switcher, "Made in Israel", the years left to right; no emoji', async () => {
    const year = new Date().getFullYear();
    for (const locale of LOCALES) {
      const html = await footer(locale, '/privacy');
      const site = messages[locale].site;
      const p = prefix(locale);
      const hrefs = attrs(html, 'a').map((a) => decode(attr(a, 'href') ?? ''));
      for (const want of [`${p || '/'}#how`, `${p || '/'}#plans`, `${p}/blog`, `${p}/privacy`, `${p}/terms`, `${p}/terms#cancel`, 'https://t.me/family_calendar_telegram_bot?start=feedback']) assert(hrefs.includes(want), `${locale}: no ${want} in ${show(hrefs)}`);
      const text = textOf(html);
      for (const word of [site.footer.privacy, site.footer.terms, site.footer.cancel, site.footer.contact, site.footer.madeIn]) assert(text.includes(word), `${locale}: no "${word}"`);
      const cancel = attrs(html, 'a').findIndex((a) => decode(attr(a, 'href') ?? '') === `${p}/terms#cancel`);
      const link = html.split('<a ').slice(1)[cancel] ?? '';
      assert(cancel >= 0 && textOf(link.slice(link.indexOf('>') + 1)).startsWith(site.footer.cancel), `${locale}: the cancel link's words`);
      assert(html.includes(`<bdi dir="ltr">© 2025–${year} FamCal</bdi>`), `${locale}: the years`);
      assert(html.includes(`aria-label="${site.footer.navLabel}"`), `${locale}: the footer's nav has no name`);
      assert(!EMOJI.test(html), `${locale}: an emoji`);
    }
  });

  await check('H4 the phone menu (real React, fake DOM): closed at first; the button opens the app\'s sheet with focus inside; Escape, the scrim, Close and a link each close it with focus back on the button; the links and the switcher are in it', async () => {
    installWindow();
    // next/link reads `self` in a browser
    (globalThis as Row).self ??= globalThis;
    const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
    const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
    for (const locale of LOCALES) {
      const site = messages[locale].site;
      const m = mount(h(AppRouterContext.Provider, { value: router }, withIntl(locale, h(SiteMenu, { path: '/blog' }))));
      const button = () => elements(m.container).find((e) => e.localName === 'button' && e.getAttribute('aria-label') === site.menu.open) as FakeElement;
      const dialog = () => elements(m.container).find((e) => e.getAttribute('role') === 'dialog');
      const open = () => {
        button().focus();
        m.click(button());
        const d = dialog();
        assert(d && d.getAttribute('aria-label') === site.menu.button && d.getAttribute('aria-modal') === 'true', `${locale}: the sheet did not open`);
        assert(fakeDocument.activeElement === d, `${locale}: focus is not in the sheet`);
        assert(button().getAttribute('aria-expanded') === 'true', `${locale}: aria-expanded`);
        return d;
      };
      const closed = (how: string) => {
        assert(!dialog(), `${locale}: ${how} left the sheet open`);
        assert(fakeDocument.activeElement === button(), `${locale}: after ${how} focus is not back on the button`);
        assert(button().getAttribute('aria-expanded') === 'false', `${locale}: aria-expanded after ${how}`);
      };
      let step = 'start';
      try {
      assert(!dialog() && button().getAttribute('aria-expanded') === 'false', `${locale}: open at first`);
      step = 'open';
      let d = open();
      const links = elements(d).filter((e) => e.localName === 'a');
      const p = prefix(locale);
      const hrefs = links.map((a) => a.getAttribute('href'));
      for (const want of [`${p || '/'}#how`, `${p || '/'}#plans`, `${p}/blog`, '/en/blog', '/he/blog', '/ru/blog'].filter((href) => href !== `/${locale}/blog`)) assert(hrefs.includes(want), `${locale}: the sheet has no ${want}: ${show(hrefs)}`);
      assert(links.some((a) => a.getAttribute('aria-current') === 'true' && a.getAttribute('href') === `${p}/blog`), `${locale}: the current language`);
      step = 'escape';
      m.key(d, 'Escape');
      closed('Escape');
      step = 'scrim';
      open();
      m.click(elements(m.container).find((e) => e.className === 'ch-sheet-backdrop') as FakeElement);
      closed('a tap on the scrim');
      step = 'close';
      d = open();
      m.click(elements(d).find((e) => e.localName === 'button' && e.textContent === site.menu.close) as FakeElement);
      closed('Close');
      step = 'link';
      d = open();
      m.click(elements(d).find((e) => e.localName === 'a' && e.textContent === site.nav.plans) as FakeElement);
      closed('a link');
      } catch (err) {
        throw new Error(`${locale} at ${step}: ${err instanceof Error ? err.message : err} [${elements(m.container).map((e) => e.localName).join(' ')}]`);
      }
      m.unmount();
    }
  });

  await check('H5 the chrome\'s CSS: the kit\'s lint, every tap target at least 44 px, one width where the wide and the phone parts swap, and no slide for the sheet', () => {
    const own = SITE_CSS.slice(APP_THEME_CSS.length);
    assert(SITE_CSS.startsWith(APP_THEME_CSS), 'the kit\'s theme is not the sheet\'s first part');
    const problems = lintCss(own);
    assert(problems.length === 0, show(problems));
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(own)?.[1];
    for (const selector of ['.site-logo', '.site-nav a', '.site-langs a', '.site-jump', '.site-start', '.site-starts-compact .site-start', '.site-menu-list a', '.site-footer-links a', '.site-cancel-link', '.site-back a', '.site-post-card a', '.site-more a', '.site-copy']) {
      const body = rule(selector);
      assert(body, `no rule ${selector}`);
      const min = /min-block-size:\s*(\d+)px/.exec(body);
      assert(min && Number(min[1]) >= 44, `${selector}: ${body.trim().replace(/\s+/g, ' ')}`);
    }
    const button = rule('.site-menu-button');
    assert(button && /inline-size:\s*44px/.test(button) && /block-size:\s*44px/.test(button), `the menu button: ${button}`);
    assert(/@media \(max-width: 959\.98px\) \{\s*\.site-wide-only \{\s*display: none !important;/.test(own) && /@media \(min-width: 960px\) \{\s*\.site-phone-only \{\s*display: none !important;/.test(own), 'the swap');
    assert(/\.site \.ch-sheet \{[^}]*animation: none;/.test(own), 'the sheet slides');
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export type { Row };
