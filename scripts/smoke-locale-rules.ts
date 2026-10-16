// Smoke test for the week-start and Hebrew-date rules (spec §6): src/utils/locale-rules.ts
// and its zone table, src/config/week-start-zones.ts. This is the locale part of the
// spec's pure reader smoke.
//
// Today the bot's weeks have two shapes: Jewish culture runs Sunday to Saturday,
// everyone else Monday to Sunday (week-lookahead.ts:80-99 and :435-451). The new rule
// takes the week start from the country of the user's timezone, then the language, so a
// week can also start on Saturday (Egypt, Iran, ...) or Friday (the Maldives). The
// boundary functions take any week start and must give today's days for 0 and 1; the
// reference copies of today's functions below are what they are held to.
//
// Pure: no database, Redis, network or AI. Every input is a yyyy-MM-dd string, so the
// output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-locale-rules.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-locale-rules.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-locale-rules.ts

import {
  hebrewDatesFor,
  legacyWeekStart,
  nextWeekBoundaries,
  nextWeekBoundary,
  tzKnownFor,
  weekStartFor,
  type LocaleFacts,
  type WeekStart,
} from '../src/utils/locale-rules';
import { NON_MONDAY_ZONES } from '../src/config/week-start-zones';
import { addDaysToDate } from '../src/utils/day-events';
import type { UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; skipped?: boolean; reason?: string };
const results: Result[] = [];

/** Thrown by a check that can't run on this Node; printed as SKIP, not counted as failed. */
class Skip extends Error {}

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    if (err instanceof Skip) results.push({ name, ok: true, skipped: true, reason: err.message });
    else results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEqual<T>(got: T, want: T, label: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---- Today's functions, copied from src/services/week-lookahead.ts at main@858886c ----

function refWeekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

// week-lookahead.ts:80-99, getNextWeekBoundary
function refNextWeekBoundary(culture: string | undefined, always7Days: boolean | undefined, today: string): string {
  let daysUntilBoundary: number;

  if (always7Days) {
    daysUntilBoundary = 7;
  } else {
    const dayOfWeek = refWeekdayOf(today);

    if (culture === 'jewish') {
      daysUntilBoundary = (6 - dayOfWeek + 7) % 7;
    } else {
      daysUntilBoundary = (7 - dayOfWeek) % 7;
    }
  }

  return addDaysToDate(today, daysUntilBoundary);
}

// week-lookahead.ts:435-451, getNextWeekBoundaries
function refNextWeekBoundaries(culture: string | undefined, today: string): { first: string; last: string } {
  const dayOfWeek = refWeekdayOf(today);

  let daysUntilNextWeekStart: number;
  const weekLength: number = 7;

  if (culture === 'jewish') {
    daysUntilNextWeekStart = (7 - dayOfWeek) % 7 || 7;
  } else {
    daysUntilNextWeekStart = ((8 - dayOfWeek) % 7) || 7;
  }

  const first = addDaysToDate(today, daysUntilNextWeekStart);
  return { first, last: addDaysToDate(first, weekLength - 1) };
}

// ---- Fixtures ----

/** Two weeks in October 2026 (Sun 11th to Sat 24th), a year end, and a leap-day week. */
const DAYS: string[] = [
  ...Array.from({ length: 14 }, (_, i) => addDaysToDate('2026-10-11', i)),
  ...Array.from({ length: 14 }, (_, i) => addDaysToDate('2026-12-27', i)),
  ...Array.from({ length: 9 }, (_, i) => addDaysToDate('2028-02-25', i)),
];

const ALL_STARTS: WeekStart[] = [0, 1, 2, 3, 4, 5, 6];

/** Days from `a` to `b`, both yyyy-MM-dd. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const known = (tz: string, language: string, culture = 'default'): LocaleFacts => ({ culture, language, tz, tzKnown: true });
const unknown = (tz: string, language: string | undefined, culture = 'default'): LocaleFacts => ({ culture, language, tz, tzKnown: false });

/** Intl.Locale's week and zone methods (Node 24+); TypeScript's lib doesn't have them yet. */
type WeekLocale = Intl.Locale & {
  getWeekInfo?: () => { firstDay: number };
  getTimeZones?: () => string[] | undefined;
};

async function main() {
  // A fresh DB user row must fit tzKnownFor's parameter (compile-time check).
  const _acceptsUser: (u: Pick<UserConfig, 'location' | 'googleRefreshToken'>) => boolean = tzKnownFor;

  await check('tzKnownFor: a location or a Google token makes the timezone known', () => {
    assertEqual(tzKnownFor({ location: 'Haifa, Israel', googleRefreshToken: '' }), true, 'location');
    assertEqual(tzKnownFor({ location: '', googleRefreshToken: 'refresh-token' }), true, 'Google token');
    assertEqual(tzKnownFor({ location: '', googleRefreshToken: '' }), false, 'neither (empty strings)');
    assertEqual(tzKnownFor({ location: null, googleRefreshToken: null }), false, 'neither (null)');
    assertEqual(tzKnownFor({}), false, 'neither (absent)');
  });

  await check('legacyWeekStart: today\'s rule, jewish → Sunday, anything else → Monday', () => {
    assertEqual(legacyWeekStart('jewish'), 0, 'jewish');
    assertEqual(legacyWeekStart('default'), 1, 'default');
    assertEqual(legacyWeekStart(undefined), 1, 'undefined');
    assertEqual(legacyWeekStart('Jewish'), 1, 'compared strictly');
  });

  await check('weekStartFor: Jewish culture always starts on Sunday', () => {
    assertEqual(weekStartFor(known('Europe/London', 'en', 'jewish')), 0, 'London');
    assertEqual(weekStartFor(known('Africa/Cairo', 'ru', 'jewish')), 0, 'Cairo');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'ru', 'jewish')), 0, 'unknown timezone');
  });

  await check('weekStartFor: the country of a known timezone decides', () => {
    assertEqual(weekStartFor(known('Africa/Cairo', 'en')), 6, 'Cairo → Saturday');
    assertEqual(weekStartFor(known('Asia/Tehran', 'en')), 6, 'Tehran → Saturday');
    assertEqual(weekStartFor(known('Indian/Maldives', 'en')), 5, 'the Maldives → Friday');
    assertEqual(weekStartFor(known('America/New_York', 'ru')), 0, 'New York → Sunday, not Russian Monday');
    assertEqual(weekStartFor(known('Asia/Jerusalem', 'ru')), 0, 'Israel → Sunday');
    assertEqual(weekStartFor(known('Asia/Riyadh', 'en')), 0, 'Saudi Arabia → Sunday');
    assertEqual(weekStartFor(known('Europe/London', 'en')), 1, 'London → Monday, not English Sunday');
    assertEqual(weekStartFor(known('Europe/Moscow', 'he')), 1, 'Moscow → Monday, not Hebrew Sunday');
    assertEqual(weekStartFor(known('Asia/Dubai', 'he')), 1, 'the Emirates → Monday');
  });

  await check('weekStartFor: both Kolkata spellings, and Asia/Tel_Aviv through Intl\'s canonical name', () => {
    assertEqual(weekStartFor(known('Asia/Kolkata', 'ru')), 0, 'Asia/Kolkata');
    assertEqual(weekStartFor(known('Asia/Calcutta', 'ru')), 0, 'Asia/Calcutta');
    assert(!Object.hasOwn(NON_MONDAY_ZONES, 'Asia/Tel_Aviv'), 'Asia/Tel_Aviv is in the table, so this would not test the canonical lookup');
    assertEqual(weekStartFor(known('Asia/Tel_Aviv', 'ru')), 0, 'Asia/Tel_Aviv');
    assertEqual(weekStartFor(known('US/Eastern', 'ru')), 0, 'US/Eastern');
  });

  await check('weekStartFor: Asia/Hebron counts as Palestine → Monday, even in Hebrew', () => {
    assertEqual(weekStartFor(known('Asia/Hebron', 'he')), 1, 'Hebron');
    assertEqual(weekStartFor(known('Asia/Gaza', 'en')), 1, 'Gaza');
  });

  await check('weekStartFor: Etc/UTC and other non-country zones fall to the language rule', () => {
    for (const tz of ['Etc/UTC', 'UTC', 'GMT', 'Etc/GMT', 'Etc/GMT+5', 'Universal']) {
      assertEqual(weekStartFor(known(tz, 'he')), 0, `${tz} he`);
      assertEqual(weekStartFor(known(tz, 'en')), 0, `${tz} en`);
      assertEqual(weekStartFor(known(tz, 'ru')), 1, `${tz} ru`);
      assertEqual(weekStartFor(known(tz, 'fr')), 1, `${tz} fr`);
    }
  });

  await check('weekStartFor: a timezone Intl rejects falls to the language rule', () => {
    assertEqual(weekStartFor(known('Bogus/Zone', 'en')), 0, 'bogus en');
    assertEqual(weekStartFor(known('', 'en')), 0, 'empty en');
    assertEqual(weekStartFor(known('constructor', 'ru')), 1, 'an Object.prototype key');
    assertEqual(weekStartFor(known('toString', 'he')), 0, 'another Object.prototype key');
  });

  await check('weekStartFor: an unknown language → Monday', () => {
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'fr')), 1, 'fr');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'HE')), 1, 'compared strictly');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', undefined)), 1, 'no language');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', '')), 1, 'empty language');
  });

  await check('weekStartFor: tzKnown false ignores the timezone (the Asia/Jerusalem fallback)', () => {
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'he')), 0, 'he → Sunday');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'en')), 0, 'en → Sunday');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'ru')), 1, 'ru → Monday, not Israel\'s Sunday');
    assertEqual(weekStartFor(unknown('Africa/Cairo', 'ru')), 1, 'Cairo unknown → Russian Monday');
  });

  await check('hebrewDatesFor: Jewish culture, Hebrew language, or a known Israel timezone', () => {
    const cases: [LocaleFacts, boolean, string][] = [
      [known('Europe/London', 'en', 'jewish'), true, 'Jewish culture in London'],
      [unknown('Asia/Jerusalem', 'ru', 'jewish'), true, 'Jewish culture, timezone unknown'],
      [known('Europe/Berlin', 'he'), true, 'Hebrew in Berlin'],
      [unknown('Asia/Jerusalem', 'he'), true, 'Hebrew, timezone unknown'],
      [known('Asia/Jerusalem', 'ru'), true, 'Russian in Israel'],
      [known('Asia/Jerusalem', 'en'), true, 'English in Israel'],
      [known('Asia/Tel_Aviv', 'en'), true, 'Asia/Tel_Aviv'],
      [known('Israel', 'en'), true, 'Israel'],
      [unknown('Asia/Jerusalem', 'en'), false, 'English with the fallback timezone'],
      [unknown('Asia/Jerusalem', 'ru'), false, 'Russian with the fallback timezone'],
      [known('America/New_York', 'en'), false, 'English in New York'],
      [known('Europe/Moscow', 'ru'), false, 'Russian in Moscow'],
      [known('Asia/Hebron', 'en'), false, 'Hebron is not an Israel signal'],
      [known('Europe/London', 'en', 'Jewish'), false, 'culture compared strictly'],
      [known('Europe/London', 'HE'), false, 'language compared strictly'],
      [known('asia/jerusalem', 'en'), false, 'the Israel zones compared as given'],
    ];
    for (const [facts, want, label] of cases) assertEqual(hebrewDatesFor(facts), want, label);
  });

  await check('nextWeekBoundary equals today\'s getNextWeekBoundary for ws 0 and 1 on every weekday', () => {
    for (const day of DAYS) {
      for (const always7 of [true, false, undefined]) {
        assertEqual(nextWeekBoundary(0, always7, day), refNextWeekBoundary('jewish', always7, day), `ws 0 ${day} always7=${always7}`);
        assertEqual(nextWeekBoundary(1, always7, day), refNextWeekBoundary('default', always7, day), `ws 1 ${day} always7=${always7}`);
      }
    }
  });

  await check('nextWeekBoundaries equals today\'s getNextWeekBoundaries for ws 0 and 1 on every weekday', () => {
    for (const day of DAYS) {
      assertEqual(nextWeekBoundaries(0, day), refNextWeekBoundaries('jewish', day), `ws 0 ${day}`);
      assertEqual(nextWeekBoundaries(1, day), refNextWeekBoundaries('default', day), `ws 1 ${day}`);
    }
  });

  await check('legacyWeekStart fed to the boundaries gives today\'s days for any culture string', () => {
    for (const culture of ['jewish', 'default', undefined, 'Jewish', '']) {
      for (const day of DAYS) {
        assertEqual(nextWeekBoundaries(legacyWeekStart(culture), day), refNextWeekBoundaries(culture, day), `${culture} ${day}`);
        for (const always7 of [true, false, undefined]) {
          assertEqual(nextWeekBoundary(legacyWeekStart(culture), always7, day), refNextWeekBoundary(culture, always7, day), `${culture} ${day} ${always7}`);
        }
      }
    }
  });

  await check('ws 6 gives Saturday-to-Friday weeks', () => {
    // Wed 14 Oct 2026: this week ends Fri 16th; next week is Sat 17th to Fri 23rd.
    assertEqual(nextWeekBoundary(6, false, '2026-10-14'), '2026-10-16', 'this week from Wednesday');
    assertEqual(nextWeekBoundaries(6, '2026-10-14'), { first: '2026-10-17', last: '2026-10-23' }, 'next week from Wednesday');
    // Fri 16th is the week's last day: this week is just today; next week starts tomorrow.
    assertEqual(nextWeekBoundary(6, false, '2026-10-16'), '2026-10-16', 'this week from Friday');
    assertEqual(nextWeekBoundaries(6, '2026-10-16'), { first: '2026-10-17', last: '2026-10-23' }, 'next week from Friday');
    // Sat 17th is the first day: this week runs to Fri 23rd; next week is the one after.
    assertEqual(nextWeekBoundary(6, false, '2026-10-17'), '2026-10-23', 'this week from Saturday');
    assertEqual(nextWeekBoundaries(6, '2026-10-17'), { first: '2026-10-24', last: '2026-10-30' }, 'next week from Saturday');
    assertEqual(nextWeekBoundary(6, true, '2026-10-14'), '2026-10-21', 'always 7 days');
  });

  await check('ws 5 gives Friday-to-Thursday weeks', () => {
    assertEqual(nextWeekBoundary(5, false, '2026-10-14'), '2026-10-15', 'this week from Wednesday');
    assertEqual(nextWeekBoundaries(5, '2026-10-14'), { first: '2026-10-16', last: '2026-10-22' }, 'next week from Wednesday');
    assertEqual(nextWeekBoundary(5, false, '2026-10-15'), '2026-10-15', 'this week from Thursday');
    assertEqual(nextWeekBoundary(5, false, '2026-10-16'), '2026-10-22', 'this week from Friday');
    assertEqual(nextWeekBoundaries(5, '2026-10-16'), { first: '2026-10-23', last: '2026-10-29' }, 'next week from Friday');
  });

  await check('every week start: this week ends the day before a week start, next week is the following whole week', () => {
    for (const ws of ALL_STARTS) {
      for (const day of DAYS) {
        const end = nextWeekBoundary(ws, false, day);
        const toEnd = daysBetween(day, end);
        assert(toEnd >= 0 && toEnd <= 6, `ws ${ws} ${day}: this week ends ${toEnd} days on`);
        assertEqual(refWeekdayOf(end), (ws + 6) % 7, `ws ${ws} ${day}: this week's last weekday`);
        const { first, last } = nextWeekBoundaries(ws, day);
        assertEqual(refWeekdayOf(first), ws, `ws ${ws} ${day}: next week's first weekday`);
        assertEqual(first, addDaysToDate(end, 1), `ws ${ws} ${day}: next week starts the day after this week ends`);
        assertEqual(last, addDaysToDate(first, 6), `ws ${ws} ${day}: next week is 7 days`);
        assertEqual(nextWeekBoundary(ws, true, day), addDaysToDate(day, 7), `ws ${ws} ${day}: always 7 days`);
      }
    }
  });

  await check('NON_MONDAY_ZONES: Sunday, Saturday or Friday only, every name accepted by Intl, both spellings', () => {
    const bad: string[] = [];
    for (const [zone, day] of Object.entries(NON_MONDAY_ZONES)) {
      if (day !== 0 && day !== 5 && day !== 6) bad.push(`${zone}: ${day}`);
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
      } catch {
        bad.push(`${zone}: rejected by Intl`);
      }
    }
    assert(bad.length === 0, bad.join('; '));
    for (const [iana, cldr] of [
      ['Asia/Kolkata', 'Asia/Calcutta'],
      ['Asia/Kathmandu', 'Asia/Katmandu'],
      ['Asia/Yangon', 'Asia/Rangoon'],
      ['America/Atikokan', 'America/Coral_Harbour'],
      ['America/Indiana/Indianapolis', 'America/Indianapolis'],
      ['America/Kentucky/Louisville', 'America/Louisville'],
    ]) {
      assert(Object.hasOwn(NON_MONDAY_ZONES, iana) && Object.hasOwn(NON_MONDAY_ZONES, cldr), `${iana} / ${cldr}: a spelling is missing`);
    }
  });

  await check('NON_MONDAY_ZONES matches Intl\'s week data for every zone (Node 24 or newer)', () => {
    const probe = new Intl.Locale('und-US') as WeekLocale;
    if (typeof probe.getWeekInfo !== 'function' || typeof probe.getTimeZones !== 'function') {
      throw new Skip(`Node ${process.versions.node} has no Intl.Locale getWeekInfo/getTimeZones`);
    }
    // Every zone Intl assigns to a country, with that country's week start (0 = Sunday).
    const fromIntl = new Map<string, number>();
    const problems: string[] = [];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of letters) {
      for (const b of letters) {
        const region = a + b;
        const locale = new Intl.Locale(`und-${region}`) as WeekLocale;
        if (locale.region !== region) continue; // an old code Intl maps to a current one (UK → GB)
        const firstDay = locale.getWeekInfo!().firstDay % 7; // Intl counts 1 = Monday ... 7 = Sunday
        for (const zone of locale.getTimeZones!() ?? []) {
          const seen = fromIntl.get(zone);
          if (seen !== undefined && seen !== firstDay) problems.push(`${zone}: two countries, ${seen} and ${firstDay}`);
          fromIntl.set(zone, firstDay);
        }
      }
    }
    assert(fromIntl.size > 400, `Intl assigned only ${fromIntl.size} zones to countries`);
    for (const [zone, day] of fromIntl) {
      const listed = Object.hasOwn(NON_MONDAY_ZONES, zone) ? NON_MONDAY_ZONES[zone] : 1;
      if (listed !== day) problems.push(`${zone}: Intl ${day}, table ${listed}`);
      const ruled = weekStartFor({ language: 'xx', tz: zone, tzKnown: true });
      if (ruled !== day) problems.push(`${zone}: weekStartFor ${ruled}, Intl ${day}`);
    }
    for (const [zone, day] of Object.entries(NON_MONDAY_ZONES)) {
      const canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
      const intlDay = fromIntl.get(zone) ?? fromIntl.get(canonical);
      if (intlDay !== day) problems.push(`${zone} (${canonical}): table ${day}, Intl ${intlDay ?? 'no country'}`);
    }
    assert(
      problems.length === 0,
      `ICU ${process.versions.icu}, CLDR ${process.versions.cldr ?? '?'}, tz ${process.versions.tz ?? '?'}: ${problems.join('; ')}`,
    );
  });

  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.skipped) {
      skipped++;
      console.log(`SKIP  ${r.name} — ${r.reason}`);
      continue;
    }
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(
    `\n${results.length - failed}/${results.length} passed${skipped ? ` (${skipped} skipped)` : ''} (process TZ=${process.env.TZ ?? 'unset'})`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
