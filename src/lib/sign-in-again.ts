// Signing in again from an app screen in a browser (spec 2026-11-03-web-sign-up §2.13, §3.6; plan 6c-1 Task 9). A screen whose
// request was refused because this browser's sign-in ended, and a Connect Telegram button whose sign-in is over an hour old,
// send the person to /signin. /signin sends a browser that still holds a cookie straight to its calendar (it reads only the
// cookie's signature and age), so this browser signs out first (POST /api/auth/signout clears the cookie; no database query),
// then opens /signin in the page's language. Inside Telegram the chat's buttons reopen the Mini App instead, and the screens
// keep their "open it again from the bot" words there (sessionEndedKey).
//
// It is a sign-out on this device, so this browser's notifications go first (6c-2 §2.4): turnOffPush(null) unsubscribes the
// browser (there is no user id here: the server deletes the device when the push service answers "gone" at the next send);
// a failure is logged there and never stops the sign-out.
//
// Client-safe: two imports, and the log lines carry a status or an error's name only.

import { signInHref } from '@/src/site/signin';
import { turnOffPush } from '@/src/lib/web-push-client';

const TAG = '[sign-in-again]';

/** calendarsPage's words for a request refused because the sign-in ended: the bot's inside Telegram, the browser's outside it. */
export function sessionEndedKey(inTelegram: boolean): 'errors.reopen' | 'errors.reopenBrowser' {
  return inTelegram ? 'errors.reopen' : 'errors.reopenBrowser';
}

/** Signs this browser out, then opens /signin. False (logged; the page stays) when the sign-out or the move failed. */
export async function signInAgain(locale: string): Promise<boolean> {
  await turnOffPush(null);
  try {
    const res = await fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) {
      console.warn(`${TAG} signing out answered ${res.status}`);
      return false;
    }
  } catch (error) {
    console.error(`${TAG} signing out got no answer: ${error instanceof Error ? error.name : typeof error}`);
    return false;
  }
  try {
    window.location.assign(signInHref(locale));
    return true;
  } catch (error) {
    console.error(`${TAG} /signin could not be opened: ${error instanceof Error ? error.name : typeof error}`);
    return false;
  }
}
