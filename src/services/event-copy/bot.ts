/**
 * The receiver's side of "Send a copy of an event" in the bot (docs/superpowers/specs/2026-11-27-send-event-copy-design.md):
 *   - `/start cp_<token>` (handleCopyStart): the offer's state in the receiver's words; an open one shows the card and one
 *     button per FamCal calendar the receiver can write, `cp:<token>:<calendar cuid>` (51 bytes, Telegram allows 64);
 *   - a press (handleCopyPress): claims the offer, copies the event through the event store, turns the card into
 *     "Copied to <calendar>", and sends the sender one quiet note naming who copied (their language, no sound).
 *
 * The /start reply and the press are replies to the person's own action, and the note to the sender is the receiver's
 * action carried to the sender without a sound: scripts/smoke-pause.ts lists this file as not paused. A failed note is
 * logged and the copy stands.
 *
 * Logs: the prefix `[event-copy]`, user ids, the offer's id and outcomes. Never the token, a title, a name or the card's text.
 */

import type { NativeEvent, User } from '@prisma/client';
import { getBotMessages } from '../../lib/bot-messages';
import { captureError } from '../../lib/error-capture';
import { telegramErrorInfo, telegramRefusalSays } from '../../lib/telegram-errors';
import { resolveUserTimezone } from '../../lib/timezone';
import { normalizeLocale, type Locale } from '../../utils/locale';
import { weekStartOfUser } from '../../utils/locale-rules';
import { escapeHtml } from '../../utils/html';
import type { UserConfig } from '../../types';
import { MessageFormat } from '../messaging';
import { writableCalendarRows } from '../calendar-write/item-info';
import { getMainNativeCalendar } from '../native-calendar/event-store';
import { getUserByTelegramId } from '../user-service';
import { getBot, getMessagingService } from '../telegram/bot';
import { copyWhen } from './card';
import { claimCopyOffer, copyEventFor, copyTokenFromStart, recordCopy, releaseCopyOffer, viewCopyOffer, type CopyOfferView } from './offers';

const TAG = '[event-copy]';
/** `cp:<22-character token>:<calendar cuid>`: 3 + 22 + 1 + 25 = 51 bytes. */
const CALLBACK_DATA = /^cp:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{1,30})$/;

const why = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
const fill = (template: string, params: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? '');

/** What a Telegram failure was, for a log line: the status or the kind, never Telegram's words (they can echo text). */
function failure(error: unknown): string {
  const info = telegramErrorInfo(error);
  if (!info) return why(error);
  return info.kind === 'refused' ? `refused ${info.status}` : info.kind;
}

async function whenFor(source: NativeEvent, user: UserConfig, locale: Locale): Promise<string> {
  const zone = await resolveUserTimezone(user);
  return copyWhen(source, locale, zone, weekStartOfUser(user, zone));
}

/** The line a state that is not open answers with (the offer's `yours` names the calendar). */
function stateLine(words: Record<string, string>, view: CopyOfferView): string {
  switch (view.state) {
    case 'yours': return view.calendarName === null ? words.yoursPlain : fill(words.yours, { calendar: escapeHtml(view.calendarName) });
    case 'invalid': return words.invalid;
    case 'open': return words.failed;
    default: return words[view.state];
  }
}

/**
 * `/start cp_<token>`: the offer's state, in the receiver's language. An open offer shows the card and the receiver's
 * writable calendars (their main one is made when they have none), one button each, their own first and main first.
 */
export async function handleCopyStart(chatId: number | string, user: UserConfig, payload: string, locale: string, footer: string): Promise<void> {
  const lang = normalizeLocale(locale);
  let words: Record<string, string> | null = null;
  const service = getMessagingService();
  const reply = (text: string, replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }) =>
    service.sendMessage(chatId, footer ? `${text}\n\n${footer}` : text, {
      format: MessageFormat.HTML,
      ...(footer ? { disablePreview: true } : {}),
      ...(replyMarkup ? { replyMarkup } : {}),
    });
  try {
    words = (await getBotMessages(lang)).eventCopy as Record<string, string>;
    const token = copyTokenFromStart(payload);
    const view: CopyOfferView = token ? await viewCopyOffer(token, user.id) : { state: 'invalid' };
    if (view.state !== 'open' || !token) {
      console.log(`${TAG} user ${user.id}: /start answered ${view.state}`);
      await reply(stateLine(words, view));
      return;
    }
    let rows = await writableCalendarRows(user);
    if (!rows.some((r) => r.entry.mine)) {
      await getMainNativeCalendar(user.id);
      rows = await writableCalendarRows(user);
    }
    if (rows.length === 0) {
      console.warn(`${TAG} user ${user.id}: no calendar to copy into for offer ${view.offer.id}`);
      await reply(words.failed);
      return;
    }
    // Their own first (writableCalendarRows already does), the main one first among them.
    rows.sort((a, b) => Number(b.entry.mine) - Number(a.entry.mine) || Number(b.entry.main) - Number(a.entry.main));
    const when = await whenFor(view.source, user, lang);
    const buttons = rows.map(({ calendar, entry }) => [{
      text: entry.mine || !entry.ownerName ? entry.name : `${entry.name} · ${entry.ownerName}`,
      callback_data: `cp:${token}:${calendar.id}`,
    }]);
    console.log(`${TAG} user ${user.id}: /start showed offer ${view.offer.id} with ${buttons.length} calendars`);
    await reply(fill(words.open, { title: escapeHtml(view.source.title), when: escapeHtml(when) }), { inline_keyboard: buttons });
  } catch (error) {
    console.error(`${TAG} user ${user.id}: /start failed (${why(error)})`);
    captureError(error, 'event-copy-start', { user_id: user.id });
    if (words) await reply(words.failed).catch((sendError: unknown) => console.error(`${TAG} user ${user.id}: the failure line was not sent (${failure(sendError)})`));
  }
}

/** Turns the card into a line (no buttons). An edit Telegram calls "not modified" is not a failure. */
async function editCard(chatId: number, messageId: number, text: string, userId: number): Promise<void> {
  try {
    await getBot().editMessageText({ text, chat_id: chatId, message_id: messageId, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch (error) {
    if (telegramRefusalSays(error, 'message is not modified')) return;
    console.error(`${TAG} user ${userId}: the card could not be edited (${failure(error)})`);
    captureError(error, 'event-copy-edit', { user_id: userId }, 'warning');
  }
}

/** A line under the card, keeping its buttons. */
async function sayAside(chatId: number, text: string, userId: number): Promise<void> {
  try {
    await getBot().sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
  } catch (error) {
    console.error(`${TAG} user ${userId}: a line could not be sent (${failure(error)})`);
    captureError(error, 'event-copy-say', { user_id: userId }, 'warning');
  }
}

/**
 * The quiet note to the sender, in the sender's language: who copied which event. True when it was sent. A failure is
 * logged and reported and the copy stands.
 */
async function tellSender(sender: User, receiver: UserConfig, source: NativeEvent, offerId: string): Promise<boolean> {
  if (sender.telegramId === null) {
    console.log(`[event-copy notice] skipped user ${sender.id}: no Telegram`);
    return false;
  }
  try {
    const words = (await getBotMessages(normalizeLocale(sender.language))).eventCopy as Record<string, string>;
    const title = escapeHtml(source.title);
    // An account whose Telegram name was empty is stored as "User" (createAccount): that is no name
    const stored = receiver.name?.trim();
    const name = stored && stored !== 'User' ? stored : '';
    const text = name ? fill(words.notice, { title, name: escapeHtml(name) }) : fill(words.noticeAnon, { title });
    await getBot().sendMessage({ chat_id: Number(sender.telegramId), text, parse_mode: 'HTML', disable_notification: true });
    console.log(`${TAG} offer ${offerId}: user ${sender.id} was told`);
    return true;
  } catch (error) {
    console.error(`${TAG} offer ${offerId}: the note to user ${sender.id} was not sent (${failure(error)})`);
    captureError(error, 'event-copy-notice', { user_id: sender.id, offer_id: offerId }, 'warning');
    return false;
  }
}

/**
 * A press of `cp:<token>:<calendar>`. The spinner is answered first; then the offer is read for this person, the
 * calendar is checked as one they can write (a refusal leaves the offer open), the claim decides the winner, and the
 * copy is written and recorded. A store failure gives the claim back.
 */
export async function handleCopyPress(chatId: number, messageId: number, queryId: string, telegramId: number, data: string): Promise<void> {
  await getBot().answerCallbackQuery({ callback_query_id: queryId }).catch((error: unknown) => console.error(`${TAG} could not answer a copy button (${failure(error)})`));
  const match = CALLBACK_DATA.exec(data);
  if (!match) {
    console.warn(`${TAG} refused a button that is not cp:<token>:<calendar>`);
    return;
  }
  const [, token, calendarCuid] = match;
  let userId: number | undefined;
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      console.warn(`${TAG} a button from a Telegram id with no account was refused`);
      return;
    }
    userId = user.id;
    const lang = normalizeLocale(user.language);
    const words = (await getBotMessages(lang)).eventCopy as Record<string, string>;

    const view = await viewCopyOffer(token, user.id);
    if (view.state === 'yours' && view.calendarName === null) {
      // A second tap while the first one's copy is being made: the first one's answer is on its way
      console.log(`${TAG} user ${user.id}: a press while their copy of offer ${view.offer.id} is being made`);
      return;
    }
    if (view.state !== 'open') {
      console.log(`${TAG} user ${user.id}: a press answered ${view.state}`);
      await editCard(chatId, messageId, stateLine(words, view), user.id);
      return;
    }
    const rows = await writableCalendarRows(user);
    const target = rows.find((r) => r.calendar.id === calendarCuid);
    if (!target) {
      console.warn(`${TAG} user ${user.id}: refused a calendar they cannot write for offer ${view.offer.id}`);
      await sayAside(chatId, words.notWritable, user.id);
      return;
    }
    if (!(await claimCopyOffer(view.offer.id, user.id))) {
      // Lost the race (or the original was deleted a moment ago): read it again for the line.
      const again = await viewCopyOffer(token, user.id);
      await editCard(chatId, messageId, stateLine(words, again), user.id);
      return;
    }
    let copyId: string;
    try {
      copyId = (await copyEventFor(view.source, user, calendarCuid)).id;
    } catch (error) {
      console.error(`${TAG} offer ${view.offer.id}: the copy for user ${user.id} failed (${why(error)})`);
      captureError(error, 'event-copy-write', { user_id: user.id, offer_id: view.offer.id });
      await releaseCopyOffer(view.offer.id, user.id).catch((releaseError: unknown) => {
        console.error(`${TAG} offer ${view.offer.id}: giving the claim back failed (${why(releaseError)})`);
        captureError(releaseError, 'event-copy-release', { user_id: user.id, offer_id: view.offer.id });
      });
      await sayAside(chatId, words.failed, user.id);
      return;
    }
    // The copy stands: a failed record is reported, never released (a release would let a second copy in).
    await recordCopy(view.offer.id, copyId).catch((error: unknown) => {
      console.error(`${TAG} offer ${view.offer.id}: the copy ${copyId} was made but not recorded (${why(error)})`);
      captureError(error, 'event-copy-record', { user_id: user.id, offer_id: view.offer.id });
    });
    const told = await tellSender(view.sender, user, view.source, view.offer.id);
    const when = await whenFor(view.source, user, lang);
    const copied = fill(words.copied, { calendar: escapeHtml(target.entry.name), title: escapeHtml(view.source.title), when: escapeHtml(when) });
    // "The sender was told", never the sender's name: the receiver may not know them by it (legal review M1)
    await editCard(chatId, messageId, told ? `${copied}\n\n${words.told}` : copied, user.id);
  } catch (error) {
    console.error(`${TAG} user ${userId ?? 'unknown'}: a press failed (${why(error)})`);
    captureError(error, 'event-copy-press', { user_id: userId });
  }
}
