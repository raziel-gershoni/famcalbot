// Smoke test: every reader of a failed Bot API call reads node-telegram-bot-api 2.x's errors through the one helper,
// telegramErrorInfo (src/lib/telegram-errors.ts), and gets for each failure what it got under 0.66: the guest answer's
// retry verdict, the refund's refusal, the guest answer's log words and "already answered", the reminder pass's "try
// again on a later tick", the blocked-user flag and the reason stored with it (without 2.x's "403: " prefix).
//
// The failures are the library's own classes (scripts/lib/fake-telegram.ts). Nothing is faked but the env (fake values
// from ci-smokes); no DB, Redis or network.
//
// Run: npx tsx scripts/smoke-telegram-errors.ts

import Module from 'node:module';
import path from 'node:path';
import { tgNoAnswer, tgRefused, tgServerPage, tgUnreadable } from './lib/fake-telegram';

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS: the reminder pass and the guest answer read its ESM build.
const ModuleInternals = Module as unknown as { _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string };
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);

/** One row of the table: what each reader says of one failure (undefined: not asked of this row). */
interface Row {
  label: string;
  error: Error;
  info: unknown;
  verdict: unknown;
  refusal: string | null;
  refusalText?: string;
  alreadyAnswered: boolean;
  passing: boolean;
  unreachable: boolean;
  described: string;
}

async function main() {
  const { telegramErrorInfo } = await import('../src/lib/telegram-errors');
  const { telegramRetryVerdict } = await import('../src/services/messaging/telegram-adapter');
  const { telegramRefusal } = await import('../src/services/admin-refund');
  const { refusalText, alreadyAnswered } = await import('../src/services/ask-in-chat/handler');
  const { isPassingFailure } = await import('../src/services/native-reminders/pass');
  const { isUnreachableError, describeDeliveryError } = await import('../src/lib/delivery-errors');

  const noAnswer = tgNoAnswer();
  const serverPage = tgServerPage(502);
  const unreadable = tgUnreadable();
  const flattened = new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user');

  const rows: Row[] = [
    {
      label: '400 query is too old', error: tgRefused(400, 'Bad Request: query is too old'),
      info: { kind: 'refused', status: 400, description: 'Bad Request: query is too old', retryAfterMs: null },
      verdict: { retry: false }, refusal: 'Bad Request: query is too old', refusalText: 'HTTP 400 Bad Request: query is too old',
      alreadyAnswered: false, passing: false, unreachable: false, described: 'Bad Request: query is too old',
    },
    {
      label: '400 query has already been answered', error: tgRefused(400, 'Bad Request: query has already been answered'),
      info: { kind: 'refused', status: 400, description: 'Bad Request: query has already been answered', retryAfterMs: null },
      verdict: { retry: false }, refusal: 'Bad Request: query has already been answered', refusalText: 'HTTP 400 Bad Request: query has already been answered',
      alreadyAnswered: true, passing: false, unreachable: false, described: 'Bad Request: query has already been answered',
    },
    {
      label: '403 bot was blocked by the user', error: tgRefused(403, 'Forbidden: bot was blocked by the user'),
      info: { kind: 'refused', status: 403, description: 'Forbidden: bot was blocked by the user', retryAfterMs: null },
      verdict: { retry: false }, refusal: 'Forbidden: bot was blocked by the user', refusalText: 'HTTP 403 Forbidden: bot was blocked by the user',
      alreadyAnswered: false, passing: false, unreachable: true, described: 'Forbidden: bot was blocked by the user',
    },
    {
      label: '403 with words not known to mean blocked', error: tgRefused(403, 'Forbidden: something new'),
      info: { kind: 'refused', status: 403, description: 'Forbidden: something new', retryAfterMs: null },
      verdict: { retry: false }, refusal: 'Forbidden: something new',
      alreadyAnswered: false, passing: false, unreachable: false, described: 'Forbidden: something new',
    },
    {
      label: '429 retry after 3', error: tgRefused(429, 'Too Many Requests: retry after 3', 3),
      info: { kind: 'refused', status: 429, description: 'Too Many Requests: retry after 3', retryAfterMs: 3000 },
      verdict: { retry: true, askedMs: 3000 }, refusal: null, refusalText: 'HTTP 429 Too Many Requests: retry after 3',
      alreadyAnswered: false, passing: true, unreachable: false, described: 'Too Many Requests: retry after 3',
    },
    {
      label: '500 Internal Server Error (Telegram\'s JSON)', error: tgRefused(500, 'Internal Server Error'),
      info: { kind: 'refused', status: 500, description: 'Internal Server Error', retryAfterMs: null },
      verdict: { retry: true }, refusal: null, refusalText: 'HTTP 500 Internal Server Error',
      alreadyAnswered: false, passing: true, unreachable: false, described: 'Internal Server Error',
    },
    {
      label: 'no answer (fetch threw)', error: noAnswer,
      info: { kind: 'no-answer', code: 'EFETCH' },
      verdict: { retry: true }, refusal: null, refusalText: 'no answer (EFETCH)',
      alreadyAnswered: false, passing: true, unreachable: false, described: noAnswer.message,
    },
    {
      label: 'a gateway\'s HTML 502 (now EFETCH, still retried)', error: serverPage,
      info: { kind: 'no-answer', code: 'EFETCH' },
      verdict: { retry: true }, refusal: null, refusalText: 'no answer (EFETCH)',
      alreadyAnswered: false, passing: true, unreachable: false, described: serverPage.message,
    },
    {
      label: 'an answer under 500 that is not JSON (EPARSE: no status in 2.x, so the guest answer no longer retries it)', error: unreadable,
      info: { kind: 'unreadable', code: 'EPARSE' },
      verdict: { retry: false }, refusal: null, refusalText: 'no answer (EPARSE)',
      alreadyAnswered: false, passing: true, unreachable: false, described: unreadable.message,
    },
    {
      label: 'not a Telegram error (our own bug)', error: new Error('boom'),
      info: null,
      verdict: { retry: false }, refusal: null, refusalText: 'no answer (Error)',
      alreadyAnswered: false, passing: true, unreachable: false, described: 'boom',
    },
    {
      label: 'a flattened message (the structure lost on the way)', error: flattened,
      info: null,
      verdict: { retry: false }, refusal: null,
      alreadyAnswered: false, passing: true, unreachable: true, described: flattened.message,
    },
  ];

  for (const row of rows) {
    check(`${row.label}: every reader says what it said under 0.66`, () => {
      const got = {
        info: telegramErrorInfo(row.error),
        verdict: telegramRetryVerdict(row.error),
        refusal: telegramRefusal(row.error),
        ...(row.refusalText !== undefined ? { refusalText: refusalText(row.error) } : {}),
        alreadyAnswered: alreadyAnswered(row.error),
        passing: isPassingFailure(row.error),
        unreachable: isUnreachableError(row.error),
        described: describeDeliveryError(row.error),
      };
      const want = {
        info: row.info,
        verdict: row.verdict,
        refusal: row.refusal,
        ...(row.refusalText !== undefined ? { refusalText: row.refusalText } : {}),
        alreadyAnswered: row.alreadyAnswered,
        passing: row.passing,
        unreachable: row.unreachable,
        described: row.described,
      };
      for (const key of Object.keys(want) as (keyof typeof want)[]) {
        assert(show(got[key]) === show(want[key]), `${key}: got ${show(got[key])}, want ${show(want[key])}`);
      }
    });
  }

  check('the reason stored for a blocked user is Telegram\'s words, without 2.x\'s "403: " prefix', () => {
    const blocked = tgRefused(403, 'Forbidden: bot was blocked by the user');
    assert(blocked.message === '403: Forbidden: bot was blocked by the user', `the library's message changed: ${blocked.message}`);
    assert(describeDeliveryError(blocked) === 'Forbidden: bot was blocked by the user', describeDeliveryError(blocked));
  });

  check('a 400 "message is not modified" still says so in its message (the adapter\'s and the reminders\' checks read it)', () => {
    const error = tgRefused(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
    assert(error.message.includes('message is not modified'), error.message);
  });

  check('a WhatsApp error classifies as before: 131026 is unreachable, 131047 is not, and neither is a Telegram error', () => {
    const waError = (code: number) => new Error(`WhatsApp API error: ${show({ error: { message: 'x', type: 'OAuthException', code, error_data: { messaging_product: 'whatsapp', details: 'x' }, fbtrace_id: 'abc' } })}`);
    assert(isUnreachableError(waError(131026)), '131026 not classified');
    assert(!isUnreachableError(waError(131047)), '131047 classified');
    assert(isUnreachableError(Object.assign(new Error('x'), { whatsappError: { code: 131026 } })), 'status error not classified');
    assert(telegramErrorInfo(waError(131026)) === null, 'a WhatsApp error read as a Telegram one');
  });

  check('a non-error (a string, null) is no Telegram error and nothing reads it as a refusal', () => {
    assert(telegramErrorInfo('ETELEGRAM') === null && telegramErrorInfo(null) === null, 'a non-error was read');
    assert(show(telegramRetryVerdict(null)) === show({ retry: false }) && telegramRefusal(null) === null && !alreadyAnswered(null) && isPassingFailure(null), 'a non-error was classified');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.reason ? `\n      ${r.reason}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
