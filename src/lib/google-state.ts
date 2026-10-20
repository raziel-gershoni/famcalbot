// The user's Google connection as the banners, the menu and the nudges see it ("Google as a
// connection" spec §2), and the Google choices every reader counts. Pure: it reads only the
// stored token, the stored choices and the legacy source column.

import type { CalendarAssignment } from '../types';

export type GoogleState =
  /** Never connected: no token and no live choices. Connect lives in the menu only. */
  | 'none'
  /** A token with no chosen calendars: choose calendars. */
  | 'choose'
  /** A legacy Google user with no token (cleared on a scope error) and calendars stored: reconnect. */
  | 'reconnect'
  /** A token and chosen calendars. A token Google has revoked still reads as connected
   *  here; the reader's reconnect status says it (the home's banner, the summary's line). */
  | 'connected';

/** What the Google rules read off a user: a Prisma row or a UserConfig, with all three selected. */
export type GoogleChoicesOwner = {
  googleRefreshToken: string | null | undefined;
  /** Legacy, read only by this rule (and its query form, setup-tracks.ts): the marker of a user who connected Google before it became a connection. */
  calendarSource: string | null | undefined;
  calendarAssignments?: unknown;
};

/**
 * The user's Google choices that count: the stored ones (User.calendarAssignments) when the
 * user has a token, or when they are a legacy Google user (calendarSource GOOGLE) whose token
 * is gone, who really lost their connection and is asked to reconnect. A FamCal user with no
 * token has relics there, not choices: migration 20260506000001 made every user without a
 * token NATIVE, and a scope error used to clear only the token. Those count as none.
 * Every reader of the stored choices goes through this; writes keep the column as it is.
 */
export function liveGoogleChoices(user: GoogleChoicesOwner): CalendarAssignment[] {
  const stored = Array.isArray(user.calendarAssignments) ? (user.calendarAssignments as CalendarAssignment[]) : [];
  if (user.googleRefreshToken) return stored;
  // calendarSource is read as the legacy marker here (and in this rule's query form,
  // setup-tracks.ts) and nowhere else: GOOGLE was set only for the users who connected Google
  // when it replaced FamCal; connecting now leaves the column as it was.
  return user.calendarSource === 'GOOGLE' ? stored : [];
}

export function googleStateOf(user: GoogleChoicesOwner): GoogleState {
  const chosen = liveGoogleChoices(user).length > 0;
  if (user.googleRefreshToken) return chosen ? 'connected' : 'choose';
  return chosen ? 'reconnect' : 'none';
}
