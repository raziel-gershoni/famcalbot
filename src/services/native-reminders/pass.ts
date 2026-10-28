// The native reminder pass (spec §4): find the reminder occurrences due now, claim each
// one for each person it is for (one person, or both partners), and ping them with ✅ Done
// and 💤 Snooze.
//
// A 1-minute cron runs it behind an in-process gate (due-gate.ts), so the database is
// read only when something may be due; the pass's nextDue says when that is. Due times
// are worked out here rather than in SQL: a date-only reminder pings at 09:00 in the
// recipient's timezone, which the query can't know, so it fetches a wide window.

import type { NativeEvent, NativeEventInstance, NativeReminderPing, NativeReminderState, Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { captureError } from '../../lib/error-capture';
import { describeDeliveryError } from '../../lib/delivery-errors';
import { markUnreachableAfterSendFailure } from '../../lib/user-reachability';
import { isIdentifierBlocked } from '../../lib/user-moderation';
import { resolveUserTimezone } from '../../lib/timezone';
import { isPaused } from '../zmanim/pause';
import { trackActivityAsync } from '../analytics-service';
import { expandSeries, VirtualInstance } from '../native-calendar/recurrence';
import { getActivePartnerSummary, isForBothReachable, isPingable, recipientIds, userDoneAt } from './ownership';
import { getReminderSupport, isNativeRemindersEnabled } from './support';
import { dueAtForOccurrence, isEligible, pingDayOf, MAX_PING_ATTEMPTS, PING_LOOKBACK_MS } from './due';
import { Claim, claimOccurrence, releaseClaim, undoClaim } from './claim';
import { buildDoneText, buildPingKeyboard, buildPingText, refreshPing, sendPing, stripPingButtons } from './ping';

const HOUR_MS = 60 * 60 * 1000;
// The window occurrences are expanded over. A date-only reminder pings at the recipient's
// reminder time (00:00 to 23:45) in their timezone on its date in the event's timezone:
// up to about 50 hours after that date begins (reminder time 23:45, an event at UTC+14, a
// recipient at UTC-12) or 26 hours before it (reminder time 00:00, the same zones apart).
const WINDOW_BACK_MS = 60 * HOUR_MS;
const WINDOW_AHEAD_MS = 30 * HOUR_MS;
// After a send fails for a passing reason, or a database blip cuts a series short, look
// again on the next tick.
const RETRY_AFTER_MS = 60 * 1000;

const USER_SELECT = {
  id: true,
  name: true,
  language: true,
  telegramId: true,
  location: true,
  reminderTime: true,
  pairingId: true,
  suspendedAt: true,
  unreachableSince: true,
  // The Shabbat and Yom Tov pause (isPaused): the switch, and the place and community its windows are counted at
  pauseOnShabbat: true,
  zmanimCommunity: true,
  latitude: true,
  longitude: true,
  elevationM: true,
} as const;
type PassUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/** One occurrence the pass may ping, with its due time and state. */
interface Candidate {
  occ: VirtualInstance;
  due: Date;
  snoozed: boolean;
  state: StateRow | undefined;
  /** This recipient's own ping of the occurrence: their snooze and last ping. */
  ping: NativeReminderPing | undefined;
}

type StateRow = NativeReminderState & { pings: NativeReminderPing[] };

type SendOutcome = 'sent' | 'lost' | 'raced' | 'retry' | 'failed';

export interface NativeReminderPassResult {
  sent: number;
  skipped: number;
  failed: number;
  nextDue: Date | null;
}

const occurrenceKey = (seriesEventId: string, originalStartsAt: Date) => `${seriesEventId}|${originalStartsAt.getTime()}`;

/** Load each key once per pass. */
function perPass<K, V>(load: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = load(key);
      cache.set(key, hit);
    }
    return hit;
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const group = out.get(keyOf(item));
    if (group) group.push(item);
    else out.set(keyOf(item), [item]);
  }
  return out;
}

/**
 * Reminder series that may have an occurrence due in the window: one-offs starting in
 * it, every repeating series that has begun by its end or has an occurrence moved to
 * before its end, and any series with an undone snooze waking in it, whenever its
 * occurrence was.
 */
async function loadCandidateSeries(now: Date, range: { from: Date; to: Date }) {
  const snoozeRows = await prisma.nativeReminderPing.findMany({
    // A person who has marked their own Done has nothing waking, but only while "each of us marks it done" is on
    // (with it off a leftover per-person Done is never read: ownership.userDoneAt).
    where: {
      snoozedUntil: { gte: new Date(now.getTime() - PING_LOOKBACK_MS), lt: range.to },
      state: { doneAt: null },
      OR: [{ doneAt: null }, { state: { seriesEvent: { eachMarksDone: false } } }],
    },
    select: { state: { select: { seriesEventId: true, originalStartsAt: true } } },
  });
  // Two recipients may have snoozed the same occurrence: one key.
  const snoozes = [...new Map(snoozeRows.map((r) => [occurrenceKey(r.state.seriesEventId, r.state.originalStartsAt), r.state])).values()];
  const snoozedSeriesIds = [...new Set(snoozes.map((s) => s.seriesEventId))];
  const series = await prisma.nativeEvent.findMany({
    where: {
      kind: 'REMINDER',
      isDeleted: false,
      calendar: { isDeleted: false },
      OR: [
        { rrule: null, startsAt: { gte: range.from, lt: range.to } },
        { rrule: { not: null }, startsAt: { lt: range.to } },
        // A first occurrence moved earlier than the series start: the series row keeps
        // its own start, so only the moved instance says it is due.
        { rrule: { not: null }, instances: { some: { status: 'OVERRIDE', startsAt: { lt: range.to } } } },
        ...(snoozedSeriesIds.length ? [{ id: { in: snoozedSeriesIds } }] : []),
      ],
    },
  });
  const overrides = series.length
    ? await prisma.nativeEventInstance.findMany({ where: { seriesEventId: { in: series.map((s) => s.id) } } })
    : [];
  return {
    series,
    overridesBySeries: groupBy(overrides, (o) => o.seriesEventId),
    snoozedKeysBySeries: groupBy(snoozes, (s) => s.seriesEventId),
  };
}

/**
 * A series' occurrences in the window, plus each snoozed one from outside it. Every
 * occurrence comes from expandSeries, so its key (instanceStartsAt) is the same one the
 * digests and the buttons use; exdated and cancelled occurrences never come back.
 */
function occurrencesOf(
  series: NativeEvent,
  overrides: NativeEventInstance[],
  range: { from: Date; to: Date },
  snoozedKeys: Date[]
): VirtualInstance[] {
  const occurrences = expandSeries(series, range, overrides);
  const seen = new Set(occurrences.map((o) => o.instanceStartsAt.getTime()));
  for (const key of snoozedKeys) {
    if (seen.has(key.getTime())) continue;
    // Expand just the stretch from the key to wherever an override moved it.
    const moved = overrides.find((o) => o.originalStartsAt.getTime() === key.getTime())?.startsAt ?? key;
    const around = {
      from: new Date(Math.min(key.getTime(), moved.getTime())),
      to: new Date(Math.max(key.getTime(), moved.getTime()) + 1),
    };
    const found = expandSeries(series, around, overrides).find((o) => o.instanceStartsAt.getTime() === key.getTime());
    if (found) {
      occurrences.push(found);
      seen.add(key.getTime());
    }
  }
  return occurrences;
}

/**
 * When this occurrence's time was last set: a moved occurrence when its override was
 * written, any other with its series.
 */
function armedAtOf(series: NativeEvent, occ: VirtualInstance, override: NativeEventInstance | undefined): Date | null {
  const moved = occ.startsAt.getTime() !== occ.instanceStartsAt.getTime() || occ.allDay !== series.allDay;
  return moved && override ? override.updatedAt : series.armedAt;
}

/** A send that may work on a later tick: Telegram's 429 and 5xx, or no answer at all. */
function isPassingFailure(error: unknown): boolean {
  const response = (error as { response?: { statusCode?: number; body?: { error_code?: number } } } | null)?.response;
  const status = response?.body?.error_code ?? response?.statusCode;
  return status === undefined || status === 429 || status >= 500;
}

/**
 * Whether the series changed since the pass read it: deleted, for someone else (or for both), or edited
 * at all (its updatedAt). A recipient change keeps the occurrence's key, so a claim made on
 * the old read would ping the old person and leave the new one silent (3b spec §3.1).
 */
async function changedSinceRead(series: NativeEvent): Promise<boolean> {
  const now = await prisma.nativeEvent.findUnique({
    where: { id: series.id },
    select: { forUserId: true, forBoth: true, isDeleted: true, updatedAt: true },
  });
  return !now || now.isDeleted || now.forUserId !== series.forUserId || now.forBoth !== series.forBoth || now.updatedAt.getTime() !== series.updatedAt.getTime();
}

/** Claim one occurrence for one recipient and send their ping. */
async function pingOccurrence(
  series: NativeEvent,
  candidate: Candidate,
  creator: PassUser,
  recipient: PassUser & { telegramId: bigint },
  peers: PassUser[],
  forBoth: boolean,
  now: Date
): Promise<SendOutcome> {
  const claim = await claimOccurrence(series.id, candidate.occ.instanceStartsAt, recipient.id, candidate.due, now);
  if (!claim) return 'lost'; // another pass sent it, or it was just marked done
  if (await changedSinceRead(series)) {
    // An edit landed between the read and the claim: give the claim back, and the next
    // tick reads the series as it is now.
    console.log(`[NativeReminders] Series ${series.id} changed during the pass; pinging on the next tick`);
    await undoClaim(claim);
    return 'raced';
  }

  // Each marks their own Done: the partner who already has is named on the ping.
  const doneBy = series.eachMarksDone ? peers.find((p) => candidate.state?.pings.some((x) => x.userId === p.id && x.doneAt)) : undefined;
  let messageId: number;
  try {
    const text = await buildPingText({
      title: candidate.occ.title,
      creatorName: creator.id === recipient.id ? undefined : creator.name,
      forBoth,
      ...(doneBy ? { partnerDoneName: doneBy.name } : {}),
      language: recipient.language,
    });
    messageId = await sendPing(recipient.telegramId, text, await buildPingKeyboard(claim.stateId, recipient.language));
  } catch (error) {
    return handleSendFailure(error, claim, recipient, series.id);
  }

  try {
    const saved = await prisma.nativeReminderPing.update({
      where: { id: claim.id },
      data: { pingChatId: recipient.telegramId, pingMessageId: messageId },
      select: { state: { select: { doneAt: true, doneByUserId: true, doneBy: { select: { name: true } } } } },
    });
    // An in-app done between the claim and this save found no message to edit: close it here.
    if (saved.state.doneAt) {
      // Where each marks their own Done nobody is "done by" another: it reads the plain done.
      const byOther = forBoth && !series.eachMarksDone && saved.state.doneByUserId !== recipient.id;
      const done = await buildDoneText({ title: candidate.occ.title, doneByName: byOther ? saved.state.doneBy?.name : undefined, language: recipient.language });
      await stripPingButtons(recipient.telegramId, messageId, done);
    } else if (series.eachMarksDone) {
      await settleLateOwnDone(candidate, creator, recipient, peers, forBoth, claim.stateId, messageId, doneBy);
    }
  } catch (error) {
    // The ping went out; only a later edit to it (on a move) is lost.
    console.warn(`[NativeReminders] Saving the ping of user ${recipient.id} (series ${series.id}, state ${claim.stateId}) failed`);
    captureError(error, 'native-reminders-save-ping', { user_id: recipient.id, series_id: series.id, state_id: claim.stateId }, 'warning');
  }
  trackActivityAsync(recipient.id, 'native_reminder_pinged', {
    for_partner: creator.id !== recipient.id,
    ...(forBoth ? { for_both: true } : {}),
    snoozed: candidate.snoozed,
    all_day: candidate.occ.allDay,
  });
  return 'sent';
}

/**
 * Where each marks their own Done: a Done made between this ping's claim and its save found no message
 * to edit. The person's own closes the ping ("✅ title"); a partner's is added to it, with its buttons,
 * unless the ping was built already saying so (`shown`).
 */
async function settleLateOwnDone(
  candidate: Candidate,
  creator: PassUser,
  recipient: PassUser & { telegramId: bigint },
  peers: PassUser[],
  forBoth: boolean,
  stateId: string,
  messageId: number,
  shown: PassUser | undefined
): Promise<void> {
  const done = new Set((await prisma.nativeReminderPing.findMany({ where: { stateId, doneAt: { not: null } }, select: { userId: true } })).map((p) => p.userId));
  if (done.has(recipient.id)) {
    await stripPingButtons(recipient.telegramId, messageId, await buildDoneText({ title: candidate.occ.title, language: recipient.language }));
    return;
  }
  const partner = peers.find((p) => done.has(p.id));
  if (!partner || partner.id === shown?.id) return;
  const text = await buildPingText({
    title: candidate.occ.title,
    creatorName: creator.id === recipient.id ? undefined : creator.name,
    forBoth,
    partnerDoneName: partner.name,
    language: recipient.language,
  });
  await refreshPing(recipient.telegramId, messageId, text, await buildPingKeyboard(stateId, recipient.language));
}

/**
 * A chat that refuses us for good marks the user unreachable. A passing failure gives
 * the claim back for a later pass, up to MAX_PING_ATTEMPTS sends. Anything else keeps
 * the claim: a retry would be refused the same way.
 */
async function handleSendFailure(error: unknown, claim: Claim, recipient: PassUser, seriesId: string): Promise<SendOutcome> {
  if (await markUnreachableAfterSendFailure(recipient, error)) return 'failed';
  if (isPassingFailure(error) && claim.pingAttempts < MAX_PING_ATTEMPTS) {
    console.warn(`[NativeReminders] Ping to user ${recipient.id} for series ${seriesId}, state ${claim.stateId} failed (attempt ${claim.pingAttempts}), retrying: ${describeDeliveryError(error)}`);
    await releaseClaim(claim);
    return 'retry';
  }
  console.error(`[NativeReminders] Ping to user ${recipient.id} for series ${seriesId}, state ${claim.stateId} failed for good (attempt ${claim.pingAttempts}): ${describeDeliveryError(error)}`);
  captureError(error, 'native-reminders-send', { user_id: recipient.id, series_id: seriesId, state_id: claim.stateId, attempts: claim.pingAttempts });
  return 'failed';
}

/**
 * One recipient's share of a series: work out their due times and ping the newest due
 * occurrence. Resolves to 'retry' when a tick soon should look at this series again.
 */
async function passForRecipient(a: {
  series: NativeEvent;
  occurrences: VirtualInstance[];
  overrideAt: Map<number, NativeEventInstance>;
  states: Map<string, StateRow>;
  creator: PassUser;
  recipient: PassUser;
  /** The other people it is for (a reminder for both partners): who may already have marked their own Done. */
  peers: PassUser[];
  forBoth: boolean;
  now: Date;
  result: NativeReminderPassResult;
  tz: string;
  reachable: (telegramId: bigint) => Promise<boolean>;
}): Promise<SendOutcome | 'idle'> {
  const { series: s, recipient, now, result, tz } = a;
  const candidates: Candidate[] = [];
  for (const occ of a.occurrences) {
    const state = a.states.get(occurrenceKey(s.id, occ.instanceStartsAt));
    // Done for them: the shared Done, or (each marks their own) theirs. A done person is skipped even when they had snoozed.
    if (userDoneAt(s, state, recipient.id)) continue;
    const ping = state?.pings.find((p) => p.userId === recipient.id);
    const snoozed = !!ping?.snoozedUntil;
    const due = ping?.snoozedUntil ?? dueAtForOccurrence(occ, tz, recipient.reminderTime);
    if (due > now && (!result.nextDue || due < result.nextDue)) result.nextDue = due;
    candidates.push({ occ, due, snoozed, state, ping });
  }

  const eligible = candidates.filter((c) =>
    isEligible({
      due: c.due,
      now,
      armedAt: armedAtOf(s, c.occ, a.overrideAt.get(c.occ.instanceStartsAt.getTime())),
      snoozed: c.snoozed,
      dateOnlyDay: c.occ.allDay ? pingDayOf(c.due, tz) : null,
      lastPingedAt: c.ping?.lastPingedAt ?? null,
      doneAt: c.state?.doneAt ?? null,
    })
  );
  if (eligible.length === 0) return 'idle';

  const telegramId = recipient.telegramId;
  const reachable = telegramId != null && !recipient.suspendedAt && !recipient.unreachableSince && (await a.reachable(telegramId));
  if (!reachable) {
    result.skipped += eligible.length;
    return 'idle';
  }

  // Shabbat and Yom Tov (the pause): nothing is sent to this person now. Each eligible occurrence is claimed as if
  // it had pinged, with no message, so it is not sent after the window ends (a date-only one is eligible all its
  // day) and stays open: undone, carried by the next summary as any unanswered ping is.
  if (await isPaused(recipient, now, 'native reminder ping')) {
    for (const c of eligible) await claimOccurrence(s.id, c.occ.instanceStartsAt, recipient.id, c.due, now);
    result.skipped += eligible.length;
    return 'idle';
  }

  // One live ping per series and recipient: the newest due goes out. Older ones (a daily
  // reminder snoozed into the next day's) are claimed without a send, so they stay quiet.
  eligible.sort((x, y) => y.due.getTime() - x.due.getTime() || y.occ.instanceStartsAt.getTime() - x.occ.instanceStartsAt.getTime());
  const [newest, ...older] = eligible;
  for (const old of older) {
    await claimOccurrence(s.id, old.occ.instanceStartsAt, recipient.id, old.due, now);
    result.skipped++;
  }

  const outcome = await pingOccurrence(s, newest, a.creator, { ...recipient, telegramId }, a.peers, a.forBoth, now);
  if (outcome === 'sent') result.sent++;
  else if (outcome === 'lost' || outcome === 'raced') result.skipped++;
  else result.failed++;
  return outcome === 'retry' || outcome === 'raced' ? 'retry' : outcome;
}

/**
 * Ping every reminder occurrence due now. Resolves to what it did and the earliest due
 * time still ahead (null when none is in the window), for the gate.
 */
export async function runNativeReminderPass(now: Date = new Date()): Promise<NativeReminderPassResult> {
  const result: NativeReminderPassResult = { sent: 0, skipped: 0, failed: 0, nextDue: null };
  if (!(await isNativeRemindersEnabled())) return result;

  const range = { from: new Date(now.getTime() - WINDOW_BACK_MS), to: new Date(now.getTime() + WINDOW_AHEAD_MS) };
  const { series, overridesBySeries, snoozedKeysBySeries } = await loadCandidateSeries(now, range);
  if (series.length === 0) return result;

  const expanded = series.flatMap((s) => {
    const overrides = overridesBySeries.get(s.id) ?? [];
    const snoozedKeys = (snoozedKeysBySeries.get(s.id) ?? []).map((k) => k.originalStartsAt);
    try {
      return [{ series: s, overrides, occurrences: occurrencesOf(s, overrides, range, snoozedKeys) }];
    } catch (error) {
      // A rule that can't be read fails the same way every time: report it, ping the rest.
      captureError(error, 'native-reminders-series', { series_id: s.id });
      result.failed++;
      return [];
    }
  });

  const keys = expanded.flatMap((e) => e.occurrences.map((o) => o.instanceStartsAt));
  const stateRows = keys.length
    ? await prisma.nativeReminderState.findMany({
        include: { pings: true },
        where: {
          seriesEventId: { in: expanded.map((e) => e.series.id) },
          originalStartsAt: { in: [...new Map(keys.map((k) => [k.getTime(), k])).values()] },
        },
      })
    : [];
  const states = new Map(stateRows.map((r) => [occurrenceKey(r.seriesEventId, r.originalStartsAt), r]));

  const users = perPass((id: number) => prisma.user.findUnique({ where: { id }, select: USER_SELECT }));
  const partnerOf = perPass(async (creatorId: number) => {
    const creator = await users(creatorId);
    return creator ? getActivePartnerSummary(creator.id, creator.pairingId) : null;
  });
  const timezoneOf = perPass(async (userId: number) => {
    const user = await users(userId);
    return resolveUserTimezone({ id: userId, location: user?.location ?? '' });
  });
  const isBlocked = perPass((telegramId: bigint) => isIdentifierBlocked({ telegramId }));
  const creatorSupported = perPass(async (creatorId: number) => {
    const creator = await users(creatorId);
    return !!creator && (await getReminderSupport(creator)).supported;
  });

  let retrySoon = false;
  for (const { series: s, overrides, occurrences } of expanded) {
    if (occurrences.length === 0) continue;
    try {
      const creator = await users(s.creatorUserId);
      if (!creator) continue;
      // Everyone it is for: one person, or both partners (ownership.ts, the one rule).
      const ids = recipientIds(s, await partnerOf(creator.id));
      // Pings follow the recipients who can be reached: with one of two out of reach it is, for the
      // ping text, the other's alone (no "for both of you"), as a reminder of the creator's.
      let reachableCount = 0;
      for (const id of ids) {
        const u = await users(id);
        if (u && isPingable(u) && !(await isBlocked(u.telegramId!))) reachableCount++;
      }
      const forBoth = isForBothReachable(reachableCount);
      const overrideAt = new Map(overrides.map((o) => [o.originalStartsAt.getTime(), o]));
      for (const recipientId of ids) {
        try {
          const recipient = recipientId === creator.id ? creator : await users(recipientId);
          if (!recipient) continue;
          const peers = (await Promise.all(ids.filter((id) => id !== recipientId).map((id) => users(id)))).filter((u): u is PassUser => !!u);
          const outcome = await passForRecipient({
            series: s, occurrences, overrideAt, states, creator, recipient, peers, forBoth, now, result,
            tz: await timezoneOf(recipient.id),
            reachable: async (telegramId) => !(await isBlocked(telegramId)) && (await creatorSupported(creator.id)),
          });
          if (outcome === 'retry') retrySoon = true;
        } catch (error) {
          // One recipient's trouble (a database blip) never stops the other's ping or the other series.
          console.error(`[NativeReminders] Pass failed for series ${s.id}, recipient ${recipientId}`);
          captureError(error, 'native-reminders-series', { series_id: s.id, user_id: recipientId });
          result.failed++;
          retrySoon = true;
        }
      }
    } catch (error) {
      // A database blip on one series mustn't stop the others; the next tick tries it again.
      captureError(error, 'native-reminders-series', { series_id: s.id });
      result.failed++;
      retrySoon = true;
    }
  }

  if (retrySoon) {
    const retryAt = new Date(now.getTime() + RETRY_AFTER_MS);
    if (!result.nextDue || retryAt < result.nextDue) result.nextDue = retryAt;
  }
  return result;
}
