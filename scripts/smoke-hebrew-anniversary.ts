// Smoke test for the Hebrew anniversary count (docs/superpowers/specs/2026-10-25-hebrew-anniversary-count-design.md).
// Pure: no DB, no network. Parts are added as the count reaches each surface.
//   TZ=UTC npx tsx scripts/smoke-hebrew-anniversary.ts

import { HDate, months } from '@hebcal/hdate';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { hebrewCandidates } from '../src/services/native-calendar/recurrence';
import { anniversaryCount, anniversaryOf } from '../src/lib/hebrew-anniversary';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const civil = (h: HDate) => {
  const g = h.greg();
  return `${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, '0')}-${String(g.getDate()).padStart(2, '0')}`;
};

async function main() {
  await check('count: Hebrew years apart, not civil years: a Tishrei anchor is a year on after the new year (Rosh Hashana)', () => {
    // 1 Tishrei 5786 is 2025-09-23; the day before is still 5785.
    assert(anniversaryCount('2025-09-22', '2025-09-23') === 1, 'across Rosh Hashana');
    assert(anniversaryCount('2025-09-23', '2025-09-23') === null, 'same day is N=0');
    assert(anniversaryCount('1990-05-01', '2026-05-01') === 36, 'a civil span of 36 years');
  });

  await check('count: N = 0 (the first occurrence) is hidden, null', () => {
    assert(anniversaryCount('2020-03-10', '2020-03-10') === null, 'the anchor itself');
    assert(anniversaryCount('2020-03-10', '2020-09-01') === null, 'same Hebrew year');
  });

  await check('count: an anchor in a future year shows nothing, never a negative number', () => {
    assert(anniversaryCount('2030-03-10', '2026-03-10') === null, 'future anchor');
  });

  await check('count: leap years and Adar: a 5784 (leap) Adar I and Adar II anchor, and the day-30 roll to 1 Nisan in a one-Adar year', () => {
    // 5784 is a leap year (Adar I and Adar II). 30 Adar I 5784 -> hebcal's rule puts it on 1 Nisan in 5785 (one Adar).
    const adarI30 = civil(new HDate(30, months.ADAR_I, 5784));
    const nisan1 = civil(new HDate(1, months.NISAN, 5785));
    assert(anniversaryCount(adarI30, nisan1) === 1, `rolled day ${adarI30} -> ${nisan1}`);
    // 14 Adar II 5784 anchor: 5785 (one Adar) it falls on 14 Adar; 5787 (leap) on 14 Adar II.
    const adarII14 = civil(new HDate(14, months.ADAR_II, 5784));
    assert(anniversaryCount(adarII14, civil(new HDate(14, months.ADAR_II, 5787))) === 3, 'leap to leap');
    assert(anniversaryCount(adarII14, civil(new HDate(14, months.ADAR_I, 5785))) === 1, 'a one-Adar year (hebcal numbers its only Adar ADAR_I)');
    // 30 Cheshvan rolled to 1 Kislev stays in its own year.
    const cheshvan30 = civil(new HDate(30, months.CHESHVAN, 5784));
    assert(anniversaryCount(cheshvan30, civil(new HDate(1, months.KISLEV, 5786))) === 2, 'Kislev 1');
  });

  await check('count follows the real expander: 30 Adar I 5784 lands on 1 Nisan 5785 (N=1) and the next leap year on 30 Adar I again', () => {
    const adarI30 = civil(new HDate(30, months.ADAR_I, 5784));
    const startsAt = fromZonedTime(`${adarI30} 00:00`, 'Asia/Jerusalem');
    const series = { startsAt, timeZone: 'Asia/Jerusalem', rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary' as const, hebrewAnchor: adarI30 };
    const slots = hebrewCandidates(series, { from: startsAt, to: fromZonedTime('2031-01-01 00:00', 'Asia/Jerusalem') });
    const days = slots.map((d) => formatInTimeZone(d, 'Asia/Jerusalem', 'yyyy-MM-dd'));
    const counts = days.map((d) => anniversaryCount(adarI30, d));
    assert(days[0] === adarI30 && counts[0] === null, `first ${days[0]} ${counts[0]}`);
    assert(days[1] === civil(new HDate(1, months.NISAN, 5785)) && counts[1] === 1, `5785 ${days[1]} ${counts[1]}`);
    assert(counts.slice(0, 6).every((n, i) => (i === 0 ? n === null : n === i)), `sequence ${counts}`);
  });

  await check('count: a bad anchor or day gives null', () => {
    assert(anniversaryCount(null, '2026-01-01') === null && anniversaryCount('nope', '2026-01-01') === null && anniversaryCount('2020-01-01', 'x') === null, 'bad input');
  });

  await check('anniversaryOf: only an anniversary series with an anchor counts; the day is the instant\'s civil day in the zone', () => {
    const anchor = '2020-03-10';
    // 2026-03-09 22:30 UTC is already 2026-03-10 in Jerusalem.
    assert(anniversaryOf({ hebrewRule: 'anniversary', hebrewAnchor: anchor }, '2026-03-09T22:30:00Z', 'Asia/Jerusalem') !== null, 'timed instant');
    assert(anniversaryOf({ hebrewRule: 'anniversary', hebrewAnchor: anchor }, '2026-03-10', 'Asia/Jerusalem') === anniversaryOf({ hebrewRule: 'anniversary', hebrewAnchor: anchor }, '2026-03-09T22:30:00Z', 'Asia/Jerusalem'), 'all-day date equals the instant');
    assert(anniversaryOf({ hebrewRule: null, hebrewAnchor: anchor }, '2026-03-10', 'UTC') === null, 'no rule');
    assert(anniversaryOf({ hebrewRule: 'anniversary', hebrewAnchor: null }, '2026-03-10', 'UTC') === null, 'no anchor');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` - ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
