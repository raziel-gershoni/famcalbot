// Smoke test for answering a guest message (handleGuestMessage, src/services/ask-in-chat/handler.ts; spec
// docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §3, §5.4, §8, rulings 5, 9, 11, 13 and 15):
//   - a caller with no account gets the Start line with the Open FamCal url button, in Telegram's language, and no
//     model call or calendar read;
//   - the rate limit gives its line; the same query id twice is answered once;
//   - the window, the read and the words end in one answer, and one `[ask] user <id>: answered ...` line;
//   - the sister mentioning the bot reads her own account's calendar, in her own language;
//   - a bare reply from someone else gets no answer and no model call;
//   - a Google gap gives the partial form; Google unread with no FamCal items, a FamCal error, a model failure and a
//     zone failure give "couldn't check", with a Sentry report for everything but Google's own;
//   - a refused answer is logged with Telegram's status and description and reported, and claims no answer;
//   - no console line and no report holds a sentinel planted in both messages and in the model's answer.
// Every reach outside is injected (the claim, the limiter, the zone, the model, the reader, the send, the report).
// No network, no database, no Redis.
//
//   npx tsx scripts/smoke-ask-in-chat-handler.ts

import type { AICompletionResult } from '../src/services/ai-provider';
import type { AskDeps } from '../src/services/ask-in-chat/handler';
import type { BusyRead } from '../src/services/ask-in-chat/busy';
import type { GuestAnswerArticle } from '../src/services/messaging/telegram-adapter';
import type { UserConfig } from '../src/types';
import en from '../messages/en.json';
import he from '../messages/he.json';

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

process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
let logs: string[] = [];
const allLogs: string[] = [];
const capture = (...args: unknown[]) => {
  const line = args.map(a => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : show(a))).join(' ');
  logs.push(line);
  allLogs.push(line);
};
console.log = capture;
console.warn = capture;
console.error = capture;
console.info = capture;

const BOT_ID = 123456;
const CALLER = 4001;
const SISTER = 4002;
const STRANGER = 4009;
const IL = 'Asia/Jerusalem';
const NOW = new Date('2026-11-07T10:00:00Z');
const SENTINELS = ['SECRET-MENTION-TEXT', 'SECRET-REPLIED-TEXT', 'SECRET-MODEL-OUT', 'Zelda', 'zelda_user', 'gq-secret-1'];

const user = (id: number, telegramId: number, language: string) => ({ id, telegramId, language }) as unknown as UserConfig;
const RAZ = user(1, CALLER, 'en');
const DANA = user(2, SISTER, 'he');

function guest(from: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 77,
    guest_query_id: 'gq-secret-1',
    date: 1_800_000_000,
    chat: { id: -100, type: 'supergroup', title: 'Zelda family' },
    from: { id: from, is_bot: false, first_name: 'Zelda', username: 'zelda_user', language_code: 'he' },
    text: '@famcal_test_bot SECRET-MENTION-TEXT',
    entities: [{ type: 'mention', offset: 0, length: 16 }],
    reply_to_message: { message_id: 70, from: { id: 555, first_name: 'Zelda' }, text: 'are you free Friday evening? SECRET-REPLIED-TEXT' },
    ...extra,
  };
}

const modelAnswer = (fields: Record<string, unknown>) =>
  JSON.stringify({ date: null, lastDate: null, hebrewDate: null, time: null, until: null, partOfDay: null, ...fields });
const completion = (text: string): AICompletionResult => ({ text, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'STOP', model: 'fake', durationMs: 1 });

interface World {
  answers: Array<{ id: string; article: GuestAnswerArticle }>;
  prompts: string[];
  reads: Array<{ userId: number; days: readonly string[]; tz: string }>;
  reports: Array<{ error: string; extra: unknown }>;
  claims: Set<string>;
}

/** The fakes, with what the model answers (`reply`), what the reader returns or throws (`busy`) and the limiter's verdict (`allowed`). */
function world(over: Partial<AskDeps> & { reply?: string; busy?: BusyRead | Error; allowed?: boolean } = {}): { w: World; deps: Partial<AskDeps> } {
  const { reply, busy: busyOver, allowed, ...overrides } = over;
  const w: World = { answers: [], prompts: [], reads: [], reports: [], claims: new Set() };
  const busy = busyOver ?? { days: [{ day: '2026-11-13', intervals: [{ start: Date.parse('2026-11-13T17:00:00Z'), end: Date.parse('2026-11-13T19:00:00Z'), startsBefore: false, endsAfter: false }] }] };
  const deps: Partial<AskDeps> = {
    now: () => NOW,
    claimQuery: async key => {
      if (w.claims.has(key)) return false;
      w.claims.add(key);
      return true;
    },
    allow: async () => allowed ?? true,
    timezoneOf: async () => IL,
    complete: async prompt => {
      w.prompts.push(prompt);
      return completion(reply ?? modelAnswer({ date: '2026-11-13', partOfDay: 'evening' }));
    },
    readBusy: async (u, days, tz) => {
      w.reads.push({ userId: u.id, days, tz });
      if (busy instanceof Error) throw busy;
      return busy;
    },
    answer: async (id, article) => { w.answers.push({ id, article }); },
    report: (error, extra) => { w.reports.push({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), extra }); },
    ...overrides,
  };
  return { w, deps };
}

const textOf = (w: World, i = 0) => w.answers[i]?.article.input_message_content.message_text;

async function main() {
  const { handleGuestMessage } = await import('../src/services/ask-in-chat/handler');
  const run = async (message: unknown, u: UserConfig | null, over: Parameters<typeof world>[0] = {}) => {
    logs = [];
    const { w, deps } = world(over);
    await handleGuestMessage(message, u, deps);
    return w;
  };

  await check('a full answer: one model call, one read of the caller\'s own calendar, one answer, one answered line', async () => {
    const w = await run(guest(CALLER), RAZ);
    assert(w.prompts.length === 1 && w.reads.length === 1 && w.answers.length === 1, show({ p: w.prompts.length, r: w.reads.length, a: w.answers.length }));
    assert(w.reads[0].userId === 1 && show(w.reads[0].days) === show(['2026-11-13']) && w.reads[0].tz === IL, show(w.reads));
    assert(w.answers[0].id === 'gq-secret-1', 'the query id');
    assert(textOf(w) === 'Friday 13.11, evening: busy 19:00-21:00, free the rest', show(textOf(w)));
    assert(!w.answers[0].article.reply_markup, 'no button on an answer');
    assert(logs.some(l => /^\[ask\] user 1: answered part x1 busy=1 google=ok in \d+ ms \(ai \d+, read \d+\)$/.test(l)), show(logs));
  });

  await check('no account: the Start line with the Open FamCal url button, in Telegram\'s language; no model call, no read', async () => {
    const w = await run(guest(STRANGER), null);
    assert(w.answers.length === 1 && w.prompts.length === 0 && w.reads.length === 0, show(w));
    assert(textOf(w) === he.bot.askInChat.noAccount, show(textOf(w)));
    assert(show(w.answers[0].article.reply_markup) === show({ inline_keyboard: [[{ text: he.bot.askInChat.openButton, url: 'https://t.me/famcal_test_bot' }]] }), show(w.answers[0].article));
    assert(logs.includes(`[ask] telegram ${STRANGER}: no account, Start line`), show(logs));
    const english = await run(guest(STRANGER, { from: { id: STRANGER, language_code: 'fr' } }), null);
    assert(textOf(english) === en.bot.askInChat.noAccount, 'English for any other language');
  });

  await check('over the rate limit: the rate-limited line, no model call', async () => {
    const w = await run(guest(CALLER), RAZ, { allowed: false });
    assert(textOf(w) === en.bot.askInChat.rateLimited && w.prompts.length === 0, show(w));
    assert(logs.includes('[ask] user 1: rate limited'), show(logs));
  });

  await check('the same query delivered twice is answered once; the claim key is a hash, not the id', async () => {
    const { w, deps } = world();
    logs = [];
    await handleGuestMessage(guest(CALLER), RAZ, deps);
    await handleGuestMessage(guest(CALLER), RAZ, deps);
    assert(w.answers.length === 1 && w.prompts.length === 1, show({ a: w.answers.length, p: w.prompts.length }));
    assert(logs.includes(`[ask] telegram ${CALLER}: repeat delivery dropped`), show(logs));
    const [key] = [...w.claims];
    assert(/^ask:[0-9a-f]{64}$/.test(key) && !key.includes('gq-secret-1'), key);
  });

  await check('the sister mentioning the bot reads her own account\'s calendar, in Hebrew', async () => {
    const w = await run(guest(SISTER), DANA);
    assert(w.reads[0]?.userId === 2, show(w.reads));
    assert(textOf(w)?.startsWith('יום שישי'), show(textOf(w)));
  });

  await check('a bare reply from someone else to our answer: no answer, no model call, one line', async () => {
    const ours = { message_id: 71, from: { id: BOT_ID, is_bot: true }, text: 'Friday 13.11: free all day', guest_bot_caller_user: { id: CALLER } };
    const w = await run(guest(SISTER, { text: 'thanks SECRET-MENTION-TEXT', entities: undefined, reply_to_message: ours }), DANA);
    assert(w.answers.length === 0 && w.prompts.length === 0, show(w));
    assert(logs.includes(`[ask] telegram ${SISTER}: bare reply to another caller's answer, not answered`), show(logs));
    const own = await run(guest(CALLER, { text: 'no, Saturday', entities: undefined, reply_to_message: ours }), RAZ);
    assert(own.answers.length === 1 && own.prompts.length === 1, 'the caller\'s own correction is answered');
  });

  await check('no date and too many days get their lines, naming the bot', async () => {
    const none = await run(guest(CALLER), RAZ, { reply: modelAnswer({}) });
    assert(textOf(none) === en.bot.askInChat.noDate.replace('{bot}', 'famcal_test_bot') && none.reads.length === 0, show(textOf(none)));
    assert(logs.includes('[ask] user 1: no date'), show(logs));
    const many = await run(guest(CALLER), RAZ, { reply: modelAnswer({ date: '2026-11-13', lastDate: '2026-11-20' }) });
    assert(textOf(many) === en.bot.askInChat.tooManyDays.replace('{bot}', 'famcal_test_bot'), show(textOf(many)));
  });

  await check('a Google gap gives the partial form: busy times, no free claim, the Google line', async () => {
    const busy: BusyRead = { days: [{ day: '2026-11-13', intervals: [{ start: Date.parse('2026-11-13T17:00:00Z'), end: Date.parse('2026-11-13T19:00:00Z'), startsBefore: false, endsAfter: false }] }], googleGap: 'token' };
    const w = await run(guest(CALLER), RAZ, { busy });
    assert(textOf(w) === `Friday 13.11, evening: busy 19:00-21:00\n${en.bot.askInChat.googlePartial}`, show(textOf(w)));
    assert(logs.some(l => l.includes('google=token')), show(logs));
  });

  await check('Google unread with no FamCal items: "couldn\'t check", logged, not reported (the reader reports its own outage)', async () => {
    const w = await run(guest(CALLER), RAZ, { busy: new Error('GOOGLE_FETCH_FAILED') });
    assert(textOf(w) === en.bot.askInChat.unavailable && w.reports.length === 0, show(w));
    assert(logs.includes('[ask] user 1: unavailable (read: GOOGLE_FETCH_FAILED)'), show(logs));
  });

  await check('a FamCal (database) error: "couldn\'t check" and a report at stage read', async () => {
    const w = await run(guest(CALLER), RAZ, { busy: Object.assign(new Error('connection refused'), { code: 'P1001' }) });
    assert(textOf(w) === en.bot.askInChat.unavailable, show(textOf(w)));
    assert(w.reports.length === 1 && show(w.reports[0].extra) === show({ user_id: 1, stage: 'read' }), show(w.reports));
    assert(logs.includes('[ask] user 1: unavailable (read: P1001)'), show(logs));
  });

  await check('the model failing, or answering badly twice: "couldn\'t check" and a report at stage ai', async () => {
    const down = await run(guest(CALLER), RAZ, { complete: async () => { throw Object.assign(new Error('Gemini 503'), { status: 503 }); } });
    assert(textOf(down) === en.bot.askInChat.unavailable && down.reports.length === 1 && show(down.reports[0].extra) === show({ user_id: 1, stage: 'ai' }), show(down));
    const bad = await run(guest(CALLER), RAZ, { reply: modelAnswer({ date: 'SECRET-MODEL-OUT' }) });
    assert(textOf(bad) === en.bot.askInChat.unavailable && bad.prompts.length === 2 && bad.reads.length === 0, show({ t: textOf(bad), p: bad.prompts.length }));
    assert(logs.includes('[ask] user 1: unavailable (ai: AskWindowError)'), show(logs));
  });

  await check('the zone failing: "couldn\'t check" and a report at stage read, no model call', async () => {
    const w = await run(guest(CALLER), RAZ, { timezoneOf: async () => { throw new Error('geocoder down'); } });
    assert(textOf(w) === en.bot.askInChat.unavailable && w.prompts.length === 0 && w.reports[0] && show(w.reports[0].extra) === show({ user_id: 1, stage: 'read' }), show(w));
  });

  await check('a refused answer: logged with Telegram\'s status and description, reported at stage send, no answered line', async () => {
    const refusal = Object.assign(new Error('ETELEGRAM: 400 Bad Request: query is too old'), { code: 'ETELEGRAM', response: { statusCode: 400, body: { description: 'Bad Request: query is too old' } } });
    const w = await run(guest(CALLER), RAZ, { answer: async () => { throw refusal; } });
    assert(logs.includes('[ask] user 1: answer refused HTTP 400 Bad Request: query is too old'), show(logs));
    assert(w.reports.length === 1 && show(w.reports[0].extra) === show({ user_id: 1, stage: 'send' }), show(w.reports));
    assert(!logs.some(l => l.includes('answered')), show(logs));
  });

  await check('a guest message with no query id or no sender is not answered, with one line', async () => {
    const noId = await run(guest(CALLER, { guest_query_id: undefined }), RAZ);
    const noFrom = await run(guest(CALLER, { from: undefined }), null);
    assert(noId.answers.length === 0 && noFrom.answers.length === 0, 'answered');
    assert(logs.includes('[ask] a guest message with no query id or no sender; not answered'), show(logs));
  });

  await check('no console line and no report, in any case above, holds a message\'s text, a name, a username, a chat title, the model\'s answer or the query id', () => {
    const all = allLogs.join('\n');
    for (const secret of SENTINELS) assert(!all.includes(secret), `a log line holds ${secret}: ${show(allLogs.filter(l => l.includes(secret)))}`);
  });

  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.log = realLog;
  console.error = realError;
  console.error('smoke crashed:', err);
  process.exit(1);
});
