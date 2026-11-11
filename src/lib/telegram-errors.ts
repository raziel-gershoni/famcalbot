/**
 * What a failed Bot API call says, read from node-telegram-bot-api 2.x's errors by their `code` and fields (never
 * `instanceof`: the package ships an ESM and a CJS build, and a class from one is not the other's).
 * - refused: Telegram answered `{ ok: false }` (its status and words; a 429's wait in ms).
 * - no-answer: fetch threw, or a 5xx came back that is not Telegram's JSON (a gateway's page).
 * - unreadable: an answer under 500 that is not JSON (a proxy's page); its status is lost.
 * Anything else (our own bug, another library's error) is null.
 */
export type TelegramErrorInfo =
  | { kind: 'refused'; status: number; description: string; retryAfterMs: number | null }
  | { kind: 'no-answer'; code: string }
  | { kind: 'unreadable'; code: string };

export function telegramErrorInfo(error: unknown): TelegramErrorInfo | null {
  if (!(error instanceof Error)) return null;
  const e = error as Error & { code?: unknown; errorCode?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };
  if (e.code === 'ETELEGRAM' && typeof e.errorCode === 'number') {
    const after = e.parameters?.retry_after;
    return {
      kind: 'refused',
      status: e.errorCode,
      description: typeof e.description === 'string' ? e.description : e.message,
      retryAfterMs: typeof after === 'number' ? after * 1000 : null,
    };
  }
  if (e.code === 'EFETCH' || e.code === 'ETIMEOUT') return { kind: 'no-answer', code: e.code };
  if (e.code === 'EPARSE') return { kind: 'unreadable', code: e.code };
  return null;
}

/** True when Telegram refused the call in words that contain `words` (an edit's "message is not modified", ...). */
export function telegramRefusalSays(error: unknown, words: string): boolean {
  const info = telegramErrorInfo(error);
  return info?.kind === 'refused' && info.description.includes(words);
}
