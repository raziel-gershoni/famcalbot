// Smoke test for the plan's status line, shared by the Subscription screen and Settings' "Plan" row (spec
// docs/superpowers/specs/2026-11-24-menu-revamp-design.md §5; plan 2026-11-24-menu-revamp Task 2), src/lib/plan-glance.ts:
//  - G1 planStatusOf, the Subscription screen's own rule in its order: an early adopter is early access (whatever the plan),
//    a trial is its days, a paid plan with a period end is "active until", a paid plan with no period end and Free are nothing;
//  - G2 planStatusWords gives the three phrases from the words it is handed, formats the date as the Subscription screen
//    always did (day numeric, month long, year numeric, in the page's language) and gives null for no status;
//  - G3 the Subscription screen calls the helper and no longer holds its own early-access / trial / active-until ternary.
//
// No network, no database. Run with the fake env, from the repo root:
//   bash <scratchpad>/repro/run-env.sh npx tsx scripts/smoke-plan-glance.ts

import fs from 'node:fs';
import path from 'node:path';
import { planStatusOf, type PlanStatus } from '../src/lib/plan-glance';
import { planStatusWords } from '../src/lib/plan-status-words';

const ROOT = path.resolve(__dirname, '..');

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
const show = (value: unknown) => JSON.stringify(value);

const PERIOD_END = '2026-12-12T00:00:00Z';
const base = { plan: 'FREE' as const, currentPeriodEnd: null as string | null, isEarlyAdopter: false, isTrialing: false, trialDaysRemaining: 0 };

check('G1 planStatusOf: early access first, then the trial, then active until for a paid plan with a period end; else nothing', () => {
  const rows: [string, Parameters<typeof planStatusOf>[0], PlanStatus][] = [
    ['an early adopter on PRO with a period end', { ...base, plan: 'PRO', currentPeriodEnd: PERIOD_END, isEarlyAdopter: true }, { kind: 'earlyAccess' }],
    ['an early adopter on FREE', { ...base, isEarlyAdopter: true }, { kind: 'earlyAccess' }],
    ['an early adopter who is also trialing', { ...base, plan: 'PRO', isEarlyAdopter: true, isTrialing: true, trialDaysRemaining: 3 }, { kind: 'earlyAccess' }],
    ['trialing with 5 days', { ...base, plan: 'PRO', isTrialing: true, trialDaysRemaining: 5 }, { kind: 'trial', days: 5 }],
    ['trialing beats a period end', { ...base, plan: 'PRO', currentPeriodEnd: PERIOD_END, isTrialing: true, trialDaysRemaining: 2 }, { kind: 'trial', days: 2 }],
    ['PRO with a period end', { ...base, plan: 'PRO', currentPeriodEnd: PERIOD_END }, { kind: 'activeUntil', date: PERIOD_END }],
    ['BASIC with a period end', { ...base, plan: 'BASIC', currentPeriodEnd: PERIOD_END }, { kind: 'activeUntil', date: PERIOD_END }],
    ['PRO with no period end (a gift)', { ...base, plan: 'PRO' }, null],
    ['FREE', { ...base }, null],
    ['FREE with a stale period end', { ...base, currentPeriodEnd: PERIOD_END }, null],
  ];
  for (const [name, input, want] of rows) assert(show(planStatusOf(input)) === show(want), `${name}: ${show(planStatusOf(input))} (want ${show(want)})`);
});

check('G2 planStatusWords: the three phrases from the words it is given, the date as the Subscription screen formats it, null for none', () => {
  const words = { earlyAccess: () => 'EARLY', trial: (days: number) => `TRIAL ${days}`, activeUntil: (date: string) => `UNTIL ${date}` };
  assert(planStatusWords({ kind: 'earlyAccess' }, words, 'en') === 'EARLY', 'early access');
  assert(planStatusWords({ kind: 'trial', days: 5 }, words, 'en') === 'TRIAL 5', 'trial');
  assert(planStatusWords(null, words, 'en') === null, 'no status');
  const expected = new Date('2026-12-12T12:00:00Z');
  for (const [locale, tag] of [['en', 'en-US'], ['he', 'he-IL'], ['ru', 'ru-RU'], ['xx', 'en-US']] as const) {
    const want = `UNTIL ${expected.toLocaleDateString(tag, { day: 'numeric', month: 'long', year: 'numeric' })}`;
    const got = planStatusWords({ kind: 'activeUntil', date: '2026-12-12T12:00:00Z' }, words, locale);
    assert(got === want, `${locale}: ${got} (want ${want})`);
  }
});

check('G3 the Subscription screen reads the helper and holds no status ternary of its own', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/subscription/SubscriptionClient.tsx'), 'utf8');
  assert(/planStatusOf\(/.test(source) && /planStatusWords\(/.test(source), 'SubscriptionClient does not call the helper');
  assert(!/isEarlyAdopter\s*\n?\s*\?\s*t\('earlyAccessNote'\)/.test(source), 'the early-access ternary is still in SubscriptionClient');
  assert(!source.includes("toLocaleDateString(DATE_LOCALES"), 'SubscriptionClient still formats the period end itself');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
