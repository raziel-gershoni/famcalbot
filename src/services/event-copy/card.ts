/**
 * The card of "Send a copy" (docs/superpowers/specs/2026-11-27-send-event-copy-design.md, "Making the card"): its words,
 * the inline article that carries them, and Telegram's prepared message for it.
 *
 * The card names the event's title and its when, in the sender's language and zone: a one-off's date and time (or "All
 * day"), a repeating series' repeat in the item sheet's words and its usual time (the copy is the whole series, not the
 * day the sender opened). The words are the sheet's own helpers (the Repeat row's `specText` / `infoText`, `format.ts`),
 * through a `calendarHome` translator as src/services/zmanim/api-view.ts makes one.
 *
 * Logs: the prefix `[event-copy]` and a refusal's status and Telegram's words. Never the title, the card's text or a token.
 */

import { createTranslator } from 'next-intl';
import enMessages from '../../../messages/en.json';
import heMessages from '../../../messages/he.json';
import ruMessages from '../../../messages/ru.json';
import type { NativeEvent } from '@prisma/client';
import { endOfInfo, infoText, specText, withEndText } from '../../../app/[locale]/(app)/dashboard/repeat-words';
import { repeatWords } from '../../lib/calendar-view/editor-model';
import { formatDayRange, formatDayShort, formatDayTime, formatTime, instantDay } from '../../lib/calendar-view/format';
import type { WeekStart } from '../../lib/calendar-view/types';
import { captureError } from '../../lib/error-capture';
import { telegramErrorInfo } from '../../lib/telegram-errors';
import type { Locale } from '../../utils/locale';
import { retryWithBackoff } from '../../utils/fetch-retry';
import { guestAnswerArticle, telegramRetryVerdict, type GuestAnswerArticle } from '../messaging/telegram-adapter';
import { specOfRule } from '../native-calendar/recurrence';
import { itemZone, repeatInfo, wallFor } from '../calendar-write/item-info';
import { getBot } from '../telegram/bot';

const TAG = '[event-copy]';

type WordsT = Parameters<typeof infoText>[0];
const MESSAGES = { en: enMessages, he: heMessages, ru: ruMessages } as const;
const TRANSLATORS = new Map<Locale, WordsT>();

/** "all day" inside the card's line, lower case after the comma ("Every year on 23 Kislev, all day"), unlike the sheet's label. */
function allDayWords(locale: Locale): string {
  return MESSAGES[locale].bot.eventCopy.allDay;
}

/** One translator of calendarHome.* per language, made once. */
function wordsFor(locale: Locale): WordsT {
  let t = TRANSLATORS.get(locale);
  if (!t) {
    const messages = MESSAGES[locale];
    t = createTranslator({ locale, messages, namespace: 'calendarHome' }) as unknown as WordsT;
    TRANSLATORS.set(locale, t);
  }
  return t;
}

/** "10:00–11:00" for a range within a day, or the start alone when it has no end. */
function timeRange(start: Date, end: Date, zone: string, locale: Locale): string {
  const from = formatTime(start.toISOString(), zone, locale);
  const sameDay = instantDay(start.toISOString(), zone) === instantDay(end.toISOString(), zone);
  return end > start && sameDay ? `${from}–${formatTime(end.toISOString(), zone, locale)}` : from;
}

/** The series' repeat in the sheet's words: the Repeat row's spec when it has one, else the rule's own words, end included. */
function repeatText(t: WordsT, source: NativeEvent, locale: Locale, zone: string, weekStart: WeekStart): string {
  const itemTz = itemZone(source);
  const startDay = wallFor(source.startsAt, source.endsAt, source.allDay, zone, itemTz).start.slice(0, 10);
  const spec = specOfRule(source.rrule, source.startsAt, itemTz, source);
  if (spec) return specText(t, locale, spec, { startDay, weekStart, ...(source.hebrewAnchor ? { anchorDay: source.hebrewAnchor } : {}) });
  const info = repeatInfo(source.rrule, source, { startsAt: source.startsAt, zone: itemTz });
  const own = infoText(t, locale, repeatWords(info, startDay), weekStart) ?? t('editor.repeat.currentPlain');
  return withEndText(t, locale, own, endOfInfo(info));
}

/** When the event happens, for the card: a one-off's date and time (or "all day"), a series' repeat and its usual time. */
export function copyWhen(source: NativeEvent, locale: Locale, zone: string, weekStart: WeekStart): string {
  const t = wordsFor(locale);
  const itemTz = itemZone(source);
  if (source.rrule) {
    const usual = source.allDay ? allDayWords(locale) : timeRange(source.startsAt, source.endsAt, zone, locale);
    return `${repeatText(t, source, locale, zone, weekStart)}, ${usual}`;
  }
  if (source.allDay) {
    const days = wallFor(source.startsAt, source.endsAt, true, zone, itemTz);
    return `${formatDayRange(days.start, days.end, locale)}, ${allDayWords(locale)}`;
  }
  const startIso = source.startsAt.toISOString();
  const endIso = source.endsAt.toISOString();
  const startDay = instantDay(startIso, zone);
  const hasEnd = source.endsAt > source.startsAt;
  if (hasEnd && startDay !== instantDay(endIso, zone)) return `${formatDayTime(startIso, zone, locale)} – ${formatDayTime(endIso, zone, locale)}`;
  return `${startDay ? formatDayShort(startDay, locale) : ''}, ${timeRange(source.startsAt, source.endsAt, zone, locale)}`;
}

/** The card's text: the title, then when. */
export function copyCardText(source: NativeEvent, locale: Locale, zone: string, weekStart: WeekStart): string {
  return `${source.title}\n${copyWhen(source, locale, zone, weekStart)}`;
}

/** The inline article of the card: its text with the link preview off, and one URL button (a web_app button is not allowed outside the bot's chat). */
export function copyArticle(text: string, button: string, url: string): GuestAnswerArticle {
  return guestAnswerArticle(text, { text: button, url });
}

/**
 * Telegram's prepared message of the card (Bot API 8.0, savePreparedInlineMessage): the id the Mini App hands to
 * shareMessage, or null after logging Telegram's refusal (the caller falls back to the share link). Allowed in private
 * chats and groups. Retried on no answer, a 429 and a 5xx (telegramRetryVerdict).
 */
export async function prepareCopyCard(senderTelegramId: number, article: GuestAnswerArticle): Promise<string | null> {
  try {
    const prepared = await retryWithBackoff(
      () => getBot().savePreparedInlineMessage({ user_id: senderTelegramId, result: article, allow_user_chats: true, allow_group_chats: true }),
      { label: `${TAG} savePreparedInlineMessage`, retryable: telegramRetryVerdict },
    );
    return prepared.id;
  } catch (error) {
    const info = telegramErrorInfo(error);
    // A refusal's words are Telegram's (never the card's); nothing else of the error is kept, as its text could hold the request.
    const why = info?.kind === 'refused' ? `refused ${info.status}: ${info.description}` : info ? `${info.kind} ${info.code}` : 'unexpected error';
    console.warn(`${TAG} could not prepare the card: ${why}`);
    captureError(new Error(`${TAG} savePreparedInlineMessage ${why}`), 'event-copy-prepare', {}, 'warning');
    return null;
  }
}
