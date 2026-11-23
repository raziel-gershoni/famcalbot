// The plan's status line, said once for the two screens that show it: the Subscription screen (under the plan's name, on its
// current-plan card) and Settings' Plan row (spec docs/superpowers/specs/2026-11-24-menu-revamp-design.md §5), so the two never
// disagree. It is the Subscription screen's own rule, extracted, in this order:
//  1. an early adopter: early access, whatever the plan;
//  2. trialing: the trial's days left;
//  3. a paid plan (anything but Free) with a period end: active until that date;
//  4. otherwise nothing (Free, a free gift or an admin grant with no period end).
// planStatusOf is the rule (a PlanStatus, data); planStatusWords turns it into the person's words, taking the three phrases from
// the caller (each screen reads its own translator, so no message key is named here). Client-safe: no imports beyond a type.

import type { PlanId } from '@/src/config/plans';

export type PlanStatus = { kind: 'earlyAccess' } | { kind: 'trial'; days: number } | { kind: 'activeUntil'; date: string } | null;

/** The date's language: Gregorian, in the device's zone (a period end is a point in time, not a Hebrew date). */
const DATE_LOCALES: Record<string, string> = { he: 'he-IL', ru: 'ru-RU', en: 'en-US' };

export function planStatusOf(o: { plan: PlanId; currentPeriodEnd: string | null; isEarlyAdopter: boolean; isTrialing: boolean; trialDaysRemaining: number }): PlanStatus {
  if (o.isEarlyAdopter) return { kind: 'earlyAccess' };
  if (o.isTrialing) return { kind: 'trial', days: o.trialDaysRemaining };
  if (o.plan !== 'FREE' && o.currentPeriodEnd) return { kind: 'activeUntil', date: o.currentPeriodEnd };
  return null;
}

export function planStatusWords(
  status: PlanStatus,
  words: { earlyAccess: () => string; trial: (days: number) => string; activeUntil: (date: string) => string },
  locale: string,
): string | null {
  if (!status) return null;
  switch (status.kind) {
    case 'earlyAccess':
      return words.earlyAccess();
    case 'trial':
      return words.trial(status.days);
    case 'activeUntil':
      return words.activeUntil(new Date(status.date).toLocaleDateString(DATE_LOCALES[locale] ?? 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }));
  }
}
