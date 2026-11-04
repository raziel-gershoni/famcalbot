// Smoke test for the one creation step (web sign-up spec 2026-11-03 §2.7, §3.5, §3.8; plan 6c-1 Task 1). Every new
// FamCal account, from the bot's /start, a first WhatsApp message or a sign-up on famcal.bot, is made by createAccount
// (src/services/user-service.ts). The steps, in order:
//   - the blocklist, for that way's own identifier (a Google sign-up's verified address too);
//   - the user row (and, for the web only, its sign-in way in one transaction with it);
//   - its first FamCal calendar (a failure is logged and reported, and the account stands);
//   - one log line that names the user id and the way only.
//
// What it pins:
//   - the data: BlockedIdentifier's googleSub and email columns (unique), the hand-written migration that adds them on
//     deploy (additions only, safe to run twice), and the generated client that knows them;
//   - the scan: no other User create (create, createMany, upsert) in src/ or app/; getOrCreateUser and
//     getOrCreateUserByWhatsApp keep their lookups and create only through createAccount;
//   - each path's row:
//     - the shared defaults;
//     - Telegram's name and language, WhatsApp's ids and language, the web's typed name and page language;
//     - one primary calendar;
//     - an existing account is returned, never made again;
//   - the web:
//     - one user, one way and one calendar, the user and the way in one transaction, after the ban check;
//     - a way someone took meanwhile (P2002) rolls the user back and makes no calendar;
//     - web_signup is recorded;
//   - the ban check:
//     - AccountBlockedError for a banned Telegram id, WhatsApp number, Google account or address, and for a Google
//       sign-up whose verified address is banned;
//     - its message names no identifier;
//     - isIdentifierBlocked reads the new columns and primes their cache keys (blocked:google:<sub>,
//       blocked:email:<emailKey>);
//   - accountWays: the account's Google id and sign-in address;
//   - hasChat (src/lib/has-chat.ts): a Telegram id, a WhatsApp phone or a BSUID is a chat, for a database row (null) and a
//     UserConfig (undefined) alike; nothing is not;
//   - no log line holds a name, an address, a Telegram id, a phone or a Google id.
//
// Real: user-service, user-moderation, identities, onboarding, analytics. Faked at the boundaries
// (scripts/lib/signin-world.ts): Prisma (in memory; a transaction's writes are undone when it throws) and Redis in
// memory, error capture, the chats. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6c1/run-smoke.sh smoke-account-create

import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import {
  assert, baseUser, captured, check, DB, everyLog, fakePrisma, identityRow, installSigninWorld, load, logs, prismaCalls,
  redisStore, report, resetWorld, ROOT, show, type Row,
} from './lib/signin-world';

const MIGRATION = '20261104000000_web_sign_up';
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every .ts/.tsx file under src/ and app/, relative to the repo. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(path.relative(ROOT, full));
    }
  };
  for (const root of ['src', 'app']) walk(path.join(ROOT, root));
  return out.sort();
}

/** A top-level function's text (exported or not, async or not), from its line to the closing brace at the start of a line. */
function functionBody(source: string, name: string): string {
  const match = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm').exec(source);
  assert(match, `no function ${name}`);
  const end = source.indexOf('\n}\n', match.index);
  return source.slice(match.index, end + 2);
}

/** Every write that makes a User row. */
const USER_CREATE = /\.user\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/g;

/** The names and identifiers of the run: none may reach a log line. */
const SECRETS = [
  'Dana', 'Levi', 'Avi', 'Mira', 'dana@example.com', 'Dana@Gmail.com', 'dana@gmail.com', 'mira@example.com', '5550001', '5550002',
  '+972500000001', 'IL.123', 'g-sub-1', 'banned@example.com', 'Banned@Example.com', 'g-banned', 'g-fresh', '5550009', '+972500000009', 'taken@example.com',
];

const OLD = 77;
function seed(): void {
  resetWorld();
  DB.user = [baseUser({ id: OLD, name: 'Old', telegramId: BigInt(5550077) })];
  DB.signInIdentity = [identityRow({ userId: OLD, kind: 'email', subject: 'taken@example.com', address: 'taken@example.com' })];
  DB.nativeCalendar = [];
  DB.blockedIdentifier = [];
}
const newest = (): Row => DB.user[DB.user.length - 1];
const calendarsOf = (id: number): Row[] => (DB.nativeCalendar ?? []).filter(c => c.ownerUserId === id);
const createdLines = (): string[] => logs.filter(l => l.startsWith('[account] created user '));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const SHARED = { englishName: '', gender: 'male', location: '', culture: 'default', googleRefreshToken: '' };
const sharedOf = (row: Row) => ({ englishName: row.englishName, gender: row.gender, location: row.location, culture: row.culture, googleRefreshToken: row.googleRefreshToken });

async function main() {
  await installSigninWorld();
  const users = await load('src/services/user-service.ts');
  const moderation = await load('src/lib/user-moderation.ts');
  const identities = await load('src/services/web-signin/identities.ts');
  const { emailKey } = await load('src/services/web-signin/email-address.ts');

  await check('#1 the data: BlockedIdentifier has googleSub and email, each unique; the migration adds exactly those, only adds, and is safe to run twice; the generated client knows them', () => {
    const schema = read('prisma/schema.prisma');
    const model = /model BlockedIdentifier \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    const lines = model.split('\n').map(l => l.replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ')).filter(Boolean);
    for (const want of ['googleSub String? @unique', 'email String? @unique']) assert(lines.includes(want), `BlockedIdentifier lacks "${want}": ${show(lines)}`);
    const file = path.join(ROOT, 'prisma/migrations', MIGRATION, 'migration.sql');
    assert(fs.existsSync(file), `no prisma/migrations/${MIGRATION}/migration.sql`);
    const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join(' ').replace(/\s+/g, ' ').trim();
    for (const want of [
      'ALTER TABLE "BlockedIdentifier" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;',
      'ALTER TABLE "BlockedIdentifier" ADD COLUMN IF NOT EXISTS "email" TEXT;',
      'CREATE UNIQUE INDEX IF NOT EXISTS "BlockedIdentifier_googleSub_key" ON "BlockedIdentifier"("googleSub");',
      'CREATE UNIQUE INDEX IF NOT EXISTS "BlockedIdentifier_email_key" ON "BlockedIdentifier"("email");',
    ]) assert(sql.includes(want), `the migration lacks: ${want}`);
    assert(!/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i.test(sql), `the migration does more than add: ${sql}`);
    const fields = Object.values((Prisma as unknown as Record<string, Record<string, string> | undefined>).BlockedIdentifierScalarFieldEnum ?? {});
    assert(fields.includes('googleSub') && fields.includes('email'), `the generated client's BlockedIdentifier: ${show(fields)} (run prisma generate)`);
  });

  await check('#2 one creation step: the only User create in src/ and app/ is createAccount\'s; getOrCreateUser and getOrCreateUserByWhatsApp keep their lookups and create only through it', () => {
    const service = read('src/services/user-service.ts');
    const body = functionBody(service, 'createAccount');
    const start = service.indexOf(body);
    const stray: string[] = [];
    for (const file of sourceFiles()) {
      const text = read(file);
      for (const m of text.matchAll(USER_CREATE)) {
        const inside = file === 'src/services/user-service.ts' && m.index! >= start && m.index! < start + body.length;
        if (!inside) stray.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    assert(stray.length === 0, `a User row is made outside createAccount: ${show(stray)}`);
    assert((body.match(USER_CREATE) ?? []).length === 1, 'createAccount makes the row more than once, or not at all');
    const telegram = functionBody(service, 'getOrCreateUser');
    const whatsapp = functionBody(service, 'getOrCreateUserByWhatsApp');
    assert(/createAccount\(\{\s*via: 'telegram'/.test(telegram) && telegram.includes('findUnique'), `getOrCreateUser: ${telegram}`);
    assert(/createAccount\(\{\s*via: 'whatsapp'/.test(whatsapp) && (whatsapp.match(/findUnique/g) ?? []).length === 4, `getOrCreateUserByWhatsApp: ${whatsapp}`);
  });

  await check('#3 /start: a new Telegram id gets one account with the shared defaults, its Telegram name and language, messagingPlatform telegram and one primary FamCal calendar; the same id again gets the same account and makes nothing; no web_signup', async () => {
    seed();
    prismaCalls.length = 0;
    const dana = await users.getOrCreateUser(5550001, { first_name: 'Dana', last_name: 'Levi', language_code: 'he-IL' });
    assert(!prismaCalls.includes('$transaction') && prismaCalls.includes('user.create'), `a chat account is one row, with no transaction: ${show(prismaCalls)}`);
    const row = newest();
    assert(row.id === dana.id && DB.user.length === 2, `rows ${show(DB.user.map(u => u.id))}`);
    const got = { telegramId: String(row.telegramId), name: row.name, language: row.language, messagingPlatform: row.messagingPlatform, ...sharedOf(row) };
    const want = { telegramId: '5550001', name: 'Dana Levi', language: 'he', messagingPlatform: 'telegram', ...SHARED };
    assert(show(got) === show(want), `the row ${show(got)}`);
    const calendars = calendarsOf(row.id);
    assert(calendars.length === 1 && show(calendars[0].labels) === show(['primary', 'yours']), `calendars ${show(calendars)}`);
    assert(show(createdLines()) === show([`[account] created user ${row.id} via telegram`]), `log ${show(createdLines())}`);
    const again = await users.getOrCreateUser(5550001, { first_name: 'Other' });
    assert(again.id === dana.id && DB.user.length === 2 && calendarsOf(row.id).length === 1 && createdLines().length === 1, 'the same Telegram id made a second account');
    await users.getOrCreateUser(5550002);
    assert(newest().name === 'User' && newest().language === 'en', `no profile: ${show({ name: newest().name, language: newest().language })}`);
    await tick();
    assert(!(DB.userActivity ?? []).some(a => a.action === 'web_signup'), 'a /start recorded web_signup');
  });

  await check('#4 a first WhatsApp message: a number gets its account (phone, language, messagingPlatform whatsapp, the defaults, one calendar), a BSUID alone gets one with no phone; each found again by its lookup', async () => {
    seed();
    prismaCalls.length = 0;
    const avi = await users.getOrCreateUserByWhatsApp('+972500000001', 'Avi', undefined, '+972500000001', 'ru');
    assert(!prismaCalls.includes('$transaction') && prismaCalls.includes('user.create'), `a chat account is one row, with no transaction: ${show(prismaCalls)}`);
    const row = newest();
    const got = { telegramId: row.telegramId, whatsappPhone: row.whatsappPhone, whatsappBsuid: row.whatsappBsuid, name: row.name, language: row.language, messagingPlatform: row.messagingPlatform, ...sharedOf(row) };
    const want = { telegramId: null, whatsappPhone: '+972500000001', whatsappBsuid: null, name: 'Avi', language: 'ru', messagingPlatform: 'whatsapp', ...SHARED };
    assert(row.id === avi.id && show(got) === show(want), `the row ${show(got)}`);
    assert(calendarsOf(row.id).length === 1 && createdLines().includes(`[account] created user ${row.id} via whatsapp`), `calendar ${calendarsOf(row.id).length}, log ${show(createdLines())}`);
    const mira = await users.getOrCreateUserByWhatsApp('IL.123', 'Mira', 'IL.123');
    assert(newest().id === mira.id && newest().whatsappBsuid === 'IL.123' && newest().whatsappPhone === null && newest().language === 'en', `BSUID only: ${show({ phone: newest().whatsappPhone, bsuid: newest().whatsappBsuid })}`);
    const count = DB.user.length;
    assert((await users.getOrCreateUserByWhatsApp('+972500000001')).id === avi.id && (await users.getOrCreateUserByWhatsApp('IL.123', undefined, 'IL.123')).id === mira.id && DB.user.length === count, 'a known number or BSUID made another account');
  });

  await check('#5 a sign-up on famcal.bot: after the ban check, one transaction makes the user (the typed name, the page language, the defaults, no chat) and its way (used now), then one primary calendar; the log says via web-email / web-google; web_signup is recorded with the way', async () => {
    seed();
    prismaCalls.length = 0;
    const dana = await users.createAccount({ via: 'web', way: { kind: 'email', subject: 'dana@example.com', address: 'dana@example.com' }, name: 'Dana', language: 'he' });
    const row = DB.user.find(u => u.id === dana.id) as Row;
    const got = { telegramId: row.telegramId, whatsappPhone: row.whatsappPhone, whatsappBsuid: row.whatsappBsuid, name: row.name, language: row.language, messagingPlatform: row.messagingPlatform, ...sharedOf(row) };
    const want = { telegramId: null, whatsappPhone: null, whatsappBsuid: null, name: 'Dana', language: 'he', messagingPlatform: 'telegram', ...SHARED };
    assert(show(got) === show(want), `the row ${show(got)}`);
    const ways = DB.signInIdentity.filter(i => i.userId === dana.id);
    assert(ways.length === 1 && ways[0].kind === 'email' && ways[0].subject === 'dana@example.com' && ways[0].address === 'dana@example.com' && ways[0].lastUsedAt instanceof Date, `ways ${show(ways)}`);
    assert(calendarsOf(dana.id).length === 1, `calendars ${calendarsOf(dana.id).length}`);
    const at = (call: string) => prismaCalls.indexOf(call);
    assert(at('blockedIdentifier.findFirst') >= 0 && at('blockedIdentifier.findFirst') < at('$transaction') && at('$transaction') < at('user.create') && at('user.create') < at('signInIdentity.create') && at('signInIdentity.create') < at('nativeCalendar.create'), `order ${show(prismaCalls)}`);
    assert(show(createdLines()) === show([`[account] created user ${dana.id} via web-email`]), `log ${show(createdLines())}`);
    await tick();
    const activity = (DB.userActivity ?? []).filter(a => a.userId === dana.id && a.action === 'web_signup');
    assert(activity.length === 1 && activity[0].metadata?.way === 'email' && !show(activity[0]).includes('dana@example.com'), `activity ${show(DB.userActivity)}`);
    const google = await users.createAccount({ via: 'web', way: { kind: 'google', subject: 'g-sub-1', address: 'Dana@Gmail.com' }, name: 'Dana G', language: 'en' });
    const gWays = DB.signInIdentity.filter(i => i.userId === google.id);
    assert(gWays.length === 1 && gWays[0].kind === 'google' && gWays[0].subject === 'g-sub-1' && gWays[0].address === 'Dana@Gmail.com', `Google way ${show(gWays)}`);
    assert(createdLines().includes(`[account] created user ${google.id} via web-google`), `log ${show(createdLines())}`);
  });

  await check('#6 a way another account took meanwhile fails the unique (kind, subject) with P2002: createAccount throws it, and the user row is rolled back, with no way and no calendar', async () => {
    seed();
    const before = { users: DB.user.length, ways: DB.signInIdentity.length };
    let thrown: unknown = null;
    try {
      await users.createAccount({ via: 'web', way: { kind: 'email', subject: 'taken@example.com', address: 'taken@example.com' }, name: 'Mira', language: 'en' });
    } catch (error) {
      thrown = error;
    }
    assert((thrown as Row | null)?.code === 'P2002', `thrown ${show(thrown)}`);
    assert(DB.user.length === before.users && DB.signInIdentity.length === before.ways && (DB.nativeCalendar ?? []).length === 0, `left ${show({ users: DB.user.length, ways: DB.signInIdentity.length, calendars: DB.nativeCalendar })}`);
    assert(createdLines().length === 0, `log ${show(createdLines())}`);
  });

  await check('#7 a banned identifier gets AccountBlockedError and no account on every path: a Telegram id, a WhatsApp number, a Google account, an address, and a Google sign-up whose verified address is banned; the message names none of them; isIdentifierBlocked reads googleSub and email and primes their keys', async () => {
    seed();
    const ban = (o: Row): Row => ({ id: DB.blockedIdentifier.length + 1, telegramId: null, whatsappPhone: null, googleSub: null, email: null, bannedBy: 9, bannedReason: null, createdAt: new Date(), ...o });
    DB.blockedIdentifier.push(ban({ telegramId: BigInt(5550009) }));
    DB.blockedIdentifier.push(ban({ whatsappPhone: '+972500000009' }));
    DB.blockedIdentifier.push(ban({ googleSub: 'g-banned' }));
    DB.blockedIdentifier.push(ban({ email: 'banned@example.com' }));
    const tries: [string, () => Promise<unknown>][] = [
      ['a banned Telegram id', () => users.getOrCreateUser(5550009, { first_name: 'Dana' })],
      ['a banned WhatsApp number', () => users.getOrCreateUserByWhatsApp('+972500000009', 'Avi', undefined, '+972500000009')],
      ['a banned Google account', () => users.createAccount({ via: 'web', way: { kind: 'google', subject: 'g-banned', address: 'dana@gmail.com' }, name: 'Dana', language: 'en' })],
      ['a banned address', () => users.createAccount({ via: 'web', way: { kind: 'email', subject: 'banned@example.com', address: 'banned@example.com' }, name: 'Dana', language: 'en' })],
      ['a Google sign-up whose verified address is banned', () => users.createAccount({ via: 'web', way: { kind: 'google', subject: 'g-fresh', address: 'Banned@Example.com' }, name: 'Dana', language: 'en' })],
    ];
    for (const [label, run] of tries) {
      let thrown: unknown = null;
      try {
        await run();
      } catch (error) {
        thrown = error;
      }
      assert(thrown instanceof users.AccountBlockedError && (thrown as Error).name === 'AccountBlockedError', `${label}: ${show(thrown)}`);
      const message = (thrown as Error).message;
      assert(!SECRETS.some(s => message.includes(s)), `${label}: the message names it: ${message}`);
    }
    assert(DB.user.length === 1 && (DB.nativeCalendar ?? []).length === 0 && DB.signInIdentity.length === 1 && createdLines().length === 0, `made ${show({ users: DB.user.length, calendars: DB.nativeCalendar, log: createdLines() })}`);
    assert(!('IdentifierBlockedError' in users), 'IdentifierBlockedError is still exported');
    redisStore.clear();
    assert((await moderation.isIdentifierBlocked({ googleSub: 'g-banned' })) === true, 'a banned Google account reads as not blocked');
    assert((await moderation.isIdentifierBlocked({ email: 'banned@example.com' })) === true, 'a banned address reads as not blocked');
    assert((await moderation.isIdentifierBlocked({ googleSub: 'g-other', email: 'other@example.com' })) === false, 'an unknown Google account and address read as blocked');
    assert((await moderation.isIdentifierBlocked({})) === false, 'nothing given reads as blocked');
    const keys = [...redisStore.keys()];
    assert(keys.includes('blocked:google:g-banned') && keys.includes(`blocked:email:${emailKey('banned@example.com')}`) && !keys.some(k => k.includes('banned@example.com')), `cache keys ${show(keys)}`);
  });

  await check('#8 the first calendar failing is logged and reported by its kind only (user id, no message: it can hold the name), and the account stands with its way', async () => {
    seed();
    const calendars = (fakePrisma as Row).nativeCalendar as Row;
    const real = calendars.create;
    calendars.create = async () => {
      throw Object.assign(new Error('Invalid `prisma.nativeCalendar.create()` invocation: name: "Mira"'), { code: 'P1001' });
    };
    try {
      const mira = await users.createAccount({ via: 'web', way: { kind: 'email', subject: 'mira@example.com', address: 'mira@example.com' }, name: 'Mira', language: 'ru' });
      assert(DB.user.some(u => u.id === mira.id) && DB.signInIdentity.some(i => i.userId === mira.id), 'the account did not stand');
      const sentry = captured.find(c => c.context === 'account-calendar');
      assert(sentry && sentry.extra.user_id === mira.id && !sentry.message.includes('Mira'), `Sentry ${show(captured)}`);
      assert(logs.some(l => l.startsWith(`[account] user ${mira.id}: making the first FamCal calendar failed`)), `logs ${show(logs)}`);
      assert(show(createdLines()) === show([`[account] created user ${mira.id} via web-email`]), `log ${show(createdLines())}`);
    } finally {
      calendars.create = real;
    }
  });

  await check('#9 accountWays: the account\'s Google account id, its sign-in address (the email way\'s subject) and the Google way\'s address, null for each it lacks', async () => {
    seed();
    DB.signInIdentity.push(identityRow({ userId: OLD, kind: 'google', subject: 'g-old', address: 'old@gmail.com' }));
    assert(show(await identities.accountWays(OLD)) === show({ googleSub: 'g-old', email: 'taken@example.com', googleAddress: 'old@gmail.com' }), 'both ways');
    assert(show(await identities.accountWays(12345)) === show({ googleSub: null, email: null, googleAddress: null }), 'no ways');
  });

  await check('#10 no log line of the run holds a name, an address, a Telegram id, a phone or a Google id', () => {
    const leaks = everyLog.filter(l => SECRETS.some(s => l.includes(s)));
    assert(leaks.length === 0, `leaks ${show(leaks)}`);
  });

  await check('#11 hasChat: a Telegram id, a WhatsApp phone or a BSUID is a chat; a row with null ids and a UserConfig with undefined ones (a browser-only account) is not', async () => {
    const { hasChat } = await load('src/lib/has-chat.ts');
    assert(hasChat({ telegramId: 5 }) === true && hasChat({ telegramId: BigInt(5) }) === true, 'a Telegram id');
    assert(hasChat({ telegramId: null, whatsappPhone: '+972500000001', whatsappBsuid: null }) === true, 'a WhatsApp phone');
    assert(hasChat({ telegramId: null, whatsappPhone: null, whatsappBsuid: 'IL.123' }) === true, 'a BSUID');
    assert(hasChat({ telegramId: null, whatsappPhone: null, whatsappBsuid: null }) === false, 'a database row with no chat');
    assert(hasChat({ telegramId: undefined, whatsappPhone: undefined, whatsappBsuid: undefined }) === false && hasChat({ telegramId: null }) === false, 'a UserConfig with no chat');
    assert(hasChat({ telegramId: null, whatsappPhone: '', whatsappBsuid: '' }) === false, 'empty ids');
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
