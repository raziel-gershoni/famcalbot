// Smoke test for Connect Telegram (web sign-up spec 2026-11-03 §2.9, §3.6; plan 6c-1 Task 6): an account made on
// famcal.bot, with no chat, takes on a Telegram id through a one-time link, a question in the bot and a Connect press.
//
// What it pins:
//   - the link (POST /api/telegram-connect): refused for an account with a chat, a sign-in over an hour old, a WhatsApp
//     link's session, the 6th link in an hour, and a request from another site; the token is kept only as its sha256;
//   - /start w_<token> runs before auto-registration and the breadcrumb: it never makes an account; a Telegram with no
//     account gets the question, naming the account and its FULL address, with a press id bound to that Telegram; a
//     Telegram that has an account gets the guidance (Add Google or Add email, by the browser account's way) and nothing
//     is joined;
//   - the press: the Telegram id and messagingPlatform 'telegram' on the browser account, feature access invalidated,
//     the reminder cache entry rebuilt, the menu button, the welcome with the dashboard button, the notice, and the
//     browser session still valid;
//   - refused, with a reply: an expired or used link or question, a press from another Telegram id, a suspended or
//     banned account, a banned Telegram id, a Telegram that got an account in between; Cancel drops both records;
//   - the token reaches no console line, no breadcrumb, no capture and no Sentry event (the webhook body's /start text),
//     and the Google connect's gc_ pending id is scrubbed from Sentry the same way;
//   - a name or an address holding <, & and " arrives escaped in the question, in the welcome after Connect and in the
//     guidance.
//
// Real: the route, telegram-connect.ts, /start (commands.ts) and its welcome, verifyUserAuth, the session cookie,
// signInRefusal and the blocklist, identities, the notice, the limits' count, the reminder cache, feature access,
// the Sentry scrubber. Faked at the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory, the rate
// limiter, error capture, the Telegram client (every send and menu button recorded), analytics (breadcrumbs
// recorded), fetch. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh (the plan's $RUN runner):
//   $RUN smoke-telegram-connect

import crypto from 'crypto';
import fs from 'fs';
import Module from 'module';
import path from 'path';
import {
  assert, baseUser, body, check, DB, everyCapture, everyLog, identityRow, installSigninWorld, load, logs, menuButtons,
  redisStore, report, request, resetWorld, ROOT, sent, sessionCookie, show, stubModule, world, type Row,
} from './lib/signin-world';

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-account-merge.ts): /start's module reaches it
const ModuleInternals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';

const DANA = 50; // browser-only, an email way, English
const NOAM = 51; // browser-only, a Google way, Hebrew
const ZOE = 52; // browser-only, suspended
const BEN = 53; // browser-only, its email address banned (Task 2's email bans)
const TAL = 9; // a Telegram account, Russian
const TAL_TG = 111111111;
const WANDA = 60; // a WhatsApp account
const NEW_TG = 333333333; // a Telegram with no FamCal account
const OTHER_TG = 444444444; // another Telegram with no FamCal account
const BANNED_TG = 555555555; // a banned Telegram id with no account
const MIN = 60_000;

function seed(): void {
  resetWorld();
  DB.user = [
    baseUser({ id: DANA, name: 'Dana', language: 'en', remindersEnabled: true }),
    baseUser({ id: NOAM, name: 'Noam', language: 'he' }),
    baseUser({ id: ZOE, name: 'Zoe', suspendedAt: new Date(Date.now() - 60 * MIN) }),
    baseUser({ id: BEN, name: 'Ben' }),
    baseUser({ id: TAL, name: 'Tal', language: 'ru', telegramId: BigInt(TAL_TG) }),
    baseUser({ id: WANDA, name: 'Wanda', messagingPlatform: 'whatsapp', whatsappPhone: '+972500000060' }),
  ];
  DB.signInIdentity = [
    identityRow({ userId: DANA, kind: 'email', subject: 'dana@gmail.com', address: 'dana@gmail.com' }),
    identityRow({ userId: NOAM, kind: 'google', subject: 'g-noam', address: 'noam@gmail.com' }),
    identityRow({ userId: ZOE, kind: 'email', subject: 'zoe@example.com', address: 'zoe@example.com' }),
    identityRow({ userId: BEN, kind: 'email', subject: 'banned@example.com', address: 'banned@example.com' }),
    identityRow({ userId: TAL, kind: 'email', subject: 'tal@example.com', address: 'tal@example.com' }),
  ];
  DB.blockedIdentifier = [
    { id: 1, telegramId: null, whatsappPhone: null, googleSub: null, email: 'banned@example.com', bannedBy: 1, bannedReason: null, createdAt: new Date() },
    { id: 2, telegramId: BigInt(BANNED_TG), whatsappPhone: null, googleSub: null, email: null, bannedBy: 1, bannedReason: null, createdAt: new Date() },
  ];
  breadcrumbs.length = 0;
}

/** What analytics was handed: the breadcrumbs (Sentry's) and the activity rows. */
const breadcrumbs: Row[] = [];
const activities: Row[] = [];
/** Every token this run made, so the end can check that none reached a log line, a capture or a breadcrumb. */
const tokens: string[] = [];

const userRow = (id: number): Row => DB.user.find(u => u.id === id) as Row;
const sentCount = (): number => sent.length;
const lastSent = (): Row => sent[sent.length - 1];
const buttonsOf = (message: Row): Row[] => message.options?.replyMarkup?.inline_keyboard?.[0] ?? [];
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const pressKeys = (): string[] => [...redisStore.keys()].filter(k => k.startsWith('tgconnect:press:'));
const MSG: Record<string, Row> = Object.fromEntries(
  ['en', 'he', 'ru'].map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]),
);
const words = (lang: string): Row => MSG[lang].bot.connect.web;

async function main() {
  await installSigninWorld();
  stubModule('src/services/analytics-service.ts', {
    addBreadcrumb: (message: string, data: Row = {}, category = '') => { breadcrumbs.push({ message, data, category }); },
    setUserContext: () => undefined,
    trackActivityAsync: (userId: number, action: string, metadata: Row = {}) => { activities.push({ userId, action, metadata }); },
    trackActivity: async () => undefined,
    ACTIVITY_RETENTION_DAYS: 90,
    ACTIVITY_PURGE_BATCH: 5000,
    purgeOldActivity: async () => 0,
  });
  const route = await load('app/api/telegram-connect/route.ts');
  const methodsRoute = await load('app/api/signin-methods/route.ts');
  const connect = await load('src/services/telegram-connect.ts');
  const { handleStartCommand } = await load('src/services/telegram/commands.ts');
  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const { scrubServerEvent, scrubServerBreadcrumb } = await load('src/lib/sentry-scrub.ts');

  const linkFor = async (userId: number, o: { method?: string; signedInAt?: number; origin?: string | null } = {}) =>
    route.POST(request(`/api/telegram-connect?user_id=${userId}`, {
      body: {},
      cookie: await sessionCookie(userId, o.method ?? 'email', o.signedInAt ?? Date.now() - 5 * MIN),
      origin: o.origin,
    }));
  /** A fresh link for a browser account: its token. */
  const tokenFor = async (userId: number): Promise<string> => {
    const res = await linkFor(userId);
    const answer = await body(res);
    assert(res.status === 200 && typeof answer.url === 'string', `link for ${userId}: ${res.status} ${show(answer)}`);
    const token = new URL(answer.url).searchParams.get('start')!.slice('w_'.length);
    tokens.push(token);
    return token;
  };
  /** /start w_<token> from a Telegram id in its private chat with the bot, as the webhook passes it (the deep link's payload in args, the chat's type). */
  const start = (telegramId: number, payload: string, languageCode = 'en') =>
    handleStartCommand(telegramId, telegramId, 'telegram', { id: telegramId, first_name: 'Someone', language_code: languageCode }, payload, 'private');
  /** The press id on the question's Connect button. */
  const pressIdOf = (message: Row): string => {
    const [yes, no] = buttonsOf(message);
    assert(typeof yes?.callback_data === 'string' && yes.callback_data.startsWith('tgc:'), `no Connect button: ${show(message.options)}`);
    assert(no?.callback_data === `tgc-no:${yes.callback_data.slice(4)}`, `the Cancel button carries another id: ${show(buttonsOf(message))}`);
    return yes.callback_data.slice(4);
  };
  /** A link, opened by a Telegram with no account: the press id of the question it got. */
  const askedBy = async (userId: number, telegramId: number): Promise<string> => {
    await start(telegramId, `w_${await tokenFor(userId)}`);
    return pressIdOf(lastSent());
  };
  const press = (telegramId: number, pressId: string) => connect.handleConnectPress(telegramId, telegramId, pressId, 'en');

  // ---- The link ----

  await check('the link: refused for an account with a chat (Telegram, WhatsApp): 409 has-chat, and no link is kept', async () => {
    seed();
    for (const id of [TAL, WANDA]) {
      const res = await linkFor(id);
      const answer = await body(res);
      assert(res.status === 409 && answer.error === 'has-chat', `user ${id}: ${res.status} ${show(answer)}`);
    }
    assert(![...redisStore.keys()].some(k => k.startsWith('tgconnect:')), `a link was kept: ${show([...redisStore.keys()])}`);
  });

  await check('the link: refused for a sign-in over an hour old and for a WhatsApp link\'s session (403 stale-sign-in); a sign-in 59 minutes ago gets one', async () => {
    seed();
    const old = await linkFor(DANA, { signedInAt: Date.now() - 61 * MIN });
    assert(old.status === 403 && (await body(old)).error === 'stale-sign-in', `an old sign-in: ${old.status} ${show(await body(old))}`);
    const wa = await linkFor(DANA, { method: 'wa' });
    assert(wa.status === 403 && (await body(wa)).error === 'stale-sign-in', `a WhatsApp session: ${wa.status} ${show(await body(wa))}`);
    const recent = await linkFor(DANA, { signedInAt: Date.now() - 59 * MIN });
    assert(recent.status === 200 && typeof (await body(recent)).url === 'string', `59 minutes: ${recent.status} ${show(await body(recent))}`);
  });

  await check('the hour is the shared helper\'s (src/lib/recent-sign-in.ts): Connect Telegram defines no hour of its own, and the link\'s edge is the helper\'s (59:59 passes, 60:00 is refused; a WhatsApp session never passes)', async () => {
    seed();
    const source = fs.readFileSync(path.join(ROOT, 'src/services/telegram-connect.ts'), 'utf8');
    assert(!/const RECENT_SIGN_IN_MS/.test(source) && /from '\.\.\/lib\/recent-sign-in'/.test(source), 'telegram-connect.ts keeps its own hour or does not import the helper');
    const { RECENT_SIGN_IN_MS } = await load('src/lib/recent-sign-in.ts');
    assert(RECENT_SIGN_IN_MS === 60 * MIN, `the helper's hour is ${RECENT_SIGN_IN_MS}`);
    const edge = await linkFor(DANA, { signedInAt: Date.now() - RECENT_SIGN_IN_MS + 5_000 });
    assert(edge.status === 200, `just inside the hour: ${edge.status} ${show(await body(edge))}`);
    const over = await linkFor(DANA, { signedInAt: Date.now() - RECENT_SIGN_IN_MS - 1 });
    assert(over.status === 403 && (await body(over)).error === 'stale-sign-in', `just past the hour: ${over.status} ${show(await body(over))}`);
  });

  // ---- [C1] Removing a way never restarts the hour ----

  const removeRoute = await load('app/api/signin-methods/remove/route.ts');
  const { SESSION_COOKIE_NAME, validateSessionToken } = await load('src/lib/session-auth.ts');
  /** Settings' Remove from this browser: the route's response. */
  const removeWay = (userId: number, which: string, cookie: string) =>
    removeRoute.POST(request(`/api/signin-methods/remove?user_id=${userId}`, { body: { which }, cookie }));
  /** The session cookie a response set, as a Cookie header, or null when it set none. */
  const setSession = (res: Row): string | null => {
    const value = res.cookies.get(SESSION_COOKIE_NAME)?.value;
    return value ? `${SESSION_COOKIE_NAME}=${value}` : null;
  };
  const linkWith = (userId: number, cookie: string) => route.POST(request(`/api/telegram-connect?user_id=${userId}`, { body: {}, cookie }));
  const DAY_MS = 24 * 60 * MIN;

  await check('[C1] a session signed in 3 days ago that removes a way is not signed in again: after a removal that changed nothing, and after one that removed something (a fresh cookie for this device), the link is still 403 stale-sign-in', async () => {
    seed();
    const PROVED = Date.now() - 3 * DAY_MS;
    const old = await sessionCookie(DANA, 'email', PROVED);
    userRow(DANA).googleCalendarSignIn = false;
    const none = await removeWay(DANA, 'calendar-google', old);
    assert(none.status === 200 && userRow(DANA).sessionsValidAfter === null, `nothing to remove: ${none.status} ${show(await body(none))}`);
    const afterNone = await linkWith(DANA, setSession(none) ?? old);
    assert(afterNone.status === 403 && (await body(afterNone)).error === 'stale-sign-in', `after a removal of nothing: ${afterNone.status} ${show(await body(afterNone))}`);
    userRow(DANA).googleCalendarSignIn = true;
    const removed = await removeWay(DANA, 'calendar-google', old);
    assert(removed.status === 200 && userRow(DANA).sessionsValidAfter instanceof Date, `a removal: ${removed.status} ${show(await body(removed))}`);
    const fresh = setSession(removed);
    assert(fresh, 'a removal gave this device no cookie');
    const session = validateSessionToken(fresh.slice(SESSION_COOKIE_NAME.length + 1));
    assert(session?.provedAt === PROVED && session.signedInAt >= userRow(DANA).sessionsValidAfter.getTime(), `the device's cookie ${show(session)}`);
    const afterRemoved = await linkWith(DANA, fresh);
    assert(afterRemoved.status === 403 && (await body(afterRemoved)).error === 'stale-sign-in', `after a removal: ${afterRemoved.status} ${show(await body(afterRemoved))}`);
    assert(![...redisStore.keys()].some(k => k.startsWith('tgconnect:')), 'a link was kept');
  });

  await check('[C1] a removal that changes nothing (the calendar switch already off, no such way) sets no session cookie, and the device\'s own cookie still works', async () => {
    seed();
    userRow(DANA).googleCalendarSignIn = false;
    const cookie = await sessionCookie(DANA, 'email', Date.now() - 3 * DAY_MS);
    for (const which of ['calendar-google', 'google']) {
      const res = await removeWay(DANA, which, cookie);
      const setCookies = (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie();
      assert(res.status === 200 && setSession(res) === null && !setCookies.some(l => l.startsWith(`${SESSION_COOKIE_NAME}=`)), `${which}: ${res.status} set-cookie ${show(setCookies)}`);
    }
    const still = await methodsRoute.GET(request(`/api/signin-methods?user_id=${DANA}`, { cookie }));
    assert(still.status === 200 && userRow(DANA).sessionsValidAfter === null, `the cookie after: ${still.status}`);
  });

  await check('[C1] a fresh sign-in that removes a way keeps its hour: the device\'s new cookie still gets a link, and the old cookie is ended', async () => {
    seed();
    const cookie = await sessionCookie(DANA, 'email', Date.now() - 5 * MIN);
    const removed = await removeWay(DANA, 'calendar-google', cookie);
    const fresh = setSession(removed);
    assert(removed.status === 200 && fresh, `a removal: ${removed.status} ${show(await body(removed))}`);
    const res = await linkWith(DANA, fresh);
    assert(res.status === 200 && typeof (await body(res)).url === 'string', `the link after: ${res.status} ${show(await body(res))}`);
    tokens.push(new URL((await body(res)).url).searchParams.get('start')!.slice('w_'.length));
    const old = await linkWith(DANA, cookie);
    assert(old.status === 401, `the old cookie: ${old.status} ${show(await body(old))}`);
  });

  await check('the link: 5 an hour per account; the 6th is 429 limit', async () => {
    seed();
    for (let i = 1; i <= 5; i++) await tokenFor(DANA);
    const sixth = await linkFor(DANA);
    assert(sixth.status === 429 && (await body(sixth)).error === 'limit', `6th: ${sixth.status} ${show(await body(sixth))}`);
    const other = await linkFor(NOAM);
    assert(other.status === 200, `another account has its own count: ${other.status}`);
  });

  await check('the link: a request from another site, or with no Origin, is refused before anything is read', async () => {
    seed();
    for (const origin of ['https://evil.example', null]) {
      const res = await linkFor(DANA, { origin });
      assert(res.status === 403 && (await body(res)).error === 'cross_site', `${origin}: ${res.status} ${show(await body(res))}`);
    }
    assert(![...redisStore.keys()].some(k => k.startsWith('tgconnect:')), 'a link was kept');
  });

  await check('the link: t.me/<bot>?start=w_<22 characters>; Redis keeps tgconnect:<sha256 of the token> -> the account, and the token itself nowhere', async () => {
    seed();
    const res = await linkFor(DANA);
    const { url } = await body(res);
    const m = /^https:\/\/t\.me\/famcal_test_bot\?start=w_([A-Za-z0-9_-]{22})$/.exec(url);
    assert(m, `url ${url}`);
    tokens.push(m[1]);
    const stored = redisStore.get(REDIS_KEYS.telegramConnect(sha256(m[1])));
    assert(stored && JSON.parse(stored).userId === DANA, `stored ${stored}`);
    const everywhere = [...redisStore.entries()].flat().join('\n');
    assert(!everywhere.includes(m[1]), 'the token is in Redis in clear');
  });

  // ---- /start w_ ----

  await check('/start w_ from a Telegram with no account: the question names the account and its FULL address, with Connect and Cancel on one press id bound to that Telegram; no account is made and the link is not used up', async () => {
    seed();
    const token = await tokenFor(DANA);
    const users = DB.user.length;
    await start(NEW_TG, `w_${token}`);
    assert(DB.user.length === users, `an account was made: ${show(DB.user.map(u => u.id))}`);
    assert(sentCount() === 1 && sent[0].chatId === String(NEW_TG), `sent ${show(sent)}`);
    const q = sent[0];
    assert(q.text.includes('Dana') && q.text.includes('dana@gmail.com') && !q.text.includes('•••'), `the question: ${q.text}`);
    assert(q.text.startsWith('Connect this Telegram to the FamCal account'), `not the English question: ${q.text}`);
    assert(show(buttonsOf(q).map(b => b.text)) === show([words('en').connect, words('en').cancel]), `buttons ${show(buttonsOf(q))}`);
    const pressId = pressIdOf(q);
    const record = JSON.parse(redisStore.get(REDIS_KEYS.telegramConnectPress(pressId)) ?? 'null');
    assert(record?.userId === DANA && record?.telegramId === NEW_TG && record?.linkHash === sha256(token), `press record ${show(record)}`);
    assert(redisStore.has(REDIS_KEYS.telegramConnect(sha256(token))), 'the link was used up by /start');
    assert(userRow(DANA).telegramId === null, 'connected before the press');
    assert(!activities.some(a => a.action === 'bot_start'), `/start went on to the welcome path: ${show(activities)}`);
  });

  await check('/start w_ in Hebrew: the question is in the browser account\'s language, with its name and full Google address', async () => {
    seed();
    await start(NEW_TG, `w_${await tokenFor(NOAM)}`);
    const q = lastSent();
    assert(/[֐-׿]/.test(q.text) && q.text.includes('Noam') && q.text.includes('noam@gmail.com'), `the question: ${q.text}`);
    assert(show(buttonsOf(q).map(b => b.text)) === show([words('he').connect, words('he').cancel]), `buttons ${show(buttonsOf(q))}`);
  });

  await check('[M7] /start w_ outside a private chat (a group, a supergroup, a channel, no chat type): nothing is sent, no question is kept, no account is made, the link is not used, and the line names the chat type only; the same link then works in the private chat', async () => {
    seed();
    const token = await tokenFor(DANA);
    const users = DB.user.length;
    const mark = everyLog.length;
    for (const [chatId, type] of [[-1001234567890, 'supergroup'], [-4567890, 'group'], [-1009876543210, 'channel'], [NEW_TG, undefined]] as const) {
      await handleStartCommand(chatId, NEW_TG, 'telegram', { id: NEW_TG, first_name: 'Someone', language_code: 'en' }, `w_${token}`, type);
    }
    assert(sentCount() === 0, `sent ${show(sent)}`);
    assert(pressKeys().length === 0 && DB.user.length === users && redisStore.has(REDIS_KEYS.telegramConnect(sha256(token))), 'a question, an account, or the link used up');
    const lines = everyLog.slice(mark).filter(l => l.startsWith('[tg-connect]'));
    assert(lines.length === 4 && ['supergroup', 'group', 'channel', 'unknown'].every((t, i) => lines[i].includes(`in a ${t} chat`)), `lines ${show(lines)}`);
    assert(!lines.some(l => l.includes(token) || l.includes('-100') || l.includes(String(NEW_TG))), `a line holds the token or an id: ${show(lines)}`);
    assert(!activities.some(a => a.action === 'bot_start'), `/start went on to the welcome path: ${show(activities)}`);
    await start(NEW_TG, `w_${token}`);
    assert(pressKeys().length === 1 && lastSent().text.startsWith('Connect this Telegram to the FamCal account'), `the private chat: ${lastSent()?.text}`);
  });

  await check('/start w_ with a token that is not a link (made up, malformed, or expired) answers "expired", makes no account and no question', async () => {
    seed();
    const users = DB.user.length;
    for (const payload of ['w_AAAAAAAAAAAAAAAAAAAAAA', 'w_short', 'w_']) await start(NEW_TG, payload);
    assert(DB.user.length === users, 'an account was made');
    assert(sentCount() === 3 && sent.every(s => s.text === words('en').expired), `replies ${show(sent.map(s => s.text))}`);
    assert(pressKeys().length === 0, 'a question was kept');
  });

  await check('/start w_ from a Telegram that has an account: the guidance in its language names Add email (the browser account\'s way) and the address, with Open Settings; nothing is joined', async () => {
    seed();
    const token = await tokenFor(DANA);
    await start(TAL_TG, `w_${token}`, 'ru');
    const g = lastSent();
    assert(g.text === words('ru').hasAccountEmail.replace('{address}', '⁦dana@gmail.com⁩'), `guidance ${g.text}`);
    assert(g.text.includes('«Добавить почту»'), `the guidance does not name Add email: ${g.text}`);
    const [open] = buttonsOf(g);
    assert(open?.text === words('ru').openSettings && String(open?.web_app?.url).includes(`/ru/settings?user_id=${TAL_TG}`), `button ${show(open)}`);
    assert(pressKeys().length === 0, 'a question was kept');
    assert(userRow(DANA) && userRow(DANA).telegramId === null && String(userRow(TAL).telegramId) === String(TAL_TG), 'an account changed');
  });

  await check('/start w_ from a Telegram that has an account, for a Google browser account: the guidance names Add Google', async () => {
    seed();
    await start(TAL_TG, `w_${await tokenFor(NOAM)}`, 'ru');
    assert(lastSent().text.includes('«Добавить Google»') && lastSent().text.includes('noam@gmail.com'), `guidance ${lastSent().text}`);
  });

  await check('/start w_ for a suspended or banned browser account: refused, no question', async () => {
    seed();
    // A link made while the account was fine; it is suspended or banned before the bot is opened
    const zoe = await tokenFor(DANA);
    redisStore.set(REDIS_KEYS.telegramConnect(sha256(zoe)), JSON.stringify({ userId: ZOE }));
    await start(NEW_TG, `w_${zoe}`);
    assert(lastSent().text === words('en').refused, `suspended: ${lastSent().text}`);
    const ben = await tokenFor(DANA);
    redisStore.set(REDIS_KEYS.telegramConnect(sha256(ben)), JSON.stringify({ userId: BEN }));
    await start(NEW_TG, `w_${ben}`);
    assert(lastSent().text === words('en').refused, `banned (Task 2's email bans): ${lastSent().text}`);
    assert(pressKeys().length === 0, 'a question was kept');
  });

  // ---- The press ----

  await check('Connect: the Telegram id and messagingPlatform telegram on the browser account; both records used up; feature access invalidated; the reminder cache rebuilt; the menu button; connected, then the welcome with the dashboard button', async () => {
    seed();
    redisStore.set(REDIS_KEYS.featureAccess(DANA, 'reminders'), JSON.stringify({ allowed: false }));
    const pressId = await askedBy(DANA, NEW_TG);
    const linkKeys = [...redisStore.keys()].filter(k => k.startsWith('tgconnect:') && !k.startsWith('tgconnect:press:'));
    sent.length = 0;
    await press(NEW_TG, pressId);
    const row = userRow(DANA);
    assert(String(row.telegramId) === String(NEW_TG) && row.messagingPlatform === 'telegram', `row ${show(row)}`);
    assert(![...redisStore.keys()].some(k => k.startsWith('tgconnect:')), `records left: ${show([...redisStore.keys()].filter(k => k.startsWith('tgconnect:')))} (link keys were ${show(linkKeys)})`);
    assert(!redisStore.has(REDIS_KEYS.featureAccess(DANA, 'reminders')), 'feature access was not invalidated');
    const cache = JSON.parse(redisStore.get(REDIS_KEYS.REMINDER_USERS) ?? '[]') as Row[];
    assert(cache.some(e => e.id === DANA && e.telegramId === String(NEW_TG)), `reminder cache ${show(cache)}`);
    assert(show(menuButtons) === show([[NEW_TG, 'en']]), `menu buttons ${show(menuButtons)}`);
    assert(sentCount() === 2 && sent.every(s => s.chatId === String(NEW_TG)), `sent ${show(sent)}`);
    assert(sent[0].text === words('en').connected, `first ${sent[0].text}`);
    const welcome = sent[1];
    assert(welcome.text.startsWith(MSG.en.bot.start.welcome.replace('{name}', 'Dana')), `welcome ${welcome.text}`);
    const [dashboard] = buttonsOf(welcome);
    assert(dashboard?.text === MSG.en.bot.start.dashboard && String(dashboard?.web_app?.url).endsWith(`/en/dashboard?user_id=${NEW_TG}`), `button ${show(dashboard)}`);
  });

  await check('Connect: the notice is sent for the account as it was (with no chat), and the browser session stays valid', async () => {
    seed();
    const cookie = await sessionCookie(DANA, 'email', Date.now() - 5 * MIN);
    await press(NEW_TG, await askedBy(DANA, NEW_TG));
    assert(everyLog.some(l => l.startsWith('[signin-notice]') && l.includes(`user ${DANA}`)), `no notice line: ${show(logs.filter(l => l.includes('signin-notice')))}`);
    assert(userRow(DANA).sessionsValidAfter === null, 'sessions were ended');
    const res = await methodsRoute.GET(request(`/api/signin-methods?user_id=${DANA}`, { cookie }));
    const answer = await body(res);
    assert(res.status === 200 && answer.telegram === true && answer.session === 'email', `the browser: ${res.status} ${show(answer)}`);
  });

  await check('a second press of the same question, or the used link opened again: "expired", nothing changes', async () => {
    seed();
    const token = await tokenFor(DANA);
    await start(NEW_TG, `w_${token}`);
    const pressId = pressIdOf(lastSent());
    await press(NEW_TG, pressId);
    const after = show(userRow(DANA));
    await press(NEW_TG, pressId);
    assert(lastSent().text === words('en').expired, `second press: ${lastSent().text}`);
    await start(OTHER_TG, `w_${token}`);
    assert(lastSent().text === words('en').expired, `the link again: ${lastSent().text}`);
    assert(show(userRow(DANA)) === after, 'the account changed');
  });

  await check('two questions from one link: the first press wins, the other answers "expired" (the link is taken with the press)', async () => {
    seed();
    const token = await tokenFor(DANA);
    await start(NEW_TG, `w_${token}`);
    const first = pressIdOf(lastSent());
    await start(NEW_TG, `w_${token}`);
    const second = pressIdOf(lastSent());
    await press(NEW_TG, first);
    await press(NEW_TG, second);
    assert(lastSent().text === words('en').expired && String(userRow(DANA).telegramId) === String(NEW_TG), `${lastSent().text}`);
  });

  await check('a press from another Telegram id: "not yours", nothing connected; the link stays for the right Telegram', async () => {
    seed();
    const token = await tokenFor(DANA);
    await start(NEW_TG, `w_${token}`);
    const pressId = pressIdOf(lastSent());
    await press(OTHER_TG, pressId);
    assert(lastSent().chatId === String(OTHER_TG) && lastSent().text === words('en').notYours, `reply ${show(lastSent())}`);
    assert(userRow(DANA).telegramId === null, 'connected');
    assert(redisStore.has(REDIS_KEYS.telegramConnect(sha256(token))), 'the link was used up by a stranger');
    // [M7] the stranger's tap does not use up the question: the asked Telegram's press of the same question connects
    assert(redisStore.has(REDIS_KEYS.telegramConnectPress(pressId)), 'the question was used up by a stranger');
    await press(NEW_TG, pressId);
    assert(String(userRow(DANA).telegramId) === String(NEW_TG), `the asked Telegram could not connect with the same question: ${lastSent().text}`);
    // It may also open the link again after the stranger's tap (a new question) and connect with that one
    seed();
    const again = await tokenFor(DANA);
    await start(NEW_TG, `w_${again}`);
    await press(OTHER_TG, pressIdOf(lastSent()));
    await start(NEW_TG, `w_${again}`);
    await press(NEW_TG, pressIdOf(lastSent()));
    assert(String(userRow(DANA).telegramId) === String(NEW_TG), 'the right Telegram could not connect after the stranger');
  });

  await check('expired: the link\'s 10 minutes or the question\'s 10 minutes are over before the press: "expired", nothing connected', async () => {
    seed();
    let pressId = await askedBy(DANA, NEW_TG);
    for (const k of [...redisStore.keys()]) if (k.startsWith('tgconnect:') && !k.startsWith('tgconnect:press:')) redisStore.delete(k);
    await press(NEW_TG, pressId);
    assert(lastSent().text === words('en').expired && userRow(DANA).telegramId === null, `link gone: ${lastSent().text}`);
    pressId = await askedBy(DANA, NEW_TG);
    redisStore.delete(REDIS_KEYS.telegramConnectPress(pressId));
    await press(NEW_TG, pressId);
    assert(lastSent().text === words('en').expired && userRow(DANA).telegramId === null, `question gone: ${lastSent().text}`);
    await press(NEW_TG, 'not-an-id');
    assert(lastSent().text === words('en').expired, `a malformed id: ${lastSent().text}`);
  });

  await check('refused at the press: the account suspended or banned in between, or the pressing Telegram id banned; nothing connected', async () => {
    seed();
    let pressId = await askedBy(DANA, NEW_TG);
    userRow(DANA).suspendedAt = new Date();
    await press(NEW_TG, pressId);
    assert(lastSent().text === words('en').refused && userRow(DANA).telegramId === null, `suspended: ${lastSent().text}`);
    userRow(DANA).suspendedAt = null;
    pressId = await askedBy(DANA, BANNED_TG);
    await press(BANNED_TG, pressId);
    assert(lastSent().text === words('en').refused && userRow(DANA).telegramId === null, `a banned Telegram id: ${lastSent().text}`);
    const banned = await tokenFor(DANA);
    await start(NEW_TG, `w_${banned}`);
    pressId = pressIdOf(lastSent());
    // Ben's address is banned (Task 2): point this question at Ben
    const record = JSON.parse(redisStore.get(REDIS_KEYS.telegramConnectPress(pressId))!);
    redisStore.set(REDIS_KEYS.telegramConnectPress(pressId), JSON.stringify({ ...record, userId: BEN }));
    redisStore.set(REDIS_KEYS.telegramConnect(record.linkHash), JSON.stringify({ userId: BEN }));
    await press(NEW_TG, pressId);
    assert(lastSent().text === words('en').refused && userRow(BEN).telegramId === null, `banned account: ${lastSent().text}`);
  });

  await check('a Telegram that made its own account between the question and the press gets the guidance, and nothing is joined', async () => {
    seed();
    const pressId = await askedBy(DANA, NEW_TG);
    DB.user.push(baseUser({ id: 70, name: 'New', telegramId: BigInt(NEW_TG) }));
    await press(NEW_TG, pressId);
    assert(lastSent().text.includes('dana@gmail.com') && lastSent().text === words('en').hasAccountEmail.replace('{address}', '⁦dana@gmail.com⁩'), `reply ${lastSent().text}`);
    assert(userRow(DANA).telegramId === null && DB.user.length === 7, 'joined or connected');
  });

  await check('an account that got a chat in between (connected from another question): "expired"', async () => {
    seed();
    const pressId = await askedBy(DANA, NEW_TG);
    userRow(DANA).telegramId = BigInt(OTHER_TG);
    await press(NEW_TG, pressId);
    assert(lastSent().text === words('en').expired && String(userRow(DANA).telegramId) === String(OTHER_TG), `reply ${lastSent().text}`);
  });

  // The conditional write is the race fix: every check above changes state BEFORE the press, where handleConnectPress's
  // own re-reads catch it. These change state between the last read and the write, so only the UPDATE ... WHERE (and the
  // unique telegramId) can stop it.
  const duringWrite = async (inBetween: () => void, pressId: string): Promise<void> => {
    const { prisma } = await load('src/utils/prisma.ts');
    const real = prisma.user.updateMany;
    prisma.user.updateMany = async (a: Row) => { inBetween(); return real(a); };
    try {
      await press(NEW_TG, pressId);
    } finally {
      prisma.user.updateMany = real;
    }
  };

  await check('race at the write: the account suspended after the last read -> not connected, "expired"', async () => {
    seed();
    const pressId = await askedBy(DANA, NEW_TG);
    await duringWrite(() => { userRow(DANA).suspendedAt = new Date(); }, pressId);
    assert(userRow(DANA).telegramId === null, `connected: ${show(userRow(DANA))}`);
    assert(lastSent().text === words('en').expired, `reply ${lastSent().text}`);
    assert(menuButtons.length === 0, `after-connect ran: ${show(menuButtons)}`);
  });

  await check('race at the write: the account got a chat after the last read -> its Telegram id stays, "expired"', async () => {
    seed();
    const pressId = await askedBy(DANA, NEW_TG);
    await duringWrite(() => { userRow(DANA).telegramId = BigInt(OTHER_TG); }, pressId);
    assert(String(userRow(DANA).telegramId) === String(OTHER_TG), `overwritten: ${show(userRow(DANA))}`);
    assert(lastSent().text === words('en').expired && menuButtons.length === 0, `reply ${lastSent().text}`);
  });

  await check('race at the write: the unique telegramId refuses (P2002) because the Telegram made its own account -> the guidance, nothing connected, nothing captured', async () => {
    seed();
    const pressId = await askedBy(DANA, NEW_TG);
    const captures = everyCapture.length;
    const { prisma } = await load('src/utils/prisma.ts');
    const real = prisma.user.updateMany;
    prisma.user.updateMany = async () => {
      DB.user.push(baseUser({ id: 70, name: 'New', telegramId: BigInt(NEW_TG) }));
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    };
    try {
      await press(NEW_TG, pressId);
    } finally {
      prisma.user.updateMany = real;
    }
    assert(lastSent().text === words('en').hasAccountEmail.replace('{address}', '⁦dana@gmail.com⁩'), `reply ${lastSent().text}`);
    assert(userRow(DANA).telegramId === null, 'connected');
    assert(everyCapture.length === captures, `captured ${show(everyCapture.slice(captures))}`);
  });

  await check('after the write: a failing menu button is captured, and the person still gets "connected", the welcome and the notice', async () => {
    seed();
    const pressId = await askedBy(DANA, NEW_TG);
    sent.length = 0;
    const captures = everyCapture.length;
    world.menuButtonFails = true;
    try {
      await press(NEW_TG, pressId);
    } finally {
      world.menuButtonFails = false;
    }
    assert(String(userRow(DANA).telegramId) === String(NEW_TG), 'not connected');
    assert(everyCapture.slice(captures).some(c => c.context === 'tg-connect-after'), `captures ${show(everyCapture.slice(captures).map(c => c.context))}`);
    assert(sentCount() === 2 && sent[0].text === words('en').connected, `sent ${show(sent.map(s => s.text))}`);
    assert(sent[1].text.startsWith(MSG.en.bot.start.welcome.replace('{name}', 'Dana')), `welcome ${sent[1]?.text}`);
    assert(everyLog.some(l => l.startsWith('[signin-notice]') && l.includes(`user ${DANA}`)), 'no notice line');
  });

  await check('Cancel: both records dropped and "cancelled"; Connect afterwards is "expired"; a Cancel from another Telegram changes nothing', async () => {
    seed();
    let pressId = await askedBy(DANA, NEW_TG);
    await connect.handleConnectCancel(OTHER_TG, OTHER_TG, pressId, 'en');
    assert(lastSent().text === words('en').notYours && pressKeys().length === 1, `stranger's cancel: ${lastSent().text}`);
    await connect.handleConnectCancel(NEW_TG, NEW_TG, pressId, 'en');
    assert(lastSent().text === words('en').cancelled, `cancel: ${lastSent().text}`);
    assert(![...redisStore.keys()].some(k => k.startsWith('tgconnect:')), 'a record is left');
    await press(NEW_TG, pressId);
    assert(lastSent().text === words('en').expired && userRow(DANA).telegramId === null, `connect after cancel: ${lastSent().text}`);
    pressId = await askedBy(DANA, NEW_TG);
    await press(NEW_TG, pressId);
    assert(String(userRow(DANA).telegramId) === String(NEW_TG), 'a new link after Cancel did not connect');
  });

  await check('a failed reply is logged and captured, never thrown', async () => {
    seed();
    const token = await tokenFor(DANA);
    world.telegramFails = true;
    await start(NEW_TG, `w_${token}`);
    world.telegramFails = false;
    assert(everyCapture.some(c => c.context === 'tg-connect-reply'), `captures ${show(everyCapture.map(c => c.context))}`);
  });

  // ---- The token stays out of logs, breadcrumbs, captures and Sentry ----

  await check('no token of this run is in a console line, a breadcrumb or a capture', () => {
    assert(tokens.length > 10, `tokens ${tokens.length}`);
    const haystack = [...everyLog, ...everyCapture.map(c => show(c)), ...breadcrumbs.map(b => show(b))].join('\n');
    const leaked = tokens.filter(t => haystack.includes(t));
    assert(leaked.length === 0, `leaked ${leaked.length} token(s)`);
    assert(!breadcrumbs.some(b => b.message === 'command_started' && String(b.data?.args ?? '').startsWith('w_')), 'the /start breadcrumb ran for w_');
  });

  await check('Sentry: the webhook body\'s "/start w_<token>" and a breadcrumb quoting w_<token> come out scrubbed', () => {
    const token = tokens[0];
    const update = { update_id: 1, message: { message_id: 2, from: { id: NEW_TG }, chat: { id: NEW_TG }, text: `/start w_${token}` } };
    for (const data of [update, JSON.stringify(update)]) {
      const event = scrubServerEvent({ request: { url: 'https://famcal.bot/api/webhook', data } });
      const out = typeof event.request.data === 'string' ? event.request.data : JSON.stringify(event.request.data);
      assert(!out.includes(token) && out.includes('/start w_[scrubbed]'), `event body ${out}`);
    }
    const crumb = scrubServerBreadcrumb({ category: 'command', message: 'command_started', data: { args: `w_${token}` } });
    assert(!show(crumb).includes(token), `breadcrumb ${show(crumb)}`);
    const plain = scrubServerEvent({ request: { data: { message: { text: 'new_member w_ok' } } } });
    assert(show(plain.request.data) === show({ message: { text: 'new_member w_ok' } }), `a body without a token changed: ${show(plain.request.data)}`);
  });

  await check('Sentry: the Google connect\'s pending id (gc_ + 32 characters) in a webhook body or a breadcrumb comes out scrubbed too; a lookalike of another length is left', () => {
    const id = crypto.randomBytes(24).toString('base64url'); // 32 characters, as google-connect.ts makes it
    assert(id.length === 32, `id ${id.length}`);
    const update = { update_id: 1, message: { message_id: 2, from: { id: NEW_TG }, chat: { id: NEW_TG }, text: `/start gc_${id}` } };
    for (const data of [update, JSON.stringify(update), { message: { text: `hello gc_${id} please` } }]) {
      const event = scrubServerEvent({ request: { url: 'https://famcal.bot/api/webhook', data } });
      const out = typeof event.request.data === 'string' ? event.request.data : JSON.stringify(event.request.data);
      assert(!out.includes(id) && out.includes('gc_[scrubbed]'), `event body ${out}`);
    }
    const crumb = scrubServerBreadcrumb({ category: 'command', message: 'command_started', data: { args: `gc_${id}` } });
    assert(!show(crumb).includes(id), `breadcrumb ${show(crumb)}`);
    const lookalike = { message: { text: `/start gc_${id.slice(0, 31)} and gc_${id}x` } };
    const kept = JSON.stringify(scrubServerEvent({ request: { data: lookalike } }).request.data);
    assert(kept.includes(id.slice(0, 31)) && kept.includes(`gc_${id}x`), `a lookalike was changed: ${kept}`);
  });

  // ---- Escaping (Rf3, bot half) ----

  await check('a name holding <b>&"x"</b> (and an address holding <, & and ") arrives escaped: in the question, in the welcome after Connect, and in the guidance', async () => {
    seed();
    const NAME = '<b>&"x"</b>';
    const NAME_ESCAPED = '&lt;b&gt;&amp;"x"&lt;/b&gt;';
    const ADDRESS = 'r&d"<x>@example.com';
    const ADDRESS_ESCAPED = 'r&amp;d"&lt;x&gt;@example.com';
    userRow(DANA).name = NAME;
    (DB.signInIdentity.find(i => i.userId === DANA) as Row).address = ADDRESS;
    // The guidance: a Telegram that has its own account opens the link
    await start(TAL_TG, `w_${await tokenFor(DANA)}`);
    assert(lastSent().text.includes(ADDRESS_ESCAPED) && !lastSent().text.includes(ADDRESS), `guidance ${lastSent().text}`);
    // The question: a Telegram with no account
    await start(NEW_TG, `w_${await tokenFor(DANA)}`);
    const question = lastSent();
    assert(question.text.includes(NAME_ESCAPED) && !question.text.includes(NAME), `question ${question.text}`);
    assert(question.text.includes(ADDRESS_ESCAPED) && !question.text.includes(ADDRESS), `question address ${question.text}`);
    // The welcome after Connect
    await press(NEW_TG, pressIdOf(question));
    const welcome = lastSent();
    assert(String(userRow(DANA).telegramId) === String(NEW_TG), 'not connected');
    assert(welcome.text.includes(NAME_ESCAPED) && !welcome.text.includes(NAME), `welcome ${welcome.text}`);
  });

  // ---- Wiring ----

  await check('wiring: /start answers w_ before its breadcrumb and auto-registration; the callback router answers tgc: and tgc-no: (spinner first); smoke-pause lists the new senders', () => {
    const commands = fs.readFileSync(path.join(ROOT, 'src/services/telegram/commands.ts'), 'utf8');
    const startFn = commands.slice(commands.indexOf('export async function handleStartCommand'));
    const w = startFn.indexOf("args?.startsWith('w_')");
    assert(w > 0 && w < startFn.indexOf("addBreadcrumb('command_started'") && w < startFn.indexOf('getOrCreateUser('), 'w_ is not answered first');
    const router = fs.readFileSync(path.join(ROOT, 'src/services/webhook-handlers.ts'), 'utf8');
    const branch = router.slice(router.indexOf("data.startsWith('tgc:')"), router.indexOf("data.startsWith('nr:')"));
    assert(branch.includes('answerCallbackQuery(queryId)') && branch.includes('handleConnectPress(') && branch.includes('handleConnectCancel('), `router ${branch.slice(0, 200)}`);
    assert(branch.indexOf('answerCallbackQuery') < branch.indexOf('handleConnectPress('), 'the spinner is answered after the reply');
    const pause = fs.readFileSync(path.join(ROOT, 'scripts/smoke-pause.ts'), 'utf8');
    assert(pause.includes("'src/services/telegram-connect.ts':") && pause.includes("'src/services/telegram/welcome.ts':"), 'smoke-pause does not list the new senders');
  });

  report();
}

main().catch(err => {
  console.error = () => undefined;
  process.stdout.write(`smoke crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
