'use client';

// The plan's status line in the person's words (spec docs/superpowers/specs/2026-11-24-menu-revamp-design.md §5): the PlanStatus
// from planStatusOf (./plan-glance.ts) turned into one phrase, taking the three phrases from the caller (each screen reads its own
// translator, so no message key is named here). A client module: "active until" names the period end's day on the viewer's own
// clock, as the Subscription screen always has, and scripts/smoke-dst.ts keeps server code from reading a date that way.

import type { PlanStatus } from './plan-glance';

/** The date's language: Gregorian, in the device's zone (a period end is a point in time, not a Hebrew date). */
const DATE_LOCALES: Record<string, string> = { he: 'he-IL', ru: 'ru-RU', en: 'en-US' };

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
