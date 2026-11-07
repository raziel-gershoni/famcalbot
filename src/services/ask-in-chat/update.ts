/**
 * Reading a Telegram Guest Mode update (spec docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §4).
 *
 * Bot API 10.0 sends `guest_message` when someone mentions the bot in a chat it is not a member of, or replies to the
 * bot's own answer there. This file is the only place that reads the update's shape: the probe (spec §12) showed the
 * replied-to message in `reply_to_message` and the caller in `from`. Whether a bare reply to FamCal's own answer
 * carries `guest_bot_caller_user` on it is not known yet; without it, a bare reply is never answered (ruling 9).
 *
 * Pure: no I/O, no clock. Nothing here logs: every string in the update was written by a person.
 */

/** A mention cut to this many characters before it reaches the model. */
export const MENTION_MAX_CHARS = 500;
/** The replied-to message cut to this many characters before it reaches the model. */
export const REPLIED_MAX_CHARS = 2000;

export interface GuestAsk {
  /** `guest_query_id`: what answerGuestQuery answers. Never logged. */
  guestQueryId: string;
  /** The guest message's sender (`from`): the person whose calendar is read. */
  caller: { telegramId: number; languageCode?: string };
  /** The guest message's text or caption with every @<bot> removed, trimmed, cut to MENTION_MAX_CHARS. */
  mention: string;
  /** The text mentions @<bot> (a `mention` entity, or the text itself, case-insensitive). */
  mentioned: boolean;
  /** The message it replies to, when that has text or a caption. */
  replied: { text: string; isOurAnswer: boolean; ourCallerId?: number } | null;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Cut to `max` characters by code point, so an emoji or a Hebrew letter with a mark is never split in half. */
function cut(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join('') : text;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text and its entities: `text` + `entities`, else `caption` + `caption_entities`. */
function textOf(message: Obj): { text: string; entities: unknown[] } | null {
  if (typeof message.text === 'string') return { text: message.text, entities: Array.isArray(message.entities) ? message.entities : [] };
  if (typeof message.caption === 'string') return { text: message.caption, entities: Array.isArray(message.caption_entities) ? message.caption_entities : [] };
  return null;
}

/** The text with every mention of @<bot> taken out (by its entities, then by the text), and whether there was one. */
function withoutMention(text: string, entities: unknown[], botUsername: string): { rest: string; mentioned: boolean } {
  const handle = `@${botUsername}`.toLowerCase();
  let mentioned = false;
  let rest = text;
  // Entities count UTF-16 units, as JS strings do. Cut from the end, so earlier offsets stay right.
  const ours = entities
    .filter(isObj)
    .filter(e => e.type === 'mention' && typeof e.offset === 'number' && typeof e.length === 'number')
    .map(e => ({ offset: e.offset as number, length: e.length as number }))
    .filter(e => text.slice(e.offset, e.offset + e.length).toLowerCase() === handle)
    .sort((a, b) => b.offset - a.offset);
  for (const e of ours) {
    rest = rest.slice(0, e.offset) + ' ' + rest.slice(e.offset + e.length);
    mentioned = true;
  }
  const byText = new RegExp(`${escapeRegExp(handle)}(?![A-Za-z0-9_])`, 'gi');
  if (byText.test(rest)) {
    mentioned = true;
    rest = rest.replace(byText, ' ');
  }
  return { rest: rest.replace(/\s+/g, ' ').trim(), mentioned };
}

/**
 * The parts of a `guest_message` the feature reads, or null when it has no `guest_query_id` or no sender (nothing to
 * answer, or nobody whose calendar it could be). `botId` is the number before the colon in the bot's token;
 * `botUsername` is the bot's username without the @.
 */
export function readGuestUpdate(message: unknown, botId: number, botUsername: string): GuestAsk | null {
  if (!isObj(message)) return null;
  const guestQueryId = message.guest_query_id;
  if (typeof guestQueryId !== 'string' || guestQueryId === '') return null;
  const from = message.from;
  if (!isObj(from) || typeof from.id !== 'number') return null;

  const own = textOf(message);
  const { rest, mentioned } = own ? withoutMention(own.text, own.entities, botUsername) : { rest: '', mentioned: false };

  let replied: GuestAsk['replied'] = null;
  const reply = message.reply_to_message;
  if (isObj(reply)) {
    const theirs = textOf(reply);
    const text = theirs ? theirs.text.trim() : '';
    if (text !== '') {
      const fromBot = isObj(reply.from) && reply.from.id === botId;
      const viaBot = isObj(reply.via_bot) && reply.via_bot.id === botId;
      const caller = isObj(reply.guest_bot_caller_user) && typeof reply.guest_bot_caller_user.id === 'number' ? reply.guest_bot_caller_user.id : undefined;
      replied = { text: cut(text, REPLIED_MAX_CHARS), isOurAnswer: fromBot || viaBot, ...(caller !== undefined ? { ourCallerId: caller } : {}) };
    }
  }

  return {
    guestQueryId,
    caller: { telegramId: from.id, ...(typeof from.language_code === 'string' ? { languageCode: from.language_code } : {}) },
    mention: cut(rest, MENTION_MAX_CHARS),
    mentioned,
    replied,
  };
}

/**
 * Ruling 9: a guest message is answered when it mentions the bot, or when it is a bare reply to FamCal's own answer
 * from the person who summoned that answer (a correction). A bare reply from anyone else (the sister's "thanks"), or
 * to an answer that does not say who summoned it, gets no answer.
 */
export function answersThis(ask: GuestAsk): boolean {
  if (ask.mentioned) return true;
  return ask.replied?.isOurAnswer === true && ask.replied.ourCallerId === ask.caller.telegramId;
}

/** The bot's numeric id: the part of its token before the colon, or null when the token has none. */
export function botIdFromToken(token: string | undefined): number | null {
  const id = Number((token ?? '').split(':')[0]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
