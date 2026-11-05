/**
 * What the page data hands the Settings card and the home banner for notifications in the browser (web push spec
 * 2026-11-05 §3.2). Types only, so a 'use client' file can import it.
 *
 * `key` is the public VAPID key, read at request time (never NEXT_PUBLIC_), null while push is off: the switch and the
 * banner's action then do not show. `recentSignIn` is whether the session was proved within the hour (turning on asks
 * for it), so the tap needs no request before the browser's prompt. `devices` is how many browsers the account has on.
 * The whole prop is null inside Telegram and for an account with a chat.
 */
export interface PushPageProps {
  key: string | null;
  recentSignIn: boolean;
  devices: number;
}
