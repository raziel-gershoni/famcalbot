// Smoke test for fail-closed secrets (secret rotation, spec section d). Session cookies
// were signed with SESSION_SECRET || CRON_SECRET, and unsigned WhatsApp webhooks were
// accepted while WHATSAPP_APP_SECRET was unset. Now:
// - the session cookie is signed with its own key, derived from SESSION_SECRET by HKDF
//   (src/lib/app-keys.ts); without SESSION_SECRET no cookie is made or accepted;
// - the magic link checks that key before it uses the link up (GETDEL), so a link refused
//   for a missing key still works once the key is set;
// - an unset WHATSAPP_APP_SECRET refuses every WhatsApp webhook ('unconfigured');
// - startup names every missing or reused secret in production (log, Sentry and the deploy
//   message), logs the encryption key fingerprints in every environment, and never throws;
// - the deploy message's failures are logged and captured, not swallowed;
// - no `process.env.<SECRET> || process.env.<OTHER>` fallback is left anywhere (#12).
//
// Real: app-keys, session-auth, the magic route, whatsapp-signature, startup-checks,
// encryption's describeKeys and instrumentation's register(). Faked at the boundaries:
// Prisma (a user that is not suspended), magic-link (records each use), error capture,
// Sentry's server config, the scheduler, the admin list and the Telegram bot (all
// recorded). No network, no DB.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-fail-closed.ts

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const SELF = path.relative(ROOT, __filename);
const env = process.env as Record<string, string | undefined>;

// Every value this smoke depends on is set here, never taken from the fake env.
const SESSION = 'VALUE-SESSION-fc1';
const CRON = 'VALUE-CRON-fc2';
const ENC_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
Object.assign(env, {
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || 'test',
  SESSION_SECRET: SESSION,
  CRON_SECRET: CRON,
  ENCRYPTION_KEY: ENC_KEY,
  ENCRYPTION_KEY_PREVIOUS: '',
  WHATSAPP_APP_SECRET: 'VALUE-APP-fc3',
  TELEGRAM_WEBHOOK_SECRET: 'VALUE-TG-fc4',
  NEXT_PUBLIC_APP_URL: 'https://famcal.test',
});

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
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Runs fn with `vars` set in process.env, then puts the old values back. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, env[k]]));
  Object.assign(env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

/** Runs fn with the console recorded instead of printed. */
async function recordingConsole<T>(fn: () => Promise<T> | T): Promise<{ value: T; lines: { level: string; text: string }[] }> {
  const lines: { level: string; text: string }[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const rec = (level: string) => (...args: unknown[]) => { lines.push({ level, text: args.map(a => String(a)).join(' ') }); };
  Object.assign(console, { log: rec('log'), info: rec('info'), warn: rec('warn'), error: rec('error') });
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, original);
  }
}

/** Waits for fire-and-forget work (the deploy message) until `done` holds, up to 2 s. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 10));
}

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

/** Every captureError: its context, its extra and the error's message. */
const captured: { ctx: string; extra?: Row; message: string }[] = [];
/** Every magic token the route used up. */
const magicUses: string[] = [];
/** What the next magic token holds (null: invalid or used). */
let magicData: Row | null = null;
const schedulerStarts: number[] = [];
const sends: { chatId: unknown; text: string }[] = [];
let adminIds: () => Promise<number[]> = async () => [1001, 1002];
let sendFails = false;

function installStubs() {
  stub('src/utils/prisma.ts', {
    prisma: { user: { findUnique: async () => ({ suspendedAt: null }) } },
    withRetry: (fn: () => unknown) => fn(),
  });
  stub('src/utils/redis.ts', { redis: {} });
  stub('src/services/magic-link.ts', {
    validateMagicToken: async (token: string) => { magicUses.push(token); return magicData; },
  });
  const capture = (e: unknown, ctx: string, extra?: Row) => {
    captured.push({ ctx, extra, message: e instanceof Error ? e.message : String(e) });
  };
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: () => undefined });
  stub('sentry.server.config.ts', {});
  stub('src/cron/scheduler.ts', { startScheduler: () => { schedulerStarts.push(Date.now()); } });
  stub('src/utils/error-notifier.ts', { getAdminUserIds: () => adminIds() });
  const bot = {
    sendMessage: async (chatId: unknown, text: string) => {
      if (sendFails) throw new Error('telegram down (smoke)');
      sends.push({ chatId, text });
      return {};
    },
  };
  stub('src/services/telegram/bot.ts', { getBot: () => bot });
}

// ---- Fixtures ----

const hkdf = (secret: string, purpose: string) => Buffer.from(crypto.hkdfSync('sha256', secret, '', `famcal/${purpose}/v1`, 32));
/** A session token in session-auth's format, signed with `key`. */
function sessionToken(key: crypto.BinaryLike, payload: Row | string): string {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
const live = (userId: number) => ({ userId, iat: now(), exp: now() + 3600 });

/** The once-per-process set app-keys keeps on globalThis, emptied so a check sees its own first report. */
function forgetMissingReports() {
  delete (globalThis as Row).__famcalAppKeyMissing;
}
const appKeyCaptures = (purpose: string) => captured.filter(c => c.ctx === 'app-key-missing' && c.extra?.purpose === purpose);

/** register() as the nodejs runtime with these vars set; what it logged and captured. */
async function registerWith(vars: Record<string, string>) {
  captured.length = 0;
  sends.length = 0;
  const { register } = await load('instrumentation.ts');
  return withEnv({ NEXT_RUNTIME: 'nodejs', RAILWAY_GIT_COMMIT_SHA: '', ...vars }, () => recordingConsole(async () => {
    let threw: string | null = null;
    try {
      await register();
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    return threw;
  }));
}

const PROBLEM = {
  session: 'SESSION_SECRET is not set: WhatsApp sign-in and share-story image links are refused',
  app: 'WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused (500)',
  telegram: 'TELEGRAM_WEBHOOK_SECRET is not set: every Telegram update is refused (500)',
  key: "ENCRYPTION_KEY is missing or not 64 hex characters: Google tokens can't be read or saved",
  reused: 'SESSION_SECRET equals CRON_SECRET: give it its own value',
};

async function main() {
  installStubs();
  const { NextRequest } = nodeRequire('next/server');

  const magic = async (query: string, cookie?: string) => {
    const { GET } = await load('app/api/auth/magic/route.ts');
    const { value: res, lines } = await recordingConsole<Response>(() => GET(new NextRequest(`http://localhost/api/auth/magic?${query}`, {
      headers: { 'accept-language': 'ru', ...(cookie ? { cookie } : {}) },
    })));
    const to = new URL(res.headers.get('location') ?? 'http://x/none');
    return { to: `${to.pathname}${to.search}`, setCookie: res.headers.get('set-cookie') ?? '', lines };
  };

  // ---- Session cookie ----

  await check('#1 the session cookie is signed with the HKDF session-cookie key: a raw-SESSION_SECRET signature is refused', async () => {
    const { createSessionToken, validateSessionToken } = await load('src/lib/session-auth.ts');
    const made = createSessionToken(42);
    const [body, sig] = made.split('.');
    assert(sig === crypto.createHmac('sha256', hkdf(SESSION, 'session-cookie')).update(body).digest('base64url'), 'createSessionToken does not sign with the HKDF key');
    assert(validateSessionToken(made)?.userId === 42, 'its own token is refused');
    assert(validateSessionToken(sessionToken(hkdf(SESSION, 'session-cookie'), live(7)))?.userId === 7, 'an HKDF-signed token is refused');
    assert(validateSessionToken(sessionToken(SESSION, live(7))) === null, 'a token signed with the raw SESSION_SECRET is accepted');
    assert(validateSessionToken(sessionToken(hkdf(SESSION, 'image-link'), live(7))) === null, 'a token signed with the image-link key is accepted');
  });

  await check('#2 SESSION_SECRET="" with CRON_SECRET set: createSessionToken throws, no cookie is accepted (CRON-signed included), one app-key-missing report', async () => {
    captured.length = 0;
    forgetMissingReports();
    const { createSessionToken, validateSessionToken } = await load('src/lib/session-auth.ts');
    const out = await withEnv({ SESSION_SECRET: '' }, () => {
      let thrown = '';
      try {
        createSessionToken(42);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      return {
        thrown,
        cronRaw: validateSessionToken(sessionToken(CRON, live(7))),
        cronHkdf: validateSessionToken(sessionToken(hkdf(CRON, 'session-cookie'), live(7))),
      };
    });
    assert(out.thrown !== '', 'createSessionToken signed a cookie with no SESSION_SECRET');
    assert(!out.thrown.includes(CRON), 'the error names a secret value');
    assert(out.cronRaw === null && out.cronHkdf === null, `CRON-signed tokens: ${show(out)}`);
    assert(appKeyCaptures('session-cookie').length === 1, `reports: ${show(captured)}`);
  });

  await check('#3 a correctly signed cookie that is not JSON is refused with one "[session] malformed session cookie" warning that carries no part of it', async () => {
    const { validateSessionToken } = await load('src/lib/session-auth.ts');
    const token = sessionToken(hkdf(SESSION, 'session-cookie'), 'not-json-PAYLOAD-x9');
    const { value, lines } = await recordingConsole(() => validateSessionToken(token));
    assert(value === null, `accepted: ${show(value)}`);
    const warnings = lines.filter(l => l.level === 'warn');
    assert(warnings.length === 1 && warnings[0].text === '[session] malformed session cookie', `logged ${show(lines)}`);
    assert(!lines.some(l => l.text.includes('PAYLOAD') || l.text.includes(token.split('.')[0])), 'the log carries the cookie');
  });

  // ---- Magic link ----

  await check('#4 magic link with SESSION_SECRET="": the fresh-link card, the link is not used up, no cookie, one app-key-missing report over two taps', async () => {
    captured.length = 0;
    magicUses.length = 0;
    forgetMissingReports();
    magicData = { userId: 42, locale: 'he', page: 'dashboard' };
    const taps = await withEnv({ SESSION_SECRET: '' }, async () => [
      await magic('token=tok-1&locale=he'),
      await magic('token=tok-1&locale=he'),
    ]);
    for (const tap of taps) {
      assert(tap.to === '/he/dashboard', `redirect ${tap.to}`);
      assert(!tap.setCookie.includes('famcal_session='), 'a session cookie was set');
    }
    assert(magicUses.length === 0, `the link was used up: ${show(magicUses)}`);
    assert(appKeyCaptures('session-cookie').length === 1, `reports: ${show(captured)}`);
  });

  await check('#5 magic link with SESSION_SECRET set: signs in with a cookie under the HKDF session-cookie key', async () => {
    magicUses.length = 0;
    magicData = { userId: 42, locale: 'ru', page: 'dashboard' };
    const tap = await magic('token=tok-2&locale=ru');
    assert(tap.to === '/ru/dashboard?user_id=42', `redirect ${tap.to}`);
    assert(magicUses.length === 1, `uses ${show(magicUses)}`);
    const cookie = tap.setCookie.match(/famcal_session=([^;]+)/)?.[1] ?? '';
    const [body, sig] = cookie.split('.');
    assert(body && sig === crypto.createHmac('sha256', hkdf(SESSION, 'session-cookie')).update(body).digest('base64url'),
      'the cookie is not signed with the HKDF session-cookie key');
  });

  // ---- WhatsApp ----

  await check('#6 whatsapp-signature: no accept-unsigned switch; an unset or empty WHATSAPP_APP_SECRET is "unconfigured" for every post', async () => {
    const mod = await load('src/lib/whatsapp-signature.ts');
    assert(!('ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS' in mod), 'ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS is still exported');
    const raw = '{"object":"whatsapp_business_account"}';
    const signed = `sha256=${crypto.createHmac('sha256', 'VALUE-APP-fc3').update(raw).digest('hex')}`;
    const verdicts = await withEnv({ WHATSAPP_APP_SECRET: '' }, () => [
      mod.checkWhatsAppSignature(raw, null),
      mod.checkWhatsAppSignature(raw, signed),
    ]);
    assert(show(verdicts) === show(['unconfigured', 'unconfigured']), `verdicts ${show(verdicts)}`);
    const withSecret = [mod.checkWhatsAppSignature(raw, signed), mod.checkWhatsAppSignature(raw, null)];
    assert(show(withSecret) === show(['verified', 'rejected']), `with the secret: ${show(withSecret)}`);
  });

  // ---- Startup ----

  await check('#7 startupSecretProblems names each missing or reused secret, never a value', async () => {
    const { startupSecretProblems } = await load('src/lib/startup-checks.ts');
    const full = { ENCRYPTION_KEY: ENC_KEY, SESSION_SECRET: SESSION, CRON_SECRET: CRON, WHATSAPP_APP_SECRET: 'VALUE-APP-fc3', TELEGRAM_WEBHOOK_SECRET: 'VALUE-TG-fc4' };
    const cases: [string, Record<string, string | undefined>, { name: string; message: string; missing?: true }[]][] = [
      ['all set', full, []],
      ['all empty', { ENCRYPTION_KEY: ENC_KEY, SESSION_SECRET: '', CRON_SECRET: '', WHATSAPP_APP_SECRET: '', TELEGRAM_WEBHOOK_SECRET: '' }, [
        { name: 'SESSION_SECRET', message: PROBLEM.session, missing: true },
        { name: 'WHATSAPP_APP_SECRET', message: PROBLEM.app, missing: true },
        { name: 'TELEGRAM_WEBHOOK_SECRET', message: PROBLEM.telegram, missing: true },
      ]],
      ['all unset', {}, [
        { name: 'ENCRYPTION_KEY', message: PROBLEM.key, missing: true },
        { name: 'SESSION_SECRET', message: PROBLEM.session, missing: true },
        { name: 'WHATSAPP_APP_SECRET', message: PROBLEM.app, missing: true },
        { name: 'TELEGRAM_WEBHOOK_SECRET', message: PROBLEM.telegram, missing: true },
      ]],
      ['empty key', { ...full, ENCRYPTION_KEY: '' }, [{ name: 'ENCRYPTION_KEY', message: PROBLEM.key, missing: true }]],
      ['63-hex key', { ...full, ENCRYPTION_KEY: ENC_KEY.slice(1) }, [{ name: 'ENCRYPTION_KEY', message: PROBLEM.key, missing: true }]],
      ['session reuses cron', { ...full, CRON_SECRET: SESSION }, [{ name: 'SESSION_SECRET', message: PROBLEM.reused }]],
      ['only the app secret missing', { ...full, WHATSAPP_APP_SECRET: undefined }, [{ name: 'WHATSAPP_APP_SECRET', message: PROBLEM.app, missing: true }]],
    ];
    const problems: string[] = [];
    for (const [label, input, want] of cases) {
      const got = startupSecretProblems(input);
      if (show(got) !== show(want)) problems.push(`${label}: ${show(got)}`);
      if (/VALUE-/.test(show(got))) problems.push(`${label}: a value in ${show(got)}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#8 production register() with every checked secret empty: one console.error line and one startup-secret capture each, no throw, scheduler started', async () => {
    schedulerStarts.length = 0;
    const { value: threw, lines } = await registerWith({
      NODE_ENV: 'production', SESSION_SECRET: '', WHATSAPP_APP_SECRET: '', TELEGRAM_WEBHOOK_SECRET: '',
    });
    assert(threw === null, `register() threw: ${threw}`);
    const errors = lines.filter(l => l.level === 'error' && l.text.startsWith('[startup] ')).map(l => l.text);
    assert(show(errors) === show([`[startup] ${PROBLEM.session}`, `[startup] ${PROBLEM.app}`, `[startup] ${PROBLEM.telegram}`]), `error lines ${show(errors)}`);
    const startup = captured.filter(c => c.ctx === 'startup-secret').map(c => c.extra?.variable);
    assert(show(startup) === show(['SESSION_SECRET', 'WHATSAPP_APP_SECRET', 'TELEGRAM_WEBHOOK_SECRET']), `captures ${show(captured)}`);
    assert(schedulerStarts.length === 1, 'the scheduler did not start');
    assert(![...lines.map(l => l.text), ...captured.map(c => c.message)].some(t => t.includes('VALUE-')), 'a secret value was logged');
  });

  await check('#9 register() logs the key fingerprint line in every environment, names no secret outside production, and survives a missing ENCRYPTION_KEY', async () => {
    const fp = crypto.createHash('sha256').update(Buffer.from(ENC_KEY, 'hex')).digest('hex').slice(0, 8);
    const dev = await registerWith({ NODE_ENV: 'development', SESSION_SECRET: '', WHATSAPP_APP_SECRET: '' });
    const devCaptures = captured.filter(c => c.ctx === 'startup-secret').length;
    const keyLine = dev.lines.filter(l => l.text.startsWith('[startup] ENCRYPTION_KEY')).map(l => l.text);
    assert(show(keyLine) === show([`[startup] ENCRYPTION_KEY fp ${fp}; ENCRYPTION_KEY_PREVIOUS unset`]), `development: ${show(dev.lines)}`);
    assert(!dev.lines.some(l => / is not set: /.test(l.text)) && devCaptures === 0, `development named a secret: ${show(dev.lines)}`);
    const noKey = await registerWith({ NODE_ENV: 'production', ENCRYPTION_KEY: '' });
    assert(noKey.value === null, `register() threw with no ENCRYPTION_KEY: ${noKey.value}`);
    assert(noKey.lines.some(l => l.text === '[startup] ENCRYPTION_KEY missing or invalid; ENCRYPTION_KEY_PREVIOUS unset'), `no ENCRYPTION_KEY: ${show(noKey.lines)}`);
    const keyErrors = noKey.lines.filter(l => l.level === 'error' && l.text === `[startup] ${PROBLEM.key}`);
    assert(keyErrors.length === 1, `no ENCRYPTION_KEY error line: ${show(noKey.lines)}`);
    const keyCaptures = captured.filter(c => c.ctx === 'startup-secret');
    assert(keyCaptures.length === 1 && keyCaptures[0].extra?.variable === 'ENCRYPTION_KEY', `no ENCRYPTION_KEY captures: ${show(captured)}`);
  });

  await check('#10 the deploy message names the missing secrets ("missing: ..."), and a reused one is not "missing"', async () => {
    adminIds = async () => [1001, 1002];
    sendFails = false;
    await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567', SESSION_SECRET: '', WHATSAPP_APP_SECRET: '' });
    await settle(() => sends.length >= 2);
    const texts = sends.map(s => s.text);
    assert(sends.length === 2 && sends.every(s => s.text === '🚀 FamCal <code>abcdef1</code> deployed\nmissing: SESSION_SECRET, WHATSAPP_APP_SECRET'), `sent ${show(sends)}`);
    await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567', CRON_SECRET: SESSION });
    await settle(() => sends.length >= 2);
    assert(sends.length === 2 && sends.every(s => s.text === '🚀 FamCal <code>abcdef1</code> deployed'), `reused only: sent ${show(sends)} (before: ${show(texts)})`);
  });

  await check('#10b the deploy message names a missing ENCRYPTION_KEY', async () => {
    adminIds = async () => [1001, 1002];
    sendFails = false;
    await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567', ENCRYPTION_KEY: '' });
    await settle(() => sends.length >= 2);
    assert(sends.length === 2 && sends.every(s => s.text === '🚀 FamCal <code>abcdef1</code> deployed\nmissing: ENCRYPTION_KEY'), `sent ${show(sends)}`);
  });

  await check('#11 a deploy message that fails is logged and captured (deploy-notify-send per admin, deploy-notify for the admin list), never swallowed', async () => {
    sendFails = true;
    adminIds = async () => [1001];
    try {
      await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567' });
      await settle(() => captured.some(c => c.ctx === 'deploy-notify-send'));
      const send = captured.filter(c => c.ctx === 'deploy-notify-send');
      assert(send.length === 1 && send[0].extra?.admin_id === 1001, `send failure: ${show(captured)}`);
      adminIds = async () => { throw new Error('db down (smoke)'); };
      await registerWith({ NODE_ENV: 'production', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567' });
      await settle(() => captured.some(c => c.ctx === 'deploy-notify'));
      assert(captured.filter(c => c.ctx === 'deploy-notify').length === 1, `admin list failure: ${show(captured)}`);
    } finally {
      sendFails = false;
      adminIds = async () => [1001, 1002];
    }
  });

  // The spec's source scan: no secret stands in for another through an env fallback
  await check('#12 source scan: no `process.env.<SECRET> || process.env.<OTHER>` (or ??) fallback in app, src, components, scripts or the root config files', () => {
    const FALLBACK = /process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)\s*process\.env\.([A-Z0-9_]+)/g;
    const SECRET_NAME = /SECRET|KEY|TOKEN|PASSWORD|DSN/;
    const fallbacks = (text: string) => [...text.matchAll(FALLBACK)]
      .filter(m => SECRET_NAME.test(m[1]) || SECRET_NAME.test(m[2]))
      .map(m => `${m[1]} -> ${m[2]}`);
    // The scanner itself: it catches the three fallbacks this branch removed, in either spelling.
    const fixture = [
      'const a = process.env.SESSION_SECRET || process.env.CRON_SECRET;',
      'const b = process.env.ENCRYPTION_KEY ??',
      '  process.env.CRON_SECRET;',
      "const c = process.env.SESSION_SECRET || '';",
      'const d = process.env.NODE_ENV || process.env.VERCEL_ENV;',
    ].join('\n');
    assert(show(fallbacks(fixture)) === show(['SESSION_SECRET -> CRON_SECRET', 'ENCRYPTION_KEY -> CRON_SECRET']), `scanner self-test: ${show(fallbacks(fixture))}`);

    const files: string[] = [];
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = path.join(rel, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(child);
      }
    };
    for (const dir of ['app', 'src', 'components', 'scripts']) walk(dir);
    for (const entry of fs.readdirSync(ROOT)) {
      if (/\.(ts|js|mjs)$/.test(entry) && fs.statSync(path.join(ROOT, entry)).isFile()) files.push(entry);
    }
    const hits = files.filter(f => f !== SELF).flatMap(f => fallbacks(readSource(f)).map(h => `${f}: ${h}`));
    assert(hits.length === 0, `fallbacks: ${hits.join('; ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
