/**
 * Telegram Guest Mode probe: a TEMPORARY diagnostic.
 *
 * Bot API 10.0 sends `guest_message` when someone mentions the bot in a chat it is not a member of. Telegram
 * says the update carries the summoning message and, when present, the one it replied to, but not under which
 * field. This probe logs which fields arrive (key names and text lengths only, never any value that came from a
 * person) and answers once with a fixed short text, so we learn that the reply path works and how fast.
 * It is removed (or replaced by the real feature) once the owner has read the log line.
 */

import { getBot } from './bot';
import { getBotMessages } from '../../lib/bot-messages';
import { captureWarning } from '../../lib/error-capture';
import { normalizeLocale, type Locale } from '../../utils/locale';
import type { UserConfig } from '../../types';

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A key name from Telegram's schema; anything else (it would be data) is not echoed. */
const SAFE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const keysOf = (value: Obj): string[] =>
  Object.keys(value).map(key => (SAFE_KEY.test(key) ? key : '?')).sort();

/** Enough to reach any wrapper Telegram nests a replied-to message in, not enough to chase a cycle. */
const MAX_DEPTH = 5;

export interface NestedMessageSummary {
  /** Where it sits in the guest message: `reply_to_message`, `external_reply`, `quote`, ... */
  path: string;
  keys: string[];
  /** Length of `text` / `caption` when present: never the text. */
  textLength?: number;
  captionLength?: number;
}

export interface GuestUpdateSummary {
  updateKeys: string[];
  messageKeys: string[];
  nested: NestedMessageSummary[];
  chatType: string | null;
  fromId: number | null;
  hasAccount: boolean;
  /** Milliseconds from the message's `date` (whole seconds) to now. */
  ageMs: number | null;
}

/** A value that looks like a Message (or a quote of one): it has a message_id, a text or a caption. */
function looksLikeMessage(value: Obj): boolean {
  return 'message_id' in value || 'text' in value || 'caption' in value;
}

function collectNested(value: unknown, path: string, depth: number, out: NestedMessageSummary[]): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    value.slice(0, 10).forEach((item, i) => collectNested(item, `${path}[${i}]`, depth + 1, out));
    return;
  }
  if (!isObj(value)) return;
  if (path && looksLikeMessage(value)) {
    const entry: NestedMessageSummary = { path, keys: keysOf(value) };
    if (typeof value.text === 'string') entry.textLength = value.text.length;
    if (typeof value.caption === 'string') entry.captionLength = value.caption.length;
    out.push(entry);
  }
  for (const key of Object.keys(value).sort()) {
    if (!SAFE_KEY.test(key)) continue;
    collectNested(value[key], path ? `${path}.${key}` : key, depth + 1, out);
  }
}

/**
 * What arrived in a `guest_message` update, safe to log: key names, text lengths, the chat's type, the sender's
 * Telegram id, whether they have an account and how old the message is. No string value other than the chat
 * type is ever copied (no text, caption, name, username, title, phone or entity).
 */
export function describeGuestUpdate(update: unknown, hasAccount: boolean, now: number = Date.now()): GuestUpdateSummary {
  const root = isObj(update) ? update : {};
  const message = isObj(root.guest_message) ? root.guest_message : {};
  const nested: NestedMessageSummary[] = [];
  for (const key of Object.keys(message).sort()) {
    if (!SAFE_KEY.test(key)) continue;
    collectNested(message[key], key, 1, nested);
  }
  const chatType = isObj(message.chat) && typeof message.chat.type === 'string' && SAFE_KEY.test(message.chat.type)
    ? message.chat.type
    : null;
  const fromId = isObj(message.from) && typeof message.from.id === 'number' ? message.from.id : null;
  const ageMs = typeof message.date === 'number' ? now - message.date * 1000 : null;
  return {
    updateKeys: keysOf(root),
    messageKeys: keysOf(message),
    nested,
    chatType,
    fromId,
    hasAccount,
    ageMs,
  };
}

/** The language of the answer: the FamCal language of an account, else Telegram's `language_code`, else English. */
function answerLocale(update: Obj, user: UserConfig | null): Locale {
  if (user) return normalizeLocale(user.language);
  const message = isObj(update.guest_message) ? update.guest_message : {};
  const code = isObj(message.from) && typeof message.from.language_code === 'string'
    ? message.from.language_code.toLowerCase().split('-')[0]
    : '';
  return normalizeLocale(code === 'iw' ? 'he' : code);
}

/** Telegram's own words for a failure: the HTTP status and its description, nothing else. */
function failureText(error: unknown): string {
  const response = isObj(error) && isObj(error.response) ? error.response : null;
  if (!response) return `no answer (${isObj(error) && typeof error.code === 'string' ? error.code : 'error'})`;
  const body = isObj(response.body) ? response.body : null;
  const description = body && typeof body.description === 'string' ? body.description : 'no description';
  return `HTTP ${typeof response.statusCode === 'number' ? response.statusCode : '?'} ${description}`;
}

/**
 * Log one `[guest probe]` line for a guest_message update and answer it once. Never throws and never retries:
 * a failed answer is a finding, logged with Telegram's status and description.
 */
export async function handleGuestProbe(update: Obj, user: UserConfig | null): Promise<void> {
  try {
    console.log(`[guest probe] ${JSON.stringify(describeGuestUpdate(update, user !== null))}`);
    const message = isObj(update.guest_message) ? update.guest_message : {};
    const queryId = message.guest_query_id;
    if (typeof queryId !== 'string' || queryId === '') {
      console.warn('[guest probe] no guest_query_id on the message; nothing to answer');
      return;
    }
    const t = (await getBotMessages(answerLocale(update, user))).guestProbe;
    const startedAt = Date.now();
    try {
      // The Bot API takes `result` JSON-serialized; node-telegram-bot-api has no method for answerGuestQuery yet
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (getBot() as any)._request('answerGuestQuery', {
        form: {
          guest_query_id: queryId,
          result: JSON.stringify({
            type: 'article',
            id: 'probe',
            title: t.title,
            input_message_content: { message_text: t.text },
          }),
        },
      });
      console.log(`[guest probe] answered in ${Date.now() - startedAt} ms`);
    } catch (error) {
      captureWarning(`answering failed after ${Date.now() - startedAt} ms: ${failureText(error)}`, 'guest probe');
    }
  } catch (error) {
    console.error('[guest probe] failed before answering:', error instanceof Error ? error.message : String(error));
  }
}
