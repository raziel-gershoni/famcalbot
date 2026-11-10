/**
 * Ask FamCal in a chat (Telegram Guest Mode; spec docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §3).
 *
 * Someone in another chat asks "are you free Friday evening?"; the person replies to it and mentions the bot. The
 * webhook routes the `guest_message` here after its moderation gate (a blocked or suspended caller never arrives), with
 * the account its gate looked up by the sender's telegramId. The answer is posted once, in that chat, through
 * answerGuestQuery: when the caller, their partner and their kids are busy and free on the day asked, one line each
 * (spec 2026-11-08-ask-in-chat-people), never an event's name.
 *
 * Steps: read the update; a bare reply from anyone but the answer's caller is not answered (ruling 9); one answer per
 * query (a Redis claim on the query id's hash); the per-person rate limit; no account gets the Start line; one model
 * call for the window and who was asked; one read through the summaries' reader, split by person; the lines asked
 * for (askedLines); the words.
 *
 * Not paused (scripts/smoke-pause.ts): it answers the person's own mention. Logs carry ids, kinds and timings only:
 * never a message's text, an event's title, a name, a chat id or the query id.
 */

import { createHash } from 'node:crypto';
import type { UserConfig } from '../../types';
import { guestAnswerArticle, type GuestAnswerArticle } from '../messaging/telegram-adapter';
import { getBotMessages } from '../../lib/bot-messages';
import { DEFAULT_BOT_USERNAME } from '../../lib/gate-links';
import { telegramErrorInfo } from '../../lib/telegram-errors';
import { normalizeLocale, type Locale } from '../../utils/locale';
import { judgeWindow, type BusyRead } from './busy';
import { askedLines } from './people';
import { askAnswerText, noDateText, tooManyDaysText, type AskTexts, type AskWords } from './text';
import { answersThis, botIdFromToken, readGuestUpdate, type GuestAsk } from './update';
import { readAskWindow, type CompletionFn } from './window';

/** One answer per guest query: a resent update finds the claim taken. Longer than any answer takes. */
const CLAIM_TTL_SECONDS = 3600;

/** The reader's codes for a Google half that could not be read with no FamCal items to show (spec §5.4). */
const GOOGLE_READ_CODES = new Set(['GOOGLE_TOKEN_EXPIRED', 'GOOGLE_INSUFFICIENT_SCOPES', 'GOOGLE_FETCH_FAILED']);

export type AskStage = 'ai' | 'read' | 'send';

/** What the handler reaches out to; each has the real default, and the smokes replace them. */
export interface AskDeps {
  now: () => Date;
  /** Takes the one-answer claim for this key; false when it is taken (a repeat delivery). */
  claimQuery: (key: string) => Promise<boolean>;
  /** The per-person rate limit (10 a minute); false when over it, or when Redis is down (fails closed). */
  allow: (telegramId: number) => Promise<boolean>;
  timezoneOf: (user: UserConfig) => Promise<string>;
  /** The model call; undefined is generateAICompletion. */
  complete?: CompletionFn;
  /** The busy times of each person of the caller's answer, named in `locale`. */
  readBusy: (user: UserConfig, days: readonly string[], tz: string, locale: Locale) => Promise<BusyRead>;
  answer: (guestQueryId: string, article: GuestAnswerArticle) => Promise<void>;
  report: (error: unknown, extra: { user_id: number; stage: AskStage }) => void;
}

const defaultDeps: AskDeps = {
  now: () => new Date(),
  claimQuery: async key => (await import('../../utils/redis-lock')).acquireVoiceLock(key, CLAIM_TTL_SECONDS),
  allow: async telegramId => {
    const { askInChatRateLimiter, checkRateLimit } = await import('../../lib/rate-limit');
    // A bucket of its own, by Telegram id (a caller may have no account): it shares none with the API's `u<id>` buckets
    return (await checkRateLimit(askInChatRateLimiter, `tg${telegramId}`)).success;
  },
  timezoneOf: async user => (await import('../../lib/timezone')).resolveUserTimezone(user),
  readBusy: async (user, days, tz, locale) => (await import('./busy')).readBusyDays(user, days, tz, locale),
  answer: async (guestQueryId, article) => {
    const { getBot } = await import('../telegram/bot');
    const { TelegramAdapter } = await import('../messaging/telegram-adapter');
    await new TelegramAdapter(getBot()).answerGuestQuery(guestQueryId, article);
  },
  report: (error, extra) => {
    import('../../lib/error-capture')
      .then(({ captureError }) => captureError(error, 'ask-in-chat', extra))
      .catch(failure => console.error(`[ask] user ${extra.user_id}: could not report a ${extra.stage} failure (${codeOf(failure)})`));
  },
};

/** A short code for a failure, for the log: the reader's GOOGLE_* code, else the error's code or name, never its message. */
function codeOf(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.name : 'error';
}

/** Telegram's own words for a refused answer: the HTTP status and its description (never the request). Exported for the smoke. */
export function refusalText(error: unknown): string {
  const info = telegramErrorInfo(error);
  return info?.kind === 'refused' ? `HTTP ${info.status} ${info.description}` : `no answer (${codeOf(error)})`;
}

/** What a retry after a lost success gets from Telegram: the first answer went, so there is nothing to report. Exported for the smoke. */
export function alreadyAnswered(error: unknown): boolean {
  const info = telegramErrorInfo(error);
  return info?.kind === 'refused' && info.status === 400 && /already (been )?answered/i.test(info.description);
}

/**
 * The error a report may carry: a new one with a short message and nothing attached. A failed call's error can carry
 * what was sent or where (a network failure's cause names the request URL, which holds the bot token; an unreadable
 * answer keeps the page it got), and captureError prints the error object on the console, so the original never goes to
 * a report.
 */
function plainError(message: string): Error {
  return new Error(message);
}

/** The language of a caller with no account: Telegram's language_code (he, iw, ru; anything else is English). */
function localeOfCode(code: string | undefined): Locale {
  const base = (code ?? '').toLowerCase().split('-')[0];
  return normalizeLocale(base === 'iw' ? 'he' : base);
}

async function wordsFor(locale: Locale, botUsername: string): Promise<AskWords> {
  const t = (await getBotMessages(locale)).askInChat as AskTexts;
  const genitive = locale === 'ru' ? (await import('../../../messages/ru.json')).default.calendarHome.hebrewMonthGenitive : undefined;
  return { t, locale, botUsername, ...(genitive ? { genitive } : {}) };
}

/**
 * Answer one guest message. Never throws: every failure that can still be answered gets the "couldn't check" line,
 * with one log line, and a Sentry report for the model, the database and the send.
 */
export async function handleGuestMessage(message: unknown, user: UserConfig | null, overrides: Partial<AskDeps> = {}): Promise<void> {
  const deps: AskDeps = { ...defaultDeps, ...overrides };
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
  const botId = botIdFromToken(process.env.TELEGRAM_BOT_TOKEN) ?? 0;
  let ask: GuestAsk | null;
  try {
    ask = readGuestUpdate(message, botId, botUsername);
  } catch (error) {
    console.error(`[ask] could not read a guest message (${codeOf(error)}); not answered`);
    return;
  }
  if (!ask) {
    console.warn('[ask] a guest message with no query id or no sender; not answered');
    return;
  }
  const telegramId = ask.caller.telegramId;
  const who = user ? `user ${user.id}` : `telegram ${telegramId}`;
  if (!answersThis(ask)) {
    console.log(`[ask] telegram ${telegramId}: bare reply to another caller's answer, not answered`);
    return;
  }

  const queryId = ask.guestQueryId;
  /** Posts the answer; false (logged and reported) when Telegram refused it or never answered. */
  const send = async (text: string, button?: { text: string; url: string }): Promise<boolean> => {
    try {
      await deps.answer(queryId, guestAnswerArticle(text, button));
      return true;
    } catch (error) {
      const refusal = refusalText(error);
      console.warn(`[ask] ${who}: answer refused ${refusal}`);
      // A retry after a lost success gets "already answered": the person saw the answer, so it is logged only
      if (user && !alreadyAnswered(error)) deps.report(plainError(`answerGuestQuery refused: ${refusal}`), { user_id: user.id, stage: 'send' });
      return false;
    }
  };

  try {
    const claimKey = `ask:${createHash('sha256').update(queryId).digest('hex')}`;
    if (!(await deps.claimQuery(claimKey))) {
      console.log(`[ask] telegram ${telegramId}: repeat delivery dropped`);
      return;
    }
    const locale = user ? normalizeLocale(user.language) : localeOfCode(ask.caller.languageCode);
    const words = await wordsFor(locale, botUsername);

    if (!(await deps.allow(telegramId))) {
      console.log(`[ask] ${who}: rate limited`);
      await send(words.t.rateLimited);
      return;
    }
    if (!user) {
      console.log(`[ask] telegram ${telegramId}: no account, Start line`);
      await send(words.t.noAccount, { text: words.t.openButton, url: `https://t.me/${botUsername}` });
      return;
    }

    const startedAt = Date.now();
    let tz: string;
    try {
      tz = await deps.timezoneOf(user);
    } catch (error) {
      console.warn(`[ask] user ${user.id}: unavailable (read: ${codeOf(error)})`);
      deps.report(error, { user_id: user.id, stage: 'read' });
      await send(words.t.unavailable);
      return;
    }

    let read: Awaited<ReturnType<typeof readAskWindow>>;
    try {
      read = await readAskWindow(ask, { tz, language: locale, now: deps.now(), ...(deps.complete ? { complete: deps.complete } : {}) });
    } catch (error) {
      console.warn(`[ask] user ${user.id}: unavailable (ai: ${codeOf(error)})`);
      deps.report(error, { user_id: user.id, stage: 'ai' });
      await send(words.t.unavailable);
      return;
    }
    // From here the answer is in the language of the message replied to when the model read he, en or ru there; in any
    // other case (other, no message) it stays the caller's, as before (owner, 2026-11-08)
    const messageLocale: Locale | null = read.language === 'he' || read.language === 'en' || read.language === 'ru' ? read.language : null;
    const fromMessage = messageLocale !== null;
    const answerLocale: Locale = messageLocale ?? locale;
    const lang = `${answerLocale}(${fromMessage ? 'msg' : 'user'})`;
    const answerWords = answerLocale === locale ? words : await wordsFor(answerLocale, botUsername);
    const window = read.window;
    if (window.kind === 'noDate') {
      console.log(`[ask] user ${user.id}: no date`);
      await send(noDateText(answerWords));
      return;
    }
    if (window.kind === 'tooManyDays') {
      console.log(`[ask] user ${user.id}: too many days`);
      await send(tooManyDaysText(answerWords));
      return;
    }

    const readStartedAt = Date.now();
    let busy: BusyRead;
    try {
      busy = await deps.readBusy(user, window.days, tz, answerLocale);
    } catch (error) {
      const code = codeOf(error);
      console.warn(`[ask] user ${user.id}: unavailable (read: ${code})`);
      // A Google half that could not be read is the reader's answer (it reports an outage itself); anything else is ours.
      if (!GOOGLE_READ_CODES.has(code)) deps.report(error, { user_id: user.id, stage: 'read' });
      await send(answerWords.t.unavailable);
      return;
    }
    const readMs = Date.now() - readStartedAt;

    // Who was asked is matched here against the calendars' names; the model never saw them, and the log gets the kind
    const asked = askedLines(read.who, busy.people);
    const days = busy.days.map(({ day, people }) => ({
      day,
      lines: people.map(({ person, intervals }) => ({ person, judged: judgeWindow(window.range, day, intervals, tz) })),
    }));
    const text = askAnswerText(
      { range: window.range, hebrewAsked: window.hebrewAsked, tz, days, asked: asked.keys, ...(busy.googleGap ? { googleGap: busy.googleGap } : {}) },
      answerWords
    );
    if (!(await send(text))) return;
    const busyCount = days.reduce((n, d) => n + d.lines.reduce((m, l) => m + l.judged.shown.length, 0), 0);
    console.log(
      `[ask] user ${user.id}: answered ${window.range.kind} x${days.length} who=${asked.log} lang=${lang} people=${busy.people.length} busy=${busyCount} ` +
        `google=${busy.googleGap ?? 'ok'} in ${Date.now() - startedAt} ms (ai ${read.aiMs}, read ${readMs})`
    );
  } catch (error) {
    console.error(`[ask] ${who}: failed (${codeOf(error)})`);
    if (user) deps.report(plainError(`ask failed (${codeOf(error)})`), { user_id: user.id, stage: 'send' });
  }
}
