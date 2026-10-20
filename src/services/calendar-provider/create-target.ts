// Where a bot create goes ("Google as a connection" spec §3). The parser places an event on a
// calendar it can match, else on the default of the union (defaultCalendarFor); this is the
// create site's last word: a reminder always goes on the creator's main FamCal calendar, and an
// event with no calendar (a correction or an older card that carried none) takes the default,
// the main FamCal calendar when the rule gives none. The literal 'primary' is never sent.

import type { UserConfig } from '../../types';
import type { ParsedEvent } from '../event-parser';
import { defaultCalendarFor, isFamcalId } from '../../utils/calendar-helpers';
import { encodeCalendarId, getMainNativeCalendar } from '../native-calendar/event-store';
import { getCalendarAssignmentsForUser } from './user-calendars';

/** The id of the user's main FamCal calendar, made lazily when they have none. */
async function famcalMainId(user: UserConfig): Promise<string> {
  return encodeCalendarId((await getMainNativeCalendar(user.id)).id);
}

/** The calendar id a parsed create is written to. */
export async function createCalendarFor(user: UserConfig, event: Pick<ParsedEvent, 'calendarId' | 'kind'>): Promise<string> {
  if (event.kind === 'reminder') {
    // Reminders live in FamCal (resolve.ts already put it on the main calendar)
    if (event.calendarId && isFamcalId(event.calendarId)) return event.calendarId;
    if (event.calendarId) console.warn(`[CreateTarget] user ${user.id}: a reminder carried a Google calendar; pinned to the FamCal main`);
    return famcalMainId(user);
  }
  if (event.calendarId) return event.calendarId;
  return defaultCalendarFor(await getCalendarAssignmentsForUser(user)) ?? famcalMainId(user);
}
