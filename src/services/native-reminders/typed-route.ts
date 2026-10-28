/**
 * Typed "remind me…" messages (spec §3.1, R4).
 *
 * Typed text that isn't a command used to be ignored. A message that names a reminder now
 * goes to the same text-mode extraction as a forwarded one, marked as typed so "me" is the
 * user. Every create it yields is a reminder, resolved like a voice one, and always gets
 * the card (typed text never auto-creates); edits and deletes take the existing chat flows.
 * The webhook sends text here only for users who have native reminders, so nobody else
 * sees a change.
 */

import { getMessagingService } from '../telegram';
import { MessageFormat } from '../messaging/types';
import type { IMessagingService } from '../messaging/types';
import { getBotMessages } from '../../lib/bot-messages';
import { resolveUserTimezone } from '../../lib/timezone';
import { captureError } from '../../lib/error-capture';
import { acquireVoiceLock } from '../../utils/redis-lock';
import { addBreadcrumb } from '../analytics-service';
import { startTypingInterval } from '../telegram/command-pipeline';
import { processTextWithGemini } from '../forward-event/gemini-text';
import { handleEditIntent, handleDeleteIntent } from '../voice';
import { sendAnchorQuestions, showEventConfirmation } from '../voice/confirmations';
import { showBulkConfirmation } from '../voice/bulk-confirmations';
import type { ParsedEvent, VoiceIntentResult } from '../event-parser';
import type { UserConfig } from '../../types';
import { reminderPromptContext, resolveReminderIntents } from './resolve';

/**
 * Words that send typed text to extraction, matched as case-insensitive substrings
 * (spec §3.1). The Hebrew plural "תזכורות" is added because "תזכורת" isn't inside it.
 */
export const REMINDER_KEYWORDS: readonly string[] = [
  'remind', 'reminder', "don't forget", 'dont forget',
  'תזכיר', 'תזכירי', 'תזכורת', 'תזכורות', 'להזכיר', 'אל תשכח', 'אל תשכחי',
  'напомни', 'напомина', 'не забудь',
];

/** Phone keyboards type a curly apostrophe ("don’t"), so it counts as a straight one. */
const APOSTROPHES = /[‘’ʼ`´]/g;

export function hasReminderKeyword(text: string): boolean {
  const normalized = text.toLowerCase().replace(APOSTROPHES, "'");
  return REMINDER_KEYWORDS.some(keyword => normalized.includes(keyword));
}

/**
 * A create from typed text is always a reminder (R4): one the model read as an event
 * becomes a reminder at its start, with no duration. Edits and deletes pass through.
 */
export function asTypedReminder(result: VoiceIntentResult): VoiceIntentResult {
  if (result.intent !== 'create' || !result.event) return result;
  const event = result.event;
  return { ...result, event: { ...event, kind: 'reminder', endTime: new Date(event.startTime.getTime()) } };
}

type CreateResult = VoiceIntentResult & { event: ParsedEvent };

/** What every reply to one typed message needs. */
interface TypedContext {
  chatId: number;
  user: UserConfig;
  text: string;
  timezone: string;
  service: IMessagingService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the bot message tree, as getBotMessages returns it
  t: any;
  adminFooter?: string;
}

/**
 * Answers with what extraction found: reminder cards (and a question for each reminder
 * that can't be placed), an edit or delete card, or "not understood". `results` are
 * already coerced by asTypedReminder, so every create is a reminder.
 */
async function routeTypedIntents(ctx: TypedContext, results: VoiceIntentResult[]): Promise<void> {
  // Each reminder's calendar, target and time, as for voice (Task 11). No selfOnly: typed
  // text is the user's own words, so "remind Dana…" may be for the partner. This is also
  // what sets forName, which the card's "for Dana" and the reply read.
  const { intents, failures } = await resolveReminderIntents(ctx.user, results, ctx.timezone);
  const creates = intents.filter((r): r is CreateResult => r.intent === 'create' && !!r.event && !r.error);
  if (creates.length > 0 || failures.length > 0) {
    if (creates.length > 1) {
      await showBulkConfirmation(ctx.chatId, creates, ctx.user, ctx.text, ctx.t, ctx.service, ctx.timezone, 'text');
    } else if (creates.length === 1) {
      await showEventConfirmation(ctx.chatId, undefined, creates[0].event, ctx.text, ctx.user, ctx.adminFooter, 'text');
    }
    // "an hour before the dentist" with no dentist found: ask for a time instead (sends
    // nothing when every reminder was placed). Asking is the answer, so no "not understood".
    await sendAnchorQuestions(ctx.chatId, failures, ctx.user.language || 'en', ctx.service);
    return;
  }

  const change = intents.find(r => r.intent === 'edit' || r.intent === 'delete');
  if (change?.intent === 'edit') {
    await handleEditIntent(ctx.chatId, undefined, change, ctx.text, ctx.user, ctx.t, ctx.adminFooter);
  } else if (change?.intent === 'delete') {
    await handleDeleteIntent(ctx.chatId, undefined, change, ctx.text, ctx.user, ctx.t, ctx.adminFooter);
  } else {
    await ctx.service.sendMessage(ctx.chatId, ctx.t.nativeReminders.typed.notUnderstood, { format: MessageFormat.PLAIN });
  }
}

/**
 * Handles one typed message that has a reminder keyword, for a user with native reminders.
 * `messageId` is the user's message, which keys the duplicate-delivery lock. Never throws.
 */
export async function handleTypedReminderText(user: UserConfig, chatId: number, text: string, messageId: number): Promise<void> {
  // Telegram redelivers an update it got no answer to, and extraction plus a match can take
  // most of a minute, so the same message would otherwise run twice. The lock expires.
  if (!(await acquireVoiceLock(`typed:${chatId}:${messageId}`))) {
    console.log(`[NativeReminders] Typed message ${chatId}:${messageId} already being handled - skipping duplicate`);
    return;
  }

  const service = getMessagingService();
  const t = await getBotMessages(user.language || 'en');
  let processingId: number | string | null = null;
  let stopTyping: (() => void) | null = null;

  // "On it…" stands in while the model reads, and goes once the answer is ready.
  const clearProcessing = async () => {
    stopTyping?.();
    stopTyping = null;
    if (processingId === null) return;
    const id = processingId;
    processingId = null;
    await service.deleteMessage(chatId, id).catch(() => {});
  };

  addBreadcrumb('typed_reminder_started', { user_id: user.id, text_length: text.length }, 'native_reminders');

  try {
    processingId = await service.sendMessage(chatId, t.nativeReminders.typed.processing, { format: MessageFormat.PLAIN });
    stopTyping = startTypingInterval(chatId, service);

    const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('../calendar-provider');
    if (!(await hasUsableCalendar(user))) {
      await clearProcessing();
      await service.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }
    const calendars = await getCalendarAssignmentsForUser(user);
    const timezone = await resolveUserTimezone(user);
    const reminders = await reminderPromptContext(user); // the user's and the ACTIVE partner's names

    const { intentResults, metrics } = await processTextWithGemini(
      text, user.language || 'en', calendars, timezone, reminders, 'typed'
    );
    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 ${metrics.model} | ${metrics.inputTokens}→${metrics.outputTokens} tok | ${(metrics.durationMs / 1000).toFixed(1)}s</i>`
      : undefined;
    addBreadcrumb('typed_reminder_extracted', { intents: intentResults.map(r => r.intent).join(',') }, 'native_reminders');

    await clearProcessing();
    await routeTypedIntents({ chatId, user, text, timezone, service, t, adminFooter }, intentResults.map(asTypedReminder));
  } catch (error) {
    await clearProcessing();
    console.error('[NativeReminders] Typed reminder failed:', error);
    captureError(error, 'native-reminders-typed');
    await service.sendMessage(chatId, t.nativeReminders.typed.notUnderstood, { format: MessageFormat.PLAIN }).catch(() => {});
  }
}
