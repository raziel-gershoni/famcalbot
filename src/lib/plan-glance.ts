// The plan's status line, said once for the two screens that show it: the Subscription screen (under the plan's name, on its
// current-plan card) and Settings' Plan row (spec docs/superpowers/specs/2026-11-24-menu-revamp-design.md §5), so the two never
// disagree. It is the Subscription screen's own rule, extracted, in this order:
//  1. an early adopter: early access, whatever the plan;
//  2. trialing: the trial's days left;
//  3. a paid plan (anything but Free) with a period end: active until that date;
//  4. otherwise nothing (Free, a free gift or an admin grant with no period end).
// planStatusOf is the rule (a PlanStatus, data), read by the server (Settings' page data) and the Subscription screen; the words
// are planStatusWords in ./plan-status-words.ts, a 'use client' module, because it reads the period end on the viewer's own clock
// (scripts/smoke-dst.ts keeps server code from reading a date that way). Client-safe: no imports beyond a type.

import type { PlanId } from '@/src/config/plans';

export type PlanStatus = { kind: 'earlyAccess' } | { kind: 'trial'; days: number } | { kind: 'activeUntil'; date: string } | null;

export function planStatusOf(o: { plan: PlanId; currentPeriodEnd: string | null; isEarlyAdopter: boolean; isTrialing: boolean; trialDaysRemaining: number }): PlanStatus {
  if (o.isEarlyAdopter) return { kind: 'earlyAccess' };
  if (o.isTrialing) return { kind: 'trial', days: o.trialDaysRemaining };
  if (o.plan !== 'FREE' && o.currentPeriodEnd) return { kind: 'activeUntil', date: o.currentPeriodEnd };
  return null;
}
