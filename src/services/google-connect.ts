/**
 * Google Calendar connect, bound to the account that started it (R3).
 *
 * The OAuth state says which FamCal account started a consent, but not who finished it:
 * anyone could start one and send the Google URL to someone else, whose token was then
 * saved on the sender's account. So the callback no longer saves the token. It parks it
 * here under a fresh pendingId, and the finish page (/oauth-complete) offers
 * t.me/<bot>?start=gc_<pendingId> and a wa.me message with gc_<pendingId>. The token is
 * committed only when the state's owner sends that from their own Telegram or WhatsApp.
 * Anyone else's claim uses the entry up and connects nothing.
 */

import crypto from 'crypto';
import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { prisma } from '../utils/prisma';
import { encrypt, decrypt } from '../utils/encryption';
import { buildUrl } from '../config/urls';
import { captureError } from '../lib/error-capture';
import { DEFAULT_BOT_USERNAME } from '../lib/gate-links';
import { normalizeLocale, type Locale } from '../utils/locale';
import { getUserById, getUserByTelegramId, updateUserById } from './user-service';
import { updateUserInCache } from './reminder-cache';
import { getWhatsAppService, MessageFormat } from './messaging';
import type { UserConfig } from '../types';

/** How long a parked token waits for its owner's tap */
const PENDING_TTL_SECONDS = 15 * 60;
/** How long the Mini App's /refresh-token poll can see that the commit landed */
const CONNECTED_FLAG_TTL_SECONDS = 15 * 60;

/** 24 random bytes as base64url: 32 characters, inside Telegram's 64-character /start payload */
const PENDING_ID = /^[A-Za-z0-9_-]{32}$/;
const PENDING_ID_IN_TEXT = /(?:^|[^A-Za-z0-9_-])gc_([A-Za-z0-9_-]{32})(?![A-Za-z0-9_-])/;

interface PendingGoogleToken {
  ownerUserId: number;
  /** Encrypted as googleRefreshToken is on the user row */
  refreshToken: string;
}

const pendingKey = (pendingId: string) =>
  REDIS_KEYS.oauthPending(crypto.createHash('sha256').update(pendingId).digest('hex'));

/** Park a token from the OAuth callback for its owner's tap. Returns the pendingId. */
export async function createPendingGoogleToken(ownerUserId: number, refreshToken: string): Promise<string> {
  const pendingId = crypto.randomBytes(24).toString('base64url');
  const entry: PendingGoogleToken = { ownerUserId, refreshToken: encrypt(refreshToken) };
  await redis.set(pendingKey(pendingId), JSON.stringify(entry), { ex: PENDING_TTL_SECONDS });
  return pendingId;
}

/**
 * Where the callback sends the consent browser. The locale goes in the query; the
 * pendingId, the owner's first name and the buttons to show (tg, wa) go in the fragment,
 * which survives a reload and never reaches a server or a Referer.
 */
export function finishPageUrl(
  locale: string,
  pendingId: string,
  owner: Pick<UserConfig, 'name' | 'englishName' | 'telegramId' | 'whatsappPhone' | 'whatsappBsuid'>,
): string {
  const firstName = (owner.name || owner.englishName || '').trim().split(/\s+/)[0] ?? '';
  const buttons = [owner.telegramId ? 'tg' : '', owner.whatsappPhone || owner.whatsappBsuid ? 'wa' : ''].filter(Boolean);
  const fragment = new URLSearchParams({ p: pendingId, ...(firstName ? { n: firstName } : {}), b: buttons.join(',') });
  return `/oauth-complete?locale=${normalizeLocale(locale)}#${fragment.toString()}`;
}

/** The pendingId in a WhatsApp message, which may hold more words around gc_<id> */
export function findGoogleConnectId(text: string): string | null {
  return text.match(PENDING_ID_IN_TEXT)?.[1] ?? null;
}

export type GoogleConnectClaim =
  | { status: 'connected'; owner: UserConfig }
  | { status: 'not_owner' }
  | { status: 'expired' };

/**
 * Use up a pending token. It is committed only when the sender is its owner: the same
 * telegramId (Telegram) or the same user row (WhatsApp, resolved by phone or BSUID). The
 * entry is gone either way, so a wrong claim can't be retried, and nothing is revoked at
 * Google: that would also cut off the sender's own FamCal connection, if they have one.
 */
export async function claimPendingGoogleToken(
  pendingId: string,
  sender: { telegramId?: number; userId?: number },
): Promise<GoogleConnectClaim> {
  if (!PENDING_ID.test(pendingId)) return { status: 'expired' };

  // GETDEL reads and deletes in one command, so one entry can be claimed only once
  const raw = await redis.getdel<PendingGoogleToken | string>(pendingKey(pendingId));
  if (!raw) return { status: 'expired' };
  const entry: PendingGoogleToken = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const owner = await getUserById(Number(entry.ownerUserId));
  if (!owner) return { status: 'expired' };

  const isOwner =
    (sender.telegramId !== undefined && owner.telegramId === sender.telegramId) ||
    (sender.userId !== undefined && owner.id === sender.userId);
  if (!isOwner) return { status: 'not_owner' };

  await commitGoogleToken(owner.id, decrypt(entry.refreshToken));
  return { status: 'connected', owner };
}

/**
 * Save a Google refresh token on its owner, as the OAuth callback used to: the encrypted
 * token, the NATIVE→GOOGLE switch, the reminder cache and the admin note. Then the flag
 * the Mini App polls for.
 */
export async function commitGoogleToken(ownerUserId: number, refreshToken: string): Promise<void> {
  const user = await getUserById(ownerUserId);
  if (!user) throw new Error(`User ${ownerUserId} not found`);

  // Save new refresh token on the owner, by DB id (updateUserById encrypts it)
  await updateUserById(user.id, { googleRefreshToken: refreshToken });

  // If the user was previously on NATIVE, completing OAuth is an explicit
  // opt-in to GOOGLE. Flip calendarSource and soft-delete the auto-created
  // native calendar so the model stays "either/or per user" (locked
  // product decision). The native calendar row is preserved (isDeleted=true)
  // in case the user ever switches back; the in-bot calendar UI hides it.
  if (user.calendarSource === 'NATIVE') {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { calendarSource: 'GOOGLE' },
      });
      await tx.nativeCalendar.updateMany({
        where: { ownerUserId: user.id, isDeleted: false },
        data: { isDeleted: true },
      });
    });
  }

  // Update reminder cache if user has reminders enabled
  if (user.remindersEnabled) {
    await updateUserInCache({
      id: user.id,
      telegramId: user.telegramId?.toString() ?? '',
      googleRefreshToken: refreshToken, // Fresh token (not encrypted)
      calendarAssignments: user.calendarAssignments,
      calendarSource: 'GOOGLE', // Completing OAuth switches a NATIVE user to Google (above)
      pairingId: user.pairingId,
      defaultReminderMinutes: user.defaultReminderMinutes ?? null,
      language: user.language,
      name: user.name,
      pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
      location: user.location,
    });
  }

  // Notify admin of successful token refresh
  const { notifyAdminWarning } = await import('../utils/error-notifier');
  await notifyAdminWarning(
    'Token Refreshed',
    `User ${user.telegramId ?? user.id} (${user.name || 'Unknown'}) successfully refreshed their Google Calendar token`
  ).catch(err => captureError(err, 'oauth-admin-notify', {}, 'warning'));

  // The token is saved; a lost flag only means the Mini App waits for the bot's button.
  // Its value is when: the poll counts only a commit after its own attempt opened Google.
  try {
    await redis.set(REDIS_KEYS.googleConnected(user.id), Date.now(), { ex: CONNECTED_FLAG_TTL_SECONDS });
  } catch (err) {
    captureError(err, 'google-connect-flag', { user_id: user.id }, 'warning');
  }
}

// ---- Chat replies ----

interface ConnectCopy {
  connected: string;
  chooseCalendars: string;
  notOwner: string;
  expired: string;
  failed: string;
  /** WhatsApp only: {link} is the bot's t.me link */
  telegramTip: string;
}

const COPY: Record<Locale, ConnectCopy> = {
  en: {
    connected: '✅ Google Calendar is connected! Now pick which calendars FamCal should follow.',
    chooseCalendars: 'Choose calendars',
    notOwner: 'This Google connection was started from a different FamCal account, so nothing was connected. Want to connect your own calendar? Start again from your dashboard.',
    expired: 'This link has expired. You can connect Google again from your dashboard.',
    failed: 'Something went wrong while finishing the connection. Check your dashboard: if Google isn\'t connected there, connect it again.',
    telegramTip: 'FamCal does even more on Telegram, reminders included: {link}',
  },
  he: {
    connected: '✅ יומן Google מחובר! נשאר רק לבחור אילו יומנים FamCal יקרא.',
    chooseCalendars: 'בחירת יומנים',
    notOwner: 'החיבור ל-Google הזה התחיל מחשבון FamCal אחר, אז לא חיברנו כלום. רוצים לחבר את היומן שלכם? אפשר להתחיל מחדש מלוח הבקרה.',
    expired: 'תוקף הקישור פג. אפשר לחבר את Google מחדש מלוח הבקרה.',
    failed: 'משהו השתבש בסיום החיבור. כדאי להציץ בלוח הבקרה: אם Google לא מחובר שם, אפשר לחבר אותו מחדש.',
    telegramTip: 'בטלגרם FamCal עושה אפילו יותר, כולל תזכורות: {link}',
  },
  ru: {
    connected: '✅ Google Календарь подключён! Осталось выбрать, какие календари будет читать FamCal.',
    chooseCalendars: 'Выбрать календари',
    notOwner: 'Это подключение Google начали из другого аккаунта FamCal, поэтому ничего не подключено. Хотите подключить свой календарь? Начните заново из панели.',
    expired: 'Ссылка устарела. Google можно подключить заново из панели.',
    failed: 'Что-то пошло не так при завершении подключения. Загляните в панель: если Google там не подключён, подключите его заново.',
    telegramTip: 'В Telegram FamCal умеет ещё больше, например напоминания: {link}',
  },
};

/** The reply language: the sender's own, else a guess from Telegram's code or the message's script */
function replyLocale(sender: UserConfig | null, hint = ''): Locale {
  if (sender?.language) return normalizeLocale(sender.language);
  if (hint.startsWith('he') || /[\u0590-\u05FF]/.test(hint)) return 'he';
  if (hint.startsWith('ru') || /[\u0400-\u04FF]/.test(hint)) return 'ru';
  return 'en';
}

/**
 * Claim, or null when the commit failed (already captured). It can fail half-way, after
 * the token is saved, so the "failed" reply doesn't say nothing was connected.
 */
async function tryClaim(pendingId: string, sender: { telegramId?: number; userId?: number }): Promise<GoogleConnectClaim | null> {
  try {
    return await claimPendingGoogleToken(pendingId, sender);
  } catch (err) {
    captureError(err, 'google-connect-claim', { telegram_id: sender.telegramId, user_id: sender.userId });
    return null;
  }
}

/**
 * Send a reply once the claim ran. The claim used the entry up, so a redelivered update
 * could only say "expired": a failed send is captured, never thrown into a webhook 500
 * that makes Telegram or Meta retry.
 */
async function replyAfterClaim(send: () => Promise<unknown>, context: { telegram_id?: number; user_id?: number }): Promise<void> {
  try {
    await send();
  } catch (err) {
    captureError(err, 'google-connect-reply', context);
  }
}

/**
 * Telegram /start gc_<pendingId>. Runs before /start's auto-registration: the sender is
 * only looked up, so a stranger tapping someone else's link gets no account.
 */
export async function handleGoogleConnectTelegram(
  chatId: number | string,
  telegramId: number,
  pendingId: string,
  languageCode?: string,
): Promise<void> {
  const sender = await getUserByTelegramId(telegramId);
  const { getMessagingService } = await import('./telegram/bot');
  const service = getMessagingService();
  const claim = await tryClaim(pendingId, { telegramId });

  if (claim?.status === 'connected') {
    const { owner } = claim;
    const locale = normalizeLocale(owner.language);
    const copy = COPY[locale];
    const calendarsUrl = buildUrl(`/${locale}/select-calendars?user_id=${owner.telegramId ?? owner.id}`);
    await replyAfterClaim(() => service.sendMessage(chatId, copy.connected, {
      format: MessageFormat.HTML,
      replyMarkup: { inline_keyboard: [[{ text: copy.chooseCalendars, web_app: { url: calendarsUrl } }]] },
    }), { telegram_id: telegramId });
    return;
  }

  const copy = COPY[replyLocale(sender, languageCode)];
  const text = claim === null ? copy.failed : claim.status === 'not_owner' ? copy.notOwner : copy.expired;
  await replyAfterClaim(() => service.sendMessage(chatId, text, { format: MessageFormat.HTML }), { telegram_id: telegramId });
}

/**
 * A WhatsApp message with gc_<pendingId>. The caller resolves the sender by phone or BSUID
 * without creating one, before auto-registration. The user just wrote to us, so the 24h
 * window is open and the reply can be free text with a magic link.
 */
export async function handleGoogleConnectWhatsApp(
  chatId: string,
  sender: UserConfig | null,
  pendingId: string,
  messageText = '',
): Promise<void> {
  const service = getWhatsAppService();
  const claim = await tryClaim(pendingId, sender ? { userId: sender.id } : {});
  // Every WhatsApp message points to Telegram, where FamCal does more
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
  const withTip = (copy: ConnectCopy, text: string) =>
    `${text}\n\n${copy.telegramTip.replace('{link}', `https://t.me/${botUsername}?start=connect`)}`;

  if (claim?.status === 'connected') {
    const { owner } = claim;
    const locale = normalizeLocale(owner.language);
    const copy = COPY[locale];
    await replyAfterClaim(async () => {
      const { generateMagicLink } = await import('./magic-link');
      const link = await generateMagicLink(owner.id, locale, 'select-calendars');
      await service.sendMessage(chatId, withTip(copy, copy.connected), {
        whatsappUrlButton: { text: copy.chooseCalendars, url: link },
      });
    }, { user_id: owner.id });
    return;
  }

  const copy = COPY[replyLocale(sender, messageText)];
  const text = claim === null ? copy.failed : claim.status === 'not_owner' ? copy.notOwner : copy.expired;
  await replyAfterClaim(() => service.sendMessage(chatId, withTip(copy, text)), { user_id: sender?.id });
}
