// Smoke test: the Terms of Use's plan numbers agree with the plan table (the legal texts' report, concern 2). The Terms
// are binding, owner-approved wording that changes only by hand, with a new LEGAL_UPDATED (src/site/legal.ts); they
// never interpolate the numbers. So a change to src/config/plans.ts that the Terms don't follow fails here, in each
// language:
//
//  - N1 the trial: the Trial paragraph's only number is TRIAL_DURATION_DAYS.
//  - N2 each plan's numbers (Free, Basic, Pro, in that order): its lines hold exactly the limits that aren't unlimited,
//    text then voice summaries then calendars (an unlimited one is words, never a number).
//  - N3 each plan's features: its last three lines are reminders, adding events (voice, photo, PDF, a forward) and Copy
//    to Google, each one "no ..." exactly when the plan table leaves it off.
//
// Nothing is faked: the messages and the plan table only. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-terms-plans.ts

import fs from 'node:fs';
import path from 'node:path';
import { PLAN_CONFIGS, TRIAL_DURATION_DAYS, type PlanId } from '../src/config/plans';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Locale = 'en' | 'he' | 'ru';
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const ROOT = path.resolve(__dirname, '..');
const messages: Record<Locale, Row> = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);
const numbers = (text: string) => (text.match(/\d+/g) ?? []).map(Number);

const ORDER: PlanId[] = ['FREE', 'BASIC', 'PRO'];
/** A feature line the plan leaves off starts with the language's "no". */
const OFF: Record<Locale, RegExp> = { en: /^no\b/i, he: /^בלי\b|^בלי /, ru: /^без\b|^без /i };
const FLAGS = ['reminders', 'voiceEvents', 'googleSync'] as const;

/** The Terms' "Plans and payment" blocks in a language: the Trial paragraph and the plan list (an item per plan). */
function termsPlans(locale: Locale): { trial: string; plans: { text: string; items: string[] }[] } {
  const blocks = messages[locale].legal.terms.sections.plans.blocks as unknown[];
  const titleAt = (n: number) => blocks.findIndex((b, i) => i >= n && b !== null && typeof b === 'object' && !Array.isArray(b) && 'title' in (b as Row));
  const trialTitle = titleAt(0);
  const trial = blocks[trialTitle + 1];
  const list = blocks.find((b) => Array.isArray(b) && b.length === ORDER.length && b.every((i) => i && typeof i === 'object' && Array.isArray((i as Row).items)));
  assert(typeof trial === 'string', `${locale}: no Trial paragraph after the first sub-heading`);
  assert(Array.isArray(list), `${locale}: no list of the three plans`);
  return { trial, plans: list as { text: string; items: string[] }[] };
}

check('N1 the Terms\' trial is the plan table\'s, in en, he and ru', () => {
  for (const locale of LOCALES) {
    const { trial } = termsPlans(locale);
    assert(show(numbers(trial)) === show([TRIAL_DURATION_DAYS]), `${locale}: the Trial paragraph says ${show(numbers(trial))}, the table ${TRIAL_DURATION_DAYS} days: ${trial}`);
  }
});

check('N2 each plan\'s numbers in the Terms are the plan table\'s limits that aren\'t unlimited (text, voice, calendars), in en, he and ru', () => {
  for (const locale of LOCALES) {
    const { plans } = termsPlans(locale);
    ORDER.forEach((id, i) => {
      const { textSummaries, voiceSummaries, calendars } = PLAN_CONFIGS[id].limits;
      const want = [textSummaries, voiceSummaries, calendars].filter(Number.isFinite);
      const got = plans[i].items.flatMap(numbers);
      assert(show(got) === show(want), `${locale} ${id}: the Terms say ${show(got)}, the table ${show(want)}: ${show(plans[i].items)}`);
    });
  }
});

check('N3 each plan\'s features in the Terms (reminders, adding events, Copy to Google) are on or off as the plan table has them, in en, he and ru', () => {
  for (const locale of LOCALES) {
    const { plans } = termsPlans(locale);
    ORDER.forEach((id, i) => {
      const lines = plans[i].items.slice(-FLAGS.length);
      FLAGS.forEach((flag, j) => {
        const off = OFF[locale].test(lines[j].trim());
        assert(off === !PLAN_CONFIGS[id].limits[flag], `${locale} ${id}: "${lines[j]}" for ${flag}, the table has it ${PLAN_CONFIGS[id].limits[flag] ? 'on' : 'off'}`);
      });
    });
  }
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
