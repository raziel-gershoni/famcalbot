/**
 * The words of a guest answer (spec 2026-11-07-ask-in-chat §6, and spec 2026-11-08-ask-in-chat-people §4 for the lines
 * by person; keys `bot.askInChat.*`): plain text, no HTML, no emoji, never an event's name. Each day starts with a line
 * naming the date it understood (and the time asked), then one line per person, headed by their first name. Times are
 * in the caller's zone, 24h. In Hebrew every time, range and dd.MM is a left-to-right isolate, so "19:00–21:00" keeps
 * its order in a right-to-left line, and every line starts in the answer's own direction (leadRtl, leadLtr), so a name
 * in the other script never turns a line around. Ruling 11: with Google unread (googleGap) no line claims free time,
 * and with no line left the answer is "couldn't check".
 */

import { isolateLtr } from '../../lib/bidi-isolate';
import { hebrewDayLabel } from '../../lib/calendar-view/hebrew-date';
import { instantToWallTime } from '../../utils/wall-time';
import type { Locale } from '../../utils/locale';
import type { DayKey } from '../calendar-read/types';
import type { GoogleGap } from '../calendar-read/digest';
import { dayEdges, type Interval, type Judged } from './busy';
import type { Person } from './people';
import type { AskRange, PartOfDay } from './window';

/** `bot.askInChat` in messages/<locale>.json. */
export interface AskTexts {
  date: string;
  range: string;
  until: string;
  from: string;
  parts: Record<PartOfDay, string>;
  /** A day's first line: the date, and the time asked. */
  head: { day: string; window: string; at: string };
  /** A person's line, headed by {name}. */
  line: {
    day: { some: string; free: string; all: string };
    window: { some: string; free: string; all: string };
    at: { busy: string; free: string };
    /** Busy times with Google unread: no free claim. */
    partial: string;
  };
  /** The word for someone with no name: the caller, the partner, the kids' calendars that name no one, the family. */
  people: { me: string; partner: string; kids: string; family: string };
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

/** One person's verdict on one day. */
export interface AskLine {
  person: Person;
  judged: Judged;
}

export interface AskAnswer {
  range: AskRange;
  /** The question named a Hebrew date: each day's first line echoes it ("(ט״ו בשבט)"). */
  hebrewAsked: boolean;
  tz: string;
  /** Each day asked, with every person's verdict, in the answer's order (peopleOf). */
  days: { day: DayKey; lines: AskLine[] }[];
  /** The people asked for, by key, each shown busy or free; null: no one in particular was asked (askedLines). */
  asked: ReadonlySet<string> | null;
  googleGap?: GoogleGap;
}

const RLM = '\u200F';
const LRM = '\u200E';

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

/**
 * The other way round for an English or Russian line: one that would start with a right-to-left letter (a Hebrew name
 * heading a person's line) gets U+200E first, so Telegram lays it out left to right. Isolates and digits are skipped.
 */
export function leadLtr(text: string): string {
  let depth = 0;
  for (const ch of text) {
    if (ch === '\u2066' || ch === '\u2067' || ch === '\u2068') depth++;
    else if (ch === '\u2069') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === LRM || /[\p{Script=Latin}\p{Script=Cyrillic}]/u.test(ch)) return text;
      if (ch === RLM || /[\p{Script=Hebrew}\p{Script=Arabic}]/u.test(ch)) return LRM + text;
    }
  }
  return text;
}

/** A line in the answer's direction: leadRtl in Hebrew, leadLtr otherwise. */
const leadLine = (text: string, locale: Locale): string => (locale === 'he' ? leadRtl(text, locale) : leadLtr(text));

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

/** A day's first line: "Friday 13.11:", "Friday 13.11, evening:", "Friday 13.11, 20:00:". */
function headLine(day: DayKey, answer: AskAnswer, w: AskWords): string {
  const date = dateLabel(day, answer.hebrewAsked, w);
  const range = answer.range;
  switch (range.kind) {
    case 'day':
      return fill(w.t.head.day, { date });
    case 'part':
      return fill(w.t.head.window, { date, when: w.t.parts[range.part] });
    case 'between':
      return fill(w.t.head.window, { date, when: rangeText(range.from, range.to, w) });
    case 'at':
      return fill(w.t.head.at, { date, time: ltr(range.time, w) });
  }
}

/** The name a person's line starts with, or the language's word for them. */
const nameOf = (person: Person, w: AskWords): string => person.name ?? w.t.people[person.kind === 'kid' ? 'kids' : person.kind];

/** One person's line: "Maya: busy 16:00-17:00, free the rest of the day". */
function personLine({ person, judged }: AskLine, day: DayKey, answer: AskAnswer, w: AskWords): string {
  const name = nameOf(person, w);
  const { dayEnd } = dayEdges(day, answer.tz);
  const ranges = () => rangesText(judged.shown, answer.tz, dayEnd, w);
  const partial = answer.googleGap !== undefined;
  const t = w.t.line;
  switch (answer.range.kind) {
    case 'day':
      if (judged.verdict === 'free') return fill(t.day.free, { name });
      if (judged.verdict === 'busyAll') return fill(t.day.all, { name });
      return fill(partial ? t.partial : t.day.some, { name, ranges: ranges() });
    case 'part':
    case 'between':
      if (judged.verdict === 'free') return fill(t.window.free, { name });
      if (judged.verdict === 'busyAll') return fill(t.window.all, { name });
      return fill(partial ? t.partial : t.window.some, { name, ranges: ranges() });
    case 'at':
      if (judged.verdict === 'free') return fill(t.at.free, { name });
      return fill(t.at.busy, { name, ranges: ranges() });
  }
}

/**
 * The lines a day shows (spec 2026-11-08 §4.2): the people asked for, busy or free; with no one in particular asked,
 * the caller's line and every busy one, or every line when that leaves none; with Google unread, never a free one.
 */
function shownLines(lines: readonly AskLine[], answer: AskAnswer): AskLine[] {
  const asked = answer.asked;
  let shown = asked
    ? lines.filter(l => asked.has(l.person.key))
    : lines.filter(l => l.person.kind === 'me' || l.judged.verdict !== 'free');
  if (!asked && shown.length === 0) shown = [...lines];
  return answer.googleGap === undefined ? shown : shown.filter(l => l.judged.verdict !== 'free');
}

/**
 * The answer: for each day, its first line and one line per person shown; a day with none shown has no line. Then the
 * Google line when Google was unread; "couldn't check" when nothing is left.
 */
export function askAnswerText(answer: AskAnswer, w: AskWords): string {
  const out: string[] = [];
  for (const entry of answer.days) {
    const lines = shownLines(entry.lines, answer);
    if (lines.length === 0) continue;
    out.push(headLine(entry.day, answer, w), ...lines.map(line => personLine(line, entry.day, answer, w)));
  }
  if (out.length === 0) return leadLine(w.t.unavailable, w.locale);
  if (answer.googleGap !== undefined) out.push(w.t.googlePartial);
  return out.map(line => leadLine(line, w.locale)).join('\n');
}

export const noDateText = (w: AskWords) => leadRtl(fill(w.t.noDate, { bot: w.botUsername }), w.locale);
export const tooManyDaysText = (w: AskWords) => leadRtl(fill(w.t.tooManyDays, { bot: w.botUsername }), w.locale);
