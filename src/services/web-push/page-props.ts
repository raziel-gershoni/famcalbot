/**
 * The `push` prop of the Settings and home pages (web push spec 2026-11-05 §3.2), worked out in one place for both.
 * Server only. Nothing here is logged but a failed count (by its kind, with the user id).
 */

import { hasChat } from '../../lib/has-chat';
import { recentlyProved } from '../../lib/recent-sign-in';
import type { PushPageProps } from '../../lib/web-push-props';
import { captureSignInFailure } from '../web-signin/safe-error';
import { vapidPublicKey } from './config';
import { countDevices } from './devices';

/** How the page's request proved the person: a web session (when it was proved, epoch ms), or null for Telegram initData. */
export type PageSession = { provedAt: number } | null;

/**
 * null for a request proved by Telegram's initData and for an account with a chat (they get their messages there).
 * Otherwise the key (null while push is off, and then no devices are counted), whether the session was proved within the
 * hour, and how many devices the account has on: the session's user row already carries the count (pushDeviceCount, read
 * with PUSH_DEVICE_COUNT), and only a user without it (undefined) is counted by a query. A failed count is captured by its
 * kind only (a Prisma error's message can print the query's values) and reads as none: the page still loads.
 */
export async function pushPropsFor(
  user: { id: number; telegramId: number | bigint | null | undefined; whatsappPhone?: string | null; whatsappBsuid?: string | null; pushDeviceCount?: number },
  session: PageSession,
): Promise<PushPageProps | null> {
  if (session === null || hasChat(user)) return null;
  const key = vapidPublicKey();
  let devices = 0;
  if (key !== null) {
    if (typeof user.pushDeviceCount === 'number') {
      devices = user.pushDeviceCount;
    } else {
      try {
        devices = await countDevices(user.id);
      } catch (error) {
        captureSignInFailure(error, 'push-page-props', { user_id: user.id });
      }
    }
  }
  return { key, recentSignIn: recentlyProved(session.provedAt), devices };
}
