// Smoke test for sending a guest answer (TelegramAdapter.answerGuestQuery and guestAnswerArticle,
// src/services/messaging/telegram-adapter.ts; spec docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §7):
//   - the request: answerGuestQuery with the query id and the article JSON-serialized;
//   - the article: the text as it is, its first line (64 characters at most) as the title, no link preview, and a url
//     button only when one is given;
//   - retries through the one third-party loop (src/utils/fetch-retry.ts): a 429 waits the retry_after Telegram asks,
//     a 5xx and no answer (EFATAL) are retried, a 400 fails at once, a retry_after over 10 s fails at once.
// The bot is a fake `_request`; the loop's waits go through its test seam. No network.
//
//   npx tsx scripts/smoke-ask-in-chat-send.ts

import { __useRetryForTests } from '../src/utils/fetch-retry';
import { guestAnswerArticle, TelegramAdapter } from '../src/services/messaging/telegram-adapter';

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

const realWarn = console.warn;
let warnings: string[] = [];
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

const telegramError = (status: number, description: string, retryAfter?: number) =>
  Object.assign(new Error(`ETELEGRAM: ${status} ${description}`), {
    code: 'ETELEGRAM',
    response: { statusCode: status, body: { ok: false, error_code: status, description, ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}) } },
  });
// A gateway's HTML 502 page: the library cannot parse it and throws a ParseError (EPARSE) that still holds the response
const unparsable = (status: number) => Object.assign(new Error('EPARSE: Error parsing Telegram response: <html>'), { code: 'EPARSE', response: { statusCode: status, body: '<html>' } });
const noAnswer = () => Object.assign(new Error('EFATAL: socket hang up'), { code: 'EFATAL' });

type Call = { method: string; form: Record<string, unknown> };
function fakeBot(outcomes: Array<Error | 'ok'>) {
  const calls: Call[] = [];
  const bot = {
    _request: async (method: string, options: { form: Record<string, unknown> }) => {
      calls.push({ method, form: options.form });
      const next = outcomes[calls.length - 1] ?? 'ok';
      if (next !== 'ok') throw next;
      return true;
    },
  };
  return { calls, adapter: new TelegramAdapter(bot as never) };
}

async function main() {
  const waits: number[] = [];
  __useRetryForTests({ sleep: async waitMs => { waits.push(waitMs); }, random: () => 0 });
  const reset = () => { waits.length = 0; warnings = []; };
  const article = guestAnswerArticle('Friday 13.11: free all day');

  await check('guestAnswerArticle: the text as it is, the first line as the title (64 characters at most), no link preview, a button only when given', () => {
    assert(show(article) === show({ type: 'article', id: 'a', title: 'Friday 13.11: free all day', input_message_content: { message_text: 'Friday 13.11: free all day', link_preview_options: { is_disabled: true } } }), show(article));
    const two = guestAnswerArticle(`${'x'.repeat(80)}\nsecond line`);
    assert(two.title === 'x'.repeat(64) && two.input_message_content.message_text.endsWith('second line'), show(two));
    const start = guestAnswerArticle('To check your calendar here, start FamCal first.', { text: 'Open FamCal', url: 'https://t.me/famcal_test_bot' });
    assert(show(start.reply_markup) === show({ inline_keyboard: [[{ text: 'Open FamCal', url: 'https://t.me/famcal_test_bot' }]] }), show(start));
  });

  await check('answerGuestQuery: one answerGuestQuery request with the query id and the article JSON-serialized', async () => {
    reset();
    const { calls, adapter } = fakeBot(['ok']);
    await adapter.answerGuestQuery('gq-1', article);
    assert(calls.length === 1 && calls[0].method === 'answerGuestQuery' && calls[0].form.guest_query_id === 'gq-1', show(calls));
    assert(calls[0].form.result === JSON.stringify(article), `result ${show(calls[0].form.result)}`);
  });

  await check('a 429 waits the retry_after Telegram asks, a 500 is retried, then the answer goes', async () => {
    reset();
    const { calls, adapter } = fakeBot([telegramError(429, 'Too Many Requests: retry after 2', 2), telegramError(500, 'Internal Server Error'), 'ok']);
    await adapter.answerGuestQuery('gq-1', article);
    assert(calls.length === 3, `${calls.length} tries`);
    assert(waits[0] === 2000, `waits ${show(waits)}`);
  });

  await check('a gateway 502 or 504 whose body is not JSON (EPARSE) is retried like any 5xx; an EPARSE 400 is not', async () => {
    reset();
    const { calls, adapter } = fakeBot([unparsable(502), unparsable(504), 'ok']);
    await adapter.answerGuestQuery('gq-1', article);
    assert(calls.length === 3, `${calls.length} tries`);
    reset();
    const bad = fakeBot([unparsable(400)]);
    let thrown: unknown;
    try {
      await bad.adapter.answerGuestQuery('gq-1', article);
    } catch (error) {
      thrown = error;
    }
    assert(thrown && bad.calls.length === 1, `tries ${bad.calls.length}`);
  });

  await check('no answer (EFATAL) is retried', async () => {
    reset();
    const { calls, adapter } = fakeBot([noAnswer(), 'ok']);
    await adapter.answerGuestQuery('gq-1', article);
    assert(calls.length === 2, `${calls.length} tries`);
  });

  await check('a 400 (query already answered, or guest mode off) fails at once with Telegram\'s error', async () => {
    reset();
    const refusal = telegramError(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
    const { calls, adapter } = fakeBot([refusal]);
    let thrown: unknown;
    try {
      await adapter.answerGuestQuery('gq-1', article);
    } catch (error) {
      thrown = error;
    }
    assert(thrown === refusal && calls.length === 1, `tries ${calls.length}, thrown ${String(thrown)}`);
  });

  await check('a retry_after over 10 s fails at once; three 500s in a row give up after 3 retries', async () => {
    reset();
    const slow = fakeBot([telegramError(429, 'Too Many Requests: retry after 30', 30)]);
    let thrown: unknown;
    try {
      await slow.adapter.answerGuestQuery('gq-1', article);
    } catch (error) {
      thrown = error;
    }
    assert(thrown && slow.calls.length === 1, `tries ${slow.calls.length}`);
    reset();
    const down = fakeBot([telegramError(502, 'Bad Gateway'), telegramError(502, 'Bad Gateway'), telegramError(502, 'Bad Gateway'), telegramError(502, 'Bad Gateway')]);
    let thrown2: unknown;
    try {
      await down.adapter.answerGuestQuery('gq-1', article);
    } catch (error) {
      thrown2 = error;
    }
    assert(thrown2 && down.calls.length === 4, `tries ${down.calls.length}`);
    assert(warnings.every(w => w.startsWith('[ask] answerGuestQuery ')), show(warnings));
  });

  __useRetryForTests(null);
  console.warn = realWarn;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.warn = realWarn;
  console.error('smoke crashed:', err);
  process.exit(1);
});
