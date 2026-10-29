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
//  - N4 the bot's copy that states the trial (the /terms reply) says TRIAL_DURATION_DAYS, and the trial's end notice
//    lists the Free plan's limits, in each language (the final review's M-6).
//  - N5 the refund window is one constant, REFUND_WINDOW_DAYS (src/lib/refund-eligibility.ts): every text that states it
//    (the Terms' cancelling paragraph, the bot's ways to cancel, the plan screen's line, the Stars invoice) says that
//    number, and no code counts 14 days of its own.
//
// Nothing is faked: the messages, the plan table and the refund rule only. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-terms-plans.ts

import fs from 'node:fs';
import path from 'node:path';
import { PLAN_CONFIGS, TRIAL_DURATION_DAYS, type PlanId } from '../src/config/plans';
import { REFUND_WINDOW_DAYS } from '../src/lib/refund-eligibility';

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

check('N4 the bot\'s copy that states the trial says the plan table\'s length (the /terms reply), and the trial\'s end notice lists the Free plan\'s limits, in en, he and ru', () => {
  const TRIAL: Record<Locale, RegExp> = { en: /gets (\d+) days of Pro/, he: /מקבל (\d+) יום של Pro/, ru: /получает (\d+) дн\S* Pro/ };
  for (const locale of LOCALES) {
    const terms = messages[locale].bot.support.terms as string;
    const said = TRIAL[locale].exec(terms);
    assert(said && Number(said[1]) === TRIAL_DURATION_DAYS, `${locale}: /terms says ${said?.[1] ?? 'no trial length'}, the table ${TRIAL_DURATION_DAYS} days`);
    const ended = messages[locale].bot.subscription.trialExpired.message as string;
    const { textSummaries, voiceSummaries, calendars } = PLAN_CONFIGS.FREE.limits;
    assert(show(numbers(ended)) === show([textSummaries, voiceSummaries, calendars]), `${locale}: the trial's end notice says ${show(numbers(ended))}, Free is ${show([textSummaries, voiceSummaries, calendars])}`);
  }
});

check('N5 the refund window is REFUND_WINDOW_DAYS everywhere it is stated (the Terms\' cancelling paragraph, the bot\'s ways to cancel, the plan screen, the invoice), in en, he and ru; no code counts 14 days of its own', () => {
  const WITHIN: Record<Locale, RegExp> = { en: /within (\d+) days/g, he: /תוך (\d+) יום/g, ru: /в\s+течение (\d+) дн/g };
  for (const locale of LOCALES) {
    const m = messages[locale];
    const blocks = m.legal.terms.sections.plans.blocks as unknown[];
    const cancelAt = blocks.findIndex((b) => b !== null && typeof b === 'object' && !Array.isArray(b) && (b as Row).id === 'cancel');
    const cancelling = (blocks[cancelAt + 1] as unknown[])[0] as string;
    const texts: [string, string][] = [
      ['legal.terms (cancelling)', cancelling],
      ['bot.policy.cancel', m.bot.policy.cancel],
      ['subscription.screen.refund', m.subscription.screen.refund],
      ['subscription.invoiceDescription', m.subscription.invoiceDescription],
    ];
    for (const [key, text] of texts) {
      const said = [...text.matchAll(WITHIN[locale])].map((x) => Number(x[1]));
      assert(said.length === 1 && said[0] === REFUND_WINDOW_DAYS, `${locale} ${key}: says ${show(said)}, the rule ${REFUND_WINDOW_DAYS} days: ${text}`);
    }
  }
  const SRC = path.join(ROOT, 'src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const own = walk(SRC).filter((file) => /refund/i.test(fs.readFileSync(file, 'utf8')) && /\b14\s*\*|\b14 \* (?:24|DAY)|\b1_?209_?600\b/.test(fs.readFileSync(file, 'utf8').replace(/^\s*(?:\/\/|\*).*$/gm, '')));
  assert(own.length === 0, `code that counts 14 days of its own beside a refund: ${show(own.map((f) => path.relative(ROOT, f)))}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
