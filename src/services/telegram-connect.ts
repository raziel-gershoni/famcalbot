/**
 * Connect Telegram (web sign-up spec §2.9, §3.6): an account made on famcal.bot, with no chat, takes on a Telegram id,
 * so reminders, briefings, Send to chat and Stars payments start working. The browser stays signed in.
 *
 * 1. The link. POST /api/telegram-connect makes it (createConnectLink): only for an account with no chat, only within
 *    an hour of signing in on this browser (a copied old session can't attach a Telegram, which can't be removed), at
 *    most 5 an hour per account. t.me/<bot>?start=w_<token>: 16 random bytes, kept 10 minutes as the sha256 of the
 *    token (REDIS_KEYS.telegramConnect), never in clear and never in a log line.
 * 2. /start w_<token> (handleConnectStart, called by /start before auto-registration and its breadcrumb): it reads the
 *    link without using it up. A Telegram with no FamCal account gets the question, naming the account and its FULL
 *    address (a masked one is easy to imitate), with Connect and Cancel; the buttons carry a random press id kept 10
 *    minutes and bound to the Telegram id asked (REDIS_KEYS.telegramConnectPress). A Telegram that has an account gets
 *    the guidance (Add Google or Add email there, by the browser account's way) and nothing is joined.
 * 3. Connect (handleConnectPress): both records are taken (GETDEL) and everything is checked again; the Telegram id is
 *    written onto the browser account (only while it still has no chat), then the menu button, feature access, the
 *    reminder cache, the welcome, and the notice to the ways the account had before (sendSignInNotice).
 *
 * Every reply is the answer to the person's own action, so the Shabbat pause doesn't hold it (scripts/smoke-pause.ts
 * lists this file as NOT_PAUSED). No log line names a token, a name or an address: the user id, the Telegram id and
 * the outcome only.
 */

import crypto from 'crypto';
import enMessages from '../../messages/en.json';
import heMessages from '../../messages/he.json';
import ruMessages from '../../messages/ru.json';
import { redis } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { REDIS_KEYS } from '../config/redis-keys';
import { buildUrl } from '../config/urls';
import { normalizeLocale, type Locale } from '../utils/locale';
import { fillHtml } from '../utils/html';
import { isolateAuto, isolateLtr } from '../lib/bidi-isolate';
import { DEFAULT_BOT_USERNAME } from '../lib/gate-links';
import { hasChat } from '../lib/has-chat';
import type { WebSession } from '../lib/session-auth';
import { signInRefusal } from '../lib/web-session';
import { isIdentifierBlocked } from '../lib/user-moderation';
import { sessionRecentlyProved } from '../lib/recent-sign-in';
import type { UserConfig } from '../types';
import { getUserById, getUserByTelegramId } from './user-service';
import { MessageFormat, type MessageOptions } from './messaging/types';
import { syncReminderCacheEntry } from './reminder-cache';
import { deleteDevicesOf } from './web-push/devices';
import { invalidateDueGate } from './native-reminders/due-gate';
import { countWithin } from './web-signin/limits';
import { signinHash } from './web-signin/email-address';
import { identitiesOf, type IdentityKind } from './web-signin/identities';
import { sendSignInNotice } from './web-signin/notice';
import { captureSignInFailure, safeErrorSummary } from './web-signin/safe-error';

/** The link and the question both wait 10 minutes. */
const TTL_SECONDS = 10 * 60;
const LINKS_PER_HOUR = 5;
const HOUR_SEC = 60 * 60;
/** 16 random bytes as base64url */
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
/** 12 random bytes as base64url: `tgc:<id>` and `tgc-no:<id>` stay well inside Telegram's 64 bytes of callback data */
const PRESS_ID = /^[A-Za-z0-9_-]{16}$/;

type ConnectCopy = typeof enMessages.bot.connect.web;
const COPY: Record<Locale, ConnectCopy> = {
  en: enMessages.bot.connect.web,
  he: heMessages.bot.connect.web,
  ru: ruMessages.bot.connect.web,
};

const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** The reply language: the first account that has one, else Telegram's own language code. */
function localeOf(users: Array<UserConfig | null | undefined>, languageCode?: string): Locale {
  const user = users.find(u => u?.language);
  if (user) return normalizeLocale(user.language);
  if (languageCode?.startsWith('he')) return 'he';
  if (languageCode?.startsWith('ru')) return 'ru';
  return 'en';
}

/** A stored record, or null for none. Upstash may hand back the parsed object or the JSON text. */
function parseRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    console.warn('[tg-connect] a stored record is not JSON; read as none');
    return null;
  }
}

function readLink(raw: unknown): { userId: number } | null {
  const record = parseRecord(raw);
  return record && typeof record.userId === 'number' ? { userId: record.userId } : null;
}

function readPress(raw: unknown): { userId: number; telegramId: number; linkHash: string } | null {
  const record = parseRecord(raw);
  if (!record || typeof record.userId !== 'number' || typeof record.telegramId !== 'number' || typeof record.linkHash !== 'string') return null;
  return { userId: record.userId, telegramId: record.telegramId, linkHash: record.linkHash };
}

/** One message in the chat, in HTML. A failed send is logged and captured, never thrown: the outcome stands. */
async function reply(chatId: number | string, text: string, options: MessageOptions = {}): Promise<void> {
  try {
    // Loaded here, as google-connect.ts does: the bot module pulls in the whole Telegram client
    const { getMessagingService } = await import('./telegram/bot');
    await getMessagingService().sendMessage(chatId, text, { format: MessageFormat.HTML, ...options });
  } catch (error) {
    console.error(`[tg-connect] a reply in chat ${chatId} was not sent: ${safeErrorSummary(error)}`);
    captureSignInFailure(error, 'tg-connect-reply');
  }
}

/**
 * The Connect Telegram link for an account with no chat, signed in on this browser within the hour (a WhatsApp link's
 * session never counts). 'limit' past 5 links an hour; 'unavailable' when Redis or the sign-in key fails (logged).
 */
export async function createConnectLink(
  user: UserConfig,
  session: WebSession,
): Promise<{ ok: true; url: string } | { ok: false; error: 'has-chat' | 'stale-sign-in' | 'limit' | 'unavailable' }> {
  if (hasChat(user)) {
    console.warn(`[tg-connect] user ${user.id}: link refused: the account has a chat`);
    return { ok: false, error: 'has-chat' };
  }
  // The proved-at, not the sign-in time: a renewal or a removal re-issues the cookie but never restarts this hour
  if (!sessionRecentlyProved(session, user.id, { allowWhatsApp: false })) {
    console.warn(`[tg-connect] user ${user.id}: link refused: the ${session.method} sign-in is not recent`);
    return { ok: false, error: 'stale-sign-in' };
  }
  try {
    const made = await countWithin(REDIS_KEYS.signinLimit('tg-connect-hour', signinHash('account', String(user.id))), HOUR_SEC);
    if (made > LINKS_PER_HOUR) {
      console.warn(`[tg-connect] user ${user.id}: link refused: ${LINKS_PER_HOUR} links this hour`);
      return { ok: false, error: 'limit' };
    }
    const token = crypto.randomBytes(16).toString('base64url');
    await redis.set(REDIS_KEYS.telegramConnect(tokenHash(token)), JSON.stringify({ userId: user.id }), { ex: TTL_SECONDS });
    console.log(`[tg-connect] user ${user.id}: a connect link was made`);
    const bot = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
    return { ok: true, url: `https://t.me/${bot}?start=w_${token}` };
  } catch (error) {
    captureSignInFailure(error, 'tg-connect-link', { user_id: user.id });
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * The guidance for a Telegram that already has its own account: bring the browser account in from Settings there, by
 * Add Google or Add email (the browser account's first way). Nothing is joined here.
 */
async function sendGuidance(
  chatId: number | string,
  sender: UserConfig,
  ownerId: number,
  way: { kind: IdentityKind; address: string } | undefined,
): Promise<void> {
  const locale = normalizeLocale(sender.language);
  const copy = COPY[locale];
  if (!way) {
    console.warn(`[tg-connect] user ${ownerId}: no way to name in the guidance`);
    await reply(chatId, copy.failed);
    return;
  }
  const text = fillHtml(way.kind === 'google' ? copy.hasAccountGoogle : copy.hasAccountEmail, { address: isolateLtr(way.address) });
  const settingsUrl = buildUrl(`/${locale}/settings?user_id=${sender.telegramId ?? sender.id}`);
  await reply(chatId, text, { replyMarkup: { inline_keyboard: [[{ text: copy.openSettings, web_app: { url: settingsUrl } }]] } });
  console.log(`[tg-connect] user ${ownerId}: this Telegram has its own account (user ${sender.id}); the guidance was sent and nothing was joined`);
}

/**
 * /start w_<token>, in the bot's private chat (commands.ts answers it nowhere else: the question shows the account's
 * full address). The link is read, not used up: a person who opened it in the wrong Telegram can cancel and open it
 * again in the right one. It never makes an account.
 */
export async function handleConnectStart(
  chatId: number | string,
  telegramId: number,
  token: string,
  languageCode?: string,
): Promise<void> {
  let ownerId: number | undefined;
  try {
    const hash = TOKEN.test(token) ? tokenHash(token) : null;
    const link = hash ? readLink(await redis.get(REDIS_KEYS.telegramConnect(hash))) : null;
    const owner = link ? await getUserById(link.userId) : null;
    ownerId = owner?.id;
    const sender = await getUserByTelegramId(telegramId);
    if (!hash || !link || !owner || hasChat(owner)) {
      const why = !hash ? 'not a link' : !link ? 'the link expired or was used' : !owner ? `account ${link.userId} is gone` : `user ${owner.id} has a chat now`;
      console.warn(`[tg-connect] start from Telegram ${telegramId} refused: ${why}`);
      await reply(chatId, COPY[localeOf([sender, owner], languageCode)].expired);
      return;
    }
    const refusal = await signInRefusal(owner);
    if (refusal) {
      console.warn(`[tg-connect] user ${owner.id}: start refused: the account is ${refusal}`);
      await reply(chatId, COPY[localeOf([owner], languageCode)].refused);
      return;
    }
    const way = (await identitiesOf(owner.id))[0];
    if (sender) {
      await sendGuidance(chatId, sender, owner.id, way);
      return;
    }
    const copy = COPY[normalizeLocale(owner.language)];
    if (!way) {
      console.warn(`[tg-connect] user ${owner.id}: start refused: the account has no way to show`);
      await reply(chatId, copy.failed);
      return;
    }
    const pressId = crypto.randomBytes(12).toString('base64url');
    await redis.set(REDIS_KEYS.telegramConnectPress(pressId), JSON.stringify({ userId: owner.id, telegramId, linkHash: hash }), { ex: TTL_SECONDS });
    await reply(chatId, fillHtml(copy.question, { name: isolateAuto(owner.name), address: isolateLtr(way.address) }), {
      replyMarkup: {
        inline_keyboard: [[
          { text: copy.connect, callback_data: `tgc:${pressId}` },
          { text: copy.cancel, callback_data: `tgc-no:${pressId}` },
        ]],
      },
    });
    console.log(`[tg-connect] user ${owner.id}: Telegram ${telegramId} was asked to connect`);
  } catch (error) {
    captureSignInFailure(error, 'tg-connect-start', { user_id: ownerId });
    await reply(chatId, COPY[localeOf([], languageCode)].failed);
  }
}

/** Writes the Telegram id onto the account while it still has no chat and is not suspended: one UPDATE ... WHERE. */
async function attachTelegram(userId: number, telegramId: number): Promise<'attached' | 'gone' | 'taken'> {
  try {
    const { count } = await prisma.user.updateMany({
      where: { id: userId, telegramId: null, whatsappPhone: null, whatsappBsuid: null, suspendedAt: null },
      data: { telegramId: BigInt(telegramId), messagingPlatform: 'telegram' },
    });
    return count === 1 ? 'attached' : 'gone';
  } catch (error) {
    // Another account took this Telegram id in between (its /start): the unique telegramId refuses the write
    if ((error as { code?: unknown } | null)?.code === 'P2002') return 'taken';
    throw error;
  }
}

/**
 * After the Telegram id is written: the person is told first, then the account's browser devices are deleted (it has
 * a chat now and Telegram carries everything, 6c-2 spec §2.4; no push reaches an account with a chat even before
 * this runs, canReachByPush), then feature access and the reminder pass see the chat,
 * the menu button opens the dashboard, the person is welcomed, and the notice goes to the ways the account had before
 * (`before` is the row read before the write, with no chat, so it goes by email: Task 8's routing). Never throws, and
 * each step stands alone: a Redis or Telegram hiccup in one is captured and the rest still run, so the confirmation
 * and the welcome are never lost to it. The connect has happened, so no "nothing was connected" may follow it.
 */
async function afterConnect(chatId: number | string, before: UserConfig, telegramId: number): Promise<void> {
  console.log(`[tg-connect] user ${before.id}: Telegram ${telegramId} connected`);
  await reply(chatId, COPY[normalizeLocale(before.language)].connected);
  const step = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
    } catch (error) {
      console.error(`[tg-connect] user ${before.id}: the after-connect step ${name} failed: ${safeErrorSummary(error)}`);
      captureSignInFailure(error, 'tg-connect-after', { user_id: before.id, purpose: name });
    }
  };
  await step('push-devices', async () => {
    const gone = await deleteDevicesOf(before.id);
    if (gone > 0) console.log(`[tg-connect] user ${before.id}: ${gone} browser device(s) deleted (it has a chat now)`);
  });
  await step('feature-access', async () => {
    const { invalidateFeatureAccessCache } = await import('./subscription-service');
    await invalidateFeatureAccessCache(before.id);
  });
  // The account's own reminders now have a chat to ping
  await step('due-gate', () => invalidateDueGate());
  let current: UserConfig | null = null;
  try {
    current = await getUserById(before.id);
  } catch (error) {
    console.error(`[tg-connect] user ${before.id}: the after-connect step read-user failed: ${safeErrorSummary(error)}`);
    captureSignInFailure(error, 'tg-connect-after', { user_id: before.id, purpose: 'read-user' });
  }
  const locale = normalizeLocale(current?.language ?? before.language);
  await step('menu-button', async () => {
    const { setUserMenuButton } = await import('./telegram/bot');
    await setUserMenuButton(telegramId, locale);
  });
  // Who belongs in the reminder cache is the hourly sync's rule
  const account = current;
  if (account) {
    await step('reminder-cache', () => syncReminderCacheEntry(account));
    await step('welcome', async () => {
      const { sendWelcome } = await import('./telegram/welcome');
      await sendWelcome(chatId, account);
    });
  }
  await step('notice', () => sendSignInNotice(before, { kind: 'telegram', via: 'connected' }));
}

/** The Connect button: `tgc:<pressId>`. The caller has answered the button's spinner. */
export async function handleConnectPress(
  chatId: number | string,
  telegramId: number,
  pressId: string,
  languageCode?: string,
): Promise<void> {
  let ownerId: number | undefined;
  try {
    const key = PRESS_ID.test(pressId) ? REDIS_KEYS.telegramConnectPress(pressId) : null;
    // Read first, as Cancel does: another Telegram's tap must not use up the question asked of this one
    const seen = key ? readPress(await redis.get(key)) : null;
    if (seen && seen.telegramId !== telegramId) {
      console.warn(`[tg-connect] user ${seen.userId}: a Connect press came from another Telegram (${telegramId}); nothing was connected and the question stays`);
      await reply(chatId, COPY[localeOf([await getUserByTelegramId(telegramId)], languageCode)].notYours);
      return;
    }
    // Then taken once (GETDEL): of two presses at once, one finds it gone
    const press = key && seen ? readPress(await redis.getdel(key)) : null;
    if (!press || press.telegramId !== telegramId) {
      console.warn(`[tg-connect] a Connect press from Telegram ${telegramId} found no question (expired or used)`);
      await reply(chatId, COPY[localeOf([await getUserByTelegramId(telegramId)], languageCode)].expired);
      return;
    }
    ownerId = press.userId;
    const link = readLink(await redis.getdel(REDIS_KEYS.telegramConnect(press.linkHash)));
    const owner = await getUserById(press.userId);
    if (!link || link.userId !== press.userId || !owner || hasChat(owner)) {
      const why = !link || link.userId !== press.userId ? 'the link expired or was used' : !owner ? 'the account is gone' : 'the account has a chat now';
      console.warn(`[tg-connect] user ${press.userId}: Connect refused: ${why}`);
      await reply(chatId, COPY[localeOf([owner], languageCode)].expired);
      return;
    }
    const refusal = (await signInRefusal(owner)) ?? ((await isIdentifierBlocked({ telegramId })) ? 'blocked' : null);
    if (refusal) {
      console.warn(`[tg-connect] user ${owner.id}: Connect refused: ${refusal}`);
      await reply(chatId, COPY[localeOf([owner], languageCode)].refused);
      return;
    }
    const sender = await getUserByTelegramId(telegramId);
    if (sender) {
      await sendGuidance(chatId, sender, owner.id, (await identitiesOf(owner.id))[0]);
      return;
    }
    const attached = await attachTelegram(owner.id, telegramId);
    if (attached === 'taken') {
      const holder = await getUserByTelegramId(telegramId);
      console.warn(`[tg-connect] user ${owner.id}: Connect refused: Telegram ${telegramId} got its own account in between`);
      if (holder) await sendGuidance(chatId, holder, owner.id, (await identitiesOf(owner.id))[0]);
      else await reply(chatId, COPY[localeOf([owner], languageCode)].failed);
      return;
    }
    if (attached === 'gone') {
      console.warn(`[tg-connect] user ${owner.id}: Connect refused: the account changed in between`);
      await reply(chatId, COPY[localeOf([owner], languageCode)].expired);
      return;
    }
    await afterConnect(chatId, owner, telegramId);
  } catch (error) {
    captureSignInFailure(error, 'tg-connect-press', { user_id: ownerId });
    await reply(chatId, COPY[localeOf([], languageCode)].failed);
  }
}

/** The Cancel button: `tgc-no:<pressId>`. The question and its link are dropped; only the Telegram asked can cancel. */
export async function handleConnectCancel(
  chatId: number | string,
  telegramId: number,
  pressId: string,
  languageCode?: string,
): Promise<void> {
  try {
    const key = PRESS_ID.test(pressId) ? REDIS_KEYS.telegramConnectPress(pressId) : null;
    const press = key ? readPress(await redis.get(key)) : null;
    const locale = localeOf([press ? await getUserById(press.userId) : null], languageCode);
    if (!key || !press) {
      await reply(chatId, COPY[locale].expired);
      return;
    }
    if (press.telegramId !== telegramId) {
      console.warn(`[tg-connect] user ${press.userId}: a Cancel press came from another Telegram (${telegramId})`);
      await reply(chatId, COPY[locale].notYours);
      return;
    }
    await redis.del(key, REDIS_KEYS.telegramConnect(press.linkHash));
    console.log(`[tg-connect] user ${press.userId}: Telegram ${telegramId} cancelled the connect`);
    await reply(chatId, COPY[locale].cancelled);
  } catch (error) {
    captureSignInFailure(error, 'tg-connect-cancel');
    await reply(chatId, COPY[localeOf([], languageCode)].failed);
  }
}
