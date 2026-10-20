// Calendar provider dispatch ("Google as a connection" spec §4 Providers): the provider is chosen
// per calendar id (routing.ts), never by the user. One list holds both kinds of calendars.

export { googleProvider } from './google-provider';
export { nativeProvider } from './native-provider';
export { providerForCalendar, fetchEventsInRange } from './routing';
export type { SplitFetch } from './routing';
export { createCalendarFor } from './create-target';
export { getCalendarAssignmentsForUser, hasUsableCalendar } from './user-calendars';
export * from './types';
