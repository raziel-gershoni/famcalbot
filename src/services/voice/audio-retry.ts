// Audio retention error recovery (deferred polish from PR 10).
//
// When a voice parse fails — empty transcription, low confidence, missing
// required fields — store the original OGG buffer in Redis (5-min TTL) plus
// a "retry mode" flag. The user's next message is then treated as an
// addendum: a multi-part Gemini call combines the original audio with the
// new utterance ("the meeting is at 3 not 4") and re-parses.
//
// Best-effort throughout — Redis failures fall back to the existing
// "send a new voice message" path.

import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';

const AUDIO_TTL_SECONDS = 300; // 5 minutes
const MAX_AUDIO_BASE64_BYTES = 1024 * 1024; // 1 MB cap on what we'll stash

export async function stashFailedAudio(chatId: number, audioBuffer: Buffer): Promise<void> {
  try {
    const b64 = audioBuffer.toString('base64');
    if (b64.length > MAX_AUDIO_BASE64_BYTES) return;
    await redis.set(REDIS_KEYS.retryAudio(chatId), b64, { ex: AUDIO_TTL_SECONDS });
    await redis.set(REDIS_KEYS.retryMode(chatId), '1', { ex: AUDIO_TTL_SECONDS });
  } catch (err) {
    console.warn('[AudioRetry] stash failed (non-fatal):', err);
  }
}

export async function isInRetryMode(chatId: number): Promise<boolean> {
  try {
    const flag = await redis.get<string>(REDIS_KEYS.retryMode(chatId));
    return flag !== null && flag !== undefined;
  } catch {
    return false;
  }
}

export async function readRetryAudio(chatId: number): Promise<Buffer | null> {
  try {
    const b64 = await redis.get<string>(REDIS_KEYS.retryAudio(chatId));
    if (!b64) return null;
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

export async function clearRetryMode(chatId: number): Promise<void> {
  try {
    await redis.del(REDIS_KEYS.retryAudio(chatId));
    await redis.del(REDIS_KEYS.retryMode(chatId));
  } catch (err) {
    console.warn('[AudioRetry] clear failed (non-fatal):', err);
  }
}
