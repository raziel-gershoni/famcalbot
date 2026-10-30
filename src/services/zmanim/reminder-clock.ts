/**
 * The zman clock of a person: what the reminder pass, the home, the digests and the editor ask to turn a
 * reminder's zman rule into the instant it is due. The light half (the pause's split, pause.ts): the callers
 * import this, and the calculator (hebcal, the place lookups) loads with import() only when a reminder by zman
 * is actually read, so the many files that read reminders do not each load it.
 * Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 3).
 *
 *   zmanClockFor(user, zone)   the person's clock, or null where no place can be had at all
 *   zmanClockIfNeeded(...)     the same, only when something read has a zman rule (the caller's yes/no)
 *   candleLightingDaysFor(...) the days from a day on that the person lights candles (the rest-day blocks, day-list.ts lightsCandles)
 *
 * Never throws: a failure is logged and captured, and read as no clock (the reminder is then shown at the
 * person's reminder time and the pass skips it, both logged).
 */

import { captureError } from '../../lib/error-capture';
import type { ZmanClock, ZmanimInfo } from '../../lib/calendar-view/zman-spec';
import type { PauseUser } from './pause';

export type { ZmanClock };

/** The fields of a user the clock reads: the pause's (place and community) and the place name. */
export type ZmanUser = PauseUser;

/** The person's zman clock for `zone` (their timezone), or null where there is no place to count from. */
export async function zmanClockFor(user: ZmanUser, zone: string): Promise<ZmanClock | null> {
  try {
    const { buildZmanClock } = await import('./reminder-times');
    return await buildZmanClock(user, zone);
  } catch (error) {
    console.error(`[zmanim] could not build the zman clock of user ${user.id}:`, error);
    captureError(error, 'zmanim-clock', { user_id: user.id });
    return null;
  }
}

/** zmanClockFor, but only when `needed` (something being read holds a reminder by zman); null otherwise. */
export function zmanClockIfNeeded(needed: boolean, user: ZmanUser, zone: string): Promise<ZmanClock | null> {
  return needed ? zmanClockFor(user, zone) : Promise.resolve(null);
}

/**
 * The days (yyyy-MM-dd in `zone`) from `fromDay` for `spanDays` days on which the person lights candles: the day a
 * Shabbat or Yom Tov window begins, and each Friday inside a longer one. Empty where it cannot be had (logged).
 */
export async function candleLightingDaysFor(user: ZmanUser, zone: string, fromDay: string, spanDays: number): Promise<string[]> {
  try {
    const { candleLightingDays } = await import('./reminder-times');
    return await candleLightingDays(user, zone, fromDay, spanDays);
  } catch (error) {
    console.error(`[zmanim] could not find the candle lighting days of user ${user.id}:`, error);
    captureError(error, 'zmanim-candle-days', { user_id: user.id });
    return [];
  }
}

/** The editor's zmanim block (the community's zmanim and today's time of each) for `today`, or undefined where it cannot be had (logged). */
export async function zmanEditorInfoFor(user: ZmanUser, zone: string, today: string): Promise<ZmanimInfo | undefined> {
  try {
    const { zmanEditorInfo } = await import('./reminder-times');
    return await zmanEditorInfo(user, zone, today);
  } catch (error) {
    console.error(`[zmanim] could not build the editor's zmanim for user ${user.id}:`, error);
    captureError(error, 'zmanim-editor-info', { user_id: user.id });
    return undefined;
  }
}
