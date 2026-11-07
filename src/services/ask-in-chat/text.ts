/**
 * The words of a guest answer (spec 2026-11-07-ask-in-chat §6, keys `bot.askInChat.*`): plain text, no HTML, no emoji,
 * never an event's name. Each day's line starts with the date it understood; times are in the caller's zone, 24h.
 * In Hebrew every time, range and dd.MM is a left-to-right isolate, so "19:00–21:00" keeps its order in a right-to-left
 * line. Ruling 11: with Google unread (googleGap) no line claims free time, and with no busy time at all the answer is
 * "couldn't check".
 */

import { isolateLtr } from '../../lib/bidi-isolate';
import { hebrewDayLabel } from '../../lib/calendar-view/hebrew-date';
import { instantToWallTime } from '../../utils/wall-time';
import type { Locale } from '../../utils/locale';
import type { DayKey } from '../calendar-read/types';
import type { GoogleGap } from '../calendar-read/digest';
import { dayEdges, type Interval, type Judged } from './busy';
import type { AskRange, PartOfDay } from './window';

/** `bot.askInChat` in messages/<locale>.json. */
export interface AskTexts {
  date: string;
  range: string;
  until: string;
  from: string;
  parts: Record<PartOfDay, string>;
  day: { some: string; free: string; all: string };
  window: { some: string; free: string; all: string };
  at: { busy: string; free: string };
  partial: { some: string; window: string };
  googlePartial: string;
  unavailable: string;
  noDate: string;
  tooManyDays: string;
  noAccount: string;
  openButton: string;
  rateLimited: string;
}

export interface AskWords {
  t: AskTexts;
  locale: Locale;
  /** The bot's username without the @, for "@{bot} Friday". */
  botUsername: string;
  /** Russian only: `calendarHome.hebrewMonthGenitive`, for "15 швата". */
  genitive?: readonly string[];
}

export interface AskAnswer {
  range: AskRange;
  /** The question named a Hebrew date: each line echoes it ("(ט״ו בשבט)"). */
  hebrewAsked: boolean;
  tz: string;
  days: { day: DayKey; judged: Judged }[];
  googleGap?: GoogleGap;
}

const RLM = '\u200F';

/**
 * Telegram lays a paragraph out by its first strong character (spec §12.7), so a Hebrew line must start with a
 * right-to-left letter; one that would start with a digit or a Latin letter gets U+200F first. Isolates (the
 * left-to-right ones around a time) are skipped, as in the Unicode algorithm. Every Hebrew line FamCal posts in a chat
 * goes through this.
 */
export function leadRtl(text: string, locale: Locale): string {
  if (locale !== 'he') return text;
  let depth = 0;
  for (const ch of text) {
    if (ch === '\u2066' || ch === '\u2067' || ch === '\u2068') depth++;
    else if (ch === '\u2069') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === RLM || /\p{Script=Hebrew}/u.test(ch)) return text;
      // A digit is weak, but the spec asks for the mark before one too (some clients read it as the line's start)
      if (/[\p{Script=Latin}\p{Script=Cyrillic}\p{Nd}\u200E]/u.test(ch)) return RLM + text;
    }
  }
  return text;
}

/** A template's {placeholders} filled in one pass (a value holding "{x}" is never filled again). */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

/** The date a line starts with: "Friday 13.11", "יום שישי 13.11", "Пятница, 13.11", plus the Hebrew date when asked. */
function dateLabel(day: DayKey, hebrewAsked: boolean, w: AskWords): string {
  // A plain date read as the UTC day it names, never through the server's zone.
  let weekday = new Intl.DateTimeFormat(w.locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  if (w.locale === 'ru') weekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const ddmm = `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  const label = fill(w.t.date, { weekday, date: w.locale === 'he' ? isolateLtr(ddmm) : ddmm });
  if (!hebrewAsked) return label;
  const hebrew = hebrewDayLabel(day, w.locale, w.genitive);
  return hebrew ? `${label} (${hebrew})` : label;
}

/** A time read on the zone's clock, 'HH:mm'; the day's end is "24:00", not the next day's "00:00". */
function clock(ms: number, tz: string, dayEnd: number): string {
  return ms >= dayEnd ? '24:00' : instantToWallTime(new Date(ms), tz).slice(11, 16);
}

const ltr = (text: string, w: AskWords) => (w.locale === 'he' ? isolateLtr(text) : text);

function rangeText(from: string, to: string, w: AskWords): string {
  return ltr(fill(w.t.range, { from, to }), w);
}

/** One busy interval: "19:00-21:00", "until 02:00", "from 22:00", or "20:15" for an instant. */
function intervalText(i: Interval, tz: string, dayEnd: number, w: AskWords): string {
  const start = clock(i.start, tz, dayEnd);
  const end = clock(i.end, tz, dayEnd);
  if (i.start === i.end) return ltr(start, w);
  if (i.startsBefore && i.endsAfter) return rangeText('00:00', '24:00', w);
  if (i.startsBefore) return fill(w.t.until, { time: ltr(end, w) });
  if (i.endsAfter) return fill(w.t.from, { time: ltr(start, w) });
  return rangeText(start, end, w);
}

function rangesText(shown: readonly Interval[], tz: string, dayEnd: number, w: AskWords): string {
  const parts = shown.map(i => intervalText(i, tz, dayEnd, w));
  return new Intl.ListFormat(w.locale, { type: 'conjunction' }).format(parts);
}

/** One day's line, or null for a free day while Google is unread (no free claim, ruling 11). */
function dayLine(entry: AskAnswer['days'][number], answer: AskAnswer, w: AskWords): string | null {
  const partial = answer.googleGap !== undefined;
  const { verdict, shown } = entry.judged;
  const date = dateLabel(entry.day, answer.hebrewAsked, w);
  const { dayEnd } = dayEdges(entry.day, answer.tz);
  const ranges = () => rangesText(shown, answer.tz, dayEnd, w);
  const range = answer.range;
  if (verdict === 'free' && partial) return null;
  switch (range.kind) {
    case 'day':
      if (verdict === 'free') return fill(w.t.day.free, { date });
      if (verdict === 'busyAll') return fill(w.t.day.all, { date });
      return fill(partial ? w.t.partial.some : w.t.day.some, { date, ranges: ranges() });
    case 'part':
    case 'between': {
      const when = range.kind === 'part' ? w.t.parts[range.part] : rangeText(range.from, range.to, w);
      if (verdict === 'free') return fill(w.t.window.free, { date, when });
      if (verdict === 'busyAll') return fill(w.t.window.all, { date, when });
      return fill(partial ? w.t.partial.window : w.t.window.some, { date, when, ranges: ranges() });
    }
    case 'at': {
      const time = ltr(range.time, w);
      if (verdict === 'free') return fill(w.t.at.free, { date, time });
      return fill(w.t.at.busy, { date, time, ranges: ranges() });
    }
  }
}

/** The answer: one line per day, then the Google line when Google was unread; "couldn't check" when nothing is left. */
export function askAnswerText(answer: AskAnswer, w: AskWords): string {
  const lines = answer.days.map(entry => dayLine(entry, answer, w)).filter((line): line is string => line !== null);
  if (answer.googleGap === undefined) return leadRtl(lines.join('\n'), w.locale);
  if (lines.length === 0) return leadRtl(w.t.unavailable, w.locale);
  return leadRtl([...lines, w.t.googlePartial].join('\n'), w.locale);
}

export const noDateText = (w: AskWords) => leadRtl(fill(w.t.noDate, { bot: w.botUsername }), w.locale);
export const tooManyDaysText = (w: AskWords) => leadRtl(fill(w.t.tooManyDays, { bot: w.botUsername }), w.locale);
