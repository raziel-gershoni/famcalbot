/**
 * The holidays of a day, computed in-process on @hebcal/core with the Israel schedule.
 *
 * One definition serves the bot's summaries (getHolidaysForDate) and the calendar home
 * (holidaysInRange, behind GET /api/calendar/holidays). Spec:
 * docs/superpowers/specs/2026-10-19-hebrew-holidays-design.md
 *
 * Server only: @hebcal/core must never reach a client bundle (the home gets holidays as data).
 */

import { HDate, HebrewCalendar, Locale, flags, type Event } from '@hebcal/core';
import { gematriya } from '@hebcal/hdate';
// Adds Russian to hebcal's Locale. Bundles don't share module state in Next 16, so this
// module registers it itself instead of relying on claude.ts or hebrew-date.ts.
import '@hebcal/locales/ru';
import enMessages from '../../messages/en.json';
import heMessages from '../../messages/he.json';
import ruMessages from '../../messages/ru.json';

export type HolidayKind = 'chag' | 'fast' | 'erev' | 'cholHamoed' | 'minor' | 'modern' | 'roshChodesh';

export interface Holiday {
  /** The full name: "Rosh Hashana 5787", "Chanukah: 8 Candles". */
  title: string;
  /** The short name for the Month's cells (hebcal's renderBrief). */
  brief: string;
  /** A yom tov, a day off: the home colours these with the accent. */
  chag: boolean;
  kind: HolidayKind;
}

/** The kinds, highest priority first. An event's kind is the first one its flags match. */
const KINDS: ReadonlyArray<{ kind: HolidayKind; mask: number }> = [
  { kind: 'chag', mask: flags.CHAG },
  { kind: 'fast', mask: flags.MAJOR_FAST | flags.MINOR_FAST },
  { kind: 'erev', mask: flags.EREV },
  { kind: 'cholHamoed', mask: flags.CHOL_HAMOED },
  { kind: 'minor', mask: flags.MINOR_HOLIDAY },
  { kind: 'modern', mask: flags.MODERN_HOLIDAY },
  { kind: 'roshChodesh', mask: flags.ROSH_CHODESH },
];

/** hebcal's locale for each language the app speaks; anything else reads as English. */
const LOCALES: Record<string, string> = { en: 'en', he: 'he-x-NoNikud', ru: 'ru' };

/**
 * Names where hebcal's wording is not how people say it (Russian most of all), in
 * messages/{en,he,ru}.json under holidays.names.<id>. en and he mirror hebcal's own wording,
 * so one code path serves every language. The messages are read statically because
 * holidaysInRange is synchronous. An {arg} in a name is filled by holidayNameKey.
 */
const NAMES: Record<string, Record<string, string>> = {
  en: enMessages.holidays.names,
  he: heMessages.holidays.names,
  ru: ruMessages.holidays.names,
};

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 };

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The kind of an event, or null when it is not a holiday we show (parashot, special Shabbatot, the Omer...). */
function kindOf(ev: Event): HolidayKind | null {
  const f = ev.getFlags();
  for (const { kind, mask } of KINDS) if (f & mask) return kind;
  return null;
}

/** A stable camelCase id from hebcal's English description: "Tish'a B'Av" is tishaBav. */
function slug(desc: string): string {
  return desc
    .replace(/['’]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word, i) => {
      const lower = word.toLowerCase();
      return i === 0 ? lower : lower[0].toUpperCase() + lower.slice(1);
    })
    .join('');
}

/**
 * The id of a holiday's entry in holidays.names and the values for its {arguments}.
 * What varies between days of one holiday (the month of a Rosh Chodesh, the year of Rosh
 * Hashana, the day of a chol hamoed) becomes an argument; everything else is the slug of
 * hebcal's English description. `locale` is hebcal's.
 */
export function holidayNameKey(desc: string, locale: string): { id: string; args: Record<string, string> } {
  const hebrew = locale === 'he-x-NoNikud';
  let m: RegExpExecArray | null;
  if ((m = /^Rosh Chodesh (.+)$/.exec(desc))) {
    // hebcal writes its apostrophes as ’; so does the month here.
    return { id: 'roshChodesh', args: { month: Locale.gettext(m[1], locale).replace(/'/g, '’') } };
  }
  if ((m = /^Rosh Hashana (\d{4})$/.exec(desc))) {
    return { id: 'roshHashana', args: { year: hebrew ? gematriya(Number(m[1])) : m[1] } };
  }
  if ((m = /^(Sukkot|Pesach) ([IVX]+) \(CH''M\)$/.exec(desc))) {
    return { id: `${m[1].toLowerCase()}CholHamoed`, args: { n: hebrew ? gematriya(ROMAN[m[2]]) : m[2] } };
  }
  if (desc === 'Sukkot VII (Hoshana Raba)') return { id: 'hoshanaRaba', args: {} };
  return { id: slug(desc), args: {} };
}

/** The wording holidays.names gives an event in a language, or null when hebcal's own is used. */
function nameOverride(ev: Event, locale: string, language: string): string | null {
  const { id, args } = holidayNameKey(ev.getDesc(), locale);
  const template = NAMES[language][id];
  if (!template) return null;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => args[name] ?? placeholder);
}

/** A local calendar day from a yyyy-MM-dd key, or null when the key is not a real date. */
function parseDayKey(key: string): Date | null {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** The Gregorian day key of an event, read from hebcal's own civil date (never through ISO or UTC). */
function dayKeyOf(ev: Event): string {
  const d = ev.getDate().greg();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A Hebrew year inside a Hebrew title ("ראש השנה 5787") is written in gematriya, as the project asks. */
function withGematriyaYear(text: string, locale: string): string {
  if (locale !== 'he-x-NoNikud') return text;
  return text.replace(/\b5\d{3}\b/g, year => gematriya(Number(year)));
}

/**
 * The holidays of each day from `from` to `to` (inclusive, yyyy-MM-dd, civil days), in a language.
 * Only days with a holiday have a key; a day's holidays are sorted by kind priority, then in
 * hebcal's order. A bad or reversed range gives {}.
 */
export function holidaysInRange(from: string, to: string, lang: string): Record<string, Holiday[]> {
  const start = parseDayKey(from);
  const end = parseDayKey(to);
  if (!start || !end || start > end) return {};
  const language = Object.hasOwn(LOCALES, lang) ? lang : 'en';
  const locale = LOCALES[language];

  const days: Record<string, Holiday[]> = {};
  for (const ev of HebrewCalendar.calendar({ start: new HDate(start), end: new HDate(end), il: true })) {
    const kind = kindOf(ev);
    if (!kind) continue;
    const key = dayKeyOf(ev);
    const named = nameOverride(ev, locale, language);
    (days[key] ??= []).push({
      title: named ?? withGematriyaYear(ev.render(locale), locale),
      brief: named ?? withGematriyaYear(ev.renderBrief(locale), locale),
      chag: kind === 'chag',
      kind,
    });
  }

  const rank = (h: Holiday) => KINDS.findIndex(k => k.kind === h.kind);
  const sorted: Record<string, Holiday[]> = {};
  for (const key of Object.keys(days).sort()) {
    // Array.prototype.sort is stable, so hebcal's order holds within a kind.
    sorted[key] = days[key].sort((a, b) => rank(a) - rank(b));
  }
  return sorted;
}

/**
 * The holiday titles of the user's local day, for the summaries' prompt. Async only because
 * the caller (claude.ts) awaits it.
 */
export async function getHolidaysForDate(date: Date, language: string, timezone: string): Promise<string[]> {
  const day = date.toLocaleDateString('en-CA', { timeZone: timezone }); // en-CA gives yyyy-MM-dd
  return holidaysInRange(day, day, language)[day]?.map(h => h.title) ?? [];
}
