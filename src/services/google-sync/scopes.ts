// The Google OAuth scopes FamCal asks for (google-sync spec §3, The permission). Pure: the
// OAuth start, the callback, the commit and the sync worker share one copy.
//
// Connecting asks for the two calendar scopes only. Copying to Google adds
// calendar.app.created, asked for incrementally (include_granted_scopes) the first time a
// user turns a copy on, and used only for calendars.* calls on the calendars FamCal made.

export const GOOGLE_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
export const GOOGLE_SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
export const GOOGLE_SCOPE_SYNC = 'https://www.googleapis.com/auth/calendar.app.created';

/** What connecting requires, and what the callback checks the consent granted. */
export const GOOGLE_CONNECT_SCOPES: readonly string[] = [GOOGLE_SCOPE_READ, GOOGLE_SCOPE_EVENTS];

/** What a consent asks for: the two connect scopes, plus calendar.app.created for a copy. */
export function consentScopes(purpose: 'connect' | 'sync'): string[] {
  return purpose === 'sync' ? [...GOOGLE_CONNECT_SCOPES, GOOGLE_SCOPE_SYNC] : [...GOOGLE_CONNECT_SCOPES];
}

/** The token response's `scope` (space-delimited, case-sensitive) as a list, without blanks or repeats. */
export function parseGrantedScopes(scope: unknown): string[] {
  if (typeof scope !== 'string') return [];
  return [...new Set(scope.split(' ').filter(Boolean))];
}

/** Whether the stored grant (User.googleScopes) lets FamCal create and manage its own calendars. */
export function hasSyncScope(scopes: readonly string[] | null | undefined): boolean {
  return (scopes ?? []).includes(GOOGLE_SCOPE_SYNC);
}
