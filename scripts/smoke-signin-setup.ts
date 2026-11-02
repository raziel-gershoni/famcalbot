// Smoke test for web sign-in's setup: the startup warnings and the docs (spec 2026-11-02-web-sign-in §6; plan Task 11b).
//
//  - S1 signInSetupWarnings (src/lib/startup-checks.ts) names each web sign-in way that is off by its variables, and a
//    Google sign-in client that is the calendar's, and never a value; SIGN_IN_ENV holds the five variables the sign-in
//    code reads (Task 4's oidc.ts, Task 5's email-send.ts), and every secret among them matches the console
//    scrubber's name pattern (CLAUDE.md: name a new secret to match, or its value is printed). That register() logs
//    them is smoke-fail-closed #8b.
//  - S2 the docs: the README's env table has a row for each of the five, and a Web sign-in section with both callback
//    URLs; .env.example has a commented placeholder for each (a copied placeholder must never become a real value);
//    CLAUDE.md has the sign-in rule; and only the files that rule names touch SignInIdentity rows.
//
// Real: src/lib/startup-checks.ts and the files read as text. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/6b/run-smoke.sh smoke-signin-setup

import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

const FIVE = ['TELEGRAM_LOGIN_CLIENT_ID', 'TELEGRAM_LOGIN_CLIENT_SECRET', 'GOOGLE_SIGNIN_CLIENT_ID', 'GOOGLE_SIGNIN_CLIENT_SECRET', 'RESEND_API_KEY'];
const ALL_OFF = [
  'web sign-in with Telegram is off: TELEGRAM_LOGIN_CLIENT_ID and TELEGRAM_LOGIN_CLIENT_SECRET are not set',
  'web sign-in with Google is off: GOOGLE_SIGNIN_CLIENT_ID and GOOGLE_SIGNIN_CLIENT_SECRET are not set',
  'web sign-in with an email code is off: RESEND_API_KEY is not set',
];

/** The files the CLAUDE.md rule lets read or write SignInIdentity rows. */
const SIGNIN_IDENTITY_FILES = ['src/services/web-signin/identities.ts', 'src/services/account-linking.ts'];

async function main() {
  await check('S1 signInSetupWarnings names each way that is off by its variables, and a Google sign-in client that is the calendar\'s; never a value; SIGN_IN_ENV is the five variables the sign-in code reads, and its secrets match the console scrubber', async () => {
    const mod = (await import(path.join(ROOT, 'src/lib/startup-checks.ts'))) as Row;
    assert(typeof mod.signInSetupWarnings === 'function', 'startup-checks exports no signInSetupWarnings');
    const names = (mod.SIGN_IN_ENV as { way: string; names: string[] }[]).flatMap((w) => w.names);
    assert(show(names) === show(FIVE), `SIGN_IN_ENV names ${show(names)}`);
    const all = { TELEGRAM_LOGIN_CLIENT_ID: '8000000001', TELEGRAM_LOGIN_CLIENT_SECRET: 'VALUE-TGL-1', GOOGLE_SIGNIN_CLIENT_ID: 'VALUE-GSI-id', GOOGLE_SIGNIN_CLIENT_SECRET: 'VALUE-GSI-2', RESEND_API_KEY: 'VALUE-RES-3', GOOGLE_CLIENT_ID: 'VALUE-CAL-id' };
    const cases: [string, Record<string, string | undefined>, string[]][] = [
      ['all set', all, []],
      ['none set', {}, ALL_OFF],
      ['all empty', Object.fromEntries(FIVE.map((n) => [n, ''])), ALL_OFF],
      ['only the Telegram secret missing', { ...all, TELEGRAM_LOGIN_CLIENT_SECRET: undefined }, ['web sign-in with Telegram is off: TELEGRAM_LOGIN_CLIENT_SECRET is not set']],
      ['Google sign-in on the calendar client', { ...all, GOOGLE_CLIENT_ID: 'VALUE-GSI-id' }, ['web sign-in with Google is off: GOOGLE_SIGNIN_CLIENT_ID is the calendar client GOOGLE_CLIENT_ID; give sign-in its own Web client']],
    ];
    const problems: string[] = [];
    for (const [label, env, want] of cases) {
      const got = mod.signInSetupWarnings(env);
      if (show(got) !== show(want)) problems.push(`${label}: ${show(got)}`);
      if (/VALUE-|8000000001/.test(show(got))) problems.push(`${label}: a value in ${show(got)}`);
    }
    // One rule, two readers: the warning and oidc.ts's refusal both decide through client-ids.ts
    const ids = (await import(path.join(ROOT, 'src/services/web-signin/client-ids.ts'))) as Row;
    const rule: [string | undefined, string | undefined, boolean][] = [['a', 'a', true], ['a', 'b', false], ['a', undefined, false], [undefined, undefined, false], ['', '', false]];
    for (const [signIn, calendar, want] of rule) if (ids.googleSignInUsesCalendarClient(signIn, calendar) !== want) problems.push(`client-ids: ${show([signIn, calendar])} is not ${want}`);
    if (!/googleSignInUsesCalendarClient\(/.test(read('src/services/web-signin/oidc.ts'))) problems.push('oidc.ts does not decide through client-ids.ts');
    if (!/googleSignInUsesCalendarClient\(/.test(read('src/lib/startup-checks.ts'))) problems.push('startup-checks.ts does not decide through client-ids.ts');
    // The names the sign-in code reads: a renamed variable here would warn about one nobody reads
    const code = read('src/services/web-signin/oidc.ts') + read('src/services/web-signin/email-send.ts');
    for (const name of FIVE) if (!code.includes(`process.env.${name}`)) problems.push(`the sign-in code never reads process.env.${name}`);
    const pattern = /const SECRET_NAME = \/(.+)\/i;/.exec(read('src/lib/console-scrub.ts'))?.[1];
    assert(pattern, 'no SECRET_NAME in src/lib/console-scrub.ts');
    for (const name of FIVE.filter((n) => !n.endsWith('_CLIENT_ID'))) if (!new RegExp(pattern, 'i').test(name)) problems.push(`${name} does not match the console scrubber's SECRET_NAME`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('S2 the README\'s env table has a row for each of the five and a Web sign-in section with both callbacks; .env.example a commented placeholder for each; CLAUDE.md the sign-in rule; only the files the rule names touch SignInIdentity', () => {
    const readme = read('README.md');
    const example = read('.env.example').split('\n');
    const problems: string[] = [];
    for (const name of FIVE) {
      if (!new RegExp(`^\\|[^\\n]*\`${name}\``, 'm').test(readme)) problems.push(`README's table has no ${name} row`);
      const line = example.find((l) => l.startsWith(`# ${name}=`));
      if (!line || !/^# [A-Z_]+=your_[a-z_]+_here$/.test(line)) problems.push(`.env.example has no commented placeholder for ${name}`);
      if (example.some((l) => l.startsWith(`${name}=`))) problems.push(`.env.example sets ${name} uncommented`);
    }
    if (!/^### Web sign-in$/m.test(readme)) problems.push('README has no "### Web sign-in" section');
    for (const url of ['https://famcal.bot/api/auth/telegram/callback', 'https://famcal.bot/api/auth/google/callback']) if (!readme.includes(url)) problems.push(`README does not name ${url}`);
    const rule = read('CLAUDE.md').split('\n').find((l) => l.startsWith('- Every web sign-in'));
    if (!rule) problems.push('CLAUDE.md has no "- Every web sign-in" rule');
    else for (const word of ['`finishSignIn`', ...SIGNIN_IDENTITY_FILES.map((f) => path.basename(f)), 'sessionsValidAfter', '`matchCalendarAccount`', '(never `sub`)']) if (!rule.includes(word)) problems.push(`the CLAUDE.md rule does not name ${word}`);
    // The rule's file list, held: no other file reads or writes SignInIdentity rows
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(rel);
        return /\.tsx?$/.test(e.name) ? [rel] : [];
      });
    const touching = ['src', 'app', 'components'].flatMap(walk).filter((rel) => /\.signInIdentity\b/.test(read(rel)));
    const stray = touching.filter((rel) => !SIGNIN_IDENTITY_FILES.includes(rel));
    if (stray.length > 0) problems.push(`SignInIdentity rows touched outside the rule's files: ${show(stray)}`);
    if (!touching.includes(SIGNIN_IDENTITY_FILES[0])) problems.push(`identities.ts touches no SignInIdentity row (the walk found ${show(touching)})`);
    assert(problems.length === 0, problems.join('; '));
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
