// The colour a new FamCal calendar takes (colour change, 2026-10-24), and the colours the
// user sees together. Every path that creates a native calendar calls autoCalendarColour,
// so the pick is made once, the same way; every response that carries a calendar's colour
// to a screen passes it through displayColourFor, so every surface draws the same one.

import { encodeCalendarId, listVisibleCalendars } from './event-store';
import { liveGoogleChoices, type GoogleChoicesOwner } from '../../lib/google-state';
import { displayColours, mapGoogleColour, pickCalendarColour, type VisibleCalendar } from '../../lib/calendar-colours';

export type ColourOwner = GoogleChoicesOwner & { id: number; pairingId: string | null | undefined };

/**
 * Every calendar on the user's screen with its colour: their FamCal calendars and the
 * partner's they see, and their chosen Google calendars as Google's app shows them
 * (the saved colour, mapped).
 */
export async function calendarsOnScreen(user: ColourOwner): Promise<VisibleCalendar[]> {
  const native = await listVisibleCalendars(user.id, user.pairingId ?? null);
  return [
    ...native.map((c): VisibleCalendar => ({ id: encodeCalendarId(c.id), color: c.color, native: true })),
    ...liveGoogleChoices(user).map((a): VisibleCalendar => ({ id: a.calendarId, color: mapGoogleColour(a.color || null), native: false })),
  ];
}

/** The palette colour farthest from everything the user sees (pickCalendarColour). */
export async function autoCalendarColour(user: ColourOwner): Promise<string> {
  return pickCalendarColour((await calendarsOnScreen(user)).map((c) => c.color));
}

/**
 * The colour each of the user's FamCal calendars is drawn in, by calendar id (displayColours).
 * Google calendars are not in it: their colour is Google's, live or saved, and never shifted.
 */
export async function displayColourMap(user: ColourOwner): Promise<Map<string, string>> {
  const calendars = await calendarsOnScreen(user);
  const natives = new Set(calendars.filter((c) => c.native).map((c) => c.id));
  return new Map([...displayColours(calendars)].filter(([id]) => natives.has(id)));
}

/** A calendar reference with the colour it is drawn in; one with no id (masked) or no entry stays as it is. */
export function displayColourFor<T extends { id: string | null; color: string | null }>(calendar: T, map: ReadonlyMap<string, string>): T {
  const colour = calendar.id === null ? undefined : map.get(calendar.id);
  return colour !== undefined && colour !== calendar.color ? { ...calendar, color: colour } : calendar;
}
