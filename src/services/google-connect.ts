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
 *
 * The consent itself starts here too (createGoogleConsent, for POST /api/oauth/start). Every
 * consent sends include_granted_scopes, so a later reconnect keeps calendar.app.created.
 * A 'sync' consent (google-sync spec §3) also asks for that scope and names the FamCal
 * calendar to copy; the scopes Google granted, and for a sync the calendar and the
 * account, travel in the pending entry, and the commit saves them (User.googleScopes) and
 * turns the copy on.
 */

import crypto from 'crypto';
import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { encrypt, decrypt } from '../utils/encryption';
import { buildUrl } from '../config/urls';
import { captureError } from '../lib/error-capture';
import { DEFAULT_BOT_USERNAME } from '../lib/gate-links';
import { escapeHtml } from '../utils/html';
import { normalizeLocale, type Locale } from '../utils/locale';
import { getUserById, getUserByTelegramId, updateUserById } from './user-service';
import { updateUserInCache } from './reminder-cache';
import { clearGoogleTracks } from './setup-tracks';
import { stampGoogleCache } from './calendar-read/google';
import { getWhatsAppService, MessageFormat } from './messaging';
import type { UserConfig } from '../types';
import { Prisma } from '@prisma/client';
import { liveGoogleChoices } from '../lib/google-state';
import { prisma } from '../utils/prisma';
import { OAUTH_STATE_PREFIX, OAUTH_STATE_TTL_MS } from '../lib/oauth-state';
import { consentScopes, hasSyncScope } from './google-sync/scopes';
import { enableSyncLink, restoreSyncLinks, type EnableResult, type SyncConsent } from './google-sync/links';
import { syncAllowed } from './google-sync/access';
import { getBotMessages } from '../lib/bot-messages';

/** How long a parked token waits for its owner's tap */
const PENDING_TTL_SECONDS = 15 * 60;
/** How long the Mini App's /refresh-token poll can see that the commit landed */
const CONNECTED_FLAG_TTL_SECONDS = 15 * 60;

/** 24 random bytes as base64url: 32 characters, inside Telegram's 64-character /start payload */
const PENDING_ID = /^[A-Za-z0-9_-]{32}$/;
const PENDING_ID_IN_TEXT = /(?:^|[^A-Za-z0-9_-])gc_([A-Za-z0-9_-]{32})(?![A-Za-z0-9_-])/;

/** What Google granted with a token: the token response's scopes, and for a 'sync' consent what to copy. */
export interface GoogleGrant {
  scopes: string[];
  sync?: SyncConsent;
}

interface PendingGoogleToken {
  ownerUserId: number;
  /** Encrypted as googleRefreshToken is on the user row */
  refreshToken: string;
  /** Absent on an entry parked before the scopes were carried: its commit leaves googleScopes as they are. */
  scopes?: string[];
  sync?: SyncConsent;
}

/** A FamCal calendar id is a cuid; anything longer is not one */
const MAX_CALENDAR_ID = 64;

export type ConsentRequest = { purpose: 'connect' } | { purpose: 'sync'; nativeCalendarId: string };

/** oauth/start's body as a consent request: no purpose is a connect; null for anything else. */
export function parseConsentRequest(body: { purpose?: unknown; nativeCalendarId?: unknown }): ConsentRequest | null {
  if (body.purpose === undefined || body.purpose === null || body.purpose === 'connect') return { purpose: 'connect' };
  if (body.purpose !== 'sync') return null;
  const id = body.nativeCalendarId;
  if (typeof id !== 'string' || id === '' || id.length > MAX_CALENDAR_ID) return null;
  return { purpose: 'sync', nativeCalendarId: id };
}

export type GoogleConsent = { status: 'ok'; oauthUrl: string } | { status: 'calendar_not_found' } | { status: 'upgrade_required' };

/**
 * Start a Google consent for a proved user: a one-time state (10 minutes) bound to the user's
 * DB id, and Google's consent URL. A 'sync' consent is only for a user whose plan has
 * google_sync (S4) and a live FamCal calendar the user owns; the commit checks the calendar again.
 */
export async function createGoogleConsent(userId: number, request: ConsentRequest): Promise<GoogleConsent> {
  if (request.purpose === 'sync') {
    if (!(await syncAllowed(userId))) {
      console.warn(`[google-connect] user ${userId}: no sync consent for calendar ${request.nativeCalendarId}: the plan lacks google_sync`);
      return { status: 'upgrade_required' };
    }
    const own = await prisma.nativeCalendar.findFirst({
      where: { id: request.nativeCalendarId, ownerUserId: userId, isDeleted: false },
      select: { id: true },
    });
    if (!own) {
      console.warn(`[google-connect] user ${userId}: no sync consent for calendar ${request.nativeCalendarId}: not their own live calendar`);
      return { status: 'calendar_not_found' };
    }
  }

  // Secure random state token, stored with a 10-minute expiry
  const stateToken = OAUTH_STATE_PREFIX + crypto.randomBytes(32).toString('hex');
  await prisma.oAuthState.create({
    data: {
      userId: BigInt(userId),
      token: stateToken,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      ...(request.purpose === 'sync' ? { purpose: 'sync', nativeCalendarId: request.nativeCalendarId } : {}),
    },
  });

  const urlParams = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: buildUrl('/api/refresh-token'),
    response_type: 'code',
    scope: consentScopes(request.purpose).join(' '),
    access_type: 'offline',
    prompt: 'consent', // Force consent to get refresh token
    // Incremental authorization: the new token also covers every scope granted before, so a
    // reconnect never drops calendar.app.created
    include_granted_scopes: 'true',
    state: stateToken,
  });
  return { status: 'ok', oauthUrl: `https://accounts.google.com/o/oauth2/v2/auth?${urlParams.toString()}` };
}

const pendingKey = (pendingId: string) =>
  REDIS_KEYS.oauthPending(crypto.createHash('sha256').update(pendingId).digest('hex'));

/** Park a token from the OAuth callback, with what Google granted, for its owner's tap. Returns the pendingId. */
export async function createPendingGoogleToken(ownerUserId: number, refreshToken: string, grant?: GoogleGrant): Promise<string> {
  const pendingId = crypto.randomBytes(24).toString('base64url');
  const entry: PendingGoogleToken = {
    ownerUserId,
    refreshToken: encrypt(refreshToken),
    ...(grant ? { scopes: grant.scopes, ...(grant.sync ? { sync: grant.sync } : {}) } : {}),
  };
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

/**
 * What a 'sync' consent's commit did with the copy, and whether the grant held
 * calendar.app.created: Google's granular consent lets the user untick it while approving
 * the rest, and then the copy waits in 'scopes' with nothing copied.
 */
export type SyncCommit = EnableResult & { permitted: boolean };

export type GoogleConnectClaim =
  /** sync: what a 'sync' consent's commit did with the copy (absent for a connect) */
  | { status: 'connected'; owner: UserConfig; sync?: SyncCommit }
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

  const grant = Array.isArray(entry.scopes) ? { scopes: entry.scopes, ...(entry.sync ? { sync: entry.sync } : {}) } : undefined;
  let refreshToken: string;
  try {
    refreshToken = decrypt(entry.refreshToken);
  } catch (err) {
    // Parked under a key this server has neither as ENCRYPTION_KEY nor as
    // ENCRYPTION_KEY_PREVIOUS: the entry is used up, and the user taps Connect again.
    captureError(err, 'oauth-claim-undecryptable', { user_id: owner.id });
    return { status: 'expired' };
  }
  const committed = await commitGoogleToken(owner.id, refreshToken, grant);
  return { status: 'connected', owner, ...(committed.sync ? { sync: committed.sync } : {}) };
}

/**
 * Save a Google refresh token on its owner, as the OAuth callback used to: the encrypted
 * token, the reminder cache, a fresh start for the Google setup nudges and the admin
 * note. Then the flag the Mini App polls for. Nothing else changes: Google is a
 * connection beside FamCal.
 *
 * With the grant (every entry the callback parks now): the granted scopes are saved on the
 * user (an empty list means calendar.app.created is missing) and the outage notice resets;
 * a 'sync' consent turns its copy on first, then the user's copies stopped on the token or
 * the permission go back to work. Without one (an entry from before), googleScopes stay.
 */
export async function commitGoogleToken(ownerUserId: number, refreshToken: string, grant?: GoogleGrant): Promise<{ sync?: SyncCommit }> {
  const user = await getUserById(ownerUserId);
  if (!user) throw new Error(`User ${ownerUserId} not found`);

  // A FamCal user's leftover Google choices from before (stored, but no token, so
  // liveGoogleChoices counts them as none) may be another account's: a new connect starts
  // from an empty list, so the user chooses their calendars again.
  const stale = liveGoogleChoices(user).length === 0
    && Array.isArray(user.calendarAssignments) && user.calendarAssignments.length > 0;
  if (stale) console.warn(`[google-connect] user ${user.id}: stale Google choices cleared at connect`);

  // Save new refresh token on the owner, by DB id (updateUserById encrypts it)
  await updateUserById(user.id, {
    googleRefreshToken: refreshToken,
    ...(stale ? { calendarAssignments: Prisma.DbNull as unknown as null } : {}),
    ...(grant ? { googleScopes: grant.scopes, googleSyncNotifiedAt: null } : {}),
  });

  // Google is a connection ("Google as a connection" spec §1): the user keeps their FamCal
  // calendars, partner and reminders, and calendarSource is left as it was (a legacy column).
  // A fresh connect starts the Google setup nudges over (choose calendars, reconnect).
  await clearGoogleTracks(user.id);
  // Update reminder cache if user has reminders enabled
  if (user.remindersEnabled) {
    await updateUserInCache({
      id: user.id,
      telegramId: user.telegramId?.toString() ?? '',
      googleRefreshToken: refreshToken, // Fresh token (not encrypted)
      calendarAssignments: stale ? null : user.calendarAssignments,
      calendarSource: user.calendarSource, // Legacy: liveGoogleChoices' marker
      pairingId: user.pairingId,
      defaultReminderMinutes: user.defaultReminderMinutes ?? null,
      language: user.language,
      name: user.name,
      pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
      location: user.location,
    });
  }

  // The calendar home's cached Google reads may be of the account this token replaced.
  // The stamp never throws.
  await stampGoogleCache(user.id);

  // Notify admin of successful token refresh. It is sent with parse_mode HTML, and the
  // name is the user's own text
  const { notifyAdminWarning } = await import('../utils/error-notifier');
  await notifyAdminWarning(
    'Token Refreshed',
    `User ${user.telegramId ?? user.id} (${escapeHtml(user.name) || 'Unknown'}) successfully refreshed their Google Calendar token`
  ).catch(err => captureError(err, 'oauth-admin-notify', {}, 'warning'));

  // The token is saved; a lost flag only means the Mini App waits for the bot's button.
  // Its value is when: the poll counts only a commit after its own attempt opened Google.
  try {
    await redis.set(REDIS_KEYS.googleConnected(user.id), Date.now(), { ex: CONNECTED_FLAG_TTL_SECONDS });
  } catch (err) {
    captureError(err, 'google-connect-flag', { user_id: user.id }, 'warning');
  }

  // The copies to Google (google-sync spec §3, §4). A failure here throws to the claim,
  // whose "failed" reply says to check: the token is saved by now. The 'sync' consent goes
  // first: a copy turned off with a Remove/Keep still queued is re-enabled with that choice
  // dropped before restoreSyncLinks could put it in 'ok' and open the gate, where a worker
  // tick in between would carry out the Remove the user just took back.
  let sync: SyncCommit | undefined;
  if (grant) {
    if (grant.sync) {
      sync = { ...(await enableSyncLink(user.id, grant.sync, grant.scopes)), permitted: hasSyncScope(grant.scopes) };
      if (!sync.permitted) console.warn(`[google-connect] user ${user.id}: sync consent for calendar ${grant.sync.nativeCalendarId} committed without calendar.app.created: the copy waits for approval`);
    }
    await restoreSyncLinks(user.id, grant.scopes);
  }
  return sync ? { sync } : {};
}

// ---- Chat replies ----

/** A sync commit's line: nothing copied (not their calendar), the permission not given, or started. */
function syncReplyText(t: { started: string; notOwner: string; noPermission: string }, sync: SyncCommit): string {
  if (sync.status === 'not_owner') return t.notOwner;
  return sync.permitted ? t.started : t.noPermission;
}

interface ConnectCopy {
  connected: string;
  chooseCalendars: string;
  notOwner: string;
  /** Also the reply to a second tap after a successful connect: GETDEL used the entry */
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
    expired: 'This link was already used or has expired. If Google isn\'t connected on your dashboard, you can connect it again from there.',
    failed: 'Something went wrong while finishing the connection. Check your dashboard: if Google isn\'t connected there, connect it again.',
    telegramTip: 'FamCal does even more on Telegram, reminders included: {link}',
  },
  he: {
    connected: '✅ יומן Google מחובר! נשאר רק לבחור אילו יומנים FamCal יקרא.',
    chooseCalendars: 'בחירת יומנים',
    notOwner: 'החיבור ל-Google הזה התחיל מחשבון FamCal אחר, אז לא חיברנו כלום. רוצים לחבר את היומן שלכם? אפשר להתחיל מחדש מלוח הבקרה.',
    expired: 'הקישור הזה כבר נוצל או שפג תוקפו. אם Google לא מחובר בלוח הבקרה, אפשר לחבר אותו מחדש משם.',
    failed: 'משהו השתבש בסיום החיבור. כדאי להציץ בלוח הבקרה: אם Google לא מחובר שם, אפשר לחבר אותו מחדש.',
    telegramTip: 'בטלגרם FamCal עושה אפילו יותר, כולל תזכורות: {link}',
  },
  ru: {
    connected: '✅ Google Календарь подключён! Осталось выбрать, какие календари будет читать FamCal.',
    chooseCalendars: 'Выбрать календари',
    notOwner: 'Это подключение Google начали из другого аккаунта FamCal, поэтому ничего не подключено. Хотите подключить свой календарь? Начните заново из панели.',
    expired: 'Эта ссылка уже использована или устарела. Если Google в панели не подключён, подключите его заново оттуда.',
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

  if (claim?.status === 'connected' && claim.sync) {
    // A 'sync' consent (S4): the copy's own line, never the connect's "now choose calendars".
    const { owner, sync } = claim;
    const locale = normalizeLocale(owner.language);
    const t = (await getBotMessages(locale)).googleSync.consent;
    const text = syncReplyText(t, sync);
    const pageUrl = buildUrl(`/${locale}/calendars?user_id=${owner.telegramId ?? owner.id}`);
    await replyAfterClaim(() => service.sendMessage(chatId, text, {
      format: MessageFormat.HTML,
      ...(sync.status === 'not_owner' ? {} : { replyMarkup: { inline_keyboard: [[{ text: t.button, web_app: { url: pageUrl } }]] } }),
    }), { telegram_id: telegramId });
    return;
  }

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

  if (claim?.status === 'connected' && claim.sync) {
    // A 'sync' consent (S4): the copy's own line with the Telegram tip; the calendars page
    // has no magic link, and the connect's "choose calendars" doesn't apply.
    const { owner, sync } = claim;
    const locale = normalizeLocale(owner.language);
    const t = (await getBotMessages(locale)).googleSync.consent;
    await replyAfterClaim(() => service.sendMessage(chatId, withTip(COPY[locale], syncReplyText(t, sync))), { user_id: owner.id });
    return;
  }

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
