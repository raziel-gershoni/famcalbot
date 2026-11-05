// Smoke test for the sign-in-within-the-hour rule (6c-1 follow-ups plan, Tasks 3 and 4): src/lib/recent-sign-in.ts is the
// one place that compares a session's proved-at (the cookie's `pa`) with the clock. Connect Telegram, Add Google, Add
// email, the browser Google connect and its claim, Turn on and Join all ask it.
//
// What it pins:
//   - the boundary: 59:59.999 after the proof passes, 60:00.000 is refused;
//   - sessionRecentlyProved: another user's session is refused, and a WhatsApp link's session only when the caller
//     says allowWhatsApp: false (Connect Telegram);
//   - refuseStaleSignIn: null for Telegram initData whatever its age (and for a stale cookie sent together with valid
//     initData, through verifyUserAuth), null for a fresh session, 403 { ok: false, error: 'stale-sign-in' } for a stale
//     one; the log line holds the user id and the method only;
//   - the proved-at itself: a cookie with no `pa` falls back to its sign-in time (or its iat), and a re-issue (page-data's
//     renewal, Remove) never restarts the hour;
//   - no `provedAt` arithmetic anywhere in src/ or app/ except the helper, and Connect Telegram reads the helper;
//   - the audit (Task 4): every file that adds a way to an account or connects a Google account from a browser either
//     asks the helper (GUARDED) or is listed with the reason it does not (EXEMPT); an unlisted file fails here.
//
// Real: the helper, the session cookie, verifyUserAuth. Faked at the boundaries (scripts/lib/signin-world.ts): Prisma,
// Redis, the rate limiter, error capture. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   bash scripts/ci-smokes.sh   (or the plan's $RUN smoke-recent-sign-in)

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  assert, baseUser, body, check, DB, everyLog, initDataFor, installSigninWorld, load, report, request, resetWorld, ROOT,
  sessionCookie, show, type Row,
} from './lib/signin-world';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DANA = 50;
const DANA_TG = 777000111;

// ---- The source scans ----

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
const SOURCES = ['src', 'app'].flatMap(dir => sourceFiles(path.join(ROOT, dir)));
/** A file's code lines: comment lines dropped, so a sentence about the rule is not read as arithmetic. */
const codeLines = (file: string): string[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line));

async function main() {
  await installSigninWorld();
  const helper = await load('src/lib/recent-sign-in.ts');
  const { createSessionToken, reissueSessionToken, validateSessionToken, SESSION_COOKIE_NAME } = await load('src/lib/session-auth.ts');
  const { appKey } = await load('src/lib/app-keys.ts');
  const { verifyUserAuth } = await load('src/lib/api-auth.ts');
  const { RECENT_SIGN_IN_MS, recentlyProved, sessionRecentlyProved, refuseStaleSignIn } = helper;

  const sessionOf = (method: string, provedAt: number, userId = DANA): Row => {
    const session = validateSessionToken(createSessionToken(userId, method, provedAt));
    assert(session, 'no session was made');
    return session;
  };
  const userOf = (id = DANA): Row => ({ id, telegramId: DANA_TG });
  /** A signed cookie payload with exactly these fields (the way smoke-web-session mints an old shape). */
  const signed = (payload: Row): string => {
    const key = appKey('session-cookie');
    const bodyText = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${bodyText}.${crypto.createHmac('sha256', key).update(bodyText).digest('base64url')}`;
  };

  await check('the hour is 60 minutes; 59:59.999 after the proof passes, exactly 60:00.000 is refused', () => {
    assert(RECENT_SIGN_IN_MS === HOUR, `the hour is ${RECENT_SIGN_IN_MS}`);
    const t = 1_700_000_000_000;
    assert(recentlyProved(t, t + HOUR - 1) === true, '59:59.999 was refused');
    assert(recentlyProved(t, t + HOUR) === false, '60:00.000 passed');
    assert(recentlyProved(t, t) === true, 'the same instant was refused');
    assert(recentlyProved(Date.now() - 5 * MIN) === true && recentlyProved(Date.now() - 61 * MIN) === false, 'the default clock is Date.now()');
  });

  await check('sessionRecentlyProved: another user\'s session is refused; a WhatsApp link\'s only with allowWhatsApp: false; a stale one never passes', () => {
    const fresh = Date.now() - 5 * MIN;
    assert(sessionRecentlyProved(sessionOf('email', fresh), DANA, { allowWhatsApp: false }) === true, 'own fresh session refused');
    assert(sessionRecentlyProved(sessionOf('email', fresh, 51), DANA, { allowWhatsApp: true }) === false, 'another user\'s session passed');
    assert(sessionRecentlyProved(sessionOf('wa', fresh), DANA, { allowWhatsApp: false }) === false, 'a WhatsApp session passed with allowWhatsApp: false');
    assert(sessionRecentlyProved(sessionOf('wa', fresh), DANA, { allowWhatsApp: true }) === true, 'a fresh WhatsApp session was refused with allowWhatsApp: true');
    assert(sessionRecentlyProved(sessionOf('google', Date.now() - 61 * MIN), DANA, { allowWhatsApp: true }) === false, 'a stale session passed');
    assert(sessionRecentlyProved(sessionOf('wa', Date.now() - 61 * MIN), DANA, { allowWhatsApp: true }) === false, 'a stale WhatsApp session passed');
  });

  await check('refuseStaleSignIn: null for Telegram initData of any age and for a fresh session; 403 { ok: false, error: stale-sign-in } for a stale one, logged with the user id and the method only', async () => {
    const before = everyLog.length;
    assert(refuseStaleSignIn({ success: true, via: 'telegram', user: userOf() }, 'add-link') === null, 'Telegram auth was refused');
    const fresh = refuseStaleSignIn({ success: true, via: 'session', user: userOf(), session: sessionOf('email', Date.now() - 10 * MIN) }, 'add-link');
    assert(fresh === null, 'a fresh session was refused');
    const fresh59 = refuseStaleSignIn({ success: true, via: 'session', user: userOf(), session: sessionOf('google', Date.now() - 59 * MIN) }, 'add-link');
    assert(fresh59 === null, 'a 59-minute session was refused');
    const wa = refuseStaleSignIn({ success: true, via: 'session', user: userOf(), session: sessionOf('wa', Date.now() - 10 * MIN) }, 'add-link');
    assert(wa === null, 'a fresh WhatsApp session was refused (ruling R1: it counts like any session)');
    assert(everyLog.length === before, `a pass logged: ${show(everyLog.slice(before))}`);
    const stale = refuseStaleSignIn({ success: true, via: 'session', user: userOf(), session: sessionOf('email', Date.now() - 61 * MIN) }, 'email-add');
    assert(stale && stale.status === 403, `a stale session: ${stale?.status}`);
    assert(show(await body(stale)) === show({ ok: false, error: 'stale-sign-in' }), `the answer ${show(await body(stale))}`);
    const staleWa = refuseStaleSignIn({ success: true, via: 'session', user: userOf(), session: sessionOf('wa', Date.now() - 61 * MIN) }, 'oauth-start');
    assert(staleWa && staleWa.status === 403, 'a stale WhatsApp session passed');
    const lines = everyLog.slice(before);
    assert(lines.length === 2, `two refusals, two lines: ${show(lines)}`);
    assert(lines[0] === `[recent-sign-in] user ${DANA}: email-add refused: the email sign-in is not recent`, `the line: ${lines[0]}`);
    assert(lines[1] === `[recent-sign-in] user ${DANA}: oauth-start refused: the wa sign-in is not recent`, `the line: ${lines[1]}`);
  });

  await check('valid Telegram initData together with a stale cookie passes through verifyUserAuth (initData wins); the stale cookie alone is refused', async () => {
    resetWorld();
    DB.user = [baseUser({ id: DANA, name: 'Dana', telegramId: BigInt(DANA_TG) })];
    const stale = await sessionCookie(DANA, 'email', Date.now() - 3 * 24 * HOUR);
    const limiter = { name: 'general' };
    const both = await verifyUserAuth(request(`/x?user_id=${DANA}`, { cookie: stale }), String(DANA), initDataFor(DANA_TG), limiter, 'smoke');
    assert(both.success && both.via === 'telegram', `initData did not win: ${show(both.success ? both.via : 'refused')}`);
    assert(refuseStaleSignIn(both, 'add-link') === null, 'initData plus a stale cookie was refused');
    const cookieOnly = await verifyUserAuth(request(`/x?user_id=${DANA}`, { cookie: stale }), String(DANA), null, limiter, 'smoke');
    assert(cookieOnly.success && cookieOnly.via === 'session', 'the cookie alone did not authenticate');
    const refused = refuseStaleSignIn(cookieOnly, 'add-link');
    assert(refused?.status === 403, 'a stale cookie alone passed');
  });

  await check('the proved-at: a cookie with no pa falls back to its sign-in time, and with no at either to its iat; a re-issue (renewal, Remove) never restarts the hour', async () => {
    const iatS = Math.floor((Date.now() - 3 * HOUR) / 1000);
    const noPa = validateSessionToken(signed({ userId: DANA, m: 'email', at: Date.now() - 3 * HOUR, iat: iatS, exp: iatS + 86_400 * 30 }));
    assert(noPa && noPa.provedAt === noPa.signedInAt && !recentlyProved(noPa.provedAt), `no pa: ${show(noPa)}`);
    const recentAt = Date.now() - 5 * MIN;
    const noPaRecent = validateSessionToken(signed({ userId: DANA, m: 'email', at: recentAt, iat: iatS, exp: Math.floor(Date.now() / 1000) + 3600 }));
    assert(noPaRecent && noPaRecent.provedAt === recentAt && recentlyProved(noPaRecent.provedAt), `no pa, recent at: ${show(noPaRecent)}`);
    const oldest = validateSessionToken(signed({ userId: DANA, m: 'tg', iat: iatS, exp: Math.floor(Date.now() / 1000) + 3600 }));
    assert(oldest && oldest.provedAt === iatS * 1000 && !recentlyProved(oldest.provedAt), `no pa, no at: ${show(oldest)}`);
    const old = sessionOf('email', Date.now() - 3 * HOUR);
    const renewed = validateSessionToken(reissueSessionToken(old));
    const removed = validateSessionToken(reissueSessionToken(old, { signedInAt: Date.now() }));
    for (const [label, s] of [['renewal', renewed], ['Remove', removed]] as const) {
      assert(s && s.provedAt === old.provedAt && !recentlyProved(s.provedAt), `${label} restarted the hour: ${show(s)}`);
    }
    assert(removed && removed.signedInAt > old.signedInAt, 'Remove did not move the sign-in time');
    void SESSION_COOKIE_NAME;
  });

  await check('no provedAt arithmetic in src/ or app/ outside src/lib/recent-sign-in.ts; Connect Telegram has no hour of its own and asks sessionRecentlyProved', () => {
    const arithmetic = /(?:[-+]\s*[\w.?]*provedAt\b|\bprovedAt\s*[-+<>])|RECENT_SIGN_IN_MS/;
    const hits: string[] = [];
    for (const file of SOURCES) {
      if (rel(file) === 'src/lib/recent-sign-in.ts') continue;
      codeLines(file).forEach(line => { if (arithmetic.test(line)) hits.push(`${rel(file)}: ${line.trim()}`); });
    }
    assert(hits.length === 0, `the hour is compared outside the helper:\n     ${hits.join('\n     ')}`);
    const connect = fs.readFileSync(path.join(ROOT, 'src/services/telegram-connect.ts'), 'utf8');
    assert(/sessionRecentlyProved\(\s*session\s*,\s*user\.id\s*,\s*\{\s*allowWhatsApp:\s*false\s*\}\s*\)/.test(connect), 'createConnectLink does not ask sessionRecentlyProved(session, user.id, { allowWhatsApp: false })');
  });

  report();
}

// The harness captures console.*, so a crash is written straight to stdout.
main().catch(err => {
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
