// Calendar provider dispatch — branches on User.calendarSource so existing
// GCal users keep their flow and NATIVE users hit the in-bot calendar.

import { UserConfig } from '../../types';
import { CalendarProvider } from './types';
import { googleProvider } from './google-provider';
import { nativeProvider } from './native-provider';

export function getProviderForUser(user: UserConfig): CalendarProvider {
  return user.calendarSource === 'NATIVE' ? nativeProvider : googleProvider;
}

export { googleProvider, nativeProvider };
export { getCalendarAssignmentsForUser, hasUsableCalendar } from './user-calendars';
export * from './types';
