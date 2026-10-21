/**
 * How a parsed repeat becomes the fields of a create (hebrew-repeats spec §5).
 *
 * Every place the bot creates an event from a parse goes through `recurrenceFields`, so the rule
 * is decided once: telegram and WhatsApp, a card's Confirm, "Confirm all", an auto-create, a
 * reminder. An ordinary repeat is the Gregorian RRULE it always was. A Hebrew repeat on the
 * built-in calendar is a plain yearly rule plus the Hebrew rule and the anchor day, which the store
 * expands by the Hebrew date. A Hebrew repeat headed for Google gets none of it: Google cannot
 * hold the rule, and a Gregorian yearly series would quietly repeat on the wrong day every
 * year. The event is created once, on its date, and the card says so before Confirm.
 */

import { localDate } from '../utils/day-events';
import { resolveUserTimezone } from '../lib/timezone';
import { buildRecurrenceRule } from './calendar';
import type { CalendarProviderName, CreateEventInput } from './calendar-provider/types';
import type { ParsedEvent } from './event-parser';
import type { UserConfig } from '../types';

/** What a card tells the user about the repeat before Confirm. */
export type RecurrenceNotice = 'google_once';

/** The create fields a parsed repeat decides, and the notice the card shows for it. */
export type RecurrenceFields = Pick<CreateEventInput, 'recurrence' | 'hebrewRule' | 'hebrewAnchor'> & {
  recurrence: string[];
  notice?: RecurrenceNotice;
};

/** True for a repeat by the Hebrew date. */
export const isHebrewRepeat = (recurrence: ParsedEvent['recurrence']): boolean => recurrence?.calendar === 'hebrew';

/**
 * Where an event is created: the provider of the calendar it goes to (createCalendarFor), so a
 * card words a Hebrew repeat for that calendar, whatever the user's other calendars are.
 */
export async function targetOf(user: UserConfig, event: Pick<ParsedEvent, 'calendarId' | 'kind'>): Promise<CalendarProviderName> {
  const { createCalendarFor, providerForCalendar } = await import('./calendar-provider');
  return providerForCalendar(await createCalendarFor(user, event)).name;
}

/**
 * What a card must say about the repeat on a given target. A Hebrew repeat on Google is created
 * once; nothing else needs a notice.
 */
export function recurrenceNotice(target: CalendarProviderName, recurrence: ParsedEvent['recurrence']): RecurrenceNotice | undefined {
  return isHebrewRepeat(recurrence) && target === 'google' ? 'google_once' : undefined;
}

/**
 * The recurrence, Hebrew rule and anchor of a create on `target`, and the notice a card shows.
 * `target` is the provider the create goes to. The anchor is the start's day in the user's
 * zone, where the series lives; the store refuses an anchor that is not that day.
 *
 * Only the keys that apply are present, so the create input of an ordinary event is exactly
 * what it was before Hebrew repeats.
 */
export async function recurrenceFields(
  user: UserConfig,
  target: CalendarProviderName,
  event: Pick<ParsedEvent, 'recurrence' | 'startTime'>
): Promise<RecurrenceFields> {
  const repeat = event.recurrence;
  if (!isHebrewRepeat(repeat)) return { recurrence: buildRecurrenceRule(repeat) };

  const notice = recurrenceNotice(target, repeat);
  if (notice) {
    console.warn(`[RecurrenceFields] user ${user.id}: a Hebrew repeat cannot be held by Google Calendar; creating the event once, on its date`);
    return { recurrence: [], notice };
  }
  const timezone = await resolveUserTimezone(user);
  return {
    // The Hebrew rule is yearly with no BY parts: only its INTERVAL, COUNT and UNTIL carry
    recurrence: buildRecurrenceRule({ frequency: 'yearly', interval: repeat!.interval, until: repeat!.until, count: repeat!.count }),
    // The one Hebrew repeat: every year on the Hebrew date, a yahrzeit's too
    hebrewRule: 'anniversary',
    hebrewAnchor: localDate(event.startTime, timezone),
  };
}

/** The create input's repeat keys from `recurrenceFields`, without the card's notice. */
export function repeatInput(fields: RecurrenceFields): Pick<CreateEventInput, 'recurrence' | 'hebrewRule' | 'hebrewAnchor'> {
  const { notice: _notice, ...input } = fields;
  void _notice;
  return input;
}
