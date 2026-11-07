// Smoke test for reading a Telegram Guest Mode update (src/services/ask-in-chat/update.ts; spec
// docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §4 and §12):
//   - the mention of @<bot> is taken out of the text, by its entity and by the text (case-insensitive), and a longer
//     handle that only starts with ours is not a mention;
//   - the replied-to message's text, else its caption, is read and cut; no replied-to text falls back to the mention;
//   - FamCal's own answer is recognised by `from` and by `via_bot`, and its `guest_bot_caller_user` read;
//   - ruling 9: a mention is answered, a bare reply only from the answer's own caller;
//   - no query id or no sender gives nothing to answer; the token's prefix is the bot's id.
// Pure: no network, no database, no env.
//
//   npx tsx scripts/smoke-ask-in-chat-update.ts

import { answersThis, botIdFromToken, MENTION_MAX_CHARS, readGuestUpdate, REPLIED_MAX_CHARS } from '../src/services/ask-in-chat/update';

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
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

const BOT_ID = 123456;
const BOT = 'famcal_test_bot';
const CALLER = 4001;
const SISTER = 4002;

function guest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 77,
    guest_query_id: 'gq-1',
    date: 1_800_000_000,
    chat: { id: 9, type: 'private' },
    from: { id: CALLER, is_bot: false, first_name: 'Raz', language_code: 'he' },
    text: '@famcal_test_bot',
    entities: [{ type: 'mention', offset: 0, length: 16 }],
    reply_to_message: { message_id: 70, date: 1_799_999_000, chat: { id: 9, type: 'private' }, from: { id: SISTER, is_bot: false, first_name: 'Dana' }, text: 'are you free Friday evening?' },
    ...extra,
  };
}

check('the mention is taken out by its entity, and the rest of the text is kept, trimmed', () => {
  const ask = readGuestUpdate(guest({ text: '@famcal_test_bot she means Saturday', entities: [{ type: 'mention', offset: 0, length: 16 }] }), BOT_ID, BOT);
  assert(ask && ask.mentioned && ask.mention === 'she means Saturday', show(ask));
});

check('the mention is taken out by the text with no entity, in any case, in the middle of the text', () => {
  const ask = readGuestUpdate(guest({ text: 'what about @FamCal_Test_Bot Saturday?', entities: undefined }), BOT_ID, BOT);
  assert(ask && ask.mentioned && ask.mention === 'what about Saturday?', show(ask));
});

check('a longer handle that only starts with ours, and a mention entity of someone else, are not our mention', () => {
  const ask = readGuestUpdate(guest({ text: '@famcal_test_bot2 @dana Friday', entities: [{ type: 'mention', offset: 18, length: 5 }] }), BOT_ID, BOT);
  assert(ask && !ask.mentioned && ask.mention === '@famcal_test_bot2 @dana Friday', show(ask));
});

check('a caption with caption_entities is read like a text', () => {
  const ask = readGuestUpdate(guest({ text: undefined, entities: undefined, caption: '@famcal_test_bot Sunday', caption_entities: [{ type: 'mention', offset: 0, length: 16 }] }), BOT_ID, BOT);
  assert(ask && ask.mentioned && ask.mention === 'Sunday', show(ask));
});

check('the mention is cut to MENTION_MAX_CHARS code points', () => {
  const ask = readGuestUpdate(guest({ text: `@famcal_test_bot ${'ש'.repeat(MENTION_MAX_CHARS + 50)}` }), BOT_ID, BOT);
  assert(ask && Array.from(ask.mention).length === MENTION_MAX_CHARS, `${ask && ask.mention.length}`);
});

check('the replied-to text is read, and a caption when it has no text; both cut to REPLIED_MAX_CHARS', () => {
  const a = readGuestUpdate(guest(), BOT_ID, BOT);
  assert(a && show(a.replied) === show({ text: 'are you free Friday evening?', isOurAnswer: false }), show(a?.replied));
  const b = readGuestUpdate(guest({ reply_to_message: { message_id: 70, from: { id: SISTER }, caption: 'the flyer: Friday 20:00' } }), BOT_ID, BOT);
  assert(b && b.replied?.text === 'the flyer: Friday 20:00', show(b?.replied));
  const c = readGuestUpdate(guest({ reply_to_message: { message_id: 70, from: { id: SISTER }, text: 'x'.repeat(REPLIED_MAX_CHARS + 10) } }), BOT_ID, BOT);
  assert(c && c.replied?.text.length === REPLIED_MAX_CHARS, `${c?.replied?.text.length}`);
});

check('no replied-to message, or one with no text and no caption (a photo, a sticker), is the fallback: replied is null', () => {
  const none = readGuestUpdate(guest({ reply_to_message: undefined }), BOT_ID, BOT);
  assert(none && none.replied === null, show(none));
  const photo = readGuestUpdate(guest({ reply_to_message: { message_id: 70, from: { id: SISTER }, photo: [{ file_id: 'p' }] } }), BOT_ID, BOT);
  assert(photo && photo.replied === null, show(photo));
});

check('FamCal\'s own answer is recognised by from and by via_bot, with guest_bot_caller_user read when there', () => {
  const byFrom = readGuestUpdate(guest({ text: 'no, Saturday', entities: undefined, reply_to_message: { message_id: 71, from: { id: BOT_ID, is_bot: true }, text: 'Friday 13.11: free all day', guest_bot_caller_user: { id: CALLER } } }), BOT_ID, BOT);
  assert(byFrom && show(byFrom.replied) === show({ text: 'Friday 13.11: free all day', isOurAnswer: true, ourCallerId: CALLER }), show(byFrom?.replied));
  const byVia = readGuestUpdate(guest({ reply_to_message: { message_id: 71, from: { id: SISTER }, via_bot: { id: BOT_ID }, text: 'Friday 13.11: free all day' } }), BOT_ID, BOT);
  assert(byVia && byVia.replied?.isOurAnswer === true && byVia.replied.ourCallerId === undefined, show(byVia?.replied));
});

check('ruling 9: a mention is answered; a bare reply to our answer only from its caller; a bare reply with no caller id, or to someone else\'s message, never', () => {
  const ours = (callerId?: number) => ({ message_id: 71, from: { id: BOT_ID }, text: 'Friday 13.11: free all day', ...(callerId ? { guest_bot_caller_user: { id: callerId } } : {}) });
  const bare = (from: number, reply: Record<string, unknown>) => readGuestUpdate(guest({ from: { id: from }, text: 'no, Saturday', entities: undefined, reply_to_message: reply }), BOT_ID, BOT)!;
  assert(answersThis(readGuestUpdate(guest(), BOT_ID, BOT)!), 'a mention');
  assert(answersThis(bare(CALLER, ours(CALLER))), 'the caller\'s correction');
  assert(!answersThis(bare(SISTER, ours(CALLER))), 'the sister\'s "thanks"');
  assert(!answersThis(bare(CALLER, ours())), 'no caller id on our answer');
  assert(!answersThis(bare(CALLER, { message_id: 70, from: { id: SISTER }, text: 'hi' })), 'a bare reply to someone else');
  const sisterMentions = readGuestUpdate(guest({ from: { id: SISTER }, reply_to_message: ours(CALLER) }), BOT_ID, BOT)!;
  assert(answersThis(sisterMentions) && sisterMentions.caller.telegramId === SISTER, 'the sister mentioning the bot is a caller in her own right');
});

check('the caller is from, with its language_code; no from, a from with no id, or no guest_query_id gives null', () => {
  const ask = readGuestUpdate(guest(), BOT_ID, BOT);
  assert(ask && show(ask.caller) === show({ telegramId: CALLER, languageCode: 'he' }) && ask.guestQueryId === 'gq-1', show(ask));
  assert(readGuestUpdate(guest({ from: undefined }), BOT_ID, BOT) === null, 'no from');
  assert(readGuestUpdate(guest({ from: { first_name: 'x' } }), BOT_ID, BOT) === null, 'no id');
  assert(readGuestUpdate(guest({ guest_query_id: undefined }), BOT_ID, BOT) === null, 'no query id');
  assert(readGuestUpdate(guest({ guest_query_id: '' }), BOT_ID, BOT) === null, 'an empty query id');
  assert(readGuestUpdate(null, BOT_ID, BOT) === null && readGuestUpdate('x', BOT_ID, BOT) === null, 'not an object');
});

check('botIdFromToken: the number before the colon, or null', () => {
  assert(botIdFromToken('123456:AA-bb') === 123456, 'a token');
  assert(botIdFromToken('fake') === null && botIdFromToken(undefined) === null && botIdFromToken(':x') === null, 'not a token');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
