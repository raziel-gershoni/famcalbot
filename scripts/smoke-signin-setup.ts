// Smoke test for web sign-in's setup: the startup warnings and the docs (spec 2026-11-02-web-sign-in §6; plan Task 11b;
// 6c-1 Task 3 adds sign-up's two Turnstile variables, spec 2026-11-03-web-sign-up §6).
//
//  - S1 signInSetupWarnings (src/lib/startup-checks.ts) names each web sign-in way that is off by its variables (and email
//    sign-up without its Turnstile pair, Google sign-up without Resend), and a Google sign-in client that is the
//    calendar's, and never a value;
//    SIGN_IN_ENV holds the seven variables the sign-in code reads (oidc.ts, email-send.ts, turnstile.ts), and every
//    secret among them matches the console scrubber's name pattern (CLAUDE.md: name a new secret to match, or its value
//    is printed). That register() logs them is smoke-fail-closed #8b.
//  - S2 the docs: the README's env table has a row for each of the seven, and a Web sign-in section with both callback
//    URLs; .env.example has a commented placeholder for each (a copied placeholder must never become a real value);
//    CLAUDE.md has the sign-in rule; and only the files that rule names touch SignInIdentity rows.
//  - S3 web sign-up's rules (spec 2026-11-03-web-sign-up; plan Task 14): CLAUDE.md's sign-in rule names the one creation
//    step (createAccount, its smoke), the address check on a proved address (findWayByAddress), Join only after a proved
//    way (offerJoin, mergePlan) and Finish here (POST /api/oauth/claim); the pause rule names the web sign-up's sends
//    and the no-chat skip line; the README has a Web sign-up section with the Turnstile pair, and no longer says the
//    web makes no accounts.
//  - S4 browser notifications' setup (spec 2026-11-05-web-push §3.9; plan 6c-2 Task 1): pushSetupWarnings, PUSH_ENV, the
//    private key's name against the console scrubber, register()'s line, and the README and .env.example entries.
//
//  - S5 browser notifications' rules (spec 2026-11-05-web-push; plan 6c-2 Task 13): CLAUDE.md has the push rule, naming the
//    one sender, the one device file and its fence, the push-service hosts, the reach rule, the pause and the TTL, the
//    Sentry scrub, the four session writers and their smokes, and every file it names exists; the README has a
//    "Notifications in the browser" section with the key setup, the never-changed rule and the /sw.js check.
//
// Real: src/lib/startup-checks.ts and the files read as text. No network, no DB.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/6c1/run-smoke.sh smoke-signin-setup

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

/** The sign-in and sign-up variables (6b's five, 6c-1's Turnstile pair), in SIGN_IN_ENV's order. */
const NAMES = ['TELEGRAM_LOGIN_CLIENT_ID', 'TELEGRAM_LOGIN_CLIENT_SECRET', 'GOOGLE_SIGNIN_CLIENT_ID', 'GOOGLE_SIGNIN_CLIENT_SECRET', 'RESEND_API_KEY', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET'];
/** The ones that are no secret (a client id, the site key every page shows); the rest must match the console scrubber. */
const PUBLIC = ['TELEGRAM_LOGIN_CLIENT_ID', 'GOOGLE_SIGNIN_CLIENT_ID', 'TURNSTILE_SITE_KEY'];
const ALL_OFF = [
  'web sign-in with Telegram is off: TELEGRAM_LOGIN_CLIENT_ID and TELEGRAM_LOGIN_CLIENT_SECRET are not set',
  'web sign-in with Google is off: GOOGLE_SIGNIN_CLIENT_ID and GOOGLE_SIGNIN_CLIENT_SECRET are not set',
  'web sign-in with an email code is off: RESEND_API_KEY is not set',
  'web sign-up with an email code is off: TURNSTILE_SITE_KEY and TURNSTILE_SECRET are not set',
  'web sign-up with Google is off: RESEND_API_KEY is not set',
];

/** Browser notifications' two variables (6c-2), in PUSH_ENV's order. The public key is no secret: the page that turns notifications on reads it. */
const PUSH_NAMES = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];

/** The files the CLAUDE.md rule lets read or write SignInIdentity rows. */
const SIGNIN_IDENTITY_FILES = ['src/services/web-signin/identities.ts', 'src/services/account-linking.ts'];

async function main() {
  await check('S1 signInSetupWarnings names each way that is off by its variables (email sign-up without Turnstile too), and a Google sign-in client that is the calendar\'s; never a value; SIGN_IN_ENV is the seven variables the sign-in code reads, and its secrets match the console scrubber', async () => {
    const mod = (await import(path.join(ROOT, 'src/lib/startup-checks.ts'))) as Row;
    assert(typeof mod.signInSetupWarnings === 'function', 'startup-checks exports no signInSetupWarnings');
    // RESEND_API_KEY twice: email sign-in's own, and what Google sign-up waits for (signup-open.ts)
    const names = [...new Set((mod.SIGN_IN_ENV as { way: string; names: string[] }[]).flatMap((w) => w.names))];
    assert(show(names) === show(NAMES), `SIGN_IN_ENV names ${show(names)}`);
    const all = {
      TELEGRAM_LOGIN_CLIENT_ID: '8000000001', TELEGRAM_LOGIN_CLIENT_SECRET: 'VALUE-TGL-1', GOOGLE_SIGNIN_CLIENT_ID: 'VALUE-GSI-id', GOOGLE_SIGNIN_CLIENT_SECRET: 'VALUE-GSI-2',
      RESEND_API_KEY: 'VALUE-RES-3', TURNSTILE_SITE_KEY: 'VALUE-TSK-4', TURNSTILE_SECRET: 'VALUE-TSS-5', GOOGLE_CLIENT_ID: 'VALUE-CAL-id',
    };
    const cases: [string, Record<string, string | undefined>, string[]][] = [
      ['all set', all, []],
      ['none set', {}, ALL_OFF],
      ['all empty', Object.fromEntries(NAMES.map((n) => [n, ''])), ALL_OFF],
      ['only the Telegram secret missing', { ...all, TELEGRAM_LOGIN_CLIENT_SECRET: undefined }, ['web sign-in with Telegram is off: TELEGRAM_LOGIN_CLIENT_SECRET is not set']],
      ['only the Turnstile secret missing', { ...all, TURNSTILE_SECRET: undefined }, ['web sign-up with an email code is off: TURNSTILE_SECRET is not set']],
      ['only Resend missing', { ...all, RESEND_API_KEY: undefined }, ['web sign-in with an email code is off: RESEND_API_KEY is not set', 'web sign-up with Google is off: RESEND_API_KEY is not set']],
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
    const code = read('src/services/web-signin/oidc.ts') + read('src/services/web-signin/email-send.ts') + read('src/services/web-signin/turnstile.ts');
    for (const name of NAMES) if (!code.includes(`process.env.${name}`)) problems.push(`the sign-in code never reads process.env.${name}`);
    const pattern = /const SECRET_NAME = \/(.+)\/i;/.exec(read('src/lib/console-scrub.ts'))?.[1];
    assert(pattern, 'no SECRET_NAME in src/lib/console-scrub.ts');
    for (const name of NAMES.filter((n) => !PUBLIC.includes(n))) if (!new RegExp(pattern, 'i').test(name)) problems.push(`${name} does not match the console scrubber's SECRET_NAME`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('S2 the README\'s env table has a row for each of the seven and a Web sign-in section with both callbacks; .env.example a commented placeholder for each; CLAUDE.md the sign-in rule; only the files the rule names touch SignInIdentity', () => {
    const readme = read('README.md');
    const example = read('.env.example').split('\n');
    const problems: string[] = [];
    for (const name of NAMES) {
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

  await check('S3 web sign-up\'s rules are written down: the CLAUDE.md sign-in rule names the one creation step, the address check on a proved address, Join after a proved way with its one rule set, Finish here, and the sign-in from the last hour that adding a way needs; the pause rule names the web sign-up\'s sends and the no-chat skip line; the README has a Web sign-up section and no longer says the web makes no accounts', () => {
    const lines = read('CLAUDE.md').split('\n');
    const signIn = lines.find((l) => l.startsWith('- Every web sign-in')) ?? '';
    const pause = lines.find((l) => l.startsWith('- A send to a person that no one asked for')) ?? '';
    const readme = read('README.md');
    const problems: string[] = [];
    for (const word of ['`createAccount`', 'smoke-account-create.ts', '`findWayByAddress`', '`offerJoin`', '`mergePlan`', '`POST /api/oauth/claim`', 'Turnstile', '`refuseStaleSignIn`', '`recentlyProved`', 'src/lib/recent-sign-in.ts', 'smoke-recent-sign-in.ts']) if (!signIn.includes(word)) problems.push(`the sign-in rule does not name ${word}`);
    for (const word of ['`sendNoticeEmail`', 'telegram-connect.ts', 'skipped user <id>: no Telegram', '[google-sync] user <id>: no chat; no reconnect message']) if (!pause.includes(word)) problems.push(`the pause rule does not name ${word}`);
    if (!/^### Web sign-up$/m.test(readme)) problems.push('README has no "### Web sign-up" section');
    if (/The web makes no accounts/.test(readme)) problems.push('README still says the web makes no accounts');
    for (const name of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET', 'createAccount', '/signup']) if (!readme.slice(readme.indexOf('### Web sign-up')).includes(name)) problems.push(`README's Web sign-up section does not name ${name}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('S4 browser notifications\' setup (6c-2, spec 2026-11-05-web-push §3.9): pushSetupWarnings names the unset VAPID variables in one line and never a value, by the rule pushConfigured reads; PUSH_ENV is the two; the private key matches the console scrubber; production register() logs the line; the README table and .env.example have both', async () => {
    const mod = (await import(path.join(ROOT, 'src/lib/startup-checks.ts'))) as Row;
    const config = (await import(path.join(ROOT, 'src/services/web-push/config.ts'))) as Row;
    const problems: string[] = [];
    if (show(config.PUSH_ENV) !== show(PUSH_NAMES)) problems.push(`PUSH_ENV ${show(config.PUSH_ENV)}`);
    const both = { VAPID_PUBLIC_KEY: 'VALUE-VPUB-1', VAPID_PRIVATE_KEY: 'VALUE-VPRIV-2' };
    const cases: [string, Record<string, string | undefined>, string[]][] = [
      ['both set', both, []],
      ['none set', {}, ['Browser notifications are off: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set']],
      ['only the private key missing', { ...both, VAPID_PRIVATE_KEY: undefined }, ['Browser notifications are off: VAPID_PRIVATE_KEY is not set']],
      ['the public key blank', { ...both, VAPID_PUBLIC_KEY: '  ' }, ['Browser notifications are off: VAPID_PUBLIC_KEY is not set']],
    ];
    for (const [label, env, want] of cases) {
      const got = typeof mod.pushSetupWarnings === 'function' ? mod.pushSetupWarnings(env) : 'no pushSetupWarnings';
      if (show(got) !== show(want)) problems.push(`${label}: ${show(got)}`);
      if (/VALUE-/.test(show(got))) problems.push(`${label}: a value in ${show(got)}`);
      if (config.pushConfigured?.(env) !== (want.length === 0)) problems.push(`${label}: pushConfigured disagrees with the warning`);
    }
    const pattern = /const SECRET_NAME = \/(.+)\/i;/.exec(read('src/lib/console-scrub.ts'))?.[1];
    assert(pattern, 'no SECRET_NAME in src/lib/console-scrub.ts');
    if (!new RegExp(pattern, 'i').test('VAPID_PRIVATE_KEY')) problems.push('VAPID_PRIVATE_KEY does not match the console scrubber\'s SECRET_NAME');
    const boot = read('instrumentation.ts');
    const production = boot.indexOf("if (process.env.NODE_ENV === 'production') {");
    const line = boot.indexOf('for (const warning of pushSetupWarnings(process.env)) console.warn(`[startup] ${warning}`);');
    if (production < 0 || line < production) problems.push('instrumentation.ts does not log pushSetupWarnings in its production block');
    if (!/import\('\.\/src\/lib\/startup-checks'\)/.test(boot) || !/\bpushSetupWarnings\b.*=\s*await import\('\.\/src\/lib\/startup-checks'\)/.test(boot)) problems.push('instrumentation.ts does not import pushSetupWarnings from startup-checks');
    const readme = read('README.md');
    const example = read('.env.example').split('\n');
    for (const name of PUSH_NAMES) {
      if (!new RegExp(`^\\|[^\\n]*\`${name}\``, 'm').test(readme)) problems.push(`README's table has no ${name} row`);
      const placeholder = example.find((l) => l.startsWith(`# ${name}=`));
      if (!placeholder || !/^# [A-Z_]+=your_[a-z_]+_here$/.test(placeholder)) problems.push(`.env.example has no commented placeholder for ${name}`);
      if (example.some((l) => l.startsWith(`${name}=`))) problems.push(`.env.example sets ${name} uncommented`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('S5 browser notifications\' rules are written down (6c-2, spec 2026-11-05-web-push; plan Task 13): CLAUDE.md has the push rule, naming the one sender, the one device file and its fence, the push-service hosts, the reach rule, the pause and the TTL, the Sentry scrub, the four session writers and the smokes, and every file it names exists; the README has a "Notifications in the browser" section with the key setup, the never-changed rule and the /sw.js check', () => {
    const rule = read('CLAUDE.md').split('\n').find((l) => l.startsWith('- A browser notification')) ?? '';
    const readme = read('README.md');
    const problems: string[] = [];
    if (!rule) problems.push('CLAUDE.md has no "- A browser notification" rule');
    else for (const word of ['`sendWebPush`', 'src/services/web-push/send.ts', 'src/services/web-push/devices.ts', 'smoke-push-devices.ts', '`PUSH_SERVICE_HOSTS`', '`canReachByPush`', 'src/services/web-push/reach.ts', 'isPaused(', '`pushTtlSeconds`', '`nextPauseStart`', 'src/lib/sentry-scrub.ts', '`captureSignInFailure`', 'User.sessionsValidAfter', '`deleteDevicesOf`', '`afterDevicesChanged`', 'smoke-web-push-send.ts', 'smoke-push-session-end.ts', 'smoke-push-reach.ts']) {
      if (!rule.includes(word)) problems.push(`the push rule does not name ${word}`);
    }
    for (const file of rule.match(/\b(?:src|scripts)\/[\w./-]+\.ts\b/g) ?? []) if (!fs.existsSync(path.join(ROOT, file))) problems.push(`the push rule names ${file}, which does not exist`);
    if (!/^### Notifications in the browser$/m.test(readme)) problems.push('README has no "### Notifications in the browser" section');
    else {
      const section = readme.slice(readme.indexOf('### Notifications in the browser')).split(/\n### /)[0];
      for (const word of ['npx web-push generate-vapid-keys', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'Never change the keys', '/sw.js', 'cf-cache-status']) {
        if (!section.includes(word)) problems.push(`README's Notifications section does not name ${word}`);
      }
    }
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
