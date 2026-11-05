/**
 * The `push` prop of the Settings and home pages (web push spec 2026-11-05 §3.2), worked out in one place for both.
 * Server only. Nothing here is logged.
 */

import { captureError } from '../../lib/error-capture';
import { hasChat } from '../../lib/has-chat';
import { recentlyProved } from '../../lib/recent-sign-in';
import type { PushPageProps } from '../../lib/web-push-props';
import { vapidPublicKey } from './config';
import { countDevices } from './devices';

/** How the page's request proved the person: a web session (when it was proved, epoch ms), or null for Telegram initData. */
export type PageSession = { provedAt: number } | null;

/**
 * null for a request proved by Telegram's initData and for an account with a chat (they get their messages there).
 * Otherwise the key (null while push is off, and then no devices are counted), whether the session was proved within the
 * hour, and how many devices the account has on. A failed count is captured and reads as none: the page still loads.
 */
export async function pushPropsFor(
  user: { id: number; telegramId: number | bigint | null | undefined; whatsappPhone?: string | null; whatsappBsuid?: string | null },
  session: PageSession,
): Promise<PushPageProps | null> {
  if (session === null || hasChat(user)) return null;
  const key = vapidPublicKey();
  let devices = 0;
  if (key !== null) {
    try {
      devices = await countDevices(user.id);
    } catch (error) {
      captureError(error, 'push-page-props', { user_id: user.id }, 'warning');
    }
  }
  return { key, recentSignIn: recentlyProved(session.provedAt), devices };
}
