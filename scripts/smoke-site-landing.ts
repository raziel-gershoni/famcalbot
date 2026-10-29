// Smoke test for the public landing (plan docs/superpowers/plans/2026-10-29-public-website.md, Task 4; spec
// 2026-10-28-public-website §3.2, §4, §5).
//
//  - G1 each section in the spec's order and each anchor (#how, #plans, #start) in en, he and ru, with its words from
//    messages; the headline's two lines; no raw key; no emoji.
//  - G2 the start buttons, in the hero and in Start again: Telegram first, one class list for both, the honest line
//    right under them.
//  - G3 the plan cards follow the plan table: the numbers, the Stars prices in the locale's digits, Pro's
//    "everything in Basic" and its features; a fake table with another number, another price and limits of Infinity
//    changes the cards, "unlimited" comes from messages and Infinity is never printed; no early access anywhere.
//  - G4 the live parts: the bot's card in the bot's own words (no emoji, no tags), the dentist's day and 24-hour time,
//    the calendar home's real Agenda twice (light and dark) with the sample week (the coming Thursday, the Hebrew
//    dates, the new event first, the birthday's count), the ping with Done and the three snoozes; the frame inert.
//  - G5 the sample family is made up per language: each language's own names, in its own script, on the page; the
//    other languages' names nowhere on it.
//  - G6 the truth list over the rendered page in every language, and the JSON-LD from messages.
//  - G7 the look: every text colour of the site's palette keeps 4.5:1 on what it sits on and every mark 3:1, in both
//    themes (the kit's contrast helper); nothing hangs on hover; every animation sits inside prefers-reduced-motion:
//    no-preference (so reduced motion stops it), and the site's sheet doesn't slide.
//  - G8 the page reads nothing on the server but messages, the plan table and the seller's details: no database, no
//    Redis, no early-access switch; it is static, rendered again once a day.
//  - G9 the plans end with a clearly labelled "Cancel a payment" link to the Terms' #cancel, the four ways to cancel
//    right next to it (the bot's /paysupport kept as plain text, the email linked, the postal address and the phone
//    from src/lib/seller.ts, or the "to be added" words while one is missing) (Consumer Protection Law s.14I(b), (e)(2)).
//
// The page runs as Next runs it on the server (the page as a function, next-intl's server API over the real messages,
// the plan table stood in for where a check changes it). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-site-landing.ts

import { createRequire } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { contrast, type Rgb } from './lib/css-resolve';
import { assert, check, decodeEntities, EMOJI, finish, LOCALES, load, messages, readSource, render, show, stub, strayLtrTokens, stubIntlServer, textOf, UNTRUE, type Locale, type Row } from './lib/site-harness';

const nodeRequire = createRequire(__filename);
const { NextIntlClientProvider } = nodeRequire('next-intl');
const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };

// The plan table, stood in for so a check can change it (the real values are restored after each change)
const REAL_PLANS = nodeRequire('../src/config/plans');
const plans: Row = structuredClone(REAL_PLANS.PLAN_CONFIGS);
const restorePlans = () => Object.assign(plans, structuredClone(REAL_PLANS.PLAN_CONFIGS));
stub('src/config/plans.ts', { ...REAL_PLANS, PLAN_CONFIGS: plans });

const hexRgb = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const word = (locale: Locale, key: string): string => key.split('.').reduce<Row>((node, part) => node?.[part], messages[locale]) as unknown as string;
const bot = (text: string) => text.replace(/<[^>]+>/g, '').replace(/^\s*(?:\p{Extended_Pictographic}|️|‍)+\s*/u, '').trim();
const attrs = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => m[1]);
const attr = (a: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(a)?.[1];

async function main() {
  stubIntlServer();
  const { default: LandingPage, revalidate } = await load('app/[locale]/(site)/page.tsx');
  const { SITE_CSS, SITE_PALETTE, BRAND } = await load('src/site/site-css.ts');
  const { APP_THEME_CSS } = await load('components/app-ui/theme.ts');
  const { buildSampleWeek, sampleWords, comingThursday } = await load('src/site/sample-week.ts');

  const page = async (locale: Locale): Promise<string> => {
    const el = (await LandingPage({ params: Promise.resolve({ locale }) })) as ReactElement;
    const intl = h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, el) as unknown as ReactElement;
    return render(h(AppRouterContext.Provider, { value: router }, intl));
  };
  const pages = {} as Record<Locale, string>;
  for (const locale of LOCALES) pages[locale] = await page(locale);

  await check('G1 the sections in the spec\'s order with their anchors (#how, #plans, #start) in en, he and ru, the words from messages, the headline\'s two lines; no raw key, no emoji', () => {
    for (const locale of LOCALES) {
      const html = pages[locale];
      const text = textOf(html);
      const titles = ['landing.how.title', 'landing.features.title', 'landing.channels.title', 'landing.plans.title', 'landing.founder.title', 'landing.final.title'].map((k) => word(locale, k));
      let at = -1;
      for (const title of titles) {
        const next = text.indexOf(title, at + 1);
        assert(next > at, `${locale}: "${title}" is missing or out of order`);
        at = next;
      }
      for (const id of ['how', 'plans', 'start']) assert(html.includes(` id="${id}"`), `${locale}: no #${id}`);
      const [line1, line2] = word(locale, 'landing.hero.headline').replace(/ —/g, '\u00a0—').split('\n');
      assert(html.includes(`<span class="site-h1-line">${line1}</span><span class="site-h1-line">${line2}</span>`), `${locale}: the headline's lines`);
      for (const key of ['landing.hero.subtitle', 'landing.how.step1.body', 'landing.how.google', 'landing.features.jewish.pause', 'landing.channels.link', 'landing.plans.allPlans', 'landing.founder.quote', 'landing.final.body']) {
        assert(decodeEntities(html).includes(word(locale, key)), `${locale}: ${key} is not on the page`);
      }
      assert(!/\b(?:landing|site|bot)\.[a-z]+\.[a-zA-Z]/.test(text), `${locale}: a raw key in ${text.match(/\b(?:landing|site|bot)\.[a-z]+\.[a-zA-Z]\S*/)?.[0]}`);
      assert(!EMOJI.test(html.replace(/https:\/\/wa\.me\/[^"]+/g, '')), `${locale}: an emoji: ${html.match(EMOJI)?.[0]}`);
      // An email address and a bot command (the cancel line's ways) are not words
      const words = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\w/])\/[a-z]+/g, '');
      if (locale !== 'en') assert(!/[A-Za-z]{4,}/.test(words.replace(/FamCal|Telegram|WhatsApp|Google|Shabbat|Pro|PDF|English|Русский|Yom Tov|QR/g, '')) || locale === 'ru', `${locale}: English words in the page`);
    }
  });

  await check('G2 the start buttons in the hero and in Start again: Telegram first, one class list for both, the honest line right under them', () => {
    for (const locale of LOCALES) {
      const html = pages[locale];
      const main = html.slice(html.indexOf('<main'));
      const pairs = [...main.matchAll(/<div class="site-starts">([\s\S]*?)<\/div><p class="site-honest">([^<]*)<\/p>/g)];
      assert(pairs.length === 2, `${locale}: ${pairs.length} button pairs with the honest line under them`);
      for (const [, buttons, honest] of pairs) {
        const anchors = attrs(buttons, 'a');
        assert(anchors.length === 2, `${locale}: ${anchors.length} buttons`);
        assert(attr(anchors[0], 'class') === 'site-start' && attr(anchors[1], 'class') === 'site-start', `${locale}: the class lists ${show(anchors.map((a) => attr(a, 'class')))}`);
        assert(attr(anchors[0], 'data-channel') === 'telegram' && attr(anchors[1], 'data-channel') === 'whatsapp', `${locale}: the order`);
        assert(textOf(buttons).includes(word(locale, 'site.cta.telegram')) && textOf(buttons).includes(word(locale, 'site.cta.whatsapp')), `${locale}: the buttons' words`);
        assert(decodeEntities(honest) === word(locale, 'site.cta.honest'), `${locale}: the honest line ${honest}`);
      }
    }
  });

  await check('G3 the plan cards follow the plan table: the numbers, the Stars prices in the locale\'s digits, Pro\'s "everything in Basic" and features; another number, another price and Infinity change them ("unlimited" from messages, never "Infinity"); no early access', async () => {
    const plansHtml = (html: string) => html.slice(html.indexOf('id="plans"'), html.indexOf('id="founder-title"'));
    const has = (html: string, s: string) => decodeEntities(plansHtml(html)).includes(s);
    const t = (locale: Locale) => nodeRequire('next-intl').createTranslator({ locale, messages: messages[locale] });
    for (const locale of LOCALES) {
      const tr = t(locale);
      const html = pages[locale];
      for (const s of [tr('landing.plans.bullets.textSummaries', { count: 10 }), tr('landing.plans.bullets.voiceSummaries', { count: 3 }), tr('landing.plans.bullets.calendars', { count: 3 }), tr('landing.plans.bullets.calendars', { count: 5 }), tr('landing.plans.bullets.summariesUnlimited'), tr('landing.plans.bullets.everythingInBasic'), tr('landing.plans.bullets.calendarsUnlimited'), tr('landing.plans.bullets.reminders'), tr('landing.plans.bullets.voiceEvents'), tr('landing.plans.bullets.googleCopy'), tr('landing.plans.free.price'), tr('landing.plans.subtitle', { days: 14 }), tr('landing.plans.notes.trial', { days: 14 })]) {
        assert(has(html, s), `${locale}: the plans lack "${s}"`);
      }
      const price = (n: number) => tr('landing.plans.price', { price: n });
      assert(has(html, price(2500)) && has(html, price(5000)), `${locale}: the prices`);
      // Grouped as the locale groups a number (Russian with a no-break space)
      assert(price(2500).replace(/[\u00a0\u202f]/g, ' ') === { en: '2,500 Stars a month', he: '2,500 כוכבים לחודש', ru: '2 500 звёзд в месяц' }[locale], `${locale}: the price reads ${show(price(2500))}`);
      assert(!/Infinity|NaN|undefined/.test(textOf(html)), `${locale}: Infinity or NaN printed`);
    }
    try {
      plans.FREE.limits.calendars = 4;
      plans.BASIC.priceStars = 3000;
      plans.FREE.limits.textSummaries = Infinity;
      plans.BASIC.limits.calendars = Infinity;
      for (const locale of LOCALES) {
        const tr = t(locale);
        const html = await page(locale);
        assert(has(html, tr('landing.plans.bullets.calendars', { count: 4 })), `${locale}: Free's 4 calendars`);
        assert(has(html, tr('landing.plans.price', { price: 3000 })) && !has(html, tr('landing.plans.price', { price: 2500 })), `${locale}: Basic's new price`);
        assert(has(html, tr('landing.plans.bullets.textUnlimited')) && has(html, tr('landing.plans.bullets.voiceSummaries', { count: 3 })), `${locale}: Free's unlimited text, 3 voice`);
        const basic = decodeEntities(plansHtml(html)).split('id="plan-BASIC"')[1].split('</li></ul></li>')[0];
        assert(basic.includes(tr('landing.plans.bullets.calendarsUnlimited')), `${locale}: Basic's unlimited calendars`);
        assert(!/Infinity/.test(html), `${locale}: Infinity printed`);
      }
    } finally {
      restorePlans();
    }
  });

  await check('G4 the live parts: the bot\'s card in its own words, the dentist\'s day and 24-hour time; the real Agenda twice (light, dark) with the coming Thursday and Friday, their Hebrew dates, the new event first and the birthday\'s count; the ping with Done and the snoozes; the frame inert', () => {
    for (const locale of LOCALES) {
      const html = pages[locale];
      const b = messages[locale].bot;
      const week = buildSampleWeek(sampleWords(nodeRequire('next-intl').createTranslator({ locale, messages: messages[locale] })));
      const card = html.slice(html.indexOf('<div class="site-demo-card">'), html.indexOf('<div class="site-phone"'));
      const cardText = decodeEntities(textOf(card));
      for (const key of ['confirmTitle', 'createButton', 'cancelButton', 'fixTime', 'fixDay']) assert(cardText.includes(bot(b.voice[key])), `${locale}: the card lacks ${key}`);
      assert(cardText.includes(`${b.voice.from} "${word(locale, 'landing.sample.voiceNote')}"`), `${locale}: the From line`);
      assert(cardText.includes('16:00 - 17:00') && cardText.includes(word(locale, 'landing.sample.calendars.kids')), `${locale}: the card's time and calendar: ${cardText}`);
      assert(!EMOJI.test(card) && !/&lt;b&gt;|<b>/.test(card), `${locale}: emoji or tags in the card`);
      const apps = [...html.matchAll(/<div class="ch-app site-demo-app site-demo-(light|dark)" data-theme="(light|dark)"/g)].map((m) => `${m[1]}/${m[2]}`);
      assert(show(apps) === show(['light/light', 'dark/dark']), `${locale}: the Agenda's looks ${show(apps)}`);
      const frame = html.slice(html.indexOf('<div class="site-phone"'), html.indexOf('</figure>', html.indexOf('<div class="site-phone"')));
      assert(/<div class="site-phone-screen" inert="" aria-hidden="true">/.test(frame), `${locale}: the frame is not inert`);
      assert(frame.includes(`aria-label="${word(locale, 'landing.demo.calendarFrame')}"`), `${locale}: the frame's name`);
      const days = [...frame.matchAll(/<h2 class="ch-day-head" id="ch-day-(\d{4}-\d{2}-\d{2})">/g)].map((m) => m[1]);
      const thursday = week.thursday;
      const friday = week.agenda.entries[1].date;
      assert(show(days) === show([thursday, friday, thursday, friday]), `${locale}: the days ${show(days)}, want ${thursday} and ${friday} in each look`);
      assert(new Date(`${thursday}T12:00:00Z`).getUTCDay() === 4, `${locale}: ${thursday} is not a Thursday`);
      assert(/<span class="ch-day-hebrew">/.test(frame), `${locale}: no Hebrew date`);
      const firstRow = frame.slice(frame.indexOf('<li class="ch-row-li">'), frame.indexOf('</li>', frame.indexOf('<li class="ch-row-li">')));
      assert(decodeEntities(firstRow).includes(word(locale, 'landing.sample.events.dentist')) && firstRow.includes('16:00'), `${locale}: the first row is not the dentist at 16:00`);
      assert(/72/.test(textOf(frame)), `${locale}: no birthday count`);
      assert(decodeEntities(textOf(frame)).includes(word(locale, 'landing.sample.calendars.partner')), `${locale}: the partner's Done`);
      const ping = html.slice(html.indexOf('<figure class="site-ping">'), html.indexOf('</figure>', html.indexOf('<figure class="site-ping">')));
      const pingText = decodeEntities(textOf(ping));
      for (const key of ['done', 'snooze15', 'snooze60', 'snoozeTomorrow']) assert(pingText.includes(bot(b.nativeReminders.buttons[key])), `${locale}: the ping lacks ${key}`);
      assert(pingText.includes(bot(b.nativeReminders.ping.forBoth)) && pingText.includes(word(locale, 'landing.sample.reminder')) && pingText.includes(word(locale, 'landing.demo.pingCaption')), `${locale}: the ping's words`);
    }
    // The coming Thursday: never today, a week on when today is Thursday
    assert(comingThursday('2026-10-29') === '2026-11-05' && comingThursday('2026-10-28') === '2026-10-29' && comingThursday('2026-10-31') === '2026-11-05', 'comingThursday');
  });

  await check('G5 the sample family is made up per language: each language\'s names, in its own script, on its page, and no other language\'s names', () => {
    const names = (locale: Locale) => {
      const s = messages[locale].landing.sample;
      // The viewer's own name is a calendar's, which no row shows; the partner's shows in "Eli: done"
      return [s.calendars.partner, s.events.dentist, s.events.swimming, s.events.birthday];
    };
    const script: Record<Locale, RegExp> = { en: /^[A-Za-z’' ]+$/, he: /^[֐-׿ ]+$/, ru: /^[Ѐ-ӿ —]+$/ };
    for (const locale of LOCALES) {
      const text = decodeEntities(pages[locale]);
      for (const name of names(locale)) {
        assert(script[locale].test(name), `${locale}: "${name}" is not in ${locale}'s script`);
        assert(text.includes(name), `${locale}: "${name}" is not on the page`);
      }
      const own = [messages[locale].landing.sample.calendars.self, messages[locale].landing.sample.calendars.partner];
      for (const other of LOCALES.filter((l) => l !== locale)) {
        for (const name of [messages[other].landing.sample.calendars.self, messages[other].landing.sample.calendars.partner]) {
          assert(!own.includes(name) && !textOf(pages[locale]).includes(name), `${locale}: ${other}'s "${name}" is on the page`);
        }
      }
    }
  });

  await check('G6 the truth list over the rendered page in en, he and ru; the JSON-LD from messages (the description, the offer, the features), with the Organization block', () => {
    for (const locale of LOCALES) {
      const html = decodeEntities(pages[locale]);
      for (const [claim, pattern] of UNTRUE) assert(!pattern.test(html), `${locale}: ${claim}: ${html.match(pattern)?.[0]}`);
      const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(pages[locale])?.[1] ?? 'null');
      const site = messages[locale].site.jsonLd;
      assert(Array.isArray(ld) && ld[0].description === site.description && ld[0].offers.description === site.offer && show(ld[0].featureList) === show(site.features), `${locale}: the JSON-LD ${show(ld?.[0])?.slice(0, 200)}`);
      assert(ld[1]['@type'] === 'Organization' && ld[1].url === 'https://famcal.bot', `${locale}: the Organization block`);
    }
  });

  await check('G7 the look: the palette\'s text keeps 4.5:1 and its marks 3:1 in both themes; no hover; every animation only under prefers-reduced-motion: no-preference; the sheet doesn\'t slide', () => {
    const low: string[] = [];
    const TEXT: [string, string][] = [];
    for (const fg of ['--ch-text', '--ch-muted', '--ch-accent']) for (const bg of ['--ch-bg', '--ch-surface', '--ch-section', '--ch-card', '--ch-accent-soft']) TEXT.push([fg, bg]);
    TEXT.push(['--ch-button-text', '--ch-button']);
    for (const theme of ['light', 'dark'] as const) {
      const p = SITE_PALETTE[theme] as Record<string, string>;
      const ratio = (fg: string, bg: string) => contrast(hexRgb(fg), hexRgb(bg));
      for (const [fg, bg] of TEXT) if (ratio(p[fg], p[bg]) < 4.5) low.push(`${theme} ${fg} on ${bg}: ${ratio(p[fg], p[bg]).toFixed(2)}`);
      for (const brand of [BRAND.telegram, BRAND.whatsapp]) {
        if (ratio(BRAND.onBrand, brand) < 4.5) low.push(`${theme} the label on ${brand}: ${ratio(BRAND.onBrand, brand).toFixed(2)}`);
        if (ratio(brand, p['--ch-bg']) < 3) low.push(`${theme} ${brand} on the page: ${ratio(brand, p['--ch-bg']).toFixed(2)}`);
      }
      for (const mark of ['--ch-button', '--ch-accent']) for (const bg of ['--ch-bg', '--ch-surface', '--ch-section']) if (ratio(p[mark], p[bg]) < 3) low.push(`${theme} ${mark} on ${bg}`);
    }
    assert(low.length === 0, show(low));
    const own = SITE_CSS.slice(APP_THEME_CSS.length);
    assert(!/hover/.test(own), 'a hover rule');
    // Every animation of the site's own sheet is inside the no-preference block (or turns one off)
    const outside = own.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '');
    const animations = [...outside.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1].trim()).filter((v) => v !== 'none');
    assert(animations.length === 0, `animations outside the no-preference block: ${show(animations)}`);
    assert(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*\.site-demo-card \{\s*animation: site-rise/.test(own), 'the hero\'s motion is not in the no-preference block');
    assert(/\.site \.ch-sheet \{[^}]*animation: none;/.test(own), 'the sheet slides');
  });

  await check('G8 the page reads nothing on the server beyond messages, the plan table and the seller\'s details (no Prisma, Redis or early-access switch, in its own files), and is static, rendered again once a day', () => {
    const files = ['app/[locale]/(site)/page.tsx', 'components/site/LandingSections.tsx', 'components/site/HeroDemo.tsx', 'components/site/DemoAgenda.tsx', 'components/site/ReminderPing.tsx', 'components/site/LegalInline.tsx', 'src/site/plans.ts', 'src/site/sample-week.ts', 'src/site/legal.ts', 'src/lib/seller.ts'];
    for (const file of files) {
      const src = readSource(file);
      assert(!/prisma|redis|earlyAdopt|early-adopt|feature-access|subscription-service|cookies\(|headers\(/i.test(src.replace(/^\s*\/\/.*$/gm, '')), `${file} reads the server`);
    }
    assert(revalidate === 86400, `revalidate ${revalidate}`);
  });

  await check('G9 the plans end with "Cancel a payment" linked to the Terms\' #cancel, with the four ways next to it: /paysupport as plain text, the email linked, the address and the phone (or "to be added" while missing)', async () => {
    const { SELLER } = await load('src/lib/seller.ts');
    const cancelHtml = (html: string) => {
      const plans = html.slice(html.indexOf('id="plans"'), html.indexOf('id="founder-title"'));
      return plans.slice(plans.indexOf('<div class="site-cancel">'));
    };
    for (const locale of LOCALES) {
      const m = messages[locale];
      const block = cancelHtml(pages[locale]);
      assert(block.startsWith('<div class="site-cancel">'), `${locale}: no cancel block in the plans`);
      const href = locale === 'en' ? '/terms#cancel' : `/${locale}/terms#cancel`;
      assert(block.includes(`<a class="site-cancel-link" href="${href}">${m.landing.plans.cancel.link}</a>`), `${locale}: the link ${block.slice(0, 200)}`);
      // Clearly labelled: the words name the cancelling, in the page's language
      assert({ en: /^Cancel a payment$/, he: /^ביטול /, ru: /^Отменить / }[locale].test(m.landing.plans.cancel.link) && m.site.footer.cancel === m.landing.plans.cancel.link, `${locale}: the label ${m.landing.plans.cancel.link}`);
      const ways = [...block.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => x[1]);
      assert(ways.length === 4, `${locale}: ${ways.length} ways`);
      assert(ways[0].includes('<bdi dir="ltr">/paysupport</bdi>') && !/<a[^>]*paysupport/.test(ways[0]), `${locale}: /paysupport ${ways[0]}`);
      // No command or @handle anywhere on the page (the cancel ways and the footer included) outside its isolate
      assert(strayLtrTokens(pages[locale]).length === 0, `${locale}: not kept left to right: ${show(strayLtrTokens(pages[locale]))}`);
      assert(ways[1].includes(`<a href="mailto:${SELLER.email}" dir="ltr">${SELLER.email}</a>`), `${locale}: the email ${ways[1]}`);
      for (const [i, field] of [[2, 'postalAddress'], [3, 'phone']] as const) {
        const words = decodeEntities(textOf(ways[i]));
        assert(SELLER[field] ? words.includes(SELLER[field]) : words.includes(m.legal.sellerMissing), `${locale}: the ${field} way reads ${words}`);
      }
    }
    const real = { postalAddress: SELLER.postalAddress, phone: SELLER.phone };
    try {
      Object.assign(SELLER, { postalAddress: 'רחוב הדוגמה 1, תל אביב', phone: '+972 50-000-0000' });
      for (const locale of LOCALES) {
        const block = cancelHtml(await page(locale));
        assert(block.includes('<bdi>רחוב הדוגמה 1, תל אביב</bdi>') && block.includes('<a href="tel:+972500000000" dir="ltr">+972 50-000-0000</a>') && !block.includes('site-legal-missing'), `${locale}: the ways once given ${block}`);
      }
    } finally {
      Object.assign(SELLER, real);
    }
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
