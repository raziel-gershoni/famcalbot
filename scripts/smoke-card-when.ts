// Smoke test for an event's date and time on its confirm card, one formatter for the bot and the site (site review M5:
// the hero's picture of the card can't drift from the bot's): src/lib/event-card-when.ts.
//
//  - K1 the bot's card lines are byte for byte what they were before the formatter moved: formatEventDateTime on fixed
//    events (en, he, ru and an unknown language; Israel and New York; past midnight; all day; a weekly repeat), checked
//    against the strings the old code wrote.
//  - K2 the site's picture of the card draws with the same formatter: HeroDemo imports eventCardWhen and formats no
//    date or time of its own, and the bot's lines for the sample dentist are the picture's lines.
//
// Nothing is faked but @hebcal/core's resolution (ESM only: require() is pointed at its ESM file). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-card-when.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ModuleInternals = Module as unknown as { _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string };
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};

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
const show = (v: unknown) => JSON.stringify(v);

const CASES: [string, string, string, Record<string, unknown>][] = [
  ['2026-11-05T14:00:00Z', '2026-11-05T15:00:00Z', 'Asia/Jerusalem', {}],
  ['2026-11-01T05:30:00Z', '2026-11-01T07:15:00Z', 'America/New_York', {}],
  ['2026-03-27T21:30:00Z', '2026-03-28T00:30:00Z', 'Asia/Jerusalem', {}],
  ['2026-12-31T22:00:00Z', '2027-01-01T22:00:00Z', 'Asia/Jerusalem', { allDay: true }],
  ['2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z', 'Asia/Jerusalem', { recurrence: { frequency: 'weekly', daysOfWeek: ['TU'] } }],
];
/** What formatEventDateTime wrote before its date and time moved to event-card-when.ts (07c13206), case by case. */
const BEFORE: Record<string, string[]> = {
  en: ['📆 Thursday, November 5\n🕐 16:00 - 17:00', '📆 Sunday, November 1\n🕐 01:30 - 02:15', '📆 Saturday, March 28\n🕐 00:30 - 03:30', '📆 Friday, January 1 (ALLDAY)', '📆 Tuesday, November 3\n🕐 17:00 - 18:00\n🔄 Weekly (Tue)'],
  he: ['📆 יום חמישי, 5 בנובמבר\n🕐 16:00 - 17:00', '📆 יום ראשון, 1 בנובמבר\n🕐 01:30 - 02:15', '📆 יום שבת, 28 במרץ\n🕐 00:30 - 03:30', '📆 יום שישי, 1 בינואר (ALLDAY)', '📆 יום שלישי, 3 בנובמבר\n🕐 17:00 - 18:00\n🔄 שבועי (שלישי)'],
  ru: ['📆 четверг, 5 ноября\n🕐 16:00 - 17:00', '📆 воскресенье, 1 ноября\n🕐 01:30 - 02:15', '📆 суббота, 28 марта\n🕐 00:30 - 03:30', '📆 пятница, 1 января (ALLDAY)', '📆 вторник, 3 ноября\n🕐 17:00 - 18:00\n🔄 Еженедельно (Вт)'],
  fr: ['📆 Thursday, November 5\n🕐 16:00 - 17:00', '📆 Sunday, November 1\n🕐 01:30 - 02:15', '📆 Saturday, March 28\n🕐 00:30 - 03:30', '📆 Friday, January 1 (ALLDAY)', '📆 Tuesday, November 3\n🕐 17:00 - 18:00\n🔄 Weekly (Tue)'],
};

async function main() {
  const { formatEventDateTime } = await import('../src/services/voice/confirmations');
  const { eventCardWhen } = await import('../src/lib/event-card-when');
  const event = (start: string, end: string, extra: Record<string, unknown>) => ({ title: 'X', startTime: new Date(start), endTime: new Date(end), ...extra }) as never;

  await check('K1 the bot\'s card lines byte for byte as before the move: en, he, ru and an unknown language; Israel and New York; past midnight; all day; a weekly repeat', () => {
    const wrong: string[] = [];
    for (const [lang, want] of Object.entries(BEFORE)) {
      CASES.forEach(([start, end, tz, extra], i) => {
        const got = formatEventDateTime(event(start, end, extra), lang, 'ALLDAY', tz);
        if (got !== want[i]) wrong.push(`${lang} #${i}: ${show(got)}, was ${show(want[i])}`);
      });
    }
    assert(wrong.length === 0, wrong.join('\n'));
  });

  await check('K2 the hero\'s picture of the card draws with the bot\'s formatter: HeroDemo imports eventCardWhen and formats no date or time itself; the sample dentist\'s lines are the bot\'s', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/site/HeroDemo.tsx'), 'utf8');
    assert(/import \{ eventCardWhen \} from '@\/src\/lib\/event-card-when';/.test(src) && /eventCardWhen\(/.test(src), 'HeroDemo does not use eventCardWhen');
    assert(!/toLocale(?:Date|Time)?String|Intl\.DateTimeFormat/.test(src), 'HeroDemo formats a date or a time of its own');
    for (const lang of ['en', 'he', 'ru']) {
      const start = '2026-11-05T14:00:00Z';
      const end = '2026-11-05T15:00:00Z';
      const when = eventCardWhen(new Date(start), new Date(end), lang, 'Asia/Jerusalem');
      assert(formatEventDateTime(event(start, end, {}), lang, 'ALLDAY', 'Asia/Jerusalem') === `📆 ${when.date}\n🕐 ${when.time}`, `${lang}: the picture's lines ${show(when)}`);
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
