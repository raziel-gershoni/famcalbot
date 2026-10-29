// What a paid plan tells the person before and after they pay (Consumer Protection Law s.14C, s.13C(b) and s.14I; Telegram's
// Stars checklist; the legal review of 2026-10-29, Part 3 issues 3, 4, 6 and 20). One place for each piece, so the plan
// screen, the Stars invoice, the confirmation after a payment, /terms, /paysupport, /start and the WhatsApp welcome say
// the same thing:
//  - the policy pages' addresses in the person's language (the site's own pageUrl: English unprefixed, /he/terms);
//  - the two links, as Telegram's anchors or as WhatsApp's plain "label: url" lines;
//  - the ways to cancel within 14 days and the seller's lines, from SELLER (src/lib/seller.ts). A detail the owner has not
//    given yet (null) leaves its line out; scripts/smoke-seller.ts keeps a release from shipping without it;
//  - the invoice's description (Telegram takes 1-255 characters) and the confirmation's text.
// The words are the caller's: bot.policy, subscription.invoiceDescription and subscription.paymentSuccess. Every value put
// into Telegram's HTML is escaped here. Pure and client-safe: the plan screen reads policyUrl.

import { pageUrl } from '../site/seo';
import { escapeHtml } from '../utils/html';
import { normalizeLocale } from '../utils/locale';
import { formatDayYear, formatTime, instantDay, intlLocale } from './calendar-view/format';
import { SELLER, type Seller } from './seller';

export type PolicyPage = 'privacy' | 'terms';

/** A policy page in the person's language: https://famcal.bot/terms, /he/terms, /ru/terms. Any other language reads English. */
export function policyUrl(page: PolicyPage, locale: string | null | undefined): string {
  return pageUrl(normalizeLocale(locale), `/${page}`);
}

/** The words the disclosure is made of: bot.policy in messages/<locale>.json. */
export interface PolicyWords {
  privacy: string;
  terms: string;
  cancel: string;
  cancelBot: string;
  cancelEmail: string;
  cancelPost: string;
  cancelPhone: string;
  cancelDetails: string;
  seller: string;
  sellerId: string;
  sellerAddress: string;
}

/** Telegram's HTML, or WhatsApp's plain text. */
export type LinkFormat = 'html' | 'text';

/** A template's {placeholders} filled in one pass. The values go in as they are: the caller has escaped what needs it. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

/** One policy page's link: an anchor for Telegram, "label: url" for WhatsApp (which shows a link as it is written). */
export function policyLink(words: PolicyWords, page: PolicyPage, locale: string | null | undefined, format: LinkFormat): string {
  const url = policyUrl(page, locale);
  return format === 'html' ? `<a href="${escapeHtml(url)}">${escapeHtml(words[page])}</a>` : `${words[page]}: ${url}`;
}

/** The Privacy Policy and the Terms: on one line in Telegram, a line each on WhatsApp. */
export function policyLinks(words: PolicyWords, locale: string | null | undefined, format: LinkFormat): string {
  const [privacy, terms] = (['privacy', 'terms'] as const).map((page) => policyLink(words, page, locale, format));
  return format === 'html' ? `${privacy} · ${terms}` : `${privacy}\n${terms}`;
}

/**
 * The ways to cancel a payment within 14 days, in Telegram's HTML: what the person can do, a bullet per way (/paysupport,
 * the email, the post and the phone; one whose detail is still null left out), and what to give.
 */
export function cancelBlock(words: PolicyWords, seller: Seller = SELLER): string {
  const ways = [
    words.cancelBot,
    fill(words.cancelEmail, { email: escapeHtml(seller.email) }),
    seller.postalAddress ? fill(words.cancelPost, { address: escapeHtml(seller.postalAddress) }) : null,
    seller.phone ? fill(words.cancelPhone, { phone: escapeHtml(seller.phone) }) : null,
  ].filter((way): way is string => way !== null);
  return [words.cancel, ...ways.map((way) => `• ${way}`), words.cancelDetails].join('\n');
}

/** The seller's lines in Telegram's HTML: the name in the person's language, then the ID number and the address when given. */
export function sellerBlock(words: PolicyWords, locale: string | null | undefined, seller: Seller = SELLER): string {
  return [
    fill(words.seller, { name: escapeHtml(seller.name[normalizeLocale(locale)]) }),
    seller.idNumber ? fill(words.sellerId, { id: escapeHtml(seller.idNumber) }) : null,
    seller.postalAddress ? fill(words.sellerAddress, { address: escapeHtml(seller.postalAddress) }) : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** The most Telegram takes in an invoice's description. */
export const INVOICE_DESCRIPTION_MAX = 255;

/**
 * The Stars invoice's description (plain text): subscription.invoiceDescription with the plan, the seller and the Terms'
 * address without its scheme. One that would not fit is refused with the reason: Telegram would refuse the invoice, and a
 * cut one would lose the cancellation right at its end.
 */
export function invoiceDescription(template: string, locale: string | null | undefined, planName: string, seller: Seller = SELLER): string {
  const text = fill(template, {
    plan: planName,
    seller: seller.name[normalizeLocale(locale)],
    terms: policyUrl('terms', locale).replace(/^https:\/\//, ''),
  });
  if (text.length > INVOICE_DESCRIPTION_MAX) {
    throw new Error(`The invoice description is ${text.length} characters, over Telegram's ${INVOICE_DESCRIPTION_MAX} (${normalizeLocale(locale)}, ${planName})`);
  }
  return text;
}

/** "29 Nov 2026, 02:00" / "29 בנוב׳ 2026, 02:00": an instant's day with its year and its 24-hour time in `timeZone`. */
function endText(periodEnd: Date, timeZone: string, locale: string): string {
  const iso = periodEnd.toISOString();
  const day = instantDay(iso, timeZone);
  return `${day ? formatDayYear(day, locale) : ''}, ${formatTime(iso, timeZone, locale)}`;
}

/**
 * The message after a payment, in Telegram's HTML (s.14C(b), s.14I(e)(1)): subscription.paymentSuccess with the plan, the
 * price, when the month ends in the person's zone, the seller's lines, the ways to cancel and the Terms' link.
 */
export function paymentConfirmation(a: {
  template: string;
  words: PolicyWords;
  locale: string | null | undefined;
  planName: string;
  /** In Telegram Stars. */
  price: number;
  periodEnd: Date;
  timeZone: string;
  seller?: Seller;
}): string {
  const locale = normalizeLocale(a.locale);
  return fill(a.template, {
    plan: escapeHtml(a.planName),
    price: new Intl.NumberFormat(intlLocale(locale)).format(a.price),
    end: endText(a.periodEnd, a.timeZone, locale),
    seller: sellerBlock(a.words, locale, a.seller),
    cancel: cancelBlock(a.words, a.seller),
    terms: policyLink(a.words, 'terms', locale, 'html'),
  });
}
