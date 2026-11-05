/**
 * The Shabbat and Yom Tov pause: the one question every scheduled send asks before it sends.
 * Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 2).
 *
 *   isPaused(user, at)   whether `pauseOnShabbat` is on and `at` falls inside a Shabbat or Yom Tov
 *                        window at the person's place, from sunset on the eve to the end of the day
 *   nextPauseStart(user, from, withinMs)
 *                        when the next window begins within that span (null: none, or the switch is
 *                        off): a browser notification's lifetime ends there, so one waiting at the
 *                        push service never arrives inside the window (web-push/send.ts)
 *
 * A send that is paused is skipped and logged "[pause] skipped <kind> for <userId>" (pass `skipped`
 * to have it logged here, once, in one format). What a pass does with the thing it skipped is the
 * pass's own business: a native reminder is claimed as sent without a message, so it is not sent
 * after the window and stays open; an event alert's moment passes; a summary is not retried; a
 * setup nudge or a renewal reminder is tried again on its next run.
 *
 * Not paused: replies to the person's own actions (their commands, buttons and messages), and
 * messages to the admin. scripts/smoke-pause.ts lists every sender and which kind it is.
 *
 * This file is the light half, so that the many places that ask do not each load @hebcal/core and
 * the place lookups: the switch is read here, and the windows are worked out in pause-windows.ts
 * only for a person who has it on. A failure there is logged, captured, and read as "not paused":
 * a bug in the pause must never silence everyone's reminders.
 */

import { captureError } from '../../lib/error-capture';

/** The fields of a user the pause reads. A `UserConfig`, a cached reminder entry and the selects of the passes all have them. */
export interface PauseUser {
  id: number;
  /** The place name: the lazy fill's lookup, and the zone's source. */
  location?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  elevationM?: number | null;
  /** 'sephardi' | 'ashkenazi' | 'chabad'; anything else reads as the default. */
  zmanimCommunity?: string | null;
  /** The switch. Only `true` pauses: unset (an entry from before the column) and null read as off. */
  pauseOnShabbat?: boolean | null;
  /** The decrypted token, when the caller has it: the zone may come from the Google calendar. Never the stored ciphertext. */
  googleRefreshToken?: string;
}

/**
 * Whether the person's scheduled messages are paused at `at` (default now). `skipped` names the
 * send that would have gone out ("event alert", "native reminder ping", ...): when paused it is
 * logged as "[pause] skipped <skipped> for <userId>". Never throws.
 */
export async function isPaused(user: PauseUser, at: Date = new Date(), skipped?: string): Promise<boolean> {
  if (user.pauseOnShabbat !== true) return false;
  let paused: boolean;
  try {
    const { pausedAt } = await import('./pause-windows');
    paused = await pausedAt(user, at);
  } catch (error) {
    console.error(`[pause] could not tell whether user ${user.id} is in Shabbat or Yom Tov; sending as usual:`, error);
    captureError(error, 'pause-check', { user_id: user.id });
    return false;
  }
  if (paused && skipped) console.log(`[pause] skipped ${skipped} for ${user.id}`);
  return paused;
}


/**
 * The start of the person's next Shabbat or Yom Tov window that begins after `from` and no later than `from` +
 * `withinMs` (read as at most a day), or null: the switch is off, no window begins in the span, or it could not be
 * told (logged and captured; the caller keeps its own limit). Never throws.
 */
export async function nextPauseStart(user: PauseUser, from: Date, withinMs: number): Promise<Date | null> {
  if (user.pauseOnShabbat !== true || !(withinMs > 0)) return null;
  try {
    const { pauseStartWithin } = await import('./pause-windows');
    return await pauseStartWithin(user, from, withinMs);
  } catch (error) {
    console.error(`[pause] could not tell when user ${user.id}'s next Shabbat or Yom Tov begins; the push keeps its own lifetime:`, error);
    captureError(error, 'pause-next', { user_id: user.id });
    return null;
  }
}
