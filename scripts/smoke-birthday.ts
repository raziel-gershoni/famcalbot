// Smoke test for the Birthday switch (docs/superpowers/specs/2026-11-25-birthday-switch-design.md): the rule of what can
// be a birthday and the year a civil birthday counts from (src/lib/birthday.ts). The store, the readers, the editor and
// the screen are pinned where they are tested (smoke-calendar-editor-api, smoke-hebrew-anniversary). Pure: no DB, no network.
//   TZ=UTC npx tsx scripts/smoke-birthday.ts

import { birthYearOf, canBeBirthday, isEveryYearRule } from '../src/lib/birthday';

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

const show = (value: unknown) => JSON.stringify(value);
function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

async function main() {
  await check('isEveryYearRule: FREQ=YEARLY with no interval or interval 1, an end allowed; any other rule, or none, is not', () => {
    const cases: [string | null, boolean][] = [
      ['FREQ=YEARLY', true],
      ['FREQ=YEARLY;INTERVAL=1', true],
      ['RRULE:FREQ=YEARLY', true],
      ['FREQ=YEARLY;UNTIL=20300101T000000Z', true],
      ['FREQ=YEARLY;COUNT=5', true],
      ['FREQ=YEARLY;INTERVAL=2', false],
      ['FREQ=WEEKLY', false],
      ['FREQ=MONTHLY;INTERVAL=12', false],
      ['', false],
      [null, false],
    ];
    assertSame(cases.map(([rule]) => isEveryYearRule(rule)), cases.map(([, want]) => want), 'rules');
  });

  await check('canBeBirthday: an all-day EVENT repeating every year; not a reminder, a timed event, a one-off or another repeat', () => {
    const base = { kind: 'EVENT', allDay: true, rrule: 'FREQ=YEARLY' };
    assertSame(
      [
        canBeBirthday(base),
        canBeBirthday({ ...base, kind: 'REMINDER' }),
        canBeBirthday({ ...base, allDay: false }),
        canBeBirthday({ ...base, rrule: null }),
        canBeBirthday({ ...base, rrule: 'FREQ=DAILY' }),
        canBeBirthday({ ...base, rrule: 'FREQ=YEARLY;INTERVAL=3' }),
      ],
      [true, false, false, false, false, false],
      'shapes'
    );
  });

  await check('birthYearOf: the stored year when there is one, else the start\'s civil year in the series\' own zone (not the server\'s)', () => {
    // 3 March 1985 00:00 in Jerusalem is 2 March 22:00 UTC: the year is read where the series lives.
    const startsAt = new Date('1985-03-02T22:00:00Z');
    assertSame(birthYearOf({ birthYear: null, startsAt, timeZone: 'Asia/Jerusalem' }), 1985, 'from the start');
    // 1 January 2000 00:00 in Jerusalem is still 1999 in UTC.
    assertSame(birthYearOf({ birthYear: null, startsAt: new Date('1999-12-31T22:00:00Z'), timeZone: 'Asia/Jerusalem' }), 2000, 'a new year in the zone');
    assertSame(birthYearOf({ birthYear: 1972, startsAt, timeZone: 'Asia/Jerusalem' }), 1972, 'the stored year wins');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
