/**
 * "Open in Telegram" on a person's admin profile (menu-revamp spec §6, plan Task 4).
 *
 * The admin panel holds only a person's Telegram id, which no link opens. This asks Telegram for the person's chat
 * (`getChat` through the one `getBot()` Api) and answers one of:
 *  - `link`: the chat has a public username, so `https://t.me/<username>` opens their profile;
 *  - `sent`: it has none (or Telegram refused `getChat`), so the bot sends the ADMIN's own chat one message with the person's
 *    name as an HTML inline mention (`<a href="tg://user?id=<id>">name</a>`), which Telegram resolves for anyone who has
 *    messaged the bot in private. The message is the answer to the admin's own tap, so it asks no pause (smoke-pause lists it);
 *  - `notFound`: no such person, or one with no Telegram id (a web-only or WhatsApp-only account): no Telegram call at all;
 *  - `failed`: the message could not be sent.
 * Nothing is stored. The route is `app/api/admin/open-profile/route.ts`, which asks `verifyAdminAccess` first.
 *
 * Logs: one `[admin-open-profile] admin <adminDbId> user <userId>: <outcome>` line, and a failure's kind and status. Never
 * the name, the username, the message text or a chat id (a Telegram refusal's own words name none of them).
 */

import { getBotMessages } from '../lib/bot-messages';
import { captureError } from '../lib/error-capture';
import { telegramErrorInfo } from '../lib/telegram-errors';
import { escapeHtml } from '../utils/html';
import { prisma as defaultPrisma } from '../utils/prisma';
import { getBot } from './telegram/bot';

export type OpenProfileResult = { kind: 'link'; url: string } | { kind: 'sent' } | { kind: 'notFound' } | { kind: 'failed' };

/** The parts of the Bot API client this uses (the smoke passes a fake). */
interface ProfileBot {
  getChat(params: { chat_id: number }): Promise<{ username?: string }>;
  sendMessage(params: { chat_id: number; text: string; parse_mode: 'HTML' }): Promise<unknown>;
}

export interface OpenProfileDeps {
  bot?: ProfileBot;
  /** The database client: the person by database id, the admin by Telegram id. */
  prisma?: Pick<typeof defaultPrisma, 'user'>;
}

/** A Telegram username: 5 to 32 letters, digits and underscores (a stricter shape than a link needs, so nothing odd is ever opened). */
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/** What went wrong with a Bot API call, with no text of the call in it. */
function describe(error: unknown): string {
  const info = telegramErrorInfo(error);
  if (!info) return error instanceof Error ? error.name : 'unknown error';
  return info.kind === 'refused' ? `refused ${info.status}` : `${info.kind} ${info.code}`;
}

/**
 * The outcome for the admin whose Telegram id is `adminTelegramId` (read from their verified initData) opening the person
 * with database id `userId`. Never throws.
 */
export async function openProfileFor(adminTelegramId: number, userId: number, deps: OpenProfileDeps = {}): Promise<OpenProfileResult> {
  let adminLabel = 'unknown';
  const done = (result: OpenProfileResult): OpenProfileResult => {
    console.log(`[admin-open-profile] admin ${adminLabel} user ${userId}: ${result.kind}`);
    return result;
  };
  try {
    const prisma = deps.prisma ?? defaultPrisma;
    const [person, admin] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true, name: true } }),
      prisma.user.findUnique({ where: { telegramId: BigInt(adminTelegramId) }, select: { id: true, language: true } }),
    ]);
    if (admin) adminLabel = String(admin.id);
    if (!person || person.telegramId === null) return done({ kind: 'notFound' });

    const telegramId = Number(person.telegramId);
    const bot = deps.bot ?? (getBot() as unknown as ProfileBot);

    try {
      const chat = await bot.getChat({ chat_id: telegramId });
      if (typeof chat.username === 'string' && USERNAME.test(chat.username)) return done({ kind: 'link', url: `https://t.me/${chat.username}` });
    } catch (error) {
      // Telegram refused or did not answer: the mention below still works for a person who has messaged the bot
      console.warn(`[admin-open-profile] admin ${adminLabel} user ${userId}: getChat failed (${describe(error)}), sending the mention instead`);
    }

    const t = await getBotMessages(admin?.language || 'en');
    const label = person.name && person.name.trim() ? person.name.trim() : String(telegramId);
    const name = `<a href="tg://user?id=${telegramId}">${escapeHtml(label).replace(/"/g, '&quot;')}</a>`;
    const text = String(t.adminProfileLink).replace('{name}', () => name);
    try {
      await bot.sendMessage({ chat_id: adminTelegramId, text, parse_mode: 'HTML' });
    } catch (error) {
      console.error(`[admin-open-profile] admin ${adminLabel} user ${userId}: the mention was not sent (${describe(error)})`);
      captureError(new Error(`admin open-profile: the mention was not sent (${describe(error)})`), 'admin-open-profile-send', { user_id: userId }, 'warning');
      return done({ kind: 'failed' });
    }
    return done({ kind: 'sent' });
  } catch (error) {
    console.error(`[admin-open-profile] admin ${adminLabel} user ${userId}: unexpected ${describe(error)}`);
    captureError(new Error(`admin open-profile: unexpected ${describe(error)}`), 'admin-open-profile', { user_id: userId });
    return done({ kind: 'failed' });
  }
}

/** The route's HTTP answer for an outcome (`success: true` only on 200: the panel's request helper reads it). */
export function openProfileAnswer(result: OpenProfileResult): { status: number; body: Record<string, unknown> } {
  switch (result.kind) {
    case 'link':
      return { status: 200, body: { success: true, kind: 'link', url: result.url } };
    case 'sent':
      return { status: 200, body: { success: true, kind: 'sent' } };
    case 'notFound':
      return { status: 404, body: { error: 'User not found, or has no Telegram' } };
    case 'failed':
      return { status: 502, body: { error: 'Could not open the profile' } };
  }
}
