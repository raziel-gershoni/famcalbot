/**
 * Who can be given Pro for free ("comped") by an admin: the one rule, for the server (the grant in
 * src/services/subscription-service.ts) and for the Mini App (the Give button of the person's plan).
 * It imports nothing, so the browser bundle carries no Prisma and no server code.
 *
 * A person holds a paid plan when the plan is ACTIVE, or CANCELED with its period end still ahead
 * (they paid for that time, and a gift must not quietly overwrite it). A free trial is not paid:
 * a gift replaces it, and stopping the gift gives back the trial days that are left. EXPIRED holds
 * nothing.
 */
export function holdsPaidPlan(sub: { status: string; currentPeriodEnd: Date | string | null }, now: Date): boolean {
  if (sub.status === 'ACTIVE') return true;
  if (sub.status !== 'CANCELED' || sub.currentPeriodEnd === null) return false;
  const periodEnd = typeof sub.currentPeriodEnd === 'string' ? Date.parse(sub.currentPeriodEnd) : sub.currentPeriodEnd.getTime();
  return periodEnd > now.getTime();
}
