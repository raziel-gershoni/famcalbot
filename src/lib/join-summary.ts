// The Join question's words (web sign-up spec 2026-11-03 §2.9): what moves, as lines of settings.signIn.join, from the
// dry run's plan (join.ts offerJoin). Settings' email sheet (a client) and the add-Google page (a server page) both
// render these, so the two show the same list. Client-safe: type imports only.

import type { MergePlan } from '../services/account-linking';
import type { JoinSummary } from '../services/web-signin/join';

export type { JoinSummary };

/** A line of the question: a key of settings.signIn.join and its numbers. */
export type JoinLine = {
  key: 'calendars' | 'wayGoogle' | 'wayEmail' | 'google' | 'googleStays' | 'partner' | 'partnerEnds' | 'plan';
  values?: { calendars: number; events: number };
};

/** What comes over, and what doesn't, in the order the question lists it. */
export function joinLines(plan: MergePlan): JoinLine[] {
  const lines: JoinLine[] = [{ key: 'calendars', values: { calendars: plan.calendars, events: plan.events } }];
  for (const kind of plan.ways) lines.push({ key: kind === 'google' ? 'wayGoogle' : 'wayEmail' });
  if (plan.google === 'moves') lines.push({ key: 'google' });
  if (plan.google === 'stays') lines.push({ key: 'googleStays' });
  if (plan.partner === 'moves') lines.push({ key: 'partner' });
  if (plan.partner === 'ends') lines.push({ key: 'partnerEnds' });
  if (plan.plan === 'moves') lines.push({ key: 'plan' });
  return lines;
}

/**
 * The day the other account was made, in words ("3 November 2026"), in Israel's time: an account made on famcal.bot
 * has no place yet, so the default zone is its zone. The same text on the server and in the browser.
 */
export function joinDateText(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
}

const isCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The shape the email confirm route answers a join with. */
export function isJoinSummary(value: unknown): value is JoinSummary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const plan = v.plan as Record<string, unknown> | null | undefined;
  return typeof v.name === 'string' && typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
    && !!plan && isCount(plan.calendars) && isCount(plan.events) && Array.isArray(plan.ways)
    && plan.ways.every(w => w === 'google' || w === 'email')
    && ['moves', 'stays', 'none'].includes(String(plan.google)) && ['moves', 'ends', 'none'].includes(String(plan.partner))
    && ['moves', 'stays'].includes(String(plan.plan));
}
