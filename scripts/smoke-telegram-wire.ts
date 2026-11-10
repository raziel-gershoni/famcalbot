// Smoke test for what the Bot API client puts on the wire (src/services/telegram/bot.ts, src/services/messaging/telegram-adapter.ts,
// node-telegram-bot-api 2.x). The real `Api` is built with TELEGRAM_API_OPTIONS and a recording fetch, wrapped in a TelegramAdapter:
//   - sendMessage: one POST, reply_markup sent once as JSON, link previews off through link_preview_options;
//   - an edit: reply_markup sent once as JSON (never a string inside a string);
//   - a voice note and the weather photo: files with today's names and types (voice-….opus / application/octet-stream,
//     weather.png / image/png), plus caption and duration;
//   - a guest answer: `result` as JSON once; a draft: a numeric chat_id;
//   - no library retry or timeout: a lost answer, a gateway's 502 and a 429 each reach Telegram exactly once.
// 2.x sends a plain call as application/x-www-form-urlencoded (fields as strings, objects JSON-encoded once) and a call with a
// file as multipart/form-data. No network: the fetch is the recorder.
//
//   npx tsx scripts/smoke-telegram-wire.ts

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from 'node-telegram-bot-api';
import { TELEGRAM_API_OPTIONS } from '../src/services/telegram/bot';
import { guestAnswerArticle, TelegramAdapter } from '../src/services/messaging/telegram-adapter';
import { MessageFormat } from '../src/services/messaging/types';

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

/** One recorded request: the method, and its fields (text fields as sent; a file part as { filename, type, size }). */
type Sent = {
  url: string;
  method: string;
  contentType: string;
  fields: Record<string, string>;
  files: Record<string, { filename: string; type: string; size: number }>;
};

type Answer = Response | Error;
function recorder(answers: Answer[] = []) {
  const sent: Sent[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const contentType = headers.get('content-type') ?? '';
    // Read the body the way a server would: urlencoded text, or multipart (the body is a stream)
    const raw = await new Response(init?.body as BodyInit).arrayBuffer();
    const form = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
    const fields: Record<string, string> = {};
    const files: Sent['files'] = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') fields[key] = value;
      else files[key] = { filename: value.name, type: value.type, size: value.size };
    }
    sent.push({ url, method: url.split('/').pop() ?? '', contentType, fields, files });
    const next = answers[sent.length - 1];
    if (next instanceof Error) throw next;
    if (next) return next;
    // The default answer: ok, with a message-shaped result
    return json({ ok: true, result: { message_id: 4242, chat: { id: 555 }, date: 1 } });
  };
  return { sent, fetchImpl };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function build(answers: Answer[] = []) {
  const rec = recorder(answers);
  const api = new Api('123:test', { ...TELEGRAM_API_OPTIONS, fetch: rec.fetchImpl as typeof fetch });
  return { ...rec, api, adapter: new TelegramAdapter(api) };
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'smoke-telegram-wire-'));

  await check('sendMessage: one POST with the HTML mode, a force_reply sent once as JSON, link previews off through link_preview_options', async () => {
    const { adapter, sent } = build();
    const id = await adapter.sendMessage(555, 'Hello <b>there</b>', {
      format: MessageFormat.HTML,
      forceReply: true,
      inputPlaceholder: 'Type here',
      disablePreview: true,
    });
    assert(id === 4242, `message id ${id}`);
    assert(sent.length === 1, `requests ${sent.length}`);
    const r = sent[0];
    assert(r.url === 'https://api.telegram.org/bot123:test/sendMessage', r.url);
    assert(r.fields.chat_id === '555' && r.fields.text === 'Hello <b>there</b>' && r.fields.parse_mode === 'HTML', show(r.fields));
    assert(show(JSON.parse(r.fields.reply_markup)) === show({ force_reply: true, input_field_placeholder: 'Type here' }), r.fields.reply_markup);
    assert(show(JSON.parse(r.fields.link_preview_options)) === show({ is_disabled: true }), r.fields.link_preview_options);
    assert(!('disable_web_page_preview' in r.fields), 'the old preview field is sent');
  });

  await check('an edit: reply_markup is an inline keyboard sent once as JSON, never a string inside a string', async () => {
    const { adapter, sent } = build([json({ ok: true, result: true })]);
    const keyboard = { inline_keyboard: [[{ text: 'Done', callback_data: 'nr:done:1' }]] };
    await adapter.updateMessage(555, 77, 'Edited', { format: MessageFormat.HTML, disablePreview: true, replyMarkup: keyboard });
    assert(sent.length === 1 && sent[0].method === 'editMessageText', show(sent.map(s => s.method)));
    const f = sent[0].fields;
    assert(f.chat_id === '555' && f.message_id === '77' && f.text === 'Edited' && f.parse_mode === 'HTML', show(f));
    const markup = JSON.parse(f.reply_markup);
    assert(typeof markup === 'object' && show(markup) === show(keyboard), `reply_markup decodes to ${show(markup)}`);
    assert(show(JSON.parse(f.link_preview_options)) === show({ is_disabled: true }), f.link_preview_options);
  });

  await check('sendVoice: a multipart file part voice with the file\'s own name and application/octet-stream, plus caption and duration', async () => {
    const path = join(scratch, 'voice-smoke.opus');
    writeFileSync(path, Buffer.from('OggS-smoke-bytes'));
    const { adapter, sent } = build();
    await adapter.sendVoice(555, path, { caption: 'Your summary', duration: 42 });
    assert(sent.length === 1 && sent[0].method === 'sendVoice', show(sent.map(s => s.method)));
    const r = sent[0];
    assert(r.contentType.startsWith('multipart/form-data'), r.contentType);
    assert(show(r.files.voice) === show({ filename: 'voice-smoke.opus', type: 'application/octet-stream', size: 16 }), show(r.files));
    assert(r.fields.chat_id === '555' && r.fields.caption === 'Your summary' && r.fields.duration === '42', show(r.fields));
  });

  await check('sendPhoto: a Buffer goes as the part photo named weather.png of type image/png, with the caption, HTML mode and a keyboard', async () => {
    const { adapter, sent } = build();
    const keyboard = { inline_keyboard: [[{ text: 'Open', web_app: { url: 'https://example.com/w' } }]] };
    const id = await adapter.sendPhoto(555, Buffer.from('PNG-smoke-bytes'), { caption: 'Weather', format: MessageFormat.HTML, replyMarkup: keyboard });
    assert(id === 4242, `message id ${id}`);
    const r = sent[0];
    assert(r.method === 'sendPhoto' && r.contentType.startsWith('multipart/form-data'), `${r.method} ${r.contentType}`);
    assert(show(r.files.photo) === show({ filename: 'weather.png', type: 'image/png', size: 15 }), show(r.files));
    assert(r.fields.caption === 'Weather' && r.fields.parse_mode === 'HTML' && show(JSON.parse(r.fields.reply_markup)) === show(keyboard), show(r.fields));
  });

  await check('answerGuestQuery: the query id, and `result` decoded once is the article object', async () => {
    const { adapter, sent } = build([json({ ok: true, result: { inline_message_id: 'x' } })]);
    const article = guestAnswerArticle('Friday: free all day', { text: 'Open FamCal', url: 'https://t.me/famcal_test_bot' });
    await adapter.answerGuestQuery('gq-1', article);
    assert(sent.length === 1 && sent[0].method === 'answerGuestQuery', show(sent.map(s => s.method)));
    assert(sent[0].fields.guest_query_id === 'gq-1', show(sent[0].fields));
    const result = JSON.parse(sent[0].fields.result);
    assert(typeof result === 'object' && show(result) === show(article), `result decodes to ${show(result)}`);
  });

  await check('sendMessageDraft: chat_id is a number, with the draft id, the text and the HTML mode', async () => {
    const { adapter, api, sent } = build();
    const drafts: Array<Record<string, unknown>> = [];
    const original = api.sendMessageDraft.bind(api);
    api.sendMessageDraft = ((params: Parameters<typeof original>[0], signal?: AbortSignal) => {
      drafts.push(params as unknown as Record<string, unknown>);
      return original(params, signal);
    }) as typeof api.sendMessageDraft;
    const handle = await adapter.streamMessage('555', { initialPlaceholder: 'Working' });
    handle.pushDelta('Hello <b>wor');
    for (let i = 0; i < 100 && !sent.some(s => s.method === 'sendMessageDraft'); i++) await new Promise(r => setTimeout(r, 10));
    await handle.cancel('stop');
    const wire = sent.find(s => s.method === 'sendMessageDraft');
    assert(wire, show(sent.map(s => s.method)));
    assert(drafts.length >= 1 && typeof drafts[0].chat_id === 'number' && drafts[0].chat_id === 555, show(drafts));
    assert(typeof drafts[0].draft_id === 'number', show(drafts[0]));
    assert(wire.fields.chat_id === '555' && /^\d+$/.test(wire.fields.draft_id) && wire.fields.parse_mode === 'HTML', show(wire.fields));
    assert(wire.fields.text === 'Hello <b>wor</b>', wire.fields.text);
  });

  await check('no retry: a lost answer, a gateway\'s 502 page and a 429 each make exactly one request and throw', async () => {
    const lost = build([new TypeError('fetch failed')]);
    let thrown: unknown;
    try { await lost.adapter.sendMessage(555, 'hi'); } catch (e) { thrown = e; }
    assert((thrown as { code?: string } | undefined)?.code === 'EFETCH' && lost.sent.length === 1, `lost: ${(thrown as { code?: string } | undefined)?.code} after ${lost.sent.length}`);

    const page = build([new Response('<html>Bad Gateway</html>', { status: 502 })]);
    thrown = undefined;
    try { await page.adapter.sendMessage(555, 'hi'); } catch (e) { thrown = e; }
    assert((thrown as { code?: string } | undefined)?.code === 'EFETCH' && page.sent.length === 1, `502: ${(thrown as { code?: string } | undefined)?.code} after ${page.sent.length}`);

    const limited = build([json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }, 429)]);
    thrown = undefined;
    try { await limited.adapter.sendMessage(555, 'hi'); } catch (e) { thrown = e; }
    assert((thrown as { code?: string } | undefined)?.code === 'ETELEGRAM' && limited.sent.length === 1, `429: ${(thrown as { code?: string } | undefined)?.code} after ${limited.sent.length}`);
  });

  await check('TELEGRAM_API_OPTIONS is { maxRetries: 0, timeoutMs: 0 }', () => {
    assert(show(TELEGRAM_API_OPTIONS) === show({ maxRetries: 0, timeoutMs: 0 }), show(TELEGRAM_API_OPTIONS));
  });

  rmSync(scratch, { recursive: true, force: true });
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
