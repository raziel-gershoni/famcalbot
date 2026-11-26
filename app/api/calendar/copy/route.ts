/**
 * POST /api/calendar/copy: the Mini App's "Send a copy" (docs/superpowers/specs/2026-11-27-send-event-copy-design.md).
 *
 *   body { user_id, key, initData? }   (key: a FamCal item's key, 'famcal|<cuid>' or 'famcal|<cuid>#<ISO>')
 *   X-Telegram-Init-Data: <initData>   (or the __Host-famcal_session cookie in a browser)
 *
 * Makes a new single-use offer for the event and prepares the card in Telegram. Answers 200
 * { preparedId: string | null, link, text }: the prepared message's id (null when Telegram refused it, logged), the
 * offer's deep link and the card's text, for the Mini App's share-link fallback. 400 invalid (not a FamCal key),
 * 404 not_found (no such event, or one the person can't see), 409 not_event (a reminder), 409 no_telegram (an account
 * with no Telegram id: the card is sent from a Telegram account).
 *
 * Logs: `[event-copy]` lines with the user id, the offer id, the event id and the outcome; never a token, a title or the text.
 */

import { NextRequest } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { calendarRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { getBotMessages } from '@/src/lib/bot-messages';
import { resolveUserTimezone } from '@/src/lib/timezone';
import { normalizeLocale } from '@/src/utils/locale';
import { weekStartOfUser } from '@/src/utils/locale-rules';
import { loadItem } from '@/src/services/calendar-write/item-info';
import { authFailure, json, userIdOf } from '@/src/services/calendar-write/respond';
import { parseItemKey } from '@/src/services/calendar-write/validate';
import { copyArticle, copyCardText, prepareCopyCard } from '@/src/services/event-copy/card';
import { copyDeepLink, createCopyOffer } from '@/src/services/event-copy/offers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid' }, 400);
  }
  const auth = await verifyUserAuth(request, userIdOf(body), requestInitData(request, body), calendarRateLimiter, 'calendar-copy');
  if (!auth.success) return authFailure(auth.response);
  const user = auth.user;
  const key = parseItemKey((body as { key?: unknown } | null)?.key);
  if (!key) return json({ error: 'invalid', field: 'key' }, 400);
  try {
    const item = await loadItem(user, key);
    if (item.status !== 'ok') return json({ error: 'not_found' }, 404);
    if (item.series.kind !== 'EVENT') return json({ error: 'not_event' }, 409);
    if (user.telegramId === null) {
      console.log(`[event-copy] user ${user.id}: no Telegram, no card for event ${item.series.id}`);
      return json({ error: 'no_telegram' }, 409);
    }
    const locale = normalizeLocale(user.language);
    const zone = await resolveUserTimezone(user);
    const text = copyCardText(item.series, locale, zone, weekStartOfUser(user, zone));
    const { offerId, token } = await createCopyOffer(user.id, item.series.id);
    const link = copyDeepLink(token);
    const button = (await getBotMessages(locale)).eventCopy.cardButton;
    const preparedId = await prepareCopyCard(user.telegramId, copyArticle(text, button, link));
    console.log(`[event-copy] card for offer ${offerId} (user ${user.id}, event ${item.series.id}): ${preparedId ? 'prepared' : 'not prepared, the share link is the fallback'}`);
    return json({ preparedId, link, text });
  } catch (err) {
    // No titles or tokens in the context: the user id only.
    captureError(err, 'calendar-copy', { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}
