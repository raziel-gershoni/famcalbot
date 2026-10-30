/**
 * The holidays of a day, computed in-process on @hebcal/core with the Israel schedule, or the
 * diaspora's where a caller asks for it ({ il: false }: the public zmanim pages of a city abroad,
 * docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.2).
 *
 * One definition serves the bot's summaries (getHolidaysForDate) and the calendar home
 * (holidaysInRange, behind GET /api/calendar/holidays), both on the Israel schedule. Spec:
 * docs/superpowers/specs/2026-10-19-hebrew-holidays-design.md
 *
 * Server only: @hebcal/core must never reach a client bundle (the home gets holidays as data).
 */

import { HDate, HebrewCalendar, Locale, flags, type Event, type ParshaEvent } from '@hebcal/core';
import { gematriya } from '@hebcal/hdate';
// Adds Russian to hebcal's Locale. Bundles don't share module state in Next 16, so this
// module registers it itself instead of relying on claude.ts or hebrew-date.ts.
import '@hebcal/locales/ru';
import { joinTitles } from '../lib/join-titles';
import enMessages from '../../messages/en.json';
import heMessages from '../../messages/he.json';
import ruMessages from '../../messages/ru.json';

/**
 * Which schedule: `il` true (the default) is the Israel one, false the diaspora's (the second days of
 * Pesach, Shavuot and Sukkot, Simchat Torah, and the portions that follow from them).
 */
export type HolidayOptions = { il?: boolean };

export type HolidayKind = 'chag' | 'fast' | 'erev' | 'cholHamoed' | 'minor' | 'modern' | 'roshChodesh' | 'parasha' | 'specialShabbat';

export interface Holiday {
  /** The full name: "Rosh Hashana 5787", "Chanukah: 8 Candles". */
  title: string;
  /** The short name for the Month's cells (hebcal's renderBrief; a portion's name alone). */
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
  // The weekly portion and its special Shabbat (Shekalim, Zachor...) rank below every holiday (owner,
  // 2026-10-26). They are no holidays: the summaries' holiday list and the countdown leave them out.
  { kind: 'parasha', mask: flags.PARSHA_HASHAVUA },
  { kind: 'specialShabbat', mask: flags.SPECIAL_SHABBAT },
];

/** The two kinds that are no holiday (the weekly portion and its special Shabbat). */
const PARASHA_KINDS: ReadonlySet<HolidayKind> = new Set<HolidayKind>(['parasha', 'specialShabbat']);

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

/**
 * Of hebcal's MODERN_HOLIDAY events only these four national days show (owner, 2026-10-21);
 * the other Knesset days it lists (Rabin, Herzl, Ben-Gurion, Jabotinsky, Sigd, Family Day,
 * Hebrew Language Day, Yom HaAliyah and its school day) are left out. hebcal's English
 * getDesc(), which stays the same in years when the dates move.
 */
const MAJOR_MODERN_DESCS: ReadonlySet<string> = new Set(['Yom HaShoah', 'Yom HaZikaron', "Yom HaAtzma'ut", 'Yom Yerushalayim']);

/**
 * Of hebcal's MINOR_HOLIDAY events only these count as "the next holiday" of the home's
 * header countdown (owner, 2026-10-25), by hebcal's base name: no Pesach Sheni, Purim Katan,
 * Leil Selichot, Shushan Purim... Every yom tov (kind chag) and the four national days
 * (MAJOR_MODERN_DESCS) count too; fasts, eves, chol hamoed and Rosh Chodesh do not.
 */
const COUNTDOWN_MINOR_BASENAMES: ReadonlySet<string> = new Set(['Chanukah', 'Purim', 'Tu BiShvat', 'Lag BaOmer', "Tu B'Av"]);

/** How far ahead nextHoliday looks, in days. */
const NEXT_HOLIDAY_DAYS = 400;

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 };

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The kind of an event, or null when it is not a holiday we show (the Omer...). */
function kindOf(ev: Event): HolidayKind | null {
  const f = ev.getFlags();
  for (const { kind, mask } of KINDS) {
    if (!(f & mask)) continue;
    if (kind === 'modern' && !MAJOR_MODERN_DESCS.has(ev.getDesc())) continue;
    return kind;
  }
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
  return dayKey(ev.getDate().greg());
}

/** The yyyy-MM-dd key of a local civil date. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A Hebrew year inside a Hebrew title ("ראש השנה 5787") is written in gematriya, as the project asks. */
function withGematriyaYear(text: string, locale: string): string {
  if (locale !== 'he-x-NoNikud') return text;
  return text.replace(/\b5\d{3}\b/g, year => gematriya(Number(year)));
}

/**
 * The portion's name alone for the Month's cell ("Vayera", "Matot-Masei"): hebcal's renderBrief is
 * the full "Parashat Vayera", so each part (a doubled week has two) is translated by itself.
 * holidays.names.<id>Brief wins where hebcal's wording is not how people say it.
 */
function parashaBrief(ev: ParshaEvent, locale: string, language: string): string {
  const override = NAMES[language][`${holidayNameKey(ev.getDesc(), locale).id}Brief`];
  // hebcal writes its English apostrophes as ’.
  return override ?? ev.parsha.map(part => Locale.gettext(part, locale)).join('-').replace(/'/g, '’');
}

/**
 * The holidays of each day from `from` to `to` (inclusive, yyyy-MM-dd, civil days), in a language,
 * on the Israel schedule unless `options.il` is false. Only days with a holiday have a key; a day's
 * holidays are sorted by kind priority, then in hebcal's order. A bad or reversed range gives {}.
 */
export function holidaysInRange(from: string, to: string, lang: string, options: HolidayOptions = {}): Record<string, Holiday[]> {
  const start = parseDayKey(from);
  const end = parseDayKey(to);
  if (!start || !end || start > end) return {};
  const language = Object.hasOwn(LOCALES, lang) ? lang : 'en';
  const locale = LOCALES[language];

  const days: Record<string, Holiday[]> = {};
  for (const ev of HebrewCalendar.calendar({ start: new HDate(start), end: new HDate(end), il: options.il ?? true, sedrot: true })) {
    const kind = kindOf(ev);
    if (!kind) continue;
    const key = dayKeyOf(ev);
    const named = nameOverride(ev, locale, language);
    (days[key] ??= []).push({
      title: named ?? withGematriyaYear(ev.render(locale), locale),
      brief: kind === 'parasha' ? parashaBrief(ev as ParshaEvent, locale, language) : named ?? withGematriyaYear(ev.renderBrief(locale), locale),
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

/** The name hebcal gives a holiday in `locale` (the Russian locale leaves some names in English). */
function baseNameOf(ev: Event, locale: string, language: string): string {
  // The holiday line's own wording first (holidays.names, by the base name's id; "<id>Base"
  // where the full name carries an argument, as Rosh Hashana's year), else hebcal's.
  const { id } = holidayNameKey(ev.basename(), locale);
  return NAMES[language][`${id}Base`] ?? NAMES[language][id] ?? Locale.gettext(ev.basename(), locale);
}

export interface NextHoliday {
  /** The holiday's day, yyyy-MM-dd. */
  day: string;
  /** Its base name in the language, no day number or year: "Chanukah", "Rosh Hashana", "Pesach". */
  name: string;
}

/**
 * The next holiday worth counting down to, strictly after `after` (yyyy-MM-dd): a yom tov,
 * Chanukah, Purim, Tu BiShvat, Lag BaOmer, Tu B'Av or one of the four national days, on
 * the Israel schedule unless `options.il` is false, looking ahead at most `maxDays` days.
 * null when there is none, or for a bad date.
 */
export function nextHoliday(after: string, lang: string, maxDays: number = NEXT_HOLIDAY_DAYS, options: HolidayOptions = {}): NextHoliday | null {
  const from = parseDayKey(after);
  if (!from) return null;
  const language = Object.hasOwn(LOCALES, lang) ? lang : 'en';
  const locale = LOCALES[language];
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  const end = new Date(from.getFullYear(), from.getMonth(), from.getDate() + maxDays);
  if (start > end) return null;

  const rank = (kind: HolidayKind) => KINDS.findIndex(k => k.kind === kind);
  let best: { ev: Event; key: string; rank: number } | null = null;
  for (const ev of HebrewCalendar.calendar({ start: new HDate(start), end: new HDate(end), il: options.il ?? true })) {
    const kind = kindOf(ev);
    if (!kind) continue;
    if (kind === 'minor' && !COUNTDOWN_MINOR_BASENAMES.has(ev.basename())) continue;
    if (kind !== 'chag' && kind !== 'minor' && kind !== 'modern') continue;
    const key = dayKeyOf(ev);
    // The events come in date order; a later day never beats the first day found.
    if (best && key > best.key) break;
    if (!best || rank(kind) < best.rank) best = { ev, key, rank: rank(kind) };
  }
  return best ? { day: best.key, name: baseNameOf(best.ev, locale, language) } : null;
}

/**
 * The holiday titles of the user's local day, for the summaries' prompt (no parasha: the daily
 * summary gets it on its own line, weekParashaFor). Async only because the caller (claude.ts)
 * awaits it.
 */
export async function getHolidaysForDate(date: Date, language: string, timezone: string): Promise<string[]> {
  const day = date.toLocaleDateString('en-CA', { timeZone: timezone }); // en-CA gives yyyy-MM-dd
  return holidaysInRange(day, day, language)[day]?.filter(h => !PARASHA_KINDS.has(h.kind)).map(h => h.title) ?? [];
}

/**
 * This week's parasha for the daily summary, Sunday to Friday: the coming Saturday's portion,
 * with its special Shabbat when it has one ("Parashat Vayera", "Parashat Vayakhel, Shabbat
 * Shekalim"), joined as the calendar home joins a day's titles. null on Saturday itself (owner,
 * 2026-10-26: the Saturday summary says nothing of it), and when that Saturday is a holiday
 * and has no portion.
 */
export function weekParashaFor(date: Date, language: string, timezone: string): string | null {
  const day = date.toLocaleDateString('en-CA', { timeZone: timezone });
  const local = parseDayKey(day);
  if (!local || local.getDay() === 6) return null;
  const sat = new Date(local.getFullYear(), local.getMonth(), local.getDate() + (6 - local.getDay()));
  const key = dayKey(sat);
  const titles = (holidaysInRange(key, key, language)[key] ?? []).filter(h => PARASHA_KINDS.has(h.kind)).map(h => h.title);
  if (!titles.length) return null;
  return joinTitles(titles);
}
