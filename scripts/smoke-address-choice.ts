// Smoke test for "Address me as" asked once in the chats (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B2;
// plan docs/superpowers/plans/2026-11-07-b-features.md Task 5): src/services/address-choice.ts and its callers.
//  - C1 a new account's /start gets the welcome, then the question with two buttons (gd:m, gd:f) in its language; a
//    returning /start gets the welcome only; /start connect never asks; the feedback deep link of a new account asks after it
//  - C2 gd:f saves female for the presser's own account, answers the spinner and turns the question into the one-line
//    confirmation in the account's language; pressing again, or the other button, saves again
//  - C3 a stray value (gd:x, gd:) saves nothing and is answered and logged
//  - C4 the webhook sends gd: to the handler, and the WhatsApp routing reads the two button ids
//  - C5 a press from a Telegram id with no account makes no account and saves nothing (answered, logged)
//  - C6 WhatsApp: the language step ends with the question (gender_m, gender_f) after the set-up link; a tap saves and
//    is confirmed; other text is not a choice
//  - C7 the [gender] lines name the user id and the platform only (no name, no Telegram id, no phone)
// Real: address-choice, commands, welcome, whatsapp-onboarding, user-service, createAccount. Faked at the boundaries
// (scripts/lib/signin-world.ts): Prisma and Redis in memory, Telegram and WhatsApp (recorded), error capture, analytics,
// the magic link. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh: $RUN smoke-address-choice

import fs from 'fs';
import Module from 'module';
import path from 'path';
import {
  assert, baseUser, botCalls, callbackAnswers, check, DB, everyLog, installSigninWorld, load, logs, redisStore, report, resetWorld, ROOT, sent, show, stubModule, type Row,
} from './lib/signin-world';

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-telegram-connect.ts): /start's module reaches it
const ModuleInternals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

const MSG: Record<string, Row> = Object.fromEntries(['en', 'he', 'ru'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]));
const words = (lang: string): Row => MSG[lang].bot.onboarding;
const NEW_TG = 880000001;
const OLD_TG = 880000002;
const OLD = 12;
const WA_USER = 13;
const WA_PHONE = '+972500000013';
const buttonsOf = (message: Row | undefined): Row[] => message?.options?.replyMarkup?.inline_keyboard?.[0] ?? [];
/** The message edits the bot was asked for (their params). */
const edits = (): Row[] => botCalls.filter((c) => c.method === 'editMessageText').map((c) => c.params);

function seed(): void {
  resetWorld();
  DB.user = [
    baseUser({ id: OLD, name: 'Dana Levi', language: 'ru', telegramId: BigInt(OLD_TG), location: 'Haifa' }),
    baseUser({ id: WA_USER, name: 'Avi', language: 'en', messagingPlatform: 'whatsapp', whatsappPhone: WA_PHONE }),
  ];
  DB.nativeCalendar = [];
}
const userRow = (id: number): Row | undefined => DB.user.find((u) => u.id === id);

async function main() {
  await installSigninWorld();
  stubModule('src/services/analytics-service.ts', {
    addBreadcrumb: () => undefined, setUserContext: () => undefined, trackActivityAsync: () => undefined, trackActivity: async () => undefined,
    ACTIVITY_RETENTION_DAYS: 90, ACTIVITY_PURGE_BATCH: 5000, purgeOldActivity: async () => 0,
  });
  stubModule('src/services/magic-link.ts', { generateMagicLink: async () => 'https://famcal.bot/m/smoke-link' });
  const { handleStartCommand } = await load('src/services/telegram/commands.ts');
  const choice = await load('src/services/address-choice.ts');
  const onboarding = await load('src/services/whatsapp-onboarding.ts');
  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const start = (tg: number, args?: string, languageCode = 'he') =>
    handleStartCommand(tg, tg, 'telegram', { id: tg, first_name: 'Noa', language_code: languageCode }, args, 'private');

  await check('C1 a new account\'s /start: the welcome, then the question with two buttons (gd:m, gd:f) in its language; a returning /start: the welcome only; /start connect of a new account never asks; the feedback deep link of a new account asks after its reply', async () => {
    seed();
    await start(NEW_TG);
    const made = DB.user.find((u) => String(u.telegramId) === String(NEW_TG));
    assert(made, 'no account was made');
    const mine = sent.filter((m) => m.platform === 'telegram' && m.chatId === String(NEW_TG));
    assert(mine.length === 2, `messages ${show(mine.map((m) => m.text.slice(0, 40)))}`);
    const question = mine[1];
    assert(question.text === words('he').addressQuestion, `the question ${show(question.text)}`);
    assert(show(buttonsOf(question).map((b) => [b.text, b.callback_data])) === show([[words('he').addressMale, 'gd:m'], [words('he').addressFemale, 'gd:f']]), `buttons ${show(buttonsOf(question))}`);
    sent.length = 0;
    await start(NEW_TG);
    assert(sent.length === 1 && buttonsOf(sent[0]).every((b) => !String(b.callback_data ?? '').startsWith('gd:')), `a returning /start: ${show(sent.map((m) => m.text.slice(0, 40)))}`);
    sent.length = 0;
    await start(NEW_TG + 1, 'connect', 'en');
    assert(sent.every((m) => buttonsOf(m).every((b) => !String(b.callback_data ?? '').startsWith('gd:'))), `/start connect asked: ${show(sent.map((m) => m.text.slice(0, 40)))}`);
    sent.length = 0;
    await start(NEW_TG + 2, 'feedback', 'ru');
    const feedback = sent.filter((m) => m.chatId === String(NEW_TG + 2));
    assert(feedback.length === 2 && feedback[1].text === words('ru').addressQuestion, `feedback: ${show(feedback.map((m) => m.text.slice(0, 40)))}`);
  });

  await check('C2 gd:f saves female for the presser\'s own account, answers the spinner and edits the question into the confirmation in the account\'s language; the other button, or the same again, saves again', async () => {
    seed();
    await choice.handleAddressPress(OLD_TG, 501, 'q-1', OLD_TG, 'gd:f');
    assert(userRow(OLD)?.gender === 'female', `gender ${userRow(OLD)?.gender}`);
    assert(callbackAnswers.includes('q-1'), `answers ${show(callbackAnswers)}`);
    assert(show(edits()) === show([{ text: words('ru').addressSavedFemale, chat_id: OLD_TG, message_id: 501 }]), `edits ${show(edits())}`);
    await choice.handleAddressPress(OLD_TG, 501, 'q-2', OLD_TG, 'gd:m');
    await choice.handleAddressPress(OLD_TG, 501, 'q-3', OLD_TG, 'gd:m');
    assert(userRow(OLD)?.gender === 'male' && edits().at(-1)?.text === words('ru').addressSavedMale && callbackAnswers.includes('q-3'), `again: ${userRow(OLD)?.gender} ${show(edits().at(-1))}`);
  });

  await check('C3 a stray value (gd:x, gd:, gd:female) saves nothing, is answered and logged', async () => {
    seed();
    for (const [i, data] of ['gd:x', 'gd:', 'gd:female'].entries()) await choice.handleAddressPress(OLD_TG, 502, `s-${i}`, OLD_TG, data);
    assert(userRow(OLD)?.gender === 'male' && edits().length === 0, `saved ${userRow(OLD)?.gender} ${show(edits())}`);
    assert(['s-0', 's-1', 's-2'].every((q) => callbackAnswers.includes(q)), `answers ${show(callbackAnswers)}`);
    assert(logs.filter((l) => l.startsWith('[gender] refused a button')).length === 3, `logs ${show(logs.filter((l) => l.startsWith('[gender]')))}`);
  });

  await check('C4 the webhook sends a gd: press to handleAddressPress, a new account\'s "accept <token>" asks after its reply, and the WhatsApp routing reads the two button ids before the accept handler', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/services/webhook-handlers.ts'), 'utf8');
    assert(/data\.startsWith\('gd:'\)[\s\S]{0,400}handleAddressPress\(/.test(source), 'no gd: branch');
    const wa = source.indexOf('genderOfWhatsAppButton(text)');
    assert(wa > 0 && wa < source.indexOf('const acceptToken = parseAcceptCommand(text)'), 'the WhatsApp buttons are not read before the accept handler');
    assert(/const \{ user, created \} = await getOrCreateUser\(textUserId/.test(source) && /if \(created\)[\s\S]{0,200}sendAddressQuestion\(/.test(source), 'accept <token> does not ask a new account');
    assert(choice.genderOfCallback('gd:m') === 'male' && choice.genderOfCallback('gd:f') === 'female' && choice.genderOfCallback('gd:x') === null, 'genderOfCallback');
  });

  await check('C5 a press from a Telegram id with no account makes no account and saves nothing: answered and logged', async () => {
    seed();
    const before = DB.user.length;
    await choice.handleAddressPress(990000009, 503, 'n-1', 990000009, 'gd:f');
    assert(DB.user.length === before && edits().length === 0 && callbackAnswers.includes('n-1'), `users ${DB.user.length}, edits ${show(edits())}`);
    assert(logs.some((l) => l === '[gender] a button from a Telegram id with no account was refused'), `logs ${show(logs.filter((l) => l.startsWith('[gender]')))}`);
  });

  await check('C6 WhatsApp: the language step ends with the question (gender_m, gender_f) after the set-up link, in the chosen language; a tap saves and is confirmed; other text is not a choice', async () => {
    seed();
    redisStore.set(REDIS_KEYS.waOnboard(WA_PHONE), JSON.stringify({ step: 'language', userId: WA_USER }));
    assert((await onboarding.handleOnboardingMessage(WA_PHONE, 'lang_he')) === true, 'not handled');
    const mine = sent.filter((m) => m.platform === 'whatsapp' && m.chatId === WA_PHONE);
    const last = mine.at(-1);
    assert(last && last.text === words('he').addressQuestion && show(last.options.whatsappButtons) === show([{ id: 'gender_m', title: words('he').addressMale }, { id: 'gender_f', title: words('he').addressFemale }]), `the last message ${show(last)}`);
    assert(mine.at(-2)?.options?.whatsappUrlButton?.url === 'https://famcal.bot/m/smoke-link', 'the question is not after the set-up link');
    assert(choice.genderOfWhatsAppButton('gender_f') === 'female' && choice.genderOfWhatsAppButton(' gender_m ') === 'male' && choice.genderOfWhatsAppButton('gender_x') === null && choice.genderOfWhatsAppButton('hello') === null, 'genderOfWhatsAppButton');
    await choice.answerAddressWhatsApp(WA_PHONE, WA_USER, 'female', 'he');
    assert(userRow(WA_USER)?.gender === 'female' && sent.at(-1)?.text === words('he').addressSavedFemale, `saved ${userRow(WA_USER)?.gender} ${show(sent.at(-1))}`);
    for (const title of [words('en').addressMale, words('he').addressFemale, words('ru').addressFemale]) assert(Array.from(title as string).length <= 20, `a WhatsApp button title over 20 characters: ${title}`);
  });

  await check('C7 the [gender] lines name the user id and the platform only: no name, no Telegram id, no phone', () => {
    const lines = everyLog.filter((l) => l.startsWith('[gender]'));
    assert(lines.some((l) => l === `[gender] user ${OLD} chose via telegram`) && lines.some((l) => l === `[gender] user ${WA_USER} chose via whatsapp`), `lines ${show(lines)}`);
    const leaks = lines.filter((l) => ['Dana', 'Noa', 'Avi', String(OLD_TG), String(NEW_TG), WA_PHONE, '972500000013'].some((s) => l.includes(s)));
    assert(leaks.length === 0, `leaks ${show(leaks)}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
