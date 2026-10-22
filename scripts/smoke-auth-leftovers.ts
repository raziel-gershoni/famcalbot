// Smoke test for the leftovers of the auth work: dead paths and code removed, the startup
// log naming a missing secret, and one page that still looked a user up with no
// credential.
//
// - /oauth-success is gone (60b41b4); robots.ts and the proxy matcher still named it.
//   /oauth-complete stays in both.
// - getSessionUserId has had no caller since the pages stopped reading the session.
// - POST /api/subscription/usage had no caller, and with CRON_SECRET unset it let a
//   request with no secret through. The GET stays.
// - Production logs one line per missing SESSION_SECRET / WHATSAPP_APP_SECRET, naming the
//   variable and never a value.
// - The feedback page looked up the URL's user_id with no credential, which told anyone
//   whether that user exists and their language. Both entry points put the locale in the
//   URL, and submitting is authenticated, so the page renders from the URL alone.
//
// Real: robots, the proxy config, session-auth, the usage route, instrumentation's
// register() and the feedback page. Faked at the boundaries: Prisma and Redis (every
// access recorded, nothing answered), error capture, Sentry's server config and the cron
// scheduler (both recorded). No network, no DB.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-auth-leftovers.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values, used only when the fake env left them unset.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';

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
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const env = process.env as Record<string, string | undefined>;

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

/** Every Prisma or Redis access, by path ("prisma.user.findUnique"). */
const dataCalls: string[] = [];
function recording(name: string): Row {
  return new Proxy({} as Row, {
    get: (_t, model) => {
      if (typeof model !== 'string' || model === 'then') return undefined;
      return new Proxy(async () => null, {
        get: (_f, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return async () => { dataCalls.push(`${name}.${model}.${method}`); return null; };
        },
        apply: () => { dataCalls.push(`${name}.${model}()`); return Promise.resolve(null); },
      });
    },
  });
}

const schedulerStarts: number[] = [];
function installStubs() {
  stub('src/utils/prisma.ts', { prisma: recording('prisma'), withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: recording('redis') });
  const capture = () => undefined;
  stub('src/lib/error-capture.ts', { captureError: capture, captureWarning: capture, captureInfo: capture });
  stub('sentry.server.config.ts', {});
  stub('src/cron/scheduler.ts', { startScheduler: () => { schedulerStarts.push(Date.now()); } });
}

/** Source files under app/, src/ and scripts/ (this smoke excluded), for caller searches. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && rel !== path.join('scripts', 'smoke-auth-leftovers.ts')) out.push(rel);
    }
  };
  for (const dir of ['app', 'src', 'scripts']) walk(dir);
  return out;
}

/** Run register() as the nodejs runtime with this env, and return what it logged. */
async function registerWith(vars: Record<string, string | undefined>): Promise<string[]> {
  const keys = ['NEXT_RUNTIME', 'NODE_ENV', 'SESSION_SECRET', 'WHATSAPP_APP_SECRET', 'RAILWAY_GIT_COMMIT_SHA'];
  const saved = Object.fromEntries(keys.map(k => [k, env[k]]));
  const logged: string[] = [];
  const original = { warn: console.warn, error: console.error, log: console.log, info: console.info };
  const record = (...args: unknown[]) => { logged.push(args.map(a => String(a)).join(' ')); };
  try {
    for (const k of keys) delete env[k];
    Object.assign(env, { NEXT_RUNTIME: 'nodejs' }, vars);
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete env[k];
    Object.assign(console, { warn: record, error: record, log: record, info: record });
    const { register } = await load('instrumentation.ts');
    await register();
  } finally {
    Object.assign(console, original);
    for (const k of keys) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  }
  return logged;
}

async function main() {
  installStubs();

  // ---- /oauth-success is gone; /oauth-complete stays ----

  await check('#1 robots.ts no longer disallows the dead /oauth-success, and still disallows /oauth-complete', async () => {
    const robots = (await load('app/robots.ts')).default();
    const disallow: string[] = ([] as Row[]).concat(robots.rules).flatMap(r => r.disallow ?? []);
    assert(!disallow.includes('/oauth-success'), `disallow: ${show(disallow)}`);
    assert(disallow.includes('/oauth-complete') && disallow.includes('/oauth-callback'), `disallow: ${show(disallow)}`);
  });

  await check('#2 the proxy matcher no longer names oauth-success, and still skips oauth-complete, oauth-callback and refresh-token', async () => {
    const { config } = await load('proxy.ts');
    const matcher: string = config.matcher.join(' ');
    assert(!matcher.includes('oauth-success'), `matcher: ${matcher}`);
    for (const p of ['oauth-complete', 'oauth-callback', 'refresh-token']) assert(matcher.includes(p), `matcher lost ${p}: ${matcher}`);
  });

  // ---- Dead code ----

  await check('#3 getSessionUserId is gone from session-auth, and nothing calls it', async () => {
    const mod = await load('src/lib/session-auth.ts');
    assert(!('getSessionUserId' in mod), 'session-auth still exports getSessionUserId');
    assert(typeof mod.validateSessionFromRequest === 'function' && typeof mod.createSessionToken === 'function',
      'session-auth lost its live exports');
    const callers = sourceFiles().filter(f => readSource(f).includes('getSessionUserId'));
    assert(callers.length === 0, `still named in ${callers.join(', ')}`);
  });

  await check('#4 POST /api/subscription/usage is gone (no caller); the GET stays and still wants the secret', async () => {
    const route = await load('app/api/subscription/usage/route.ts');
    assert(!('POST' in route), 'the route still exports POST');
    assert(typeof route.GET === 'function', 'the route lost its GET');
    const { NextRequest } = nodeRequire('next/server');
    const res: Response = await route.GET(new NextRequest('http://localhost/api/subscription/usage?user_id=1&feature=reminders'));
    assert(res.status === 401, `GET with no secret: ${res.status}`);
    // A smoke that loads the route to test it is not a caller
    const callers = sourceFiles().filter(f => f !== path.join('app', 'api', 'subscription', 'usage', 'route.ts')
      && !/^scripts[\\/]smoke-/.test(f)
      && readSource(f).includes('subscription/usage'));
    assert(callers.length === 0, `still called from ${callers.join(', ')}`);
  });

  // ---- Startup: name a missing secret ----

  await check('#5 production startup logs one line per missing SESSION_SECRET / WHATSAPP_APP_SECRET, naming the variable and what is refused', async () => {
    const logged = await registerWith({ NODE_ENV: 'production' });
    const session = logged.filter(l => l.includes('SESSION_SECRET'));
    const app = logged.filter(l => l.includes('WHATSAPP_APP_SECRET'));
    assert(session.length === 1 && session[0] === '[startup] SESSION_SECRET is not set: WhatsApp sign-in and share-story image links are refused', `SESSION_SECRET lines: ${show(session)}`);
    assert(app.length === 1 && app[0] === '[startup] WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused (500)', `WHATSAPP_APP_SECRET lines: ${show(app)}`);
    assert(schedulerStarts.length > 0, 'register() did not start the scheduler');
  });

  await check('#6 [guard] with both secrets set, or outside production, startup names neither; no line ever carries a value', async () => {
    const set = await registerWith({ NODE_ENV: 'production', SESSION_SECRET: 'VALUE-SESSION-x1', WHATSAPP_APP_SECRET: 'VALUE-APP-x2' });
    const dev = await registerWith({ NODE_ENV: 'development' });
    const named = [...set, ...dev].filter(l => /SESSION_SECRET|WHATSAPP_APP_SECRET/.test(l));
    assert(named.length === 0, `logged: ${show(named)}`);
    assert(![...set, ...dev].some(l => l.includes('VALUE-')), 'a secret value was logged');
  });

  // ---- The feedback page renders from the URL alone ----

  await check('#7 /ru/feedback?user_id=5550001 renders FeedbackClient for the URL\'s id and locale, with no DB lookup and no redirect', async () => {
    dataCalls.length = 0;
    const page = (await load('app/[locale]/feedback/page.tsx')).default;
    let el: Row | undefined;
    let thrown: string | undefined;
    try {
      el = await page({ params: Promise.resolve({ locale: 'ru' }), searchParams: Promise.resolve({ user_id: '5550001' }) });
    } catch (err) {
      thrown = String((err as Row)?.digest ?? (err instanceof Error ? err.message : err));
    }
    assert(dataCalls.length === 0, `the page looked the user up: ${show(dataCalls)}`);
    assert(!thrown, `the page threw (redirect or 404): ${thrown}`);
    assert(el?.type?.name === 'FeedbackClient', `renders ${el?.type?.name ?? show(el)}`);
    assert(el.props.userId === 5550001 && el.props.locale === 'ru', `props: ${show(el.props)}`);
  });

  await check('#8 [guard] /en/feedback with no user_id still shows the missing-parameter card', async () => {
    const page = (await load('app/[locale]/feedback/page.tsx')).default;
    const el = await page({ params: Promise.resolve({ locale: 'en' }), searchParams: Promise.resolve({}) });
    assert(show(el).includes('user_id parameter is required'), `renders ${show(el).slice(0, 200)}`);
  });

  // ---- Docs ----

  await check('#9 README\'s env table and .env.example name SESSION_SECRET and WHATSAPP_APP_SECRET (commented placeholders only)', () => {
    const readme = readSource('README.md');
    const example = readSource('.env.example');
    for (const name of ['SESSION_SECRET', 'WHATSAPP_APP_SECRET']) {
      assert(new RegExp(`^\\|[^\\n]*\`${name}\``, 'm').test(readme), `README's table has no ${name} row`);
      // Commented out: a copied placeholder must not become a real key (a wrong app secret 401s every WhatsApp webhook).
      const line = example.split('\n').find(l => l.startsWith(`# ${name}=`));
      assert(line && /^# [A-Z_]+=your_[a-z_]+_here$/.test(line), `.env.example has no commented placeholder line for ${name}`);
      assert(!example.split('\n').some(l => l.startsWith(`${name}=`)), `.env.example sets ${name} uncommented`);
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
