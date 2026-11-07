// The Jewish times API's answers as JSON (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.1, §3.3, §3.4):
// /api/v1/shabbat's blocks and /api/v1/day's day, from the same code the zmanim pages and the sun sheet read.
//
// - Every time comes from zmanDayForPlace (day-list.ts) with the request's own memo and quiet, never the process memo, and
//   the blocks from restBlocksBetween (rest-blocks-view.ts), which the city pages' "ahead" section calls too.
// - A row is named by zmanRowName over calendarHome.* (the sun sheet's words), an opinion by calendarHome.zmanim.opinions.*,
//   a holiday and the parasha by holidaysInRange in the language (il from the place's zone).
// - `local` is the place's clock, hh:mm in 24 hours; `at` is the same reading with the zone's offset at that instant
//   (isoWithOffset: epoch arithmetic over instantToWallTime, never the server's zone and never formatInTimeZone). Where the
//   sun makes no time both are null.
// - The Hebrew date is the civil day's daytime date (no sunset shift), as the home and the site show it, the Russian month
//   in the genitive (calendarHome.hebrewMonthGenitive); `gematriya` is always the Hebrew text.
//
// Server only (src/services/zmanim, hebcal): only route handlers import it, never a 'use client' file. Pure: no database,
// Redis, network or clock (the caller gives every day).

import { createTranslator } from 'next-intl';
import type { Credit } from '../../lib/api-v1/credits';
import type { ApiLang } from '../../lib/api-v1/params';
import type { ApiPlace } from '../../lib/api-v1/place';
import { hebrewDateOf, hebrewFullDate } from '../../lib/calendar-view/hebrew-date';
import type { ZmanOpinion } from '../../lib/calendar-view/zman-spec';
import { zmanRowName, type ZmanWordsT } from '../../lib/calendar-view/zman-words';
import { formatHalachicHour, type ZmanimListRow } from '../../lib/calendar-view/zmanim-list';
import { instantToWallTime } from '../../utils/wall-time';
import { holidaysInRange, type Holiday } from '../hebrew-holidays';
import { zmanDayForPlace, type ZmanMemo } from './day-list';
import { restBlocksBetween, type RestBlockView } from './rest-blocks-view';
import type { ZmanimCommunity } from './sets';

export type ApiTime = { at: string | null; local: string | null };
export type ApiRow = { key: string; opinion: ZmanOpinion | null; name: string } & ApiTime;
export type ApiHoliday = { title: string; brief: string; kind: Holiday['kind']; chag: boolean };
export type ApiPlaceJson =
  | { city: string; timeZone: string; inIsrael: boolean; elevationM: number | null }
  | { latitude: number; longitude: number; timeZone: string; inIsrael: boolean; elevationM: number | null };

export type ShabbatBlock = {
  eve: string;
  last: string;
  candleLighting: ApiTime;
  start: ApiTime;
  end: ({ key: string; name: string } & ApiTime) | null;
  parasha: { title: string; brief: string } | null;
  holidays: ApiHoliday[];
  days: { date: string; rows: ApiRow[] }[];
};

export type ShabbatAnswer = { place: ApiPlaceJson; community: ZmanimCommunity; lang: ApiLang; from: string; to: string; blocks: ShabbatBlock[]; credits: Credit[] };

export type DayAnswer = {
  place: ApiPlaceJson;
  community: ZmanimCommunity;
  lang: ApiLang;
  date: string;
  hebrewDate: { text: string; gematriya: string; day: number; month: string; year: number };
  holidays: ApiHoliday[];
  rows: ApiRow[];
  hours: { opinion: ZmanOpinion; name: string; ms: number | null; text: string | null }[];
  credits: Credit[];
};

export type ShabbatInput = { place: ApiPlace; community: ZmanimCommunity; lang: ApiLang; from: string; to: string; credits: Credit[] };
export type DayInput = { place: ApiPlace; community: ZmanimCommunity; lang: ApiLang; date: string; credits: Credit[] };

const END_KEYS: readonly string[] = ['SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS'];

type Words = { t: ZmanWordsT; genitive: readonly string[] };
/** One translator of calendarHome.* per language, made once (the pattern of native-reminders/zman-view.ts). */
const WORDS = new Map<ApiLang, Words>();

async function wordsFor(lang: ApiLang): Promise<Words> {
  let words = WORDS.get(lang);
  if (!words) {
    const messages = (await import(`../../../messages/${lang}.json`)).default;
    words = {
      t: createTranslator({ locale: lang, messages, namespace: 'calendarHome' }) as unknown as ZmanWordsT,
      genitive: messages.calendarHome.hebrewMonthGenitive as readonly string[],
    };
    WORDS.set(lang, words);
  }
  return words;
}

/** `instant` on `zone`'s clock with the zone's offset at that instant: 2026-11-13T16:25:00+02:00 (whole seconds). */
export function isoWithOffset(instant: Date, zone: string): string {
  const wall = instantToWallTime(instant, zone);
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  const offsetMin = Math.round((Date.parse(`${wall}Z`) - wholeSecond) / 60_000);
  const abs = Math.abs(offsetMin);
  const sign = offsetMin < 0 ? '-' : '+';
  return `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** A UTC ISO instant (or null) as the API gives a time: `at` with the offset, `local` the place's hh:mm. */
export function apiTime(iso: string | null, zone: string): ApiTime {
  if (iso === null) return { at: null, local: null };
  const instant = new Date(iso);
  return { at: isoWithOffset(instant, zone), local: instantToWallTime(instant, zone).slice(11, 16) };
}

function placeJson(place: ApiPlace): ApiPlaceJson {
  const common = { timeZone: place.place.timeZone, inIsrael: place.il, elevationM: place.place.elevationM };
  return place.source === 'city' && place.slug !== null ? { city: place.slug, ...common } : { latitude: place.place.latitude, longitude: place.place.longitude, ...common };
}

const rowJson = (t: ZmanWordsT, row: ZmanimListRow, zone: string): ApiRow => ({ key: row.key, opinion: row.opinion, name: zmanRowName(t, row), ...apiTime(row.at, zone) });
const holidayJson = (h: Holiday): ApiHoliday => ({ title: h.title, brief: h.brief, kind: h.kind, chag: h.chag });

function blockJson(t: ZmanWordsT, block: RestBlockView, zone: string): ShabbatBlock {
  const candle = block.days[0]?.rows.find((row) => row.key === 'CANDLE_LIGHTING') ?? null;
  const ending = block.days[block.days.length - 1]?.rows.find((row) => END_KEYS.includes(row.key)) ?? null;
  return {
    eve: block.eve,
    last: block.last,
    candleLighting: apiTime(candle?.at ?? null, zone),
    start: apiTime(block.start, zone),
    end: ending ? { key: ending.key, name: zmanRowName(t, ending), ...apiTime(ending.at, zone) } : null,
    parasha: block.parasha ? { title: block.parasha.title, brief: block.parasha.brief } : null,
    holidays: block.holidays.map(holidayJson),
    days: block.days.map((d) => ({ date: d.day, rows: d.rows.map((row) => rowJson(t, row, zone)) })),
  };
}

/** /api/v1/shabbat: every block of rest days under way on `from` or beginning by `to`. */
export async function shabbatView(input: ShabbatInput): Promise<ShabbatAnswer> {
  const { t } = await wordsFor(input.lang);
  const memo: ZmanMemo = new Map();
  const zone = input.place.place.timeZone;
  const blocks = restBlocksBetween(input.place.place, input.community, input.from, input.to, input.lang, input.place.il, memo);
  return { place: placeJson(input.place), community: input.community, lang: input.lang, from: input.from, to: input.to, blocks: blocks.map((b) => blockJson(t, b, zone)), credits: input.credits };
}

/** /api/v1/day: one civil day's zmanim, halachic hours, holidays and Hebrew date. */
export async function dayView(input: DayInput): Promise<DayAnswer> {
  const { t, genitive } = await wordsFor(input.lang);
  const zone = input.place.place.timeZone;
  const list = zmanDayForPlace(input.place.place, input.community, input.date, { memo: new Map(), quiet: true });
  const hd = hebrewDateOf(input.date);
  if (!hd) throw new TypeError('the day is not a real day');
  return {
    place: placeJson(input.place),
    community: input.community,
    lang: input.lang,
    date: input.date,
    hebrewDate: { text: hebrewFullDate(input.date, input.lang, genitive), gematriya: hebrewFullDate(input.date, 'he'), day: hd.getDate(), month: hd.getMonthName(), year: hd.getFullYear() },
    holidays: (holidaysInRange(input.date, input.date, input.lang, { il: input.place.il })[input.date] ?? []).map(holidayJson),
    rows: list.rows.map((row) => rowJson(t, row, zone)),
    hours: list.hours.map((h) => ({ opinion: h.opinion, name: t(`zmanim.opinions.${h.opinion}`), ms: h.ms, text: h.ms === null ? null : formatHalachicHour(h.ms) })),
    credits: input.credits,
  };
}
