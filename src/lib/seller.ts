// Who sells FamCal's paid plans (Consumer Protection Law s.14C(a)(1)): the Terms, the plan screen and the confirmation
// after a payment all read these, so a change is made once. The ID number is shown only in the bot (the plan screen,
// /terms and the confirmation), never on the website: the owner's choice (2026-10-30), since the site's prices are for
// information and a plan is bought in the bot. Client-safe: no import.

export type SellerLocale = 'en' | 'he' | 'ru';

export interface Seller {
  /** The seller's name, as each language writes it. */
  name: Record<SellerLocale, string>;
  /** The ID number or the business (עוסק) number. */
  idNumber: string | null;
  /** A postal address in Israel that takes a cancellation by registered mail. */
  postalAddress: string | null;
  /** A phone number that takes a cancellation and payment questions. */
  phone: string | null;
  /** The email for privacy, payments and cancellations (Cloudflare Email Routing, from 2026-11-01). */
  email: string;
}

/** `null` marks a detail the owner hasn't given yet: the website shows "to be added" and the bot leaves it out. */
export const SELLER: Seller = {
  name: { en: 'Raziel Gershoni', he: 'רזיאל גרשוני', ru: 'Разиэль Гершони' },
  idNumber: null,
  postalAddress: null,
  phone: null,
  email: 'privacy@famcal.bot',
};
