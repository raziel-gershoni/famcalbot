// Skip-confirm flow for HIGH-confidence CREATE intents. When the bot is
// genuinely confident about what the user dictated, we skip the confirmation
// card and create the event immediately, replacing it with a "Done — tap to
// undo" message that's live for 30 seconds.
//
// SAFETY: gated behind AdminSettings.voiceAutoCreateHighConf (admin panel).
// Defaults to false — the feature does not auto-activate on first deploy and
// admin can flip it on/off without redeploys via the admin panel.
//
// Multi-event batches (PR 11) intentionally never auto-create even at HIGH
// confidence: a single mistaken parse in a 5-event batch is much louder than
// a single one-off, and the bulk confirmation card already groups them.

import crypto from 'crypto';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { getProviderForUser } from '../calendar-provider';
import { buildRecurrenceRule } from '../calendar';
import type { ParsedEvent } from '../event-parser';
import type { UserConfig } from '../../types';
import type { IMessagingService } from '../messaging/types';
import { MessageFormat } from '../messaging/types';
import { pushRecentEvent } from './recent-events-store';
import { resolveUserTimezone } from '../../lib/timezone';
import { formatEventDateTime } from './confirmations';

const UNDO_TTL_SECONDS = 30;

/**
 * Read-through cached AdminSettings flag (voiceAutoCreateHighConf). Defaults
 * to false on Redis or DB errors so the user-facing flow stays conservative.
 */
export async function isAutoCreateEnabled(): Promise<boolean> {
  const { getVoiceAutoCreateHighConf } = await import('../reminder-cache');
  return getVoiceAutoCreateHighConf();
}

interface UndoPayload {
  userId: number;
  provider: 'google' | 'native';
  calendarId: string;
  eventId: string;
  recurringEventId?: string;
}

/**
 * Generate an opaque undo token, persist the cancellation context for
 * UNDO_TTL_SECONDS, and return both the token and a plaintext callback id
 * for inline-button wiring.
 */
async function storeUndoToken(payload: UndoPayload): Promise<string> {
  const token = crypto.randomBytes(8).toString('hex');
  await redis.set(REDIS_KEYS.undoToken(token), JSON.stringify(payload), { ex: UNDO_TTL_SECONDS });
  return token;
}

/** Read an undo token's payload without consuming it. */
async function readUndoToken(token: string): Promise<UndoPayload | null> {
  const key = REDIS_KEYS.undoToken(token);
  const raw = await redis.get<string | UndoPayload>(key);
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as UndoPayload;
    } catch {
      return null;
    }
  }
  return raw as UndoPayload;
}

/** Atomically consume the token (deletes the key). */
async function deleteUndoToken(token: string): Promise<void> {
  await redis.del(REDIS_KEYS.undoToken(token));
}

/**
 * Auto-create the event without a confirmation card. Returns the messaging
 * surface that the caller should send (text + inline keyboard) so the existing
 * platform adapters wire it up consistently.
 *
 * On failure, returns null and the caller should fall back to the standard
 * confirmation flow (a misparse-prone result feels less bad inside a card).
 */
export async function autoCreateEvent(
  user: UserConfig,
  event: ParsedEvent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  service: IMessagingService,
  chatId: number | string
): Promise<boolean> {
  if (!(await isAutoCreateEnabled())) return false;

  const provider = getProviderForUser(user);
  const calendarId = event.calendarId || 'primary';
  const result = await provider.createEvent(user, calendarId, {
    title: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    location: event.location,
    description: event.description,
    allDay: event.allDay,
    recurrence: buildRecurrenceRule(event.recurrence),
  });
  if (!result.success || !result.eventId) return false;

  const token = await storeUndoToken({
    userId: user.id,
    provider: calendarId.startsWith('native:') ? 'native' : 'google',
    calendarId,
    eventId: result.eventId,
  });

  // Feed recent-events for follow-up references.
  await pushRecentEvent(user.id, {
    provider: calendarId.startsWith('native:') ? 'native' : 'google',
    calendarId,
    eventId: result.eventId,
    title: event.title,
    startsAt: event.startTime.toISOString(),
    endsAt: event.endTime.toISOString(),
    action: 'create',
  });

  const timezone = await resolveUserTimezone(user);
  const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice?.allDay || 'All day', timezone);
  const locationStr = event.location ? `\n📍 ${event.location}` : '';
  const summary =
    `${t.voice?.created || '✅ Event created!'}` +
    `\n\n📅 <b>${event.title}</b>\n${dateTimeStr}${locationStr}`;
  const undoLabel = t.voice?.undo || '↩️ Undo (30s)';

  try {
    await service.sendMessage(chatId, summary, {
      format: MessageFormat.HTML,
      replyMarkup: {
        inline_keyboard: [[{ text: undoLabel, callback_data: `voice_undo:${token}` }]],
      },
    });
  } catch (err) {
    // The event already exists but the user has no undo button — clean up so
    // we don't leave an invisible auto-created event behind. If the rollback
    // delete also fails, log and surface failure: returning false makes the
    // caller fall back to standard confirmation flow.
    console.error('[AutoCreate] sendMessage failed after createEvent — rolling back:', err);
    try {
      await provider.deleteEvent(user, calendarId, result.eventId, { scope: 'single' });
    } catch (delErr) {
      console.error('[AutoCreate] rollback deleteEvent also failed:', delErr);
    }
    return false;
  }

  return true;
}

/**
 * Process an undo button tap. Deletes the just-created event and removes it
 * from the recent-events list. Idempotent: missing/expired token is treated
 * as a no-op (returns false) so duplicate taps don't cascade.
 */
export async function handleUndoCallback(
  user: UserConfig,
  token: string
): Promise<{ ok: boolean; reason?: 'expired' | 'failed' }> {
  // Read first so a wrong-user click doesn't consume the token and lock out
  // the legitimate owner. Only delete after we confirm ownership AND the
  // delete succeeds.
  const payload = await readUndoToken(token);
  if (!payload) return { ok: false, reason: 'expired' };

  // Permission check: only the original creator's user may undo.
  if (payload.userId !== user.id) return { ok: false, reason: 'failed' };

  const provider = getProviderForUser(user);
  const result = await provider.deleteEvent(user, payload.calendarId, payload.eventId, {
    scope: 'single',
    recurringEventId: payload.recurringEventId,
  });
  if (!result.success) return { ok: false, reason: 'failed' };

  await deleteUndoToken(token);
  const { removeRecentEvent } = await import('./recent-events-store');
  await removeRecentEvent(user.id, payload.eventId);
  return { ok: true };
}
