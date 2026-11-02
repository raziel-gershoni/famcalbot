// The one rule that Google sign-in has its own OAuth client (spec 2026-11-02-web-sign-in §3): a token minted for the
// calendar client must never sign anyone in. Read by oidc.ts (the way stays off) and by the startup warnings
// (src/lib/startup-checks.ts), so the log line and the behaviour can't disagree. No import: safe anywhere.

/** Is the Google sign-in client id the calendar client's own (so Google sign-in must stay off)? */
export function googleSignInUsesCalendarClient(signInClientId: string | undefined, calendarClientId: string | undefined): boolean {
  return Boolean(signInClientId) && signInClientId === calendarClientId;
}
