// Bulk confirmation surface for multi-event utterances.
//
// Stores the batch in Redis under voice:pending:batch:<id> for 10 minutes;
// the user sees a numbered list with three buttons:
//   ✅ Confirm all
//   ❌ Cancel all
//
// Per-event Edit/Skip is intentionally deferred — the simpler "confirm-all
// or cancel" surface is much easier to ship safely and bulk batches are rare
// enough that mistakes can be re-dictated. The plan calls out per-event Edit
// as a future polish increment.

import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { getProviderForUser } from '../calendar-provider';
import { buildRecurrenceRule } from '../calendar';
import { pushRecentEvent } from './recent-events-store';
import { formatEventDateTime } from './confirmations';
import type { ParsedEvent, VoiceIntentResult } from '../event-parser';
import type { UserConfig } from '../../types';
import type { IMessagingService } from '../messaging/types';
import { MessageFormat } from '../messaging/types';

const BATCH_TTL_SECONDS = 10 * 60;

// Maximum number of events the bulk surface will accept. The Gemini prompt
// caps this, but defense-in-depth in case the parser sees a longer array.
const MAX_BATCH_SIZE = 10;

interface BulkPendingPayload {
  intents: VoiceIntentResult[];
  user: UserConfig;
  transcription: string;
}

export async function setPendingBatch(
  pendingId: string,
  payload: BulkPendingPayload
): Promise<void> {
  await redis.set(REDIS_KEYS.pendingBatch(pendingId), payload, { ex: BATCH_TTL_SECONDS });
}

export async function getPendingBatch(pendingId: string): Promise<BulkPendingPayload | null> {
  const data = await redis.get<BulkPendingPayload>(REDIS_KEYS.pendingBatch(pendingId));
  return data ?? null;
}

export async function removePendingBatch(pendingId: string): Promise<void> {
  await redis.del(REDIS_KEYS.pendingBatch(pendingId));
}

/**
 * Render and send the bulk confirmation message. Returns the pendingId that
 * the bulk callback handler will receive on confirm/cancel.
 */
export async function showBulkConfirmation(
  chatId: number | string,
  intents: VoiceIntentResult[],
  user: UserConfig,
  transcription: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  service: IMessagingService,
  timezone: string
): Promise<string> {
  // Filter to CREATE intents with valid event payloads. Edit/Delete in batches
  // is far rarer and harder to render compactly; we drop those (the user can
  // re-dictate them as separate utterances). Cap at MAX_BATCH_SIZE.
  const creates = intents
    .filter((i) => i.intent === 'create' && i.event)
    .slice(0, MAX_BATCH_SIZE);

  const pendingId = `bulk:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  // Persist the *full* original intent shape so we can iterate uniformly on
  // confirm. Drop heavy fields by re-serializing through JSON.
  const serialized: VoiceIntentResult[] = creates.map((i) => ({
    intent: i.intent,
    confidence: i.confidence,
    event: i.event,
    scope: i.scope,
  }));

  await setPendingBatch(pendingId, {
    intents: serialized,
    user,
    transcription,
  });

  const lines = creates.map((it, i) => {
    const ev = it.event as ParsedEvent;
    const when = formatEventDateTime(ev, user.language || 'en', t.voice?.allDay || 'All day', timezone);
    const recurringMark = ev.recurrence ? ' 🔁' : '';
    return `${i + 1}. <b>${ev.title}</b>${recurringMark} — ${when}`;
  });

  const heading = (t.voice?.bulkFound || '📋 Found {count} events. Confirm all?').replace('{count}', String(creates.length));
  const body = `${heading}\n\n${lines.join('\n')}`;

  const confirmLabel = t.voice?.bulkConfirmAll || '✅ Confirm all';
  const cancelLabel = t.voice?.bulkCancelAll || '❌ Cancel all';

  await service.sendMessage(chatId, body, {
    format: MessageFormat.HTML,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: confirmLabel, callback_data: `bulk_confirm:${pendingId}` },
          { text: cancelLabel, callback_data: `bulk_cancel:${pendingId}` },
        ],
      ],
    },
  });

  return pendingId;
}

/**
 * Process a "Confirm all" tap. Iterates pending intents through the
 * provider's createEvent in sequence, collecting per-item failures and
 * returning a summary. Failures do not abort the batch.
 */
export async function handleBulkConfirmAll(pendingId: string): Promise<{
  user: UserConfig;
  successCount: number;
  failureCount: number;
  failureMessages: string[];
}> {
  const pending = await getPendingBatch(pendingId);
  if (!pending) {
    throw new Error('bulk_pending_expired');
  }
  await removePendingBatch(pendingId);

  const provider = getProviderForUser(pending.user);
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < pending.intents.length; i++) {
    const intent = pending.intents[i];
    if (intent.intent !== 'create' || !intent.event) {
      failed++;
      errors.push(`#${i + 1}: not a create intent`);
      continue;
    }
    const ev = intent.event;
    const result = await provider.createEvent(pending.user, ev.calendarId || 'primary', {
      title: ev.title,
      startTime: ev.startTime,
      endTime: ev.endTime,
      location: ev.location,
      description: ev.description,
      allDay: ev.allDay,
      recurrence: buildRecurrenceRule(ev.recurrence),
    });
    if (result.success && result.eventId) {
      success++;
      const calId = ev.calendarId || 'primary';
      await pushRecentEvent(pending.user.id, {
        provider: calId.startsWith('native:') ? 'native' : 'google',
        calendarId: calId,
        eventId: result.eventId,
        title: ev.title,
        startsAt: ev.startTime.toISOString(),
        endsAt: ev.endTime.toISOString(),
        action: 'create',
      });
    } else {
      failed++;
      errors.push(`#${i + 1}: ${ev.title} — ${result.error || 'unknown'}`);
    }
  }

  return { user: pending.user, successCount: success, failureCount: failed, failureMessages: errors };
}

export async function handleBulkCancel(pendingId: string): Promise<UserConfig | null> {
  const pending = await getPendingBatch(pendingId);
  if (!pending) return null;
  await removePendingBatch(pendingId);
  return pending.user;
}
