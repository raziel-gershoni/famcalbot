// Smoke test for the Send sheet's week dates (Plan D Ruling 4, the before-ALL list): the
// client-side week ranges (src/lib/calendar-view/send-weeks.ts) must equal the bot's own
// bounds, locale-rules' nextWeekBoundary and nextWeekBoundaries, for every week start,
// both always-7 settings and 14 days in a row across a month and a year boundary; and
// formatDateSpan's strings in en, he and ru. Pure: no DB, Redis or network.
//
//   TZ=UTC npx tsx scripts/smoke-calendar-send-weeks.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-send-weeks.ts

import { nextWeekBoundaries, nextWeekBoundary } from '../src/utils/locale-rules';
import { addDaysToKey } from '../src/lib/calendar-view/store';
import { sendWeekRanges } from '../src/lib/calendar-view/send-weeks';
import { formatDateSpan } from '../src/lib/calendar-view/format';
import type { WeekStart } from '../src/lib/calendar-view/types';

const results: { name: string; ok: boolean; reason?: string }[] = [];
async function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assertEq(got: unknown, want: unknown, what: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: ${g}, wanted ${w}`);
}

async function main() {
  await check('sendWeekRanges equals the bot\'s nextWeekBoundary / nextWeekBoundaries for every week start, both settings, across a month and a year end', () => {
    for (const start of ['2026-10-25', '2026-12-25']) {
      for (let ws = 0; ws <= 6; ws++) {
        for (const always7 of [true, false]) {
          for (let n = 0; n < 14; n++) {
            const today = addDaysToKey(start, n);
            const got = sendWeekRanges(today, ws as WeekStart, always7);
            assertEq(got.thisWeek, { first: today, last: nextWeekBoundary(ws as WeekStart, always7, today) }, `this week ${today} ws${ws} 7:${always7}`);
            assertEq(got.nextWeek, nextWeekBoundaries(ws as WeekStart, today), `next week ${today} ws${ws}`);
          }
        }
      }
    }
  });

  await check('an unknown always-7 setting gives no range for this week, next week still known', () => {
    const got = sendWeekRanges('2026-10-19', 0, undefined);
    assertEq(got.thisWeek, null, 'this week');
    assertEq(got.nextWeek, { first: '2026-10-25', last: '2026-10-31' }, 'next week');
  });

  await check('Monday 19 Oct 2026, Sunday-start weeks: this week 19-24, next week 25-31', () => {
    assertEq(sendWeekRanges('2026-10-19', 0, false), { thisWeek: { first: '2026-10-19', last: '2026-10-24' }, nextWeek: { first: '2026-10-25', last: '2026-10-31' } }, 'ranges');
  });

  await check('formatDateSpan: same month, across months, one day; en, he, ru', () => {
    // Intl's range joiner carries thin spaces that vary with the ICU version: compare with the spaces around the dash folded out.
    const norm = (s: string) => s.replace(/\s*[–-]\s*/g, '–').replace(/\s+/g, ' ');
    assertEq(norm(formatDateSpan('2026-10-19', '2026-10-24', 'en')), '19–24 Oct', 'en same month');
    assertEq(norm(formatDateSpan('2026-10-31', '2026-11-06', 'en')), '31 Oct–6 Nov', 'en across months');
    assertEq(norm(formatDateSpan('2026-10-24', '2026-10-24', 'en')), '24 Oct', 'en one day');
    assertEq(norm(formatDateSpan('2026-10-19', '2026-10-24', 'he')), '19–24 באוק׳', 'he same month');
    assertEq(norm(formatDateSpan('2026-10-31', '2026-11-06', 'he')), '31 באוק׳–6 בנוב׳', 'he across months');
    assertEq(norm(formatDateSpan('2026-10-24', '2026-10-24', 'he')), '24 באוק׳', 'he one day');
    assertEq(norm(formatDateSpan('2026-10-19', '2026-10-24', 'ru')), '19–24 окт.', 'ru same month');
    assertEq(norm(formatDateSpan('2026-10-31', '2026-11-06', 'ru')), '31 окт.–6 нояб.', 'ru across months');
    assertEq(norm(formatDateSpan('2026-10-24', '2026-10-24', 'ru')), '24 окт.', 'ru one day');
    assertEq(formatDateSpan('nope', '2026-10-24', 'en'), '', 'a bad key');
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
    if (!r.ok) failed++;
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
