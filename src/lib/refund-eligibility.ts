/**
 * Until when an admin can refund a payment: the one rule for the server (the payments the admin panel is sent, in
 * app/api/admin/user-overrides; the refund itself is src/services/admin-refund.ts) and for the Mini App (the Refund row of
 * each payment in the person's plan). It imports nothing, so the browser bundle carries no Prisma and no server code.
 *
 * The refund rule is the terms' (/terms): on request within 14 days of the payment, through /paysupport. A payment is a
 * Payment row (one per Telegram Stars charge, src/services/subscription-service.ts creditPayment), dated by when it was
 * paid; one already refunded is never offered again.
 */

/** Days after a payment during which it is refunded on request: the one number for the code; scripts/smoke-terms-plans.ts holds the copy to it. */
export const REFUND_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The earliest payment that is still inside the refund window at `now`. */
export function refundWindowStart(now: Date): Date {
  return new Date(now.getTime() - REFUND_WINDOW_DAYS * DAY_MS);
}

/** Whether a payment made at `paidAt` (an ISO instant) is still inside the refund window at `now`. */
export function refundableNow(paidAt: string | null | undefined, now: Date): boolean {
  if (!paidAt) return false;
  const paid = Date.parse(paidAt);
  if (Number.isNaN(paid)) return false;
  return paid >= refundWindowStart(now).getTime();
}
