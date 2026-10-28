/**
 * Who can be refunded by an admin, and until when: the one rule for the server (the payment date the admin panel is sent,
 * the refund itself in src/services/admin-refund.ts) and for the Mini App (the "Refund last payment" button of the person's
 * plan). It imports nothing, so the browser bundle carries no Prisma and no server code.
 *
 * The refund rule is the terms' (/terms): on request within 14 days of the payment, through /paysupport. A payment is a
 * subscription row with a Telegram payment charge id that no admin gave away (a free Pro gift has none and is never a
 * payment). The date of the last payment is the start of the current period, which every payment, first or renewal, sets.
 */

/** Days after a payment during which it is refunded on request. */
export const REFUND_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

interface PaymentFacts {
  telegramPaymentChargeId: string | null;
  compedBy: number | null;
  currentPeriodStart: Date | null;
}

/** The last real payment's date, or null when the person has not paid (a free gift, a trial, no row). */
export function lastPaymentAt(sub: PaymentFacts | null | undefined): Date | null {
  if (!sub || !sub.telegramPaymentChargeId || sub.compedBy != null) return null;
  return sub.currentPeriodStart;
}

/** Whether a payment made at `paidAt` (an ISO instant) is still inside the refund window at `now`. */
export function refundableNow(paidAt: string | null | undefined, now: Date): boolean {
  if (!paidAt) return false;
  const paid = Date.parse(paidAt);
  if (Number.isNaN(paid)) return false;
  return now.getTime() - paid <= REFUND_WINDOW_DAYS * DAY_MS;
}
