// The colour a new FamCal calendar takes (colour change, 2026-10-24), and the colours the
// user sees together. Every path that creates a native calendar calls autoCalendarColour,
// so the pick is made once, the same way; every response that carries a calendar's colour
// to a screen passes it through displayColourFor, so every surface draws the same one.

import { encodeCalendarId, listVisibleCalendars } from './event-store';
import { liveGoogleChoices, type GoogleChoicesOwner } from '../../lib/google-state';
import { displayColours, googleDrawnColour, pickCalendarColour, type VisibleCalendar } from '../../lib/calendar-colours';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';

export type ColourOwner = GoogleChoicesOwner & { id: number; pairingId: string | null | undefined };

/** Google's live colour of each chosen calendar, by calendar id: '#rrggbb', lower case (the range read's LiveColours). */
export type LiveColourMap = Readonly<Record<string, string>>;

const LOG = '[colour]';
const HEX = /^#[0-9a-f]{6}$/i;
/** The live colours stay remembered this long without a new read (a cache: past it, the saved colours stand in). */
const REMEMBER_TTL_S = 30 * 24 * 3600;

/**
 * Keeps the live colours the range read just got, so the surfaces that make no Google read
 * (the editor, the item sheet, the Calendars page, calendar creation, onboarding) judge a
 * Google calendar by the same colour the home draws. Never throws: a failure is logged and
 * captured, and those surfaces use the saved colours.
 */
export async function rememberLiveColours(userId: number, live: LiveColourMap | undefined): Promise<void> {
  if (!live || Object.keys(live).length === 0) return;
  try {
    await redis.set(REDIS_KEYS.gcalColours(userId), live, { ex: REMEMBER_TTL_S });
  } catch (err) {
    console.error(`${LOG} could not remember the live Google colours for user ${userId}:`, err);
    captureError(err, 'colour-remember', { user_id: userId }, 'warning');
  }
}

async function rememberedLiveColours(userId: number): Promise<Record<string, string>> {
  try {
    const raw = await redis.get<unknown>(REDIS_KEYS.gcalColours(userId));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && HEX.test(e[1])));
  } catch (err) {
    console.error(`${LOG} could not read the remembered Google colours for user ${userId}:`, err);
    captureError(err, 'colour-recall', { user_id: userId }, 'warning');
    return {};
  }
}

/**
 * The user's chosen Google calendars with the colour the home draws them in (googleDrawnColour):
 * the live colour (`live`, from a read made now, else the one remembered from the last read),
 * then the saved choice colour, then Google's default.
 */
export async function googleColoursOnScreen(user: ColourOwner, live?: LiveColourMap): Promise<VisibleCalendar[]> {
  const choices = liveGoogleChoices(user);
  if (choices.length === 0) return [];
  const remembered = await rememberedLiveColours(user.id);
  return choices.map((a): VisibleCalendar => ({
    id: a.calendarId,
    color: googleDrawnColour(live?.[a.calendarId] ?? remembered[a.calendarId], a.color),
    native: false,
  }));
}

/**
 * Every calendar on the user's screen with its colour: their FamCal calendars and the
 * partner's they see, and their chosen Google calendars as the home draws them.
 */
export async function calendarsOnScreen(user: ColourOwner, live?: LiveColourMap): Promise<VisibleCalendar[]> {
  const native = await listVisibleCalendars(user.id, user.pairingId ?? null);
  return [
    ...native.map((c): VisibleCalendar => ({ id: encodeCalendarId(c.id), color: c.color, native: true })),
    ...(await googleColoursOnScreen(user, live)),
  ];
}

/** The palette colour farthest from everything the user sees (pickCalendarColour). */
export async function autoCalendarColour(user: ColourOwner): Promise<string> {
  return pickCalendarColour((await calendarsOnScreen(user)).map((c) => c.color));
}

/**
 * The colour each of the user's FamCal calendars is drawn in, by calendar id (displayColours).
 * Google calendars are not in it: their colour is Google's, live or saved, and never shifted.
 * `live` is the colours the caller's own Google read just got.
 */
export async function displayColourMap(user: ColourOwner, live?: LiveColourMap): Promise<Map<string, string>> {
  const calendars = await calendarsOnScreen(user, live);
  const natives = new Set(calendars.filter((c) => c.native).map((c) => c.id));
  return new Map([...displayColours(calendars)].filter(([id]) => natives.has(id)));
}

/** A calendar reference with the colour it is drawn in; one with no id (masked) or no entry stays as it is. */
export function displayColourFor<T extends { id: string | null; color: string | null }>(calendar: T, map: ReadonlyMap<string, string>): T {
  const colour = calendar.id === null ? undefined : map.get(calendar.id);
  return colour !== undefined && colour !== calendar.color ? { ...calendar, color: colour } : calendar;
}
