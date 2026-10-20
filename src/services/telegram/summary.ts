/**
 * Telegram summary generation and delivery functions
 */

import { getUserByIdentifier, getAllUsers, getWhatsAppChatId } from '../user-service';
import { getCalendarAssignmentsForUser } from '../calendar-provider';
import { DEFAULT_ON_DEMAND_READ, googleGapError, readDigestDay, type DigestEvents, type DigestRead } from '../calendar-read/digest';
import type { DayKey, SourceName } from '../calendar-read/types';

/**
 * How a summary reads its day: the user, their resolved calendar ids, their timezone,
 * the summary day (prepareSummaryForUser decides it), the run's mode and deadline, and the
 * sources to read (the outage run: FamCal only; unset: every one that applies).
 */
export type SummaryFetch = (
  user: UserConfig,
  calendarIds: string[],
  timezone: string,
  day: DayKey,
  read?: DigestRead,
  sources?: readonly SourceName[]
) => Promise<DigestEvents>;

/** The outage run's sources: Google failed this summary twice, FamCal is still read. */
const FAMCAL_ONLY: readonly SourceName[] = Object.freeze(['famcal']);

// The summaries' day read (calendar home spec §3.1): the summary day through the shared
// reader, with the run's mode and deadline (on demand unless the caller says otherwise).
// Its Google failures come back as GOOGLE_TOKEN_EXPIRED, GOOGLE_INSUFFICIENT_SCOPES or
// GOOGLE_FETCH_FAILED. One read serves today and tomorrow, on demand and scheduled alike:
// the day comes with `day`, the mode with `read`.
export const readSummaryDay: SummaryFetch = (user, calendarIds, tz, day, read = DEFAULT_ON_DEMAND_READ, sources) =>
  readDigestDay(user, day, tz, calendarIds, read, sources);
import { generateSummary, SummaryUserContext, formatDateHeader } from '../claude';
import { CalendarEvent, UserConfig, CalendarAssignment } from '../../types';
import { getMessagingService as getMessagingServiceByPlatform, MessagingPlatform, MessageFormat } from '../messaging';
import type { StreamMessageHandle } from '../messaging/types';
import { getCalendarsByLabel, getPrimaryCalendar, getSpouseInfo } from '../../utils/calendar-helpers';
import { isReminderEvent } from '../../utils/event-formatter';
import { addDigestReminders } from '../native-reminders/open-reminders';
import { buildUrl } from '../../config/urls';
import { SHARE_STORY_LABELS, TELEGRAM_CTA_LABELS, getLabel } from '../../config/labels';
import { REDIS_KEYS } from '../../config/redis-keys';
import { executeCommand } from './command-pipeline';
import { getBotMessages } from '../../lib/bot-messages';
import { answerGoogleReadError } from './google-read-errors';
import { trackActivityAsync } from '../analytics-service';
import { checkFeatureAccess, incrementUsage } from '../subscription-service';
import { SCHEDULED_READ, SCHEDULED_RETRY_READ } from '../calendar-read/digest';
import { captureError, captureWarning } from '../../lib/error-capture';
import { getMessagingService } from './bot';
import { sendVoiceMessage } from './voice';

/**
 * Categorize events by ownership for a specific user
 */
export function categorizeEvents(
  events: CalendarEvent[],
  user: UserConfig,
  // Resolved assignments. Defaults to the raw Google-only JSON column for
  // backwards compatibility; callers with a NATIVE user must pass the result of
  // getCalendarAssignmentsForUser(), or every event lands in `otherEvents`.
  assignments?: CalendarAssignment[]
) {
  const resolved = assignments ?? user.calendarAssignments ?? [];
  const ownCalendars = getCalendarsByLabel(resolved, 'yours');
  const spouseCalendars = getCalendarsByLabel(resolved, 'spouse');

  // A reminder goes by whose it is, not by its calendar: the viewer's own (set by them
  // or for them) are theirs, the partner's go to the partner. Never to otherEvents,
  // which feeds the kid-name follow-up.
  const isOwn = (e: CalendarEvent) =>
    isReminderEvent(e) ? e.reminder?.ownerIsViewer !== false : ownCalendars.includes(e.calendarId);
  const isSpouse = (e: CalendarEvent) =>
    isReminderEvent(e) ? e.reminder?.ownerIsViewer === false : spouseCalendars.includes(e.calendarId);

  return {
    userEvents: events.filter(isOwn),
    spouseEvents: events.filter(isSpouse),
    otherEvents: events.filter(e => !isOwn(e) && !isSpouse(e)),
  };
}

/**
 * Shared summary preparation logic - used by both user-invoked and scheduled flows
 */
interface PreparedSummary {
  summary: string;
  dateHeader: string;
  otherEvents: CalendarEvent[];
  /** Google needs reconnecting and the summary kept FamCal's events: the caller adds the reconnect line. */
  googleReconnect?: 'token' | 'scopes';
}

/**
 * Stages the streaming draft can be in. Caller wires this to localized
 * placeholder text and pushes via streamHandle.pushDelta.
 */
type StreamStage = 'fetchingCalendar' | 'lookingAhead' | 'fetchingWeather' | 'composing';

/**
 * Builds one user's summary. `summaryDate` is the tomorrow flag (set: tomorrow). `opts`
 * comes from the callers (calendar home spec §3.1):
 * - `day`: the summary day. Unset, it is today's rule: the user's local date, plus one
 *   calendar day for tomorrow. The scheduled retry passes the first attempt's day, so a
 *   retry that crosses midnight still reads, shapes and dates that day (A-7).
 * - `read`: the run's mode and deadline, handed to the read.
 * - `googleUnavailable`: the outage run, after Google failed the first attempt and the
 *   retry. The day and the week block are read from FamCal only ("Google as a connection"
 *   spec §4); the prompt is told why, and the outage line goes under the summary. A user
 *   without a Google token never gets here, and is left as is.
 * An on-demand read that kept FamCal while Google was unreachable is told and noted the same
 * way; one that kept FamCal while Google needs reconnecting returns googleReconnect.
 */
export async function prepareSummaryForUser(
  user: UserConfig,
  fetchFunction: SummaryFetch,
  summaryDate: Date | undefined,
  modelId?: string,
  onTextDelta?: (delta: string, accumulated: string) => void | Promise<void>,
  onStageChange?: (stage: StreamStage) => void,
  opts?: { day?: DayKey; read?: DigestRead; googleUnavailable?: boolean }
): Promise<PreparedSummary> {
  const t0 = Date.now();

  // Resolve user's timezone early for consistent use throughout
  const tTimezone = Date.now();
  const { resolveUserTimezone } = await import('../../lib/timezone');
  const userTimezone = await resolveUserTimezone(user);
  const timezoneMs = Date.now() - tTimezone;

  // Resolve the user's calendars through the provider. Reading
  // user.calendarAssignments directly would hand a NATIVE user an empty list -
  // that column is the Google-only JSON and is never populated for them - and
  // the native provider short-circuits to [] on an empty calendar list, so the
  // whole summary would come back with no events.
  const assignments = await getCalendarAssignmentsForUser(user);
  const allCalendarIds = assignments.map(a => a.calendarId);

  // Fetch calendar events with user's timezone. Google returns every event that
  // overlaps the day, so keep only what belongs to it: last night's 22:00-02:00 party
  // is dropped, and an event crossing the day's edges is marked for the prompt.
  //
  // The summary day is decided once, before the read: the user's local date, plus one
  // calendar day for tomorrow (not 24 hours, which lands on the wrong day around a DST
  // change). The prompt and the date header get noon of that day.
  onStageChange?.('fetchingCalendar');
  const tCalendar = Date.now();
  const { localDate, nextDate, shapeEventsForDay } = await import('../../utils/day-events');
  const { fromZonedTime } = await import('date-fns-tz');
  const today = localDate(new Date(), userTimezone);
  const day = opts?.day ?? (summaryDate ? nextDate(today) : today);
  const dayNoon = fromZonedTime(`${day} 12:00:00`, userTimezone);
  // The outage run: Google failed this summary twice, so the day is read from FamCal only. Only
  // a user with a Google token reads Google (sourcesFor), so no other user is affected.
  const googleOut = opts?.googleUnavailable === true && !!user.googleRefreshToken;
  const fetched = await fetchFunction(user, allCalendarIds, userTimezone, day, opts?.read, googleOut ? FAMCAL_ONLY : undefined);
  // The read kept FamCal without Google's half: unreachable on demand, or a reconnect
  const gap = googleOut ? undefined : fetched.googleGap;
  const googleMissing = googleOut || gap === 'unavailable';
  const googleReconnect = gap === 'token' || gap === 'scopes' ? gap : undefined;
  const dayEvents = shapeEventsForDay(fetched, day, userTimezone);
  // Built-in calendar reminders: done ones leave the day, past-due ones are marked
  // open, and older open ones join after the day's own (shaping would drop them).
  // Anyone else's events pass through as they are.
  const { events, moreCount: openRemindersMore } = await addDigestReminders(user, dayEvents, day, userTimezone);
  const calendarMs = Date.now() - tCalendar;

  // Categorize events by ownership
  const tCategorize = Date.now();
  const categorized = categorizeEvents(events, user, assignments);
  const categorizeMs = Date.now() - tCategorize;

  // Extract primary calendar ID
  const primaryCalendar = getPrimaryCalendar(assignments) || '';

  // Get spouse info from the resolved calendars: a NATIVE user's partner is named there
  const spouseInfo = getSpouseInfo(user, assignments);

  // Build user context for summary generation
  const userContext: SummaryUserContext = {
    culture: user.culture,
    globalRules: user.globalRules,
    calendarAssignments: assignments,
    openRemindersMore,
    // Only when Google's events are missing, so every other prompt stays as it is (A-19).
    ...(googleMissing ? { googleUnavailable: true } : {}),
  };

  // Fetch week lookahead if enabled for tomorrow summary. The outage run reads its FamCal
  // half only, as the day.
  let weekLookaheadText: string | undefined;
  let lookaheadMs = 0;
  if (summaryDate && user.includeLookaheadInTomorrow) {
    onStageChange?.('lookingAhead');
    const tLookahead = Date.now();
    try {
      const { getWeekLookahead, formatTomorrowLookahead } = await import('../week-lookahead');
      // From the same summary day, not now+24h, which is a day off on a DST eve.
      const lookahead = await getWeekLookahead(user, assignments, dayNoon, opts?.read, googleOut ? { sources: FAMCAL_ONLY } : undefined);

      if (lookahead.events.length > 0) {
        weekLookaheadText = formatTomorrowLookahead(lookahead);
      }
    } catch (error) {
      console.error('Failed to fetch week lookahead:', error);
      captureError(error, 'summary-week-lookahead', { user_id: user.id }, 'warning');
    }
    lookaheadMs = Date.now() - tLookahead;
  }

  // generateSummary internally does (1) weather fetch, then (2) prompt build,
  // then (3) AI streaming. Show 'fetchingWeather' before entering; pass the
  // stage callback through so generateSummary can flip to 'composing' as soon
  // as weather lands. The first streamed token then replaces the placeholder.
  if (user.weatherEnabled && user.location) {
    onStageChange?.('fetchingWeather');
  } else {
    onStageChange?.('composing');
  }
  const tAI = Date.now();
  const generated = await generateSummary(
    categorized.userEvents,
    categorized.spouseEvents,
    categorized.otherEvents,
    user.name,
    user.englishName,
    user.gender,
    spouseInfo?.name,
    spouseInfo?.englishName,
    spouseInfo?.gender,
    primaryCalendar,
    dayNoon,
    user.isAdmin,
    modelId,
    user.location,
    user.language,
    userContext,
    user.weatherEnabled,
    weekLookaheadText,
    userTimezone,
    onTextDelta,
    onStageChange ? () => onStageChange('composing') : undefined
  );
  const aiMs = Date.now() - tAI;

  // A summary without Google's events says so under it. deliverSummary sends this text and
  // voices it, so the line reaches both (A-32). An empty answer stays empty, so
  // deliverSummary still answers it with "could not generate".
  let summary = generated;
  if (googleMissing && generated.trim() !== '') {
    const t = await getBotMessages(user.language || 'en');
    summary = `${generated}\n\n<i>${t.errors.googleOutageNote}</i>`;
  }

  // Generate date header for voice-only delivery
  const dateHeader = formatDateHeader(
    dayNoon,
    user.language,
    user.culture,
    userTimezone
  );

  const totalMs = Date.now() - t0;
  console.log(`[Summary Timing] user=${user.telegramId} type=${summaryDate ? 'tomorrow' : 'today'} total=${totalMs}ms timezone=${timezoneMs}ms calendar=${calendarMs}ms categorize=${categorizeMs}ms lookahead=${lookaheadMs}ms ai=${aiMs}ms`);

  return { summary, dateHeader, otherEvents: categorized.otherEvents, ...(googleReconnect ? { googleReconnect } : {}) };
}

/**
 * Generic function to send summary to a specific user
 * Supports both Telegram (progress messages, inline keyboards) and WhatsApp (simple text)
 */
export async function sendSummaryToUser(
  chatId: number | string,
  fetchFunction: SummaryFetch,
  summaryDate: Date | undefined,
  errorKey: string,
  modelId?: string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  streamHandle?: StreamMessageHandle
): Promise<void> {
  // Platform-agnostic user lookup
  const user = await getUserByIdentifier(chatId);
  if (!user) {
    console.error(`User not found for ${chatId}`);
    return;
  }

  // Get the correct messaging service for this platform
  const messagingService = platform === MessagingPlatform.TELEGRAM
    ? getMessagingService()
    : getMessagingServiceByPlatform(platform);

  const userLanguage = user.language || 'en';

  trackActivityAsync(user.id, 'text_summary_requested', {
    summary_type: summaryDate ? 'tomorrow' : 'today',
    language: userLanguage,
    calendar_count: user.calendarAssignments?.length || 0,
  });

  // Check feature access for text summaries
  const textAccess = await checkFeatureAccess(user.id, 'text_summary');
  if (!textAccess.allowed) {
    const t = await getBotMessages(userLanguage);
    const limitMessage = t.subscription?.textLimitReached
      || 'You\'ve reached your monthly text summary limit.';

    await messagingService.sendMessage(chatId, limitMessage, {
      format: MessageFormat.HTML,
    });
    return;
  }

  await executeCommand({
    chatId,
    language: userLanguage,
    messagingService,
    errorKey,
    commandName: 'Summary Generation',
    context: `User: ${chatId}, Date: ${summaryDate ? summaryDate.toISOString() : 'today'}`,
    streamHandle,
    operation: async () => {
      const onTextDelta = streamHandle
        ? (_delta: string, accumulated: string) => streamHandle.pushDelta(accumulated)
        : undefined;
      let onStageChange: ((stage: StreamStage) => void) | undefined;
      if (streamHandle) {
        const stageMessages = await getBotMessages(userLanguage);
        onStageChange = (stage: StreamStage) => {
          const text = stageMessages.streaming?.[stage];
          if (text) streamHandle.pushStage(text);
        };
      }
      return prepareSummaryForUser(user, fetchFunction, summaryDate, modelId, onTextDelta, onStageChange, {
        read: DEFAULT_ON_DEMAND_READ,
      });
    },
    onSuccess: async (result) => {
      await deliverSummary({
        userId: chatId,
        summary: result.summary,
        user,
        platform: platform === MessagingPlatform.TELEGRAM ? 'telegram' : 'whatsapp',
        dateHeader: result.dateHeader,
        otherEvents: result.otherEvents,
        streamHandle,
        summaryDate,
      });
      // The summary kept FamCal while Google needs reconnecting: then the reconnect text
      if (result.googleReconnect) {
        await answerGoogleReadError(googleGapError(result.googleReconnect), { chatId, user, userLanguage, messagingService });
      }
    },
    onError: error => answerGoogleReadError(error, { chatId, user, userLanguage, messagingService, streamHandle }),
  });
}

/** prepareSummaryForUser's last argument (spec §3.1): the summary day, the read, the outage flag. */
type SummaryRunOptions = NonNullable<Parameters<typeof prepareSummaryForUser>[6]>;

/** The digest adapters' outage error (spec §3.1): Google couldn't be read for `day`, the read's first day. */
function isGoogleFetchFailed(error: unknown): error is Error & { day?: SummaryRunOptions['day'] } {
  return error instanceof Error && error.message === 'GOOGLE_FETCH_FAILED';
}

/** C5: the scheduled retry runs this long after the batch's first Google failure. */
const SCHEDULED_RETRY_AFTER_MS = 30_000;

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let scheduledRetrySleep: (ms: number) => Promise<void> = realSleep;

/** Smoke scripts only: replaces the wait before the scheduled retry; null puts the real one back. */
export function __setScheduledRetrySleepForTests(sleep: ((ms: number) => Promise<void>) | null): void {
  scheduledRetrySleep = sleep ?? realSleep;
}

/** How many users a batch handles at once (Telegram, Anthropic and Neon take this easily). */
const SUMMARY_CONCURRENCY = 4;
let summaryConcurrency = SUMMARY_CONCURRENCY;

/** Smoke scripts only: a timeline check that reads one user after another sets 1; null puts the real limit back. */
export function __setSummaryConcurrencyForTests(limit: number | null): void {
  summaryConcurrency = limit ?? SUMMARY_CONCURRENCY;
}

/**
 * Runs fn over items, `limit` at a time, starting them in order. One that throws does not
 * stop the rest; the first error is thrown once all are done, as the sequential loop's
 * throw reached the batch's own catch.
 */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

/** Result counts from batch summary delivery */
export interface SummaryBatchResult {
  processed: number;
  skippedHour: number;
  skippedDay: number;
  skippedDedup: number;
}

/**
 * The token text with the refresh button (Telegram) or the reconnect template (WhatsApp),
 * and an admin warning: after a scheduled summary that failed on a dead token, or one that
 * went out with FamCal's events while Google needs reconnecting ("Google as a connection"
 * spec §4 Summaries). A failed send is logged and reported; it never fails the batch.
 */
async function sendReconnectNotice(user: UserConfig, platform: DeliveryPlatform, reason: 'token' | 'scopes'): Promise<void> {
  const messagingService = getMessagingService();
  const t = await getBotMessages(user.language || 'en');
  const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId ?? user.id}`);
  const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;

  try {
    if ((platform === 'telegram' || platform === 'all') && user.telegramId) {
      await messagingService.sendMessage(user.telegramId, expiredMessage, {
        format: MessageFormat.HTML,
        replyMarkup: {
          inline_keyboard: [[
            { text: t.buttons.refreshGoogle, web_app: { url: refreshUrl } }
          ]]
        }
      });
    }
    if ((platform === 'whatsapp' || platform === 'all') && getWhatsAppChatId(user)) {
      const waChatId = getWhatsAppChatId(user)!;
      const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
      const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
      const template = buildWhatsAppTemplate(user.language || 'en');
      await whatsappService.sendMessage(waChatId, '', { whatsappTemplate: template });
    }
  } catch (msgError) {
    console.error(`Failed to send token expired message to user ${user.id}:`, msgError);
    captureError(msgError, 'summary-token-expired-notify', { user_id: user.id }, 'warning');
  }

  const { notifyAdminWarning } = await import('../../utils/error-notifier');
  await notifyAdminWarning(
    reason === 'scopes' ? 'Insufficient Scopes' : 'Token Expired',
    reason === 'scopes'
      ? `User ${user.id} (${user.name}) has a Google token with insufficient scopes; their summary went out with FamCal only`
      : `User ${user.id} (${user.name}) needs to refresh their Google Calendar token`
  );
}

/**
 * Generic function to send summary to all users
 */
async function sendSummaryToAll(
  fetchFunction: SummaryFetch,
  summaryDate: Date | undefined,
  options?: { filterByHour?: boolean }
): Promise<SummaryBatchResult> {
  const messagingService = getMessagingService();
  const result: SummaryBatchResult = { processed: 0, skippedHour: 0, skippedDay: 0, skippedDedup: 0 };
  // When the batch chose its users. The scheduled retry's summaries are marked sent under
  // this local date, the date the batch chose them for, also when they go out past midnight.
  const batchStartedAt = new Date();

  try {
    // Skip users Telegram refuses to deliver to. Without this a blocked user is
    // retried on every run forever, failing three sends and paging an admin each time.
    const allUsers = (await getAllUsers()).filter(u => !u.suspendedAt && !u.unreachableSince);
    if (allUsers.length === 0) {
      console.error('No users configured');
      return result;
    }

    // One-line WA cohort visibility — useful when only some users seem to receive WA.
    // Lists every user whose platform is whatsapp/all and what identifier they'd be sent to.
    const waCohort = allUsers.filter(u => {
      const p = u.messagingPlatform || 'telegram';
      return p === 'whatsapp' || p === 'all';
    });
    const waCohortSummary = waCohort.map(u => `${u.id}:${u.messagingPlatform}:${getWhatsAppChatId(u) ?? 'NONE'}`).join(', ');
    console.log(`[Summary] WA cohort (${waCohort.length}/${allUsers.length} users): ${waCohortSummary || '<empty>'}`);

    // Filter by preferred hour if requested (hourly cron mode)
    let users = allUsers;
    if (options?.filterByHour) {
      const { filterUsersForSummary } = await import('../../lib/summary-scheduling');
      const summaryType = summaryDate ? 'tomorrow' : 'daily';
      const filtered = await filterUsersForSummary(allUsers, summaryType);
      users = filtered.eligible;
      result.skippedHour = filtered.skippedHour;
      result.skippedDay = filtered.skippedDay;
      result.skippedDedup = filtered.skippedDedup;

      console.log(`[Summary] Hourly filter: ${users.length} eligible, ${filtered.skippedHour} skipped (hour), ${filtered.skippedDay} skipped (day), ${filtered.skippedDedup} skipped (dedup)`);
    }

    // C5 (spec §3.1 step 6): a user whose Google read fails is set aside here and retried
    // after the loop, so the rest of the batch never waits on Google.
    const googleRetries: { user: UserConfig; platform: DeliveryPlatform; day: SummaryRunOptions['day'] }[] = [];
    let firstGoogleFailureAt = 0;

    // One user's summary, prepared and delivered, then counted and marked sent: the same
    // on the first attempt, the retry and the outage run. `markedFor` dates the dedup mark
    // (the retry passes the batch's start); unset, it is the time of the mark, as before.
    const deliverToUser = async (user: UserConfig, platform: DeliveryPlatform, runOptions: SummaryRunOptions, markedFor?: Date) => {
      const tUser = Date.now();
      const { summary, dateHeader, otherEvents, googleReconnect } = await prepareSummaryForUser(
        user, fetchFunction, summaryDate, undefined, undefined, undefined, runOptions
      );

      // Use telegramId for TG delivery, whatsappPhone for WA, or user.id as fallback
      const deliveryUserId = user.telegramId ?? getWhatsAppChatId(user) ?? user.id;
      await deliverSummary({
        userId: deliveryUserId,
        summary,
        user,
        platform,
        dateHeader,
        waButtonPayload: summaryDate ? 'summary tmrw' : 'summary',
        otherEvents,
        summaryDate,
      });
      // The summary kept FamCal while Google needs reconnecting: the reconnect line and button follow
      if (googleReconnect) await sendReconnectNotice(user, platform, googleReconnect);

      console.log(`[Batch Summary] user=${user.id} platform=${platform} total=${Date.now() - tUser}ms`);
      result.processed++;

      // Mark as sent for dedup
      if (options?.filterByHour) {
        const { markSummarySent } = await import('../../lib/summary-scheduling');
        const { resolveUserTimezone } = await import('../../lib/timezone');
        const tz = await resolveUserTimezone(user);
        await markSummarySent(user.id, summaryDate ? 'tomorrow' : 'daily', tz, markedFor);
      }
    };

    // A failed summary: logged, and a dead token gets the token text with the refresh
    // button. No dedup mark.
    const reportFailure = async (user: UserConfig, platform: DeliveryPlatform, error: unknown) => {
      console.error(`Failed to send summary to user ${user.id}:`, error);
      captureError(error, 'summary-batch-user', { user_id: user.id });

      if (error instanceof Error && error.message === 'GOOGLE_TOKEN_EXPIRED') {
        await sendReconnectNotice(user, platform, 'token');
      }
    };

    // The one retry: on the first attempt's day, with the retry's deadline for the day
    // read and the week block. Only a second outage sends the summary without Google,
    // with the outage guideline and line; it counts as sent. Anything else it throws is
    // the caller's to report. Every summary it sends is marked for the batch's date.
    const retryOnce = async (user: UserConfig, platform: DeliveryPlatform, day: SummaryRunOptions['day']) => {
      const retry: SummaryRunOptions = { day, read: SCHEDULED_RETRY_READ };
      try {
        await deliverToUser(user, platform, retry, batchStartedAt);
      } catch (error) {
        if (!isGoogleFetchFailed(error)) throw error;
        captureError(error, 'summary-google-outage', { user_id: user.id }, 'warning');
        await deliverToUser(user, platform, { ...retry, googleUnavailable: true }, batchStartedAt);
      }
    };

    // One user's pass: skipped, weather-only, or delivered; a Google outage sets them aside.
    const processUser = async (user: UserConfig) => {
      const platform = user.messagingPlatform || 'telegram';

      // Diagnostic: log WA delivery details for dual-platform users
      if (platform === 'whatsapp' || platform === 'all') {
        console.log(`[Summary] User ${user.id}: platform=${platform} waPhone=${user.whatsappPhone || 'null'} waBsuid=${user.whatsappBsuid || 'null'} waChatId=${getWhatsAppChatId(user) || 'null'}`);
      }

      // Everyone has FamCal ("Google as a connection"), so no Google token skips nobody:
      // the calendars are the union, FamCal's then the Google choices.
      const assignments = await getCalendarAssignmentsForUser(user);
      const hasCalendars = assignments.length > 0;
      const hasLocation = !!user.location;

      if (!hasCalendars && !hasLocation) {
        console.log(`[Summary] Skipping user ${user.id}: No calendars or location`);
        return;
      }

      if (!hasCalendars && hasLocation && user.weatherEnabled) {
        try {
          await sendWeatherOnlyToUser(user, summaryDate, platform);
          result.processed++;
          if (options?.filterByHour) {
            const { markSummarySent } = await import('../../lib/summary-scheduling');
            const { resolveUserTimezone } = await import('../../lib/timezone');
            const tz = await resolveUserTimezone(user);
            await markSummarySent(user.id, summaryDate ? 'tomorrow' : 'daily', tz);
          }
        } catch (error) {
          console.error(`[Summary] Failed to send weather-only to user ${user.telegramId}:`, error);
          captureError(error, 'summary-weather-only', { user_id: user.id }, 'warning');
        }
        return;
      }

      if (!hasCalendars) {
        console.log(`[Summary] Skipping user ${user.id}: No calendars, weather disabled`);
        return;
      }

      try {
        await deliverToUser(user, platform, { read: SCHEDULED_READ });
      } catch (error) {
        if (isGoogleFetchFailed(error)) {
          console.warn(`[Summary] Google unreachable for user ${user.id}; retrying after the batch`);
          if (googleRetries.length === 0) firstGoogleFailureAt = Date.now();
          googleRetries.push({ user, platform, day: error.day });
        } else {
          await reportFailure(user, platform, error);
        }
      }
    };

    // A few users at once: a Google stall (30 s a read, up to 60 s a user) would otherwise
    // cost the batch N times that, past every later user's hour. Counters, the retry list and
    // firstGoogleFailureAt are only touched between awaits, so they need no lock.
    await runPool(users, summaryConcurrency, processUser);

    // C5: 30 s after the first failure, each set-aside user gets one retry, SUMMARY_CONCURRENCY at a time.
    if (googleRetries.length > 0) {
      // Said once per batch, before the wait: if the process stops during it (a deploy),
      // these users get no summary and no dedup mark this hour, and Sentry has the count.
      captureWarning(`${googleRetries.length} scheduled summaries set aside for a Google retry`, 'summary-google-retry', {
        set_aside: googleRetries.length,
        summary_type: summaryDate ? 'tomorrow' : 'daily',
      });
      const waitMs = firstGoogleFailureAt + SCHEDULED_RETRY_AFTER_MS - Date.now();
      if (waitMs > 0) await scheduledRetrySleep(waitMs);
      await runPool(googleRetries, summaryConcurrency, async ({ user, platform, day }) => {
        try {
          await retryOnce(user, platform, day);
        } catch (error) {
          await reportFailure(user, platform, error);
        }
      });
    }

    console.log(`[Batch Summary] ${summaryDate ? 'tomorrow' : 'daily'} done: processed=${result.processed} set aside=${googleRetries.length} total=${Date.now() - batchStartedAt.getTime()}ms`);
  } catch (error) {
    console.error('Failed to generate summary for all users:', error);
    captureError(error, 'summary-batch-all');

    const { notifyAdminError } = await import('../../utils/error-notifier');
    await notifyAdminError(
      'Batch Summary Generation',
      error,
      `Date: ${summaryDate ? summaryDate.toISOString() : 'today'}`
    );
  }

  return result;
}

/**
 * Send daily summary to a specific user
 */
export async function sendDailySummaryToUser(
  chatId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  streamHandle?: StreamMessageHandle
): Promise<void> {
  await sendSummaryToUser(
    chatId,
    readSummaryDay,
    undefined,
    'calendarFetch',
    undefined,
    platform,
    streamHandle
  );
}

/**
 * Send weather-only message to a user
 * Used when user has location set but no calendars configured
 */
async function sendWeatherOnlyToUser(
  user: UserConfig,
  summaryDate: Date | undefined,
  platform: string
): Promise<void> {
  const messagingService = getMessagingService();

  const { getTimezone } = await import('../weather/geocoding');
  const { fetchWeather, getWeatherDescription, getWindDirectionLabel } = await import('../weather/open-meteo');
  const { detectSharav } = await import('../weather/sharav');
  const { fetchAirQuality } = await import('../weather/air-quality');
  const { detectDustStorm } = await import('../weather/dust-storm');

  const timezone = await getTimezone(user.location);
  const [weatherData, airQualityData] = await Promise.all([
    fetchWeather(user.location, timezone),
    fetchAirQuality(user.location, timezone).catch(() => null),
  ]);

  const t = await getBotMessages(user.language || 'en');

  // The message's day, picked the way prepareSummaryForUser picks the summary day: the
  // local date, plus one calendar day for tomorrow. summaryDate is now+24h on the UTC
  // server, which on a spring-forward eve is the day after tomorrow.
  const { localDate, nextDate } = await import('../../utils/day-events');
  const { fromZonedTime } = await import('date-fns-tz');
  const today = localDate(new Date(), timezone);
  const targetDate = fromZonedTime(`${summaryDate ? nextDate(today) : today} 12:00:00`, timezone);

  const dateStr = targetDate.toLocaleDateString(user.language === 'he' ? 'he-IL' : user.language === 'ru' ? 'ru-RU' : 'en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone
  });

  // Wind line when significant
  const windLine = weatherData.current.windSpeed > 20
    ? `\n💨 ${getWindDirectionLabel(weatherData.current.windDirection, user.language)} ${weatherData.current.windSpeed} ${t.weatherOnly?.windSpeed || 'km/h'}`
    : '';

  // Sharav warning for today/tomorrow
  const sharavDays = detectSharav(weatherData);
  const nearSharav = sharavDays.filter(s => s.dayIndex <= 1);
  let sharavLine = '';
  if (nearSharav.length > 0) {
    const severityKeys: Record<string, string> = {
      mild: t.weatherOnly?.severityMild || 'mild',
      moderate: t.weatherOnly?.severityModerate || 'moderate',
      severe: t.weatherOnly?.severitySevere || 'severe',
    };
    const warnings = nearSharav.map(s => {
      const dayLabel = s.dayIndex === 0
        ? (t.weatherOnly?.today || 'Today')
        : (t.weatherOnly?.tomorrow || 'Tomorrow');
      return `${dayLabel}: ${severityKeys[s.severity]} (${s.tempMax}°C)`;
    }).join(', ');
    sharavLine = `\n\n⚠️ <b>${t.weatherOnly?.sharav || 'Sharav'}:</b> ${warnings}`;
  }

  // Dust storm warning for today/tomorrow
  const dustDays = detectDustStorm(airQualityData, weatherData);
  const nearDust = dustDays.filter(d => d.dayIndex <= 1);
  let dustLine = '';
  if (nearDust.length > 0) {
    const severityKeys: Record<string, string> = {
      mild: t.weatherOnly?.severityMild || 'mild',
      moderate: t.weatherOnly?.severityModerate || 'moderate',
      severe: t.weatherOnly?.severitySevere || 'severe',
    };
    const warnings = nearDust.map(d => {
      const dayLabel = d.dayIndex === 0
        ? (t.weatherOnly?.today || 'Today')
        : (t.weatherOnly?.tomorrow || 'Tomorrow');
      return `${dayLabel}: ${severityKeys[d.severity]}`;
    }).join(', ');
    dustLine = `\n\n🌫️ <b>${t.weatherOnly?.dustStorm || 'Dust Storm'}:</b> ${warnings}`;
  }

  const weatherMessage = `🌤️ <b>${t.weatherOnly?.title || 'Weather'} - ${dateStr}</b>

<b>${t.weatherOnly?.current || 'Current'}:</b> ${weatherData.current.temperature}°C (${t.weatherOnly?.feelsLike || 'feels like'} ${weatherData.current.feelsLike}°C), ${getWeatherDescription(weatherData.current.weatherCode)}${windLine}

<b>${t.weatherOnly?.today || 'Today'}:</b> ${t.weatherOnly?.high || 'High'} ${weatherData.today.tempMax}°C, ${t.weatherOnly?.low || 'Low'} ${weatherData.today.tempMin}°C, ${weatherData.today.precipitationProbability}% ${t.weatherOnly?.rain || 'rain'}
${weatherData.tomorrow ? `<b>${t.weatherOnly?.tomorrow || 'Tomorrow'}:</b> ${t.weatherOnly?.high || 'High'} ${weatherData.tomorrow.tempMax}°C, ${t.weatherOnly?.low || 'Low'} ${weatherData.tomorrow.tempMin}°C, ${weatherData.tomorrow.precipitationProbability}% ${t.weatherOnly?.rain || 'rain'}` : ''}${sharavLine}${dustLine}`;

  if ((platform === 'telegram' || platform === 'all') && user.telegramId) {
    await messagingService.sendMessage(user.telegramId, weatherMessage, {
      format: MessageFormat.HTML
    });
  }

  if ((platform === 'whatsapp' || platform === 'all') && !getWhatsAppChatId(user)) {
    console.warn(`[Delivery] WA weather skipped for user ${user.id}: no WhatsApp phone/BSUID`);
  }
  if ((platform === 'whatsapp' || platform === 'all') && getWhatsAppChatId(user)) {
    const waChatId = getWhatsAppChatId(user)!;
    const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
    const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
    const template = buildWhatsAppTemplate(user.language || 'en', 'weather');
    await whatsappService.sendMessage(waChatId, '', { whatsappTemplate: template });
  }

  console.log(`[Summary] Sent weather-only to user ${user.id}`);
}

/**
 * Send daily summary to all users
 */
export async function sendDailySummaryToAll(options?: { filterByHour?: boolean }): Promise<SummaryBatchResult> {
  return sendSummaryToAll(readSummaryDay, undefined, options);
}

/**
 * Send tomorrow's summary to a specific user
 */
export async function sendTomorrowSummaryToUser(
  chatId: number | string,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
  streamHandle?: StreamMessageHandle
): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  await sendSummaryToUser(
    chatId,
    readSummaryDay,
    tomorrow,
    'tomorrowFetch',
    undefined,
    platform,
    streamHandle
  );
}

/**
 * Send tomorrow's summary to all users
 */
export async function sendTomorrowSummaryToAll(options?: { filterByHour?: boolean }): Promise<SummaryBatchResult> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return sendSummaryToAll(readSummaryDay, tomorrow, options);
}

/** Platform options for message delivery */
type DeliveryPlatform = 'telegram' | 'whatsapp' | 'all';

/**
 * Route text message to appropriate platform(s)
 */
export async function routeTextMessage(
  userId: number | string,
  text: string,
  user: UserConfig,
  platform?: DeliveryPlatform,
  isProactive = false,
  waButtonPayload?: string,
  streamHandle?: StreamMessageHandle
): Promise<void> {
  if (!text || text.trim() === '') {
    captureError(
      new Error('Attempted to send empty message'),
      'telegram-delivery',
      { user_id: userId, service: 'routeTextMessage' }
    );
    return;
  }

  const targetPlatform = platform || user.messagingPlatform || 'telegram';
  const msgService = getMessagingService();

  if ((targetPlatform === 'telegram' || targetPlatform === 'all') && user.telegramId) {
    try {
      const lang = user.language || 'en';
      const { buildUrl } = await import('../../config/urls');
      const { redis } = await import('../../utils/redis');
      const shareLabel = getLabel(SHARE_STORY_LABELS, lang);

      // Send message first to get message ID, then stash text keyed by it.
      // When a streamHandle is present (miniapp-invoked path), finalize the
      // animated draft into the persisted message instead of opening a fresh
      // sendMessage — the draft was already showing the prose live.
      const initialMsgId = streamHandle
        ? await streamHandle.finalize(text, { format: MessageFormat.HTML })
        : await msgService.sendMessage(user.telegramId, text, { format: MessageFormat.HTML });
      const msgId = typeof initialMsgId === 'number' ? initialMsgId : Number(initialMsgId);

      // Stash text keyed by message ID for per-message story sharing
      redis.set(REDIS_KEYS.storyText(user.id, msgId), text, { ex: 86400 }).catch(() => {});

      // Edit message to add share button with message-specific URL
      const shareUrl = buildUrl(`/${lang}/share-story?user_id=${user.id}&source=summary&msg=${msgId}`);
      await msgService.updateMessage(user.telegramId, msgId, text, {
        format: MessageFormat.HTML,
        replyMarkup: {
          inline_keyboard: [[
            { text: shareLabel, web_app: { url: shareUrl } }
          ]]
        }
      });
    } catch (e) {
      console.error(`[Delivery] TG text failed for user ${user.id}:`, e);
      captureError(e, 'telegram-delivery', { user_id: userId, service: 'sendMessage' });

      // This is where a blocked user first shows up - the text send 403s before the
      // voice one does. Marking here is what actually stops the retries; the voice
      // path only ever saw it because this catch swallowed the error and let
      // execution continue as if delivery had succeeded.
      const { isUnreachableError, describeDeliveryError } = await import('../../lib/delivery-errors');
      if (isUnreachableError(e)) {
        const { markUserUnreachable } = await import('../../lib/user-reachability');
        await markUserUnreachable(user.id, describeDeliveryError(e));
      }
    }
  }

  if ((targetPlatform === 'whatsapp' || targetPlatform === 'all') && !getWhatsAppChatId(user)) {
    console.warn(`[Delivery] WA text skipped for user ${user.id}: no WhatsApp phone/BSUID (platform=${targetPlatform})`);
  }

  if ((targetPlatform === 'whatsapp' || targetPlatform === 'all') && getWhatsAppChatId(user)) {
    try {
      const waChatId = getWhatsAppChatId(user)!;
      const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);

      if (isProactive) {
        // Send template with quick reply button — user taps to get content
        const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
        const template = buildWhatsAppTemplate(user.language || 'en', waButtonPayload);
        console.log(`[Delivery] Sending WA template to user ${user.id} (${waChatId}) tpl=${template.name} payload=${waButtonPayload || 'none'}`);
        const tplId = await whatsappService.sendMessage(waChatId, '', { whatsappTemplate: template });
        console.log(`[Delivery] WA template sent (msgId=${tplId})`);
      } else {
        console.log(`[Delivery] Sending WA text to user ${user.id} (${waChatId})`);
        const telegramCta = getLabel(TELEGRAM_CTA_LABELS, user.language || 'en');
        await whatsappService.sendMessage(waChatId, text, { format: MessageFormat.HTML, telegramCta });
      }
    } catch (e) {
      console.error(`[Delivery] WA text failed for user ${user.id} (${getWhatsAppChatId(user)}):`, e);
      captureError(e, 'whatsapp-delivery', { user_id: userId, service: 'sendMessage' });
    }
  }
}

/**
 * Delivery options for unified summary delivery
 */
interface DeliveryOptions {
  userId: number | string;
  summary: string;
  user: UserConfig;
  platform?: DeliveryPlatform;
  dateHeader?: string;
  waButtonPayload?: string;
  otherEvents?: CalendarEvent[];
  /** When set, the TG text branch finalizes this draft handle instead of opening a fresh sendMessage. WA delivery ignores it. */
  streamHandle?: StreamMessageHandle;
  /** Set for the tomorrow summary, unset for today's: the voice show must know which day it covers. */
  summaryDate?: Date;
}

/**
 * Unified summary delivery pipeline
 * Handles both user-invoked and scheduled summary delivery
 * Respects user text/voice preferences
 */
async function deliverSummary(options: DeliveryOptions): Promise<void> {
  const t0 = Date.now();
  const {
    userId,
    summary,
    user,
    platform,
    dateHeader,
    waButtonPayload,
    streamHandle,
    summaryDate
  } = options;

  // Use correct messaging service based on delivery platform
  const targetPlatform = platform || user.messagingPlatform || 'telegram';
  const msgService = (targetPlatform === 'whatsapp' && getWhatsAppChatId(user))
    ? getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP)
    : getMessagingService();

  // Check for empty summary
  if (!summary || summary.trim() === '') {
    captureError(
      new Error('AI returned empty summary'),
      'summary-generation',
      { user_id: userId, service: 'deliverSummary' }
    );
    const t = await getBotMessages(user.language || 'en');
    const errorText = t.errors?.summaryGenerationFailed || 'Sorry, could not generate summary. Please try again.';
    if (streamHandle) {
      await streamHandle.cancel(errorText, { format: MessageFormat.HTML });
    } else {
      await msgService.sendMessage(userId, errorText, { format: MessageFormat.HTML });
    }
    return;
  }

  const sendText = user.textSummaryEnabled !== false;
  const sendVoiceEnabled = user.voiceSummaryEnabled !== false;

  if (!sendText && !sendVoiceEnabled) {
    return;
  }

  // Check near-limit warning for text summaries
  const tFeatureCheck = Date.now();
  let summaryWithWarning = summary;
  try {
    const textAccess = await checkFeatureAccess(user.id, 'text_summary');
    if (textAccess.limit && textAccess.limit !== Infinity && textAccess.currentUsage !== undefined) {
      const usageRatio = textAccess.currentUsage / textAccess.limit;
      if (usageRatio >= 0.7 && textAccess.remaining !== undefined && textAccess.remaining > 0) {
        const t = await getBotMessages(user.language || 'en');
        const warningText = (t.subscription?.nearLimit?.text || '({remaining} of {limit} summaries remaining this month)')
          .replace('{remaining}', String(textAccess.remaining))
          .replace('{limit}', String(textAccess.limit));
        summaryWithWarning = `${summary}\n\n<i>${warningText}</i>`;
      }
    }
  } catch {
    // Non-critical, continue without warning
  }
  const featureCheckMs = Date.now() - tFeatureCheck;

  // Handle text delivery
  const tTextDelivery = Date.now();
  if (sendText) {
    await routeTextMessage(userId, summaryWithWarning, user, platform, !!waButtonPayload, waButtonPayload, streamHandle);

    trackActivityAsync(user.id, 'text_summary_generated', {
      word_count: summary.split(/\s+/).length,
    });
    incrementUsage(user.id, 'textSummaries').catch(err => {
      console.error('[Subscription] Failed to increment text usage:', err);
      captureError(err, 'summary-increment-text-usage', { user_id: user.id }, 'warning');
    });
  }
  const textDeliveryMs = Date.now() - tTextDelivery;

  // Handle voice delivery
  let voiceDispatchMs = 0;
  if (sendVoiceEnabled) {
    const voiceAccess = await checkFeatureAccess(user.id, 'voice_summary');
    if (!voiceAccess.allowed) {
      console.log(`[Delivery Timing] user=${userId} total=${Date.now() - t0}ms featureCheck=${featureCheckMs}ms textDelivery=${textDeliveryMs}ms voiceDispatch=0ms`);
      return;
    }

    trackActivityAsync(user.id, 'voice_summary_requested', {
      language: user.language,
    });

    if (!sendText && dateHeader) {
      await routeTextMessage(userId, dateHeader, user, platform, !!waButtonPayload);
    }

    const tVoice = Date.now();
    const voiceKind = summaryDate ? 'tomorrow' : 'daily';
    // Send voice to Telegram if applicable
    if ((targetPlatform === 'telegram' || targetPlatform === 'all') && user.telegramId) {
      sendVoiceMessage(user.telegramId, summary, user, undefined, true, MessagingPlatform.TELEGRAM, undefined, voiceKind).catch(err => {
        console.error(`[Delivery] Voice generation failed for TG user ${user.id}:`, err);
        captureError(err, 'summary-voice-telegram', { user_id: user.id }, 'warning');
      });
    }
    // Send voice to WhatsApp only for user-invoked sends (within 24h window)
    if (!waButtonPayload && (targetPlatform === 'whatsapp' || targetPlatform === 'all') && getWhatsAppChatId(user)) {
      sendVoiceMessage(getWhatsAppChatId(user)!, summary, user, undefined, true, MessagingPlatform.WHATSAPP, undefined, voiceKind).catch(err => {
        console.error(`[Delivery] Voice generation failed for WA user ${user.id}:`, err);
        captureError(err, 'summary-voice-whatsapp', { user_id: user.id }, 'warning');
      });
    }
    voiceDispatchMs = Date.now() - tVoice;
  }

  console.log(`[Delivery Timing] user=${userId} total=${Date.now() - t0}ms featureCheck=${featureCheckMs}ms textDelivery=${textDeliveryMs}ms voiceDispatch=${voiceDispatchMs}ms`);

  // Kid name detection follow-up (non-blocking, TG only)
  if ((targetPlatform === 'telegram' || targetPlatform === 'all') && user.telegramId && options.otherEvents?.length) {
    import('../kid-name-detection').then(({ sendKidNameFollowUp }) =>
      sendKidNameFollowUp(user.telegramId!, user, options.otherEvents!)
    ).catch(err => {
      console.error(`[KidName] Follow-up failed for user ${user.id}:`, err);
    });
  }
}
