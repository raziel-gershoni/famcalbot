// How the admin panel words time and plans. Dates and times are the device's, in 24-hour time, in the page's language
// (the calendar home's formatters, src/lib/calendar-view/format.ts, with the device's zone filled in); "ago" is Intl's
// own, so Hebrew says "לפני 5 דקות" and "אתמול", Russian "5 минут назад" and "вчера", with the plural each language wants.
//
// Client components only: on the server the "device" is the server (src/lib/calendar-view/device-time.ts).

import { formatDeviceDate } from '@/src/lib/calendar-view/device-time';
import { formatTime, intlLocale } from '@/src/lib/calendar-view/format';
import { deviceTimeZone } from '@/src/lib/calendar-view/home-client';

/** The seconds below which a time is "now" (a server clock a little ahead of the phone's reads as now, not as "in 3 seconds"). */
const NOW_SECONDS = 45;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/**
 * "5 minutes ago" / "לפני 5 דקות" / "5 минут назад", "yesterday", "now": how long before `now` an instant was. '' when `iso` is no instant.
 * CLDR 48 (newer engines) writes Hebrew's one and two with their number in brackets ("לפני דקה (1)", "לפני שעתיים (2)"); that tail is dropped.
 */
export function relativeTime(iso: string, locale: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now.getTime() - then) / 1000);
  const sign = seconds < 0 ? 1 : -1;
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  const say = (value: number, unit: Intl.RelativeTimeFormatUnit) => rtf.format(value, unit).replace(/\s*\(\d+\)$/, '');
  if (abs < NOW_SECONDS) return say(0, 'second');
  if (abs < HOUR) return say(sign * Math.floor(abs / MINUTE), 'minute');
  if (abs < DAY) return say(sign * Math.floor(abs / HOUR), 'hour');
  const days = Math.floor(abs / DAY);
  if (days < 30) return say(sign * days, 'day');
  if (days < 365) return say(sign * Math.floor(days / 30), 'month');
  return say(sign * Math.floor(days / 365), 'year');
}

/** "3 Oct 2026, 15:45": a day with its year and a 24-hour time, on the device. '' when `iso` is no instant. */
export function dateTime24(iso: string, locale: string): string {
  const day = dateOnly(iso, locale);
  return day ? `${day}, ${formatTime(iso, deviceTimeZone() ?? '', locale)}` : '';
}

/** "3 Oct 2026": the day an instant falls on, on the device. '' when `iso` is no instant. */
export function dateOnly(iso: string, locale: string): string {
  return formatDeviceDate(iso, locale);
}

/** The translator of the `admin` namespace (next-intl's useTranslations('admin') or createTranslator). */
export type AdminTranslate = (key: string, values?: Record<string, string | number>) => string;

/** The message of each plan's name (admin.plan.names.*). */
const PLAN_NAMES: Record<string, string> = { FREE: 'plan.names.free', BASIC: 'plan.names.basic', PRO: 'plan.names.pro' };

interface PlanSource {
  plan: string;
  status: string;
  trialDaysRemaining: number | null;
  currentPeriodEnd: string | null;
  comped?: boolean;
}

/**
 * One line for a person's plan, from their subscription row (a list row's or a profile's):
 * "Pro · trial, 9 days left" (a trial counts as Pro, as the app treats it), "Basic · until 3 Nov 2026",
 * "Pro · free from an admin", "Free · expired", or "Free". A paid plan whose period has passed is Free.
 */
export function planLine(user: { subscription: PlanSource | null }, t: AdminTranslate, locale: string, now: Date = new Date()): string {
  const sub = user.subscription;
  const name = (plan: string) => (PLAN_NAMES[plan] ? t(PLAN_NAMES[plan]) : plan);
  if (!sub) return name('FREE');
  if (sub.comped && sub.status === 'ACTIVE') return t('planLine.comped', { plan: name(sub.plan) });
  if (sub.status === 'TRIALING') {
    return sub.trialDaysRemaining ? t('planLine.trial', { plan: name('PRO'), days: sub.trialDaysRemaining }) : name('FREE');
  }
  const paidPlan = sub.plan !== 'FREE';
  const periodEnd = sub.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : NaN;
  if (paidPlan && sub.status === 'ACTIVE') {
    return Number.isNaN(periodEnd) ? name(sub.plan) : t('planLine.until', { plan: name(sub.plan), date: dateOnly(sub.currentPeriodEnd as string, locale) });
  }
  if (paidPlan && sub.status === 'CANCELED' && periodEnd > now.getTime()) {
    return t('planLine.until', { plan: name(sub.plan), date: dateOnly(sub.currentPeriodEnd as string, locale) });
  }
  if (sub.status === 'EXPIRED') return t('planLine.expired', { plan: name('FREE') });
  return name('FREE');
}
