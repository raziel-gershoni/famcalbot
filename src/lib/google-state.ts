// The user's Google connection as the banners, the menu and the nudges see it ("Google as a
// connection" spec §2). Pure: it reads only the stored token and choices.

export type GoogleState =
  /** Never connected: no token and no stored calendars. Connect lives in the menu only. */
  | 'none'
  /** A token with no chosen calendars: choose calendars. */
  | 'choose'
  /** No token while calendars are stored (cleared on a scope error): reconnect. */
  | 'reconnect'
  /** A token and chosen calendars. A token Google has revoked still reads as connected
   *  here; the reader's reconnect status says it (the home's banner, the summary's line). */
  | 'connected';

export function googleStateOf(user: { googleRefreshToken?: string | null; calendarAssignments?: unknown }): GoogleState {
  const chosen = Array.isArray(user.calendarAssignments) && user.calendarAssignments.length > 0;
  if (user.googleRefreshToken) return chosen ? 'connected' : 'choose';
  return chosen ? 'reconnect' : 'none';
}
