// Providers by calendar id ("Google as a connection" spec §4 Providers). A user's calendars are
// one list of both kinds (getCalendarAssignmentsForUser), so the provider is chosen per calendar:
// a FamCal id (`native:<cuid>`) goes to the built-in calendar, every other id to Google. Nothing
// here reads User.calendarSource.

import type { UserConfig } from '../../types';
import type { SourceName } from '../calendar-read/types';
import { isFamcalId } from '../../utils/calendar-helpers';
import { captureError } from '../../lib/error-capture';
import { googleProvider } from './google-provider';
import { nativeProvider } from './native-provider';
import type { CalendarProvider, UnifiedEvent } from './types';

/** The provider that holds `calendarId`: FamCal for a `native:` id, Google for the rest. */
export function providerForCalendar(calendarId: string): CalendarProvider {
  return isFamcalId(calendarId) ? nativeProvider : googleProvider;
}

/** A split fetch: the events of both halves that answered, and the halves that failed. */
export interface SplitFetch {
  events: UnifiedEvent[];
  failed: SourceName[];
}

/**
 * The events of `calendarIds` in [startDate, endDate): the ids split by provider, each half
 * asked in parallel for its own ids only (a half with no ids is not asked). FamCal's events
 * come first, then Google's. A half that throws is logged and sent to Sentry with its provider,
 * never thrown: the caller gets the other half's events and the failed half's name.
 */
export async function fetchEventsInRange(
  user: UserConfig,
  calendarIds: string[],
  startDate: Date,
  endDate: Date
): Promise<SplitFetch> {
  const halves: { source: SourceName; provider: CalendarProvider; ids: string[] }[] = [
    { source: 'famcal', provider: nativeProvider, ids: calendarIds.filter(isFamcalId) },
    { source: 'google', provider: googleProvider, ids: calendarIds.filter(id => !isFamcalId(id)) },
  ];
  const asked = halves.filter(h => h.ids.length > 0);
  const settled = await Promise.allSettled(asked.map(h => h.provider.fetchEventsInRange(user, h.ids, startDate, endDate)));
  const events: UnifiedEvent[] = [];
  const failed: SourceName[] = [];
  settled.forEach((outcome, i) => {
    const half = asked[i];
    if (outcome.status === 'fulfilled') {
      events.push(...outcome.value);
      return;
    }
    failed.push(half.source);
    console.error(`[CalendarProvider] ${half.provider.name} fetch failed for user ${user.id} (${half.ids.length} calendars):`, outcome.reason);
    captureError(outcome.reason, 'calendar-provider-fetch', { user_id: user.id, provider: half.provider.name, calendars: half.ids.length }, 'warning');
  });
  return { events, failed };
}
