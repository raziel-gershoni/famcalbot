// Smoke test for what a paid plan tells the person before and after paying (the legal review of 2026-10-29, Part 3
// issues 3, 4, 6 and 20; Consumer Protection Law s.14C, s.13C(b), s.14I; Telegram's Stars checklist), all built by
// src/lib/plan-disclosure.ts from messages/<locale>.json and src/lib/seller.ts:
//  - D1 the policy pages' addresses in each language: English unprefixed, /he/terms, /ru/terms, the site's own pageUrl;
//  - D2 the two links: Telegram's anchors, WhatsApp's plain "label: url" lines (no tag, a link WhatsApp shows as written);
//  - D3 the ways to cancel within 14 days: /paysupport, the email, the post and the phone, a way whose detail is still
//    null left out (never "null"), the values escaped for Telegram's HTML, and "give your name and the payment date";
//  - D4 the seller's lines: the name in the person's language, the ID number and the address when there are some;
//  - D5 the Stars invoice's description in en, he and ru for Basic and Pro: within Telegram's 255 characters, plain text,
//    with the plan, one month, never renews, the seller, agreeing to the Terms by paying (their address) and 14 days to
//    cancel with /paysupport; one that would not fit is refused, never cut;
//  - D6 the confirmation after a payment: the plan, the price, the end of the month in the person's zone (24-hour), never
//    renews, the seller, the ways to cancel and the Terms link, with and without the seller's missing details;
//  - W1 the wiring: payment-handler's invoice carries D5's description, and a successful payment sends one message, D6's,
//    in the person's language and zone, as HTML with no link preview and the View Subscription button; a zone lookup
//    that throws is logged and the confirmation still goes, in the default zone.
//
// Faked for W1 only: the bot and the messaging service (every send is recorded), the user lookup, the subscription writes,
// analytics, error capture and the zone lookup. No network, no database.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-plan-disclosure.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { SELLER, type Seller } from '../src/lib/seller';
import { MessageFormat } from '../src/services/messaging/types';
import type { PolicyWords } from '../src/lib/plan-disclosure';
import { pageUrl } from '../src/site/seo';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Locale = 'en' | 'he' | 'ru';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const messages: Record<Locale, Row> = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

/** Every detail filled, with characters Telegram's HTML must not read as markup. */
const FULL: Seller = { ...SELLER, idNumber: '012345678', postalAddress: 'PO Box 7 <Harish> & Co', phone: '+972-50-000-0000' };
/** Every detail the owner has not given yet. */
const BARE: Seller = { ...SELLER, idNumber: null, postalAddress: null, phone: null };

const words = (l: Locale) => messages[l].bot.policy as PolicyWords;
const sub = (l: Locale) => messages[l].subscription as Row;
const planName = (l: Locale, id: 'basic' | 'pro') => sub(l).plans[id].name as string;
/** The fixed parts of a template, in order: what is left between its {placeholders}. */
const fixedParts = (template: string) => template.split(/\{\w+\}/).map((s) => s.trim()).filter(Boolean);
function inOrder(text: string, parts: string[], what: string) {
  let at = -1;
  for (const part of parts) {
    const next = text.indexOf(part, at + 1);
    assert(next > at, `${what}: "${part}" is missing or out of order in:\n${text}`);
    at = next;
  }
}
/** The words that carry the law in each language. */
const NEVER_RENEWS: Record<Locale, RegExp> = { en: /never renews/i, he: /לא מתחדש|בלי חידוש/, ru: /не продлевается|без автопродления/ };
const FULL_REFUND: Record<Locale, RegExp> = { en: /full refund/i, he: /החזר מלא/, ru: /полный возврат/ };
const ONE_MONTH: Record<Locale, RegExp> = { en: /one month/i, he: /חודש אחד/, ru: /один месяц/ };

async function main() {
  const D = await import('../src/lib/plan-disclosure');

  await check('D1 the policy pages in each language: English unprefixed, /he and /ru prefixed, the site\'s pageUrl; an unknown or missing language is English', () => {
    const want: Record<Locale, string> = { en: 'https://famcal.bot', he: 'https://famcal.bot/he', ru: 'https://famcal.bot/ru' };
    for (const l of LOCALES) {
      for (const page of ['terms', 'privacy'] as const) {
        assert(D.policyUrl(page, l) === `${want[l]}/${page}`, `${l} ${page}: ${D.policyUrl(page, l)}`);
        assert(D.policyUrl(page, l) === pageUrl(l, `/${page}`), `${l} ${page}: not the site's pageUrl`);
      }
    }
    for (const odd of ['fr', '', null, undefined, 'Hebrew']) assert(D.policyUrl('terms', odd) === 'https://famcal.bot/terms', `${show(odd)}: ${D.policyUrl('terms', odd)}`);
  });

  await check('D2 the two links: in Telegram an anchor each with its label, on one line; on WhatsApp "label: url" on a line each, plain text', () => {
    for (const l of LOCALES) {
      const w = words(l);
      const html = D.policyLinks(w, l, 'html');
      assert(html === `<a href="${D.policyUrl('privacy', l)}">${w.privacy}</a> · <a href="${D.policyUrl('terms', l)}">${w.terms}</a>`, `${l} html: ${html}`);
      const text = D.policyLinks(w, l, 'text');
      assert(text === `${w.privacy}: ${D.policyUrl('privacy', l)}\n${w.terms}: ${D.policyUrl('terms', l)}`, `${l} text: ${text}`);
      assert(!/[<>]/.test(text), `${l}: a tag in WhatsApp's text`);
      assert(D.policyLink(w, 'terms', l, 'html') === `<a href="${D.policyUrl('terms', l)}">${w.terms}</a>`, `${l}: the Terms link alone`);
    }
  });

  await check('D3 the ways to cancel: 14 days and a full refund, /paysupport, the email, the post and the phone when given (escaped), then "give your name and the payment date"; a missing detail\'s way is left out, never "null"', () => {
    for (const l of LOCALES) {
      const w = words(l);
      const bare = D.cancelBlock(w, BARE);
      assert(FULL_REFUND[l].test(bare) && bare.includes('14'), `${l}: no 14-day full refund in:\n${bare}`);
      inOrder(bare, [w.cancel, fixedParts(w.cancelBot)[0], fixedParts(w.cancelEmail)[0] ?? '', SELLER.email, w.cancelDetails].filter(Boolean), `${l} bare`);
      assert(bare.includes('/paysupport'), `${l}: no /paysupport`);
      assert(!bare.includes(fixedParts(w.cancelPost)[0]) && !bare.includes(fixedParts(w.cancelPhone)[0]), `${l}: a way with no detail is there:\n${bare}`);
      assert(!/null|undefined|\{\w+\}/.test(bare), `${l}: a hole in:\n${bare}`);
      assert(bare.split('\n').filter((line) => line.startsWith('• ')).length === 2, `${l}: two ways while the post and phone are missing:\n${bare}`);
      const full = D.cancelBlock(w, FULL);
      assert(full.split('\n').filter((line) => line.startsWith('• ')).length === 4, `${l}: four ways:\n${full}`);
      assert(full.includes('PO Box 7 &lt;Harish&gt; &amp; Co') && !full.includes('<Harish>'), `${l}: the address is not escaped:\n${full}`);
      assert(full.includes('+972-50-000-0000'), `${l}: no phone`);
      inOrder(full, [w.cancel, '/paysupport', SELLER.email, 'PO Box 7', '+972-50-000-0000', w.cancelDetails], `${l} full`);
    }
  });

  await check('D4 the seller\'s lines: the name as the language writes it; the ID number and the address when given (escaped); nothing for a detail still missing', () => {
    for (const l of LOCALES) {
      const w = words(l);
      const bare = D.sellerBlock(w, l, BARE);
      assert(bare === w.seller.replace('{name}', SELLER.name[l]), `${l} bare: ${show(bare)}`);
      const full = D.sellerBlock(w, l, FULL);
      assert(
        full === [w.seller.replace('{name}', SELLER.name[l]), w.sellerId.replace('{id}', '012345678'), w.sellerAddress.replace('{address}', 'PO Box 7 &lt;Harish&gt; &amp; Co')].join('\n'),
        `${l} full: ${show(full)}`
      );
    }
    assert(D.sellerBlock(words('en'), 'fr', BARE).includes(SELLER.name.en), 'an unknown language gets the English name');
  });

  await check('D5 the invoice\'s description, en, he and ru, Basic and Pro: at most 255 characters, plain text, the plan, one month, never renews, the seller, agreeing to the Terms by paying (their address in the language), 14 days with /paysupport; one that would not fit is refused', () => {
    for (const l of LOCALES) {
      const template = sub(l).invoiceDescription as string;
      for (const id of ['basic', 'pro'] as const) {
        const text = D.invoiceDescription(template, l, planName(l, id));
        assert(text.length >= 1 && text.length <= 255, `${l} ${id}: ${text.length} characters: ${text}`);
        assert(text.includes(planName(l, id)), `${l} ${id}: no plan name`);
        assert(text.includes(SELLER.name[l]), `${l} ${id}: no seller`);
        assert(text.includes(D.policyUrl('terms', l).replace(/^https:\/\//, '')), `${l} ${id}: not the Terms in this language: ${text}`);
        assert(text.includes('/paysupport') && text.includes('14'), `${l} ${id}: no 14 days with /paysupport`);
        assert(ONE_MONTH[l].test(text) && NEVER_RENEWS[l].test(text), `${l} ${id}: one month, never renews: ${text}`);
        assert(!/[<>]|\{\w+\}|null/.test(text), `${l} ${id}: markup or a hole: ${text}`);
        inOrder(text, fixedParts(template), `${l} ${id}`);
      }
      let refused = '';
      try {
        D.invoiceDescription(template, l, 'P'.repeat(300));
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
      }
      assert(/255/.test(refused), `${l}: a description over 255 characters was not refused: ${show(refused)}`);
    }
  });

  await check('D6 the confirmation, en, he and ru: the plan, the price as the language writes it, the end in the person\'s zone (24-hour), never renews, the seller, the ways to cancel and the Terms link; with the missing details left out, and with them all given', () => {
    const end = new Date('2026-11-29T00:00:00Z');
    const zoneCases: [string, string, string][] = [['Asia/Jerusalem', '29', '02:00'], ['America/New_York', '28', '19:00']];
    for (const l of LOCALES) {
      const w = words(l);
      const template = sub(l).paymentSuccess as string;
      for (const [zone, day, time] of zoneCases) {
        for (const seller of [BARE, FULL]) {
          const text = D.paymentConfirmation({ template, words: w, locale: l, planName: planName(l, 'pro'), price: 5000, periodEnd: end, timeZone: zone, seller });
          const what = `${l} ${zone} ${seller === BARE ? 'bare' : 'full'}`;
          assert(text.includes(`<b>${planName(l, 'pro')}</b>`), `${what}: no plan`);
          assert(text.includes(new Intl.NumberFormat(l === 'en' ? 'en-GB' : l === 'he' ? 'he-IL' : 'ru-RU').format(5000)), `${what}: no price`);
          assert(text.includes(`${day} `) && text.includes(time) && text.includes('2026'), `${what}: the end is not ${day} ... ${time}:\n${text}`);
          assert(!/AM|PM/.test(text), `${what}: a 12-hour time`);
          assert(NEVER_RENEWS[l].test(text), `${what}: never renews`);
          assert(text.includes(D.sellerBlock(w, l, seller)), `${what}: not the seller's lines`);
          assert(text.includes(D.cancelBlock(w, seller)), `${what}: not the ways to cancel`);
          assert(text.includes(D.policyLink(w, 'terms', l, 'html')), `${what}: not the Terms link in this language`);
          assert(!/null|undefined|\{\w+\}/.test(text), `${what}: a hole:\n${text}`);
          inOrder(text, fixedParts(template), what);
          if (seller === FULL) assert(text.includes('012345678') && text.includes('+972-50-000-0000'), `${what}: the ID or the phone is missing`);
        }
      }
    }
  });

  await wiring(D);

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

// ---- W1: payment-handler with its boundaries faked ----

type Sent = { method: string; chatId: unknown; args: unknown[] };
const sent: Sent[] = [];
const logs: string[] = [];
const captured: string[] = [];
const PERIOD_END = new Date('2026-11-29T00:00:00Z');
let zoneFails = false;
const USERS: Row[] = [
  { id: 11, telegramId: BigInt(5011), language: 'en', location: 'Haifa', googleRefreshToken: null },
  { id: 12, telegramId: BigInt(5012), language: 'he', location: 'Haifa', googleRefreshToken: null },
  { id: 13, telegramId: BigInt(5013), language: 'ru', location: 'Haifa', googleRefreshToken: null },
];
const messaging = { sendMessage: async (chatId: unknown, text: string, options?: Row) => { sent.push({ method: 'sendMessage', chatId, args: [text, options] }); return 1; } };
const bot = {
  sendInvoice: async (chatId: unknown, ...args: unknown[]) => { sent.push({ method: 'sendInvoice', chatId, args }); return {}; },
  answerPreCheckoutQuery: async () => true,
};
const stubs: Record<string, object> = {
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => bot, getMessagingService: () => messaging },
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async (id: number) => USERS.find((u) => Number(u.telegramId) === Number(id)) ?? null },
  [`${SRC}/services/subscription-service.ts`]: {
    getSubscription: async () => null,
    upgradeSubscription: async (userId: number, plan: string) => ({ subscription: { userId, plan, status: 'ACTIVE', currentPeriodEnd: PERIOD_END }, credited: true }),
    renewSubscription: async (userId: number) => ({ subscription: { userId, plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: PERIOD_END }, credited: true }),
  },
  [`${SRC}/utils/prisma.ts`]: { prisma: { user: { findUnique: async ({ where }: Row) => USERS.find((u) => u.id === where.id) ?? null } } },
  [`${SRC}/services/analytics-service.ts`]: { trackActivity: async () => undefined, addBreadcrumb: () => undefined, setUserContext: () => undefined },
  [`${SRC}/lib/error-capture.ts`]: { captureError: (e: unknown, context: string) => void captured.push(`${context}: ${e instanceof Error ? e.message : String(e)}`) },
  [`${SRC}/lib/timezone.ts`]: {
    TZ_LOOKUP_MS: 2000,
    timezoneWithin: async (u: Row) => {
      if (zoneFails) throw new Error('redis down (smoke)');
      return u.id === 11 ? 'America/New_York' : 'Asia/Jerusalem';
    },
  },
};
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const kept = { log: console.log, warn: console.warn, error: console.error };
  const take = (...args: unknown[]) => void logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  console.log = take;
  console.warn = take;
  console.error = take;
  try {
    return await fn();
  } finally {
    Object.assign(console, kept);
  }
}

async function wiring(D: typeof import('../src/lib/plan-disclosure')) {
  const handler = await import('../src/services/payment-handler');
  const people: [Locale, Row][] = [['en', USERS[0]], ['he', USERS[1]], ['ru', USERS[2]]];

  await check('W1 the invoice: payment-handler sends the description D5 builds, in the person\'s language, for the plan chosen', async () => {
    for (const [l, user] of people) {
      for (const [plan, id] of [['BASIC', 'basic'], ['PRO', 'pro']] as const) {
        sent.length = 0;
        await quietly(() => handler.sendSubscriptionInvoice(Number(user.telegramId), user.id, plan));
        assert(sent.length === 1 && sent[0].method === 'sendInvoice', `${l} ${plan}: ${show(sent.map((s) => s.method))}`);
        const [title, description, , , currency] = sent[0].args as string[];
        assert(description === D.invoiceDescription(sub(l).invoiceDescription, l, planName(l, id)), `${l} ${plan}: the description ${show(description)}`);
        assert(typeof title === 'string' && title.length <= 32 && title.includes(planName(l, id)) && currency === 'XTR', `${l} ${plan}: the title ${show(title)} ${show(currency)}`);
      }
    }
  });

  await check('W1 a successful payment: one message, D6\'s confirmation in the person\'s language and zone, as HTML with no link preview and the View Subscription button', async () => {
    for (const [l, user] of people) {
      for (const action of ['upgrade', 'renew'] as const) {
        sent.length = 0;
        const payload = JSON.stringify({ plan: 'PRO', userId: user.id, action });
        await quietly(() => handler.handleSuccessfulPayment(Number(user.telegramId), Number(user.telegramId), { currency: 'XTR', total_amount: 5000, invoice_payload: payload, telegram_payment_charge_id: 'chg_1', provider_payment_charge_id: '' }));
        assert(sent.length === 1 && sent[0].method === 'sendMessage', `${l} ${action}: ${sent.length} sends: ${show(sent.map((s) => [s.method, String(s.args[0]).slice(0, 60)]))}`);
        const [text, options] = sent[0].args as [string, Row];
        const zone = user.id === 11 ? 'America/New_York' : 'Asia/Jerusalem';
        const want = D.paymentConfirmation({ template: sub(l).paymentSuccess, words: words(l), locale: l, planName: planName(l, 'pro'), price: 5000, periodEnd: PERIOD_END, timeZone: zone });
        assert(text === want, `${l} ${action}: the text\n${text}\n--- want ---\n${want}`);
        assert(options?.format === MessageFormat.HTML && options?.disablePreview === true, `${l} ${action}: the options ${show(options)}`);
        const button = options?.replyMarkup?.inline_keyboard?.[0]?.[0];
        assert(button?.text === sub(l).viewSubscription && String(button?.web_app?.url).includes(`/${l}/subscription?user_id=${user.telegramId}`), `${l} ${action}: the button ${show(button)}`);
      }
    }
  });

  await check('W1 a zone lookup that throws is logged and the confirmation still goes, in the default zone (Asia/Jerusalem)', async () => {
    sent.length = 0;
    logs.length = 0;
    captured.length = 0;
    zoneFails = true;
    try {
      const user = USERS[0];
      await quietly(() => handler.handleSuccessfulPayment(5011, 5011, { currency: 'XTR', total_amount: 5000, invoice_payload: JSON.stringify({ plan: 'PRO', userId: 11, action: 'upgrade' }), telegram_payment_charge_id: 'chg_2', provider_payment_charge_id: '' }));
      assert(sent.length === 1, `${sent.length} sends`);
      const want = D.paymentConfirmation({ template: sub('en').paymentSuccess, words: words('en'), locale: 'en', planName: planName('en', 'pro'), price: 5000, periodEnd: PERIOD_END, timeZone: 'Asia/Jerusalem' });
      assert(sent[0].args[0] === want, `the text in the default zone:\n${sent[0].args[0]}`);
      assert(logs.some((line) => line.includes('redis down (smoke)') && line.includes(String(user.id))), `not logged: ${show(logs)}`);
      assert(captured.some((line) => line.includes('redis down (smoke)')), `not captured: ${show(captured)}`);
    } finally {
      zoneFails = false;
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
