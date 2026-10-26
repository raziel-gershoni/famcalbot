// Smoke test for albums and PDFs in the photo-to-events feature (spec
// docs/superpowers/specs/2026-10-25-albums-and-pdfs-design.md).
//
// A Telegram album arrives as separate webhook updates sharing media_group_id. Every part
// is stored in Redis; exactly one request (the leader, by a SET NX lock) waits for a quiet
// period, reads them all in ONE Gemini request and shows ONE card. A PDF (or an image sent
// as a document) is read as one file; the first 20 pages of a longer PDF are kept.
//
// Real: the Telegram webhook branch, the album collector, the media handler, gemini-image
// (prompt, retry, parsing), the event-extraction prompt builder, pdf-lib, the dedupe, the
// bot texts and the typing interval. Faked at the boundaries: Gemini (scripted answers),
// Redis (in memory, with real interleaving), the Telegram file download, the user, the
// plan gate, analytics, error capture, the confirmation cards and Telegram's send calls.
// No network, no DB.
//
//   npx tsx scripts/smoke-album-pdf.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { UserConfig } from '../src/types';

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

// ---- Environment: fakes only, set before anything under test loads ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';

const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

/** Intervals still running: the typing indicator must run during the work and stop after. */
const liveIntervals = new Set<unknown>();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const handle = realSetInterval(fn, ms, ...rest);
  liveIntervals.add(handle);
  return handle;
}) as unknown as typeof setInterval;
globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
  liveIntervals.delete(handle);
  realClearInterval(handle);
}) as typeof clearInterval;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const MAYA = 2001; // English, AI events on
const NOA = 2002; // Hebrew
const DANIL = 2003; // Russian
const OFF = 2004; // AI events switched off
const STRANGER = 2009;

function makeUser(id: number, telegramId: number, extra: Record<string, unknown>): UserConfig {
  return {
    id, telegramId, name: 'Maya', englishName: 'Maya', gender: 'female', language: 'en',
    calendarSource: 'NATIVE', googleRefreshToken: '', pairingId: null, isAdmin: false,
    suspendedAt: null, unreachableSince: null, voiceInputEnabled: true,
    ...extra,
  } as unknown as UserConfig;
}
const USERS: Record<number, UserConfig> = {
  [MAYA]: makeUser(1, MAYA, {}),
  [NOA]: makeUser(2, NOA, { name: 'נועה', language: 'he' }),
  [DANIL]: makeUser(3, DANIL, { name: 'Данил', language: 'ru' }),
  [OFF]: makeUser(4, OFF, { voiceInputEnabled: false }),
};
const CALENDARS = [{ calendarId: 'native:maya', labels: ['primary', 'yours'], name: 'Home', color: '#000' }];

// ---- Fakes ----

type GeminiCall = { text: string; parts: Array<{ mimeType: string; data: string }> };
let geminiAnswers: Array<object | Error> = [];
let geminiCalls: GeminiCall[] = [];
let intervalsAtGemini: number[] = [];
/** Runs inside the Gemini call (a part can arrive while the album is being read). */
let onGemini: ((callNumber: number) => Promise<void>) | null = null;
const fakeGemini = {
  models: {
    generateContent: async (request: { contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> }) => {
      const parts = request.contents[0].parts;
      geminiCalls.push({
        text: parts.map(p => p.text ?? '').join('\n'),
        parts: parts.filter(p => p.inlineData).map(p => p.inlineData!),
      });
      intervalsAtGemini.push(liveIntervals.size);
      await onGemini?.(geminiCalls.length);
      await sleep(5);
      const answer = geminiAnswers.shift();
      if (!answer) throw new Error('no scripted Gemini answer left');
      if (answer instanceof Error) throw answer;
      return { text: JSON.stringify(answer), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    },
  },
};

/** Redis in memory: strings (NX), sets, lists. Every call yields so concurrent handlers interleave. */
const redisData = new Map<string, unknown>();
let redisLog: string[] = [];
let redisFail: ((op: string) => boolean) | null = null;
let intervalsAtLlen: number[] = [];
let lastRedisOp = 0;
const tick = () => { lastRedisOp = Date.now(); return sleep(1); };
const fakeRedis = {
  set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    await tick();
    redisLog.push(`set ${key}${opts?.nx ? ' nx' : ''}${opts?.ex ? ` ex=${opts.ex}` : ''}`);
    if (redisFail?.('set')) throw new Error('redis down');
    if (opts?.nx && redisData.has(key)) return null;
    redisData.set(key, value);
    return 'OK';
  },
  get: async (key: string) => { await tick(); return redisData.get(key) ?? null; },
  del: async (...keys: string[]) => { await tick(); redisLog.push(`del ${keys.join(',')}`); keys.forEach(k => redisData.delete(k)); return keys.length; },
  expire: async (key: string, seconds: number) => { await tick(); redisLog.push(`expire ${key} ${seconds}`); return 1; },
  sadd: async (key: string, ...members: string[]) => {
    await tick();
    if (redisFail?.('sadd')) throw new Error('redis down');
    const set = (redisData.get(key) as Set<string> | undefined) ?? new Set<string>();
    let added = 0;
    for (const m of members) if (!set.has(m)) { set.add(m); added++; }
    redisData.set(key, set);
    return added;
  },
  rpush: async (key: string, ...items: unknown[]) => {
    await tick();
    const list = (redisData.get(key) as unknown[] | undefined) ?? [];
    list.push(...items);
    redisData.set(key, list);
    return list.length;
  },
  llen: async (key: string) => {
    await tick();
    if (redisFail?.('llen')) throw new Error('redis down');
    intervalsAtLlen.push(liveIntervals.size);
    return ((redisData.get(key) as unknown[] | undefined) ?? []).length;
  },
  lrange: async (key: string, start: number, stop: number) => {
    await tick();
    if (redisFail?.('lrange')) throw new Error('redis down');
    const list = (redisData.get(key) as unknown[] | undefined) ?? [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  },
  ltrim: async (key: string, start: number, stop: number) => {
    await tick();
    const list = (redisData.get(key) as unknown[] | undefined) ?? [];
    redisData.set(key, list.slice(start, stop === -1 ? undefined : stop + 1));
    return 'OK';
  },
};

type Sent = { chatId: number | string; text: string };
let sent: Sent[] = [];
let typingCalls = 0;
const fakeService = {
  sendMessage: async (chatId: number | string, text: string) => { sent.push({ chatId, text }); return 1; },
  deleteMessage: async () => {},
  updateMessage: async () => {},
  sendTypingIndicator: async () => { typingCalls++; },
};
const fakeBot = {
  sendMessage: async (chatId: number | string, text: string) => { sent.push({ chatId, text }); return {}; },
};

type Card = { chatId: number; event: ParsedEvent; label: string; user: UserConfig; modality: string };
let cards: Card[] = [];
let bulkCards: Array<{ chatId: number | string; intents: VoiceIntentResult[]; label: string }> = [];
let captured: string[] = [];
let gateChecks: Array<{ userId: number; feature: string }> = [];
let activity: string[] = [];

/** file_id -> bytes (or a download failure). */
const files = new Map<string, Buffer | Error>();
let downloads: string[] = [];

const SRC = path.resolve(__dirname, '../src');
const noop = () => {};
const asyncNoop = async () => {};

const stubs: Record<string, object> = {
  [`${SRC}/services/ai-provider.ts`]: {
    getGemini: () => fakeGemini,
    extractionConfig: () => ({}),
    generateAICompletion: async () => { throw new Error('no AI completion in this test'); },
    streamAICompletion: async () => { throw new Error('no AI stream in this test'); },
  },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/redis-lock.ts`]: { acquireVoiceLock: async () => true, releaseVoiceLock: asyncNoop },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: new Proxy({}, { get: (_t, model) => { throw new Error(`the database was read (${String(model)})`); } }),
  },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (err: unknown, context: string) => { captured.push(`${context}: ${err instanceof Error ? err.message : String(err)}`); },
    captureWarning: noop,
    captureInfo: noop,
  },
  [`${SRC}/lib/user-moderation.ts`]: { isIdentifierBlocked: async () => false, isUserSuspended: () => false },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/services/analytics-service.ts`]: {
    setUserContext: noop,
    addBreadcrumb: noop,
    trackActivityAsync: (_userId: number, name: string) => { activity.push(name); },
    trackActivity: asyncNoop,
  },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async (userId: number, feature: string) => { gateChecks.push({ userId, feature }); return { allowed: true }; },
  },
  [`${SRC}/services/payment-handler.ts`]: { handlePreCheckoutQuery: asyncNoop, handleSuccessfulPayment: asyncNoop },
  [`${SRC}/services/user-service.ts`]: {
    getUserByTelegramId: async (telegramId: number) => USERS[Number(telegramId)] ?? null,
    getOrCreateUser: async (telegramId: number) => USERS[Number(telegramId)],
    getUserByWhatsAppPhone: async () => null,
    getOrCreateUserByWhatsApp: async () => null,
  },
  [`${SRC}/services/telegram/index.ts`]: {
    getBot: () => fakeBot,
    getMessagingService: () => fakeService,
    handleStartCommand: asyncNoop,
    handleSummaryCommand: asyncNoop,
    handleWeatherCommand: asyncNoop,
    handleFeedbackCommand: asyncNoop,
    handleConnectCommand: asyncNoop,
  },
  [`${SRC}/services/voice/index.ts`]: {
    handleVoiceMessage: asyncNoop,
    handleEventCallback: asyncNoop,
    handleEditCallback: asyncNoop,
    handleDeleteCallback: asyncNoop,
  },
  [`${SRC}/services/voice/event-resolution.ts`]: {
    downloadTelegramFile: async (fileId: string) => {
      downloads.push(fileId);
      await sleep(2);
      const got = files.get(fileId);
      if (!got) throw new Error(`no such file ${fileId}`);
      if (got instanceof Error) throw got;
      return got;
    },
  },
  [`${SRC}/services/voice/confirmations.ts`]: {
    escapeHtml: (text: string) => text,
    showEventConfirmation: async (chatId: number, _messageId: number | undefined, event: ParsedEvent, label: string, user: UserConfig, _footer: string | undefined, modality: string) => {
      cards.push({ chatId, event, label, user, modality });
    },
  },
  [`${SRC}/services/voice/bulk-confirmations.ts`]: {
    showBulkConfirmation: async (chatId: number | string, intents: VoiceIntentResult[], _user: UserConfig, label: string) => {
      bulkCards.push({ chatId, intents, label });
      return 'bulk:1';
    },
  },
  [`${SRC}/services/voice/auto-create.ts`]: { isAutoCreateEnabled: async () => false, autoCreateEvent: async () => false },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => CALENDARS,
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Scenario helpers ----

function reset() {
  geminiAnswers = [];
  geminiCalls = [];
  intervalsAtGemini = [];
  onGemini = null;
  intervalsAtLlen = [];
  redisData.clear();
  redisLog = [];
  redisFail = null;
  sent = [];
  typingCalls = 0;
  cards = [];
  bulkCards = [];
  captured = [];
  gateChecks = [];
  activity = [];
  files.clear();
  downloads = [];
}

let nextUpdateId = 1;
let nextMessageId = 100;
const sizes = [{ width: 90, height: 90 }, { width: 1280, height: 960 }];

interface PartOpts { gid?: string; caption?: string; messageId?: number; forwarded?: boolean }

function base(fromId: number, opts: PartOpts) {
  return {
    message_id: opts.messageId ?? nextMessageId++, date: 0,
    from: { id: fromId, first_name: 'Maya' }, chat: { id: fromId, type: 'private' },
    ...(opts.gid ? { media_group_id: opts.gid } : {}),
    ...(opts.caption ? { caption: opts.caption } : {}),
    ...(opts.forwarded ? { forward_origin: { type: 'user' }, forward_date: 1 } : {}),
  };
}

/** A photo message: Telegram sends several sizes, the last is the largest. */
function photoUpdate(fromId: number, uid: string, opts: PartOpts = {}) {
  files.set(`f-${uid}`, Buffer.from(`jpeg-${uid}`));
  return {
    update_id: nextUpdateId++,
    message: {
      ...base(fromId, opts),
      photo: sizes.map((s, i) => ({ ...s, file_id: `f-${uid}${i === 0 ? '-small' : ''}`, file_unique_id: `u-${uid}${i === 0 ? '-small' : ''}`, file_size: 1000 })),
    },
  };
}
function videoUpdate(fromId: number, uid: string, opts: PartOpts = {}) {
  return {
    update_id: nextUpdateId++,
    message: { ...base(fromId, opts), video: { file_id: `f-${uid}`, file_unique_id: `u-${uid}`, duration: 3, width: 10, height: 10, mime_type: 'video/mp4', file_size: 5000 } },
  };
}
function documentUpdate(fromId: number, uid: string, mime: string, size: number | undefined, opts: PartOpts & { animation?: boolean } = {}) {
  return {
    update_id: nextUpdateId++,
    message: {
      ...base(fromId, opts),
      document: { file_id: `f-${uid}`, file_unique_id: `u-${uid}`, file_name: `${uid}`, mime_type: mime, file_size: size },
      // Telegram also sets message.document on a GIF, "for backward compatibility".
      ...(opts.animation ? { animation: { file_id: `f-${uid}`, file_unique_id: `u-${uid}`, duration: 1, width: 10, height: 10 } } : {}),
    },
  };
}

async function pdfOf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]).drawText(`Page ${i + 1}`);
  return Buffer.from(await doc.save());
}
async function pagesOf(base64: string): Promise<number> {
  return (await PDFDocument.load(Buffer.from(base64, 'base64'))).getPageCount();
}

const { log, warn, error } = console;
const loud = false; // set true to see the services' logs while debugging
// A depth count: several webhooks run at once, and the logs stay silent until the last ends.
let quietDepth = 0;
function quietOn() { if (!loud && quietDepth++ === 0) { console.log = noop; console.warn = noop; console.error = noop; } }
function quietOff() { if (!loud && --quietDepth === 0) Object.assign(console, { log, warn, error }); }

/** Posts one update to the real webhook; resolves when the webhook answered, with its status. */
async function deliver(update: object): Promise<number> {
  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');
  let status = 0;
  quietOn();
  try {
    await handleTelegramWebhook({ body: update }, { status: code => { status = code; return { json: noop }; } });
  } finally {
    quietOff();
  }
  return status;
}
/**
 * Waits until the background work of an album (quiet wait, lock, read, reply) is over:
 * no album lock, no typing interval and no Redis call for a moment.
 */
async function settle(): Promise<void> {
  for (;;) {
    await sleep(15);
    const locked = [...redisData.keys()].some(k => k.includes(':lock'));
    if (!locked && liveIntervals.size === 0 && Date.now() - lastRedisOp > 40) return;
  }
}
/**
 * Posts several updates the way Telegram does for one chat: one after another, each
 * webhook answered before the next one is sent (staggerMs is the pause between them).
 * Then waits for the background read to finish.
 */
async function deliverAll(updates: object[], staggerMs = 0): Promise<number[]> {
  const out: number[] = [];
  for (const u of updates) {
    out.push(await deliver(u));
    if (staggerMs) await sleep(staggerMs);
  }
  await settle();
  return out;
}

const ev = (title: string, date: string, time = '18:00', extra: Record<string, unknown> = {}) => ({
  intent: 'create', confidence: 'medium',
  event: { title, startDate: date, startTime: time, endDate: date, endTime: '19:00', allDay: false, calendarId: 'native:maya', calendarName: 'Home', recurrence: null, ...extra },
});
const answerOf = (...events: Array<ReturnType<typeof ev>>) =>
  events.length === 1 ? events[0] : { intent: 'create', confidence: 'medium', intents: events };
const NONE = { intent: 'none', confidence: 'high' };

const msg = async (locale: string, key: string, params?: Record<string, string>) => {
  const { getBotMessage } = await import('../src/lib/bot-messages');
  return getBotMessage(locale, `imageEvent.${key}`, params);
};
const cardTitles = () => [...cards.map(c => c.event.title), ...bulkCards.flatMap(b => b.intents.map(i => i.event!.title))];
const nothingShown = () => assert(cards.length === 0 && bulkCards.length === 0, `a card was shown: ${JSON.stringify(cardTitles())}`);

async function main() {
  const { albumConfig } = await import('../src/services/image-event/album');
  albumConfig.quietMs = 80;

  // ---- Albums ----

  await check('album of 2: parts collected, ONE Gemini request, ONE bulk card, one usage', async () => {
    reset();
    geminiAnswers = [answerOf(ev('Noa birthday', '2026-11-14'), ev('Dance recital', '2026-11-20'))];
    const codes = await deliverAll([
      photoUpdate(MAYA, 'a1', { gid: 'G1' }),
      photoUpdate(MAYA, 'a2', { gid: 'G1' }),
    ]);
    assert(codes.every(c => c === 200), `statuses ${codes}`);
    assert(geminiCalls.length === 1, `${geminiCalls.length} Gemini calls`);
    assert(geminiCalls[0].parts.length === 2, `${geminiCalls[0].parts.length} parts sent`);
    assert(geminiCalls[0].parts.every(p => p.mimeType === 'image/jpeg'), 'mime');
    const order = geminiCalls[0].parts.map(p => Buffer.from(p.data, 'base64').toString());
    assert(order.join() === 'jpeg-a1,jpeg-a2', `order ${order}`);
    assert(downloads.every(d => !d.endsWith('-small')), `downloaded a small size: ${downloads}`);
    assert(bulkCards.length === 1 && cards.length === 0, `${bulkCards.length} bulk, ${cards.length} single`);
    assert(bulkCards[0].intents.length === 2, `${bulkCards[0].intents.length} events`);
    assert(bulkCards[0].label === (await msg('en', 'fromImages')), `label ${bulkCards[0].label}`);
    assert(sent.length === 0, `extra messages ${JSON.stringify(sent)}`);
    assert(gateChecks.length === 1 && gateChecks[0].feature === 'voice_events', `gate ${JSON.stringify(gateChecks)}`);
    assert(activity.filter(a => a === 'image_event_started').length === 1, `usage ${activity}`);
    assert(liveIntervals.size === 0, `${liveIntervals.size} typing interval(s) still running`);
  });

  await check('album of 10: all ten read in one request, in message order, even when they arrive shuffled', async () => {
    reset();
    geminiAnswers = [answerOf(ev('One', '2026-11-01'), ev('Two', '2026-11-02'))];
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const shuffled = [5, 0, 9, 3, 1, 8, 2, 7, 4, 6];
    const updates = ids.map((id, i) => photoUpdate(MAYA, id, { gid: 'G10', messageId: 500 + i }));
    await deliverAll(shuffled.map(i => updates[i]));
    assert(geminiCalls.length === 1, `${geminiCalls.length} Gemini calls`);
    const order = geminiCalls[0].parts.map(p => Buffer.from(p.data, 'base64').toString().replace('jpeg-', ''));
    assert(order.join() === ids.join(), `order ${order}`);
    assert(bulkCards.length === 1, 'no bulk card');
    assert(gateChecks.length === 1, `${gateChecks.length} gate checks`);
  });

  await check('album: a caption on the 2nd part applies to the whole album', async () => {
    reset();
    geminiAnswers = [answerOf(ev('Class trip', '2026-11-05'))];
    await deliverAll([
      photoUpdate(MAYA, 'c1', { gid: 'GC', messageId: 701 }),
      photoUpdate(MAYA, 'c2', { gid: 'GC', messageId: 702, caption: 'for the kids calendar' }),
    ]);
    assert(geminiCalls.length === 1 && geminiCalls[0].text.includes('for the kids calendar'), 'caption missing from the prompt');
    assert(cards.length === 1 && cards[0].label === 'for the kids calendar', `label ${cards[0]?.label}`);
  });

  await check('album: a part arriving late, within the quiet period, is still read', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'), ev('B', '2026-11-02'), ev('C', '2026-11-03'))];
    await deliverAll([
      photoUpdate(MAYA, 'l1', { gid: 'GL', messageId: 801 }),
      photoUpdate(MAYA, 'l2', { gid: 'GL', messageId: 802 }),
      photoUpdate(MAYA, 'l3', { gid: 'GL', messageId: 803 }),
    ], albumConfig.quietMs - 25);
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 3, `${geminiCalls.length} calls, ${geminiCalls[0]?.parts.length} parts`);
    assert(bulkCards.length === 1 && bulkCards[0].intents.length === 3, 'one card with three events');
  });

  await check('album: concurrent handlers, only one reads (one lock, one request)', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'), ev('B', '2026-11-02'))];
    await deliverAll(Array.from({ length: 5 }, (_, i) => photoUpdate(MAYA, `k${i}`, { gid: 'GK', messageId: 900 + i })));
    const lockTries = redisLog.filter(l => l.startsWith('set album:') && l.includes(':lock') && l.includes('nx'));
    assert(lockTries.length === 5, `${lockTries.length} lock attempts`);
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 5, `${geminiCalls.length} calls`);
    assert(bulkCards.length === 1 && cards.length === 0, 'more than one card');
    assert(redisLog.some(l => l.startsWith('expire album:')), 'the parts have no expiry');
    assert(!([...redisData.keys()].some(k => k.includes(':lock'))), 'the lock was left behind');
  });

  await check('album: the leader types during the quiet wait and the read, and stops after', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    await deliverAll([photoUpdate(MAYA, 'y1', { gid: 'GY' }), photoUpdate(MAYA, 'y2', { gid: 'GY' })]);
    // The last count is the leader's look after the read (typing stopped before the answer).
    assert(intervalsAtLlen.length >= 2 && intervalsAtLlen.slice(0, -1).every(n => n >= 1), `interval during the wait: ${intervalsAtLlen}`);
    assert(intervalsAtGemini.every(n => n >= 1), `interval during the read: ${intervalsAtGemini}`);
    assert(typingCalls >= 1, 'no typing action was sent');
    assert(liveIntervals.size === 0, 'typing interval still running');
  });

  await check('album: a part landing while the album is being read is read in a second round, not stranded', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01')), answerOf(ev('B', '2026-11-02'))];
    let late: Promise<number> | null = null;
    onGemini = async n => { if (n === 1) late = deliver(photoUpdate(MAYA, 'j3', { gid: 'GJ', messageId: 1203 })); };
    await deliverAll([photoUpdate(MAYA, 'j1', { gid: 'GJ', messageId: 1201 }), photoUpdate(MAYA, 'j2', { gid: 'GJ', messageId: 1202 })]);
    await late;
    await settle();
    assert(geminiCalls.length === 2, `${geminiCalls.length} Gemini calls`);
    assert(geminiCalls[0].parts.length === 2 && geminiCalls[1].parts.length === 1, `parts ${geminiCalls.map(c => c.parts.length)}`);
    assert(cards.length === 2, `${cards.length} cards`);
    assert(intervalsAtGemini.every(n => n >= 1), `typing during the reads: ${intervalsAtGemini}`);
    assert(!([...redisData.keys()].some(k => k.includes(':lock'))), 'the lock was left behind');
    assert(liveIntervals.size === 0, 'typing interval still running');
  });

  await check('pdf: nothing found uses the PDF wording', async () => {
    reset();
    files.set('f-nopdf', await pdfOf(1));
    geminiAnswers = [NONE];
    await deliver(documentUpdate(MAYA, 'nopdf', 'application/pdf', 1000));
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'noEventFoundPdf')), `sent ${JSON.stringify(sent)}`);
  });

  await check('album: a part is never also handled as a single photo', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    await deliverAll([photoUpdate(MAYA, 'n1', { gid: 'GN' }), photoUpdate(MAYA, 'n2', { gid: 'GN' })]);
    assert(downloads.length === 2, `${downloads.length} downloads: ${downloads}`);
    assert(activity.filter(a => a === 'image_event_started').length === 1, `usage ${activity}`);
  });

  await check('album: a Telegram retry of a part (same file) is ignored, also after the album was read', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    const p1 = photoUpdate(MAYA, 'r1', { gid: 'GR', messageId: 1001 });
    const p2 = photoUpdate(MAYA, 'r2', { gid: 'GR', messageId: 1002 });
    await deliverAll([p1, p2, p1]);
    await deliver(p2);
    await settle();
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 2, `${geminiCalls.length} calls, parts ${geminiCalls[0]?.parts.length}`);
    assert(cards.length + bulkCards.length === 1, 'the retry made another card');
  });

  await check('album: a part that cannot be downloaded is dropped with a note, the rest go through', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'), ev('B', '2026-11-02'))];
    const u = [photoUpdate(MAYA, 'd1', { gid: 'GD' }), photoUpdate(MAYA, 'd2', { gid: 'GD' }), photoUpdate(MAYA, 'd3', { gid: 'GD' })];
    files.set('f-d2', new Error('Telegram said no'));
    await deliverAll(u);
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 2, `${geminiCalls[0]?.parts.length} parts`);
    assert(bulkCards.length === 1, 'no card');
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'partsUnreadable')), `notes ${JSON.stringify(sent)}`);
    assert(captured.some(c => c.includes('Telegram said no')), `not captured: ${captured}`);
  });

  await check('album: every part failing gives one error reply, no Gemini call', async () => {
    reset();
    const u = [photoUpdate(MAYA, 'e1', { gid: 'GE' }), photoUpdate(MAYA, 'e2', { gid: 'GE' })];
    files.set('f-e1', new Error('gone'));
    files.set('f-e2', new Error('gone'));
    await deliverAll(u);
    const { getBotMessages } = await import('../src/lib/bot-messages');
    assert(geminiCalls.length === 0, 'Gemini was called');
    assert(sent.length === 1 && sent[0].text === (await getBotMessages('en')).voice.geminiError, `sent ${JSON.stringify(sent)}`);
    nothingShown();
  });

  await check('album: nothing found anywhere gives ONE "no events" reply', async () => {
    reset();
    geminiAnswers = [NONE];
    await deliverAll([photoUpdate(MAYA, 'z1', { gid: 'GZ' }), photoUpdate(MAYA, 'z2', { gid: 'GZ' }), photoUpdate(MAYA, 'z3', { gid: 'GZ' })]);
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'noEventFoundMany')), `sent ${JSON.stringify(sent)}`);
    nothingShown();
  });

  await check('album: a video is skipped with a note, the photos are read', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'), ev('B', '2026-11-02'))];
    await deliverAll([
      photoUpdate(MAYA, 'v1', { gid: 'GV', messageId: 1101 }),
      videoUpdate(MAYA, 'v2', { gid: 'GV', messageId: 1102 }),
      photoUpdate(MAYA, 'v3', { gid: 'GV', messageId: 1103 }),
    ]);
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 2, `${geminiCalls[0]?.parts.length} parts`);
    assert(!downloads.includes('f-v2'), 'the video was downloaded');
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'videoSkipped')), `notes ${JSON.stringify(sent)}`);
    assert(bulkCards.length === 1, 'no card');
  });

  await check('album: a note and "no events" are ONE message', async () => {
    reset();
    geminiAnswers = [NONE];
    await deliverAll([photoUpdate(MAYA, 'w1', { gid: 'GW' }), videoUpdate(MAYA, 'w2', { gid: 'GW' })]);
    assert(sent.length === 1, `${sent.length} messages`);
    assert(sent[0].text.includes(await msg('en', 'videoSkipped')) && sent[0].text.includes(await msg('en', 'noEventFound')), `sent ${JSON.stringify(sent)}`);
  });

  await check('album: a video-only album is ignored like a lone video', async () => {
    reset();
    await deliverAll([videoUpdate(MAYA, 'x1', { gid: 'GX' }), videoUpdate(MAYA, 'x2', { gid: 'GX' })]);
    assert(geminiCalls.length === 0 && sent.length === 0 && gateChecks.length === 0, 'something happened');
  });

  await check('album: the same event on two photos is created once (deduped in code)', async () => {
    reset();
    geminiAnswers = [answerOf(ev('Noa birthday', '2026-11-14', '17:00'), ev('  noa BIRTHDAY ', '2026-11-14', '17:00'), ev('Dance recital', '2026-11-20'))];
    await deliverAll([photoUpdate(MAYA, 'q1', { gid: 'GQ' }), photoUpdate(MAYA, 'q2', { gid: 'GQ' })]);
    assert(bulkCards.length === 1 && bulkCards[0].intents.map(i => i.event!.title).join() === 'Noa birthday,Dance recital', `${JSON.stringify(cardTitles())}`);
  });

  await check('album: duplicates that collapse to one event give the single card', async () => {
    reset();
    geminiAnswers = [answerOf(ev('Noa birthday', '2026-11-14', '17:00'), ev('Noa birthday', '2026-11-14', '17:00'))];
    await deliverAll([photoUpdate(MAYA, 'p1', { gid: 'GP' }), photoUpdate(MAYA, 'p2', { gid: 'GP' })]);
    assert(cards.length === 1 && bulkCards.length === 0, `${cards.length} single, ${bulkCards.length} bulk`);
  });

  await check('album: the prompt tells Gemini the files are one ordered set and to list an event once', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    await deliverAll([photoUpdate(MAYA, 's1', { gid: 'GS' }), photoUpdate(MAYA, 's2', { gid: 'GS' })]);
    const text = geminiCalls[0].text;
    assert(/one set|in order/i.test(text) && /continue/i.test(text) && /once/i.test(text), `prompt lacks the album rules: ${text.slice(-600)}`);
  });

  await check('album: a forwarded album is read like a normal one', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'), ev('B', '2026-11-02'))];
    await deliverAll([photoUpdate(MAYA, 'o1', { gid: 'GO', forwarded: true }), photoUpdate(MAYA, 'o2', { gid: 'GO', forwarded: true })]);
    assert(geminiCalls.length === 1 && bulkCards.length === 1, 'not read as one album');
  });

  await check('albums with different ids are read separately (more than 10 photos)', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01')), answerOf(ev('B', '2026-11-02'))];
    await deliverAll([
      photoUpdate(MAYA, 'm1', { gid: 'GM1' }), photoUpdate(MAYA, 'm2', { gid: 'GM1' }),
      photoUpdate(MAYA, 'm3', { gid: 'GM2' }), photoUpdate(MAYA, 'm4', { gid: 'GM2' }),
    ]);
    assert(geminiCalls.length === 2 && geminiCalls.every(c => c.parts.length === 2), `${geminiCalls.length} calls`);
    assert(cards.length === 2, `${cards.length} cards`);
  });

  await check('album: a Hebrew user gets Hebrew copy', async () => {
    reset();
    geminiAnswers = [NONE];
    await deliverAll([photoUpdate(NOA, 'h1', { gid: 'GH' }), photoUpdate(NOA, 'h2', { gid: 'GH' })]);
    assert(sent.length === 1 && sent[0].text === (await msg('he', 'noEventFoundMany')) && sent[0].text !== (await msg('en', 'noEventFoundMany')), `sent ${JSON.stringify(sent)}`);
  });

  await check('album: a user with AI events off gets the switch-on prompt once, nothing is read', async () => {
    reset();
    await deliverAll([photoUpdate(OFF, 'f1', { gid: 'GF' }), photoUpdate(OFF, 'f2', { gid: 'GF' })]);
    assert(sent.length === 1 && geminiCalls.length === 0 && gateChecks.length === 0, `${sent.length} messages, ${geminiCalls.length} calls`);
  });

  await check('album: a failing Redis is logged and sent to Sentry, the part is not read as a single photo', async () => {
    reset();
    redisFail = () => true;
    await deliver(photoUpdate(MAYA, 'b1', { gid: 'GB' }));
    assert(captured.some(c => c.includes('redis down')), `captured ${captured}`);
    assert(geminiCalls.length === 0 && downloads.length === 0, 'handled as a single photo');
  });

  await check('album: each webhook answers at once, before the quiet wait ends and before the read starts', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'), ev('B', '2026-11-02'), ev('C', '2026-11-03'))];
    const answered: Array<{ ms: number; geminiCalls: number; status: number }> = [];
    for (const uid of ['w1x', 'w2x', 'w3x']) {
      const started = Date.now();
      const status = await deliver(photoUpdate(MAYA, uid, { gid: 'GWH' }));
      answered.push({ ms: Date.now() - started, geminiCalls: geminiCalls.length, status });
    }
    assert(answered.every(a => a.status === 200), `statuses ${JSON.stringify(answered)}`);
    assert(answered.every(a => a.geminiCalls === 0), `the read had started: ${JSON.stringify(answered)}`);
    assert(answered.every(a => a.ms < albumConfig.quietMs), `a webhook waited for the quiet period: ${JSON.stringify(answered)}`);
    await settle();
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 3, `${geminiCalls.length} calls, ${geminiCalls[0]?.parts.length} parts`);
    assert(bulkCards.length === 1 && cards.length === 0, 'not one card for the whole album');
    assert(activity.filter(a => a === 'image_event_started').length === 1, `usage ${activity}`);
  });

  await check('album: a caption on the 3rd part, delivered one at a time, still applies to every photo', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    await deliverAll([
      photoUpdate(MAYA, 'cp1', { gid: 'GCP', messageId: 1301 }),
      photoUpdate(MAYA, 'cp2', { gid: 'GCP', messageId: 1302 }),
      photoUpdate(MAYA, 'cp3', { gid: 'GCP', messageId: 1303, caption: 'camp dates' }),
    ]);
    assert(geminiCalls.length === 1 && geminiCalls[0].text.includes('camp dates'), 'caption missing');
  });

  await check('album: a failure while collecting gets one error reply, frees the lock and clears the parts', async () => {
    reset();
    redisFail = op => op === 'lrange';
    const u = [photoUpdate(MAYA, 'mf1', { gid: 'GMF' }), photoUpdate(MAYA, 'mf2', { gid: 'GMF' })];
    for (const x of u) await deliver(x);
    await settle();
    redisFail = null;
    const { getBotMessages } = await import('../src/lib/bot-messages');
    assert(geminiCalls.length === 0, 'Gemini was called');
    assert(sent.length === 1 && sent[0].text === (await getBotMessages('en')).voice.geminiError, `sent ${JSON.stringify(sent)}`);
    assert(captured.some(c => c.includes('redis down')), `captured ${captured}`);
    assert(![...redisData.keys()].some(k => k.includes(':lock')), 'the lock was left behind');
    assert(((redisData.get('album:2001:GMF:parts') as unknown[] | undefined) ?? []).length === 0, 'parts left behind');
    assert(liveIntervals.size === 0, 'typing interval still running');
  });

  await check('album: a Redis failure AFTER the read was answered sends no error reply and keeps the parts that landed meanwhile; the lock is freed', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    redisFail = op => op === 'llen' && geminiCalls.length > 0;
    for (const x of [photoUpdate(MAYA, 'af1', { gid: 'GAF' }), photoUpdate(MAYA, 'af2', { gid: 'GAF' })]) await deliver(x);
    await settle();
    redisFail = null;
    const { getBotMessages } = await import('../src/lib/bot-messages');
    assert(geminiCalls.length === 1, `Gemini calls ${geminiCalls.length}`);
    const errorText = (await getBotMessages('en')).voice.geminiError;
    assert(!sent.some(m => m.text === errorText), `an error reply followed the answer: ${JSON.stringify(sent)}`);
    assert(captured.some(c => c.includes('redis down')), `captured ${captured}`);
    assert(![...redisData.keys()].some(k => k.includes(':lock')), 'the lock was left behind');
  });

  await check('album: only unsupported files (3 .docx) gets ONE "send a photo or PDF" reply', async () => {
    reset();
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await deliverAll([1, 2, 3].map(i => documentUpdate(MAYA, `dx${i}`, docx, 3000, { gid: 'GDX', messageId: 1400 + i })));
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'unsupportedDocument')), `sent ${JSON.stringify(sent)}`);
    assert(geminiCalls.length === 0 && downloads.length === 0 && gateChecks.length === 0, 'it did work');
  });

  await check('album: unsupported files next to photos are read as before (photos read, a note)', async () => {
    reset();
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    await deliverAll([
      photoUpdate(MAYA, 'ux1', { gid: 'GUX', messageId: 1451 }),
      documentUpdate(MAYA, 'ux2', 'application/zip', 3000, { gid: 'GUX', messageId: 1452 }),
    ]);
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 1, 'not read');
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'partsUnreadable')), `sent ${JSON.stringify(sent)}`);
  });

  await check('a GIF (Telegram sets message.document on animations) is ignored silently, as before', async () => {
    reset();
    await deliver(documentUpdate(MAYA, 'gif', 'video/mp4', 90000, { animation: true }));
    await deliver(documentUpdate(MAYA, 'gif2', 'image/gif', 90000, { animation: true }));
    assert(sent.length === 0 && downloads.length === 0 && geminiCalls.length === 0 && gateChecks.length === 0, `sent ${JSON.stringify(sent)}`);
  });

  await check('album: parts over the total size cap are skipped (by declared size) with a note, the rest are read', async () => {
    reset();
    const MB = 1024 * 1024;
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    const ids = ['cap1', 'cap2', 'cap3', 'cap4'];
    for (const id of ids) files.set(`f-${id}`, Buffer.from(`jpeg-${id}`));
    await deliverAll(ids.map((id, i) => documentUpdate(MAYA, id, 'image/jpeg', 15 * MB, { gid: 'GCAP', messageId: 1500 + i })));
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 2, `${geminiCalls[0]?.parts.length} parts sent`);
    assert(downloads.length === 2, `${downloads.length} downloads: ${downloads}`);
    assert(sent.length === 1 && sent[0].text.includes(await msg('en', 'partsUnreadable')), `notes ${JSON.stringify(sent)}`);
  });

  await check('album: parts over the total size cap are skipped (by real size, no declared size) too', async () => {
    reset();
    const MB = 1024 * 1024;
    geminiAnswers = [answerOf(ev('A', '2026-11-01'))];
    const ids = ['rcap1', 'rcap2', 'rcap3'];
    for (const id of ids) files.set(`f-${id}`, Buffer.alloc(15 * MB, 1));
    await deliverAll(ids.map((id, i) => documentUpdate(MAYA, id, 'image/jpeg', undefined, { gid: 'GRCAP', messageId: 1600 + i })));
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 2, `${geminiCalls[0]?.parts.length} parts sent`);
    assert(sent.length === 1 && sent[0].text.includes(await msg('en', 'partsUnreadable')), `notes ${JSON.stringify(sent)}`);
  });

  // ---- Single photo unchanged ----

  await check('single photo: one request, one card, same label as before', async () => {
    reset();
    geminiAnswers = [answerOf(ev('Party', '2026-11-14'))];
    await deliver(photoUpdate(MAYA, 'sp'));
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 1 && cards.length === 1, 'not one request and one card');
    assert(cards[0].label === (await msg('en', 'fromImage')) && cards[0].modality === 'image', `label ${cards[0].label}`);
    assert(!redisLog.some(l => l.includes('album:')), 'a single photo touched the album keys');
  });

  // ---- PDFs ----

  await check('pdf: happy path, one file, one request, one card', async () => {
    reset();
    files.set('f-pdf1', await pdfOf(3));
    geminiAnswers = [answerOf(ev('Parents evening', '2026-11-10'))];
    await deliver(documentUpdate(MAYA, 'pdf1', 'application/pdf', 5000));
    assert(geminiCalls.length === 1 && geminiCalls[0].parts.length === 1, 'not one request');
    assert(geminiCalls[0].parts[0].mimeType === 'application/pdf', geminiCalls[0].parts[0].mimeType);
    assert((await pagesOf(geminiCalls[0].parts[0].data)) === 3, 'pages changed');
    assert(cards.length === 1 && cards[0].label === (await msg('en', 'fromPdf')), `label ${cards[0]?.label}`);
    assert(sent.length === 0, `extra messages ${JSON.stringify(sent)}`);
    assert(gateChecks.length === 1 && activity.filter(a => a === 'image_event_started').length === 1, 'usage');
    assert(liveIntervals.size === 0, 'typing interval still running');
  });

  await check('pdf: a PDF with a caption uses it as the label and context', async () => {
    reset();
    files.set('f-pdf2', await pdfOf(1));
    geminiAnswers = [answerOf(ev('Trip', '2026-11-10'))];
    await deliver(documentUpdate(MAYA, 'pdf2', 'application/pdf', 5000, { caption: 'school trip' }));
    assert(geminiCalls[0].text.includes('school trip') && cards[0].label === 'school trip', 'caption lost');
  });

  await check('pdf: over 20 MB is answered clearly, nothing is downloaded or read', async () => {
    reset();
    await deliver(documentUpdate(MAYA, 'big', 'application/pdf', 21 * 1024 * 1024));
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'fileTooLarge')), `sent ${JSON.stringify(sent)}`);
    assert(downloads.length === 0 && geminiCalls.length === 0, 'it downloaded or read');
  });

  await check('pdf: over 20 pages is trimmed to the first 20 and the user is told', async () => {
    reset();
    files.set('f-long', await pdfOf(27));
    geminiAnswers = [answerOf(ev('Schedule', '2026-11-10'))];
    await deliver(documentUpdate(MAYA, 'long', 'application/pdf', 90000));
    assert((await pagesOf(geminiCalls[0].parts[0].data)) === 20, 'not trimmed to 20 pages');
    const note = await msg('en', 'pdfTrimmed', { kept: '20', total: '27' });
    assert(sent.length === 1 && sent[0].text === note && /20/.test(note) && /27/.test(note), `sent ${JSON.stringify(sent)}`);
    assert(cards.length === 1, 'no card');
  });

  await check('pdf: exactly 20 pages is sent whole, with no note', async () => {
    reset();
    files.set('f-twenty', await pdfOf(20));
    geminiAnswers = [answerOf(ev('Schedule', '2026-11-10'))];
    await deliver(documentUpdate(MAYA, 'twenty', 'application/pdf', 60000));
    assert((await pagesOf(geminiCalls[0].parts[0].data)) === 20 && sent.length === 0, 'trimmed or noted');
  });

  await check('pdf: a broken PDF gets a clear "can\'t open this file"', async () => {
    reset();
    files.set('f-broken', Buffer.from('this is not a pdf at all'));
    await deliver(documentUpdate(MAYA, 'broken', 'application/pdf', 100));
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'pdfUnreadable')), `sent ${JSON.stringify(sent)}`);
    assert(geminiCalls.length === 0, 'Gemini was called');
    assert(captured.length >= 1, 'not sent to Sentry');
  });

  /** A PDF flagged encrypted (an /Encrypt entry in the trailer); the content is not really encrypted. */
  const encryptedPdf = async (pages: number) => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([100, 100]);
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: 'x', U: 'x', P: -4 }));
    return Buffer.from(await doc.save());
  };

  await check('pdf: an encrypted PDF goes to Gemini untrimmed (original bytes, even over 20 pages)', async () => {
    reset();
    const bytes = await encryptedPdf(27);
    files.set('f-enc', bytes);
    geminiAnswers = [answerOf(ev('Concert', '2026-11-10'))];
    await deliver(documentUpdate(MAYA, 'enc', 'application/pdf', bytes.length));
    assert(geminiCalls.length === 1 && Buffer.from(geminiCalls[0].parts[0].data, 'base64').equals(bytes), 'not the original bytes');
    assert(sent.length === 0, `sent ${JSON.stringify(sent)}`);
  });

  await check('pdf: Gemini accepting an encrypted PDF gives the events', async () => {
    reset();
    const bytes = await encryptedPdf(2);
    files.set('f-enc2', bytes);
    geminiAnswers = [answerOf(ev('Concert', '2026-11-10'))];
    await deliver(documentUpdate(MAYA, 'enc2', 'application/pdf', bytes.length));
    assert(cards.length === 1 && cards[0].event.title === 'Concert', `cards ${JSON.stringify(cardTitles())}`);
  });

  const rejections: Array<[string, () => Error]> = [
    ['a 400', () => Object.assign(new Error('bad request'), { status: 400 })],
    ['INVALID_ARGUMENT', () => new Error('INVALID_ARGUMENT: the document has no pages')],
  ];
  for (const [name, make] of rejections) {
    await check(`pdf: Gemini rejecting an encrypted PDF (${name}) gives "can't open this file", logged to Sentry, no retry`, async () => {
      reset();
      const bytes = await encryptedPdf(1);
      files.set('f-encr', bytes);
      geminiAnswers = [make(), make()];
      await deliver(documentUpdate(MAYA, 'encr', 'application/pdf', bytes.length));
      assert(sent.length === 1 && sent[0].text === (await msg('en', 'pdfUnreadable')), `sent ${JSON.stringify(sent)}`);
      assert(geminiCalls.length === 1, `${geminiCalls.length} Gemini calls (a refusal is not retried)`);
      assert(captured.length >= 1, 'not sent to Sentry');
    });
  }

  await check('pdf: an empty Gemini answer for an encrypted PDF gives "can\'t open this file"', async () => {
    reset();
    const bytes = await encryptedPdf(1);
    files.set('f-ence', bytes);
    geminiAnswers = [new Error('Gemini returned empty response'), new Error('Gemini returned empty response')];
    await deliver(documentUpdate(MAYA, 'ence', 'application/pdf', bytes.length));
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'pdfUnreadable')), `sent ${JSON.stringify(sent)}`);
  });

  await check('pdf: a rejected UNencrypted file keeps the generic error reply', async () => {
    reset();
    files.set('f-plainrej', await pdfOf(1));
    geminiAnswers = [Object.assign(new Error('bad request'), { status: 400 })];
    await deliver(documentUpdate(MAYA, 'plainrej', 'application/pdf', 100));
    const { getBotMessages } = await import('../src/lib/bot-messages');
    assert(sent.length === 1 && sent[0].text === (await getBotMessages('en')).voice.geminiError, `sent ${JSON.stringify(sent)}`);
  });

  await check('pdf: a Russian user gets Russian copy', async () => {
    reset();
    files.set('f-ru', Buffer.from('nope'));
    await deliver(documentUpdate(DANIL, 'ru', 'application/pdf', 100));
    assert(sent.length === 1 && sent[0].text === (await msg('ru', 'pdfUnreadable')) && sent[0].text !== (await msg('en', 'pdfUnreadable')), `sent ${JSON.stringify(sent)}`);
  });

  await check('pdf: a scanned PDF (page images, no text) is sent as is', async () => {
    reset();
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    // 1x1 white PNG as the page image, the way a scanner's output has no text layer
    const png = await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+XJ/P2QAAAABJRU5ErkJggg==', 'base64'));
    page.drawImage(png, { x: 0, y: 0, width: 200, height: 200 });
    files.set('f-scan', Buffer.from(await doc.save()));
    geminiAnswers = [answerOf(ev('Notice', '2026-11-10'))];
    await deliver(documentUpdate(MAYA, 'scan', 'application/pdf', 4000));
    assert(geminiCalls.length === 1 && cards.length === 1, 'not read');
  });

  // ---- Documents that are not PDFs ----

  await check('image as a document: read like a photo (mime kept), same label', async () => {
    reset();
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
      geminiAnswers = [answerOf(ev('Party', '2026-11-14'))];
      files.set('f-img', Buffer.from('imgbytes'));
      await deliver(documentUpdate(MAYA, 'img', mime, 3000));
    }
    assert(geminiCalls.length === 5 && cards.length === 5, `${geminiCalls.length} calls`);
    assert(geminiCalls.map(c => c.parts[0].mimeType).join() === 'image/jpeg,image/png,image/webp,image/heic,image/heif', 'mime types');
    assert(cards.every(c => c.label === 'an invitation image'), `labels ${cards.map(c => c.label)}`);
  });

  await check('another document type gets a polite "send a photo or PDF"', async () => {
    reset();
    await deliver(documentUpdate(MAYA, 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 3000));
    assert(sent.length === 1 && sent[0].text === (await msg('en', 'unsupportedDocument')), `sent ${JSON.stringify(sent)}`);
    assert(downloads.length === 0 && geminiCalls.length === 0 && gateChecks.length === 0, 'it did work');
  });

  await check('a document from a stranger is answered as for a photo (register first), not ignored', async () => {
    reset();
    await deliver(documentUpdate(STRANGER, 'st', 'application/pdf', 100));
    assert(sent.length === 1 && geminiCalls.length === 0, `${sent.length} messages`);
  });

  await check('a document from a user with AI events off gets the switch-on prompt', async () => {
    reset();
    files.set('f-off', await pdfOf(1));
    await deliver(documentUpdate(OFF, 'off', 'application/pdf', 100));
    assert(sent.length === 1 && geminiCalls.length === 0, `${sent.length} messages`);
  });

  // ---- Gemini retry (the existing image path) ----

  await check('gemini: a failed request is retried with backoff, then the album is read', async () => {
    reset();
    geminiAnswers = [new Error('503 overloaded'), answerOf(ev('A', '2026-11-01'))];
    await deliverAll([photoUpdate(MAYA, 'g1', { gid: 'GG' }), photoUpdate(MAYA, 'g2', { gid: 'GG' })]);
    assert(geminiCalls.length === 2 && cards.length === 1, `${geminiCalls.length} calls, ${cards.length} cards`);
  });

  await check('gemini: failing every time gives one error reply and Sentry gets it', async () => {
    reset();
    geminiAnswers = [new Error('503 a'), new Error('503 b')];
    await deliverAll([photoUpdate(MAYA, 'g3', { gid: 'GG2' }), photoUpdate(MAYA, 'g4', { gid: 'GG2' })]);
    assert(sent.length === 1 && captured.some(c => c.includes('503')), `sent ${sent.length}, captured ${captured}`);
    assert(liveIntervals.size === 0, 'typing interval still running');
  });

  await check('no network was reached', () => {
    assert(networkAttempts.length === 0, `fetched ${networkAttempts.join(', ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` - ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
