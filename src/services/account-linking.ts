/**
 * Account Linking Service
 * Links Telegram and WhatsApp accounts via short-lived link codes.
 *
 * Flow:
 * 1. Telegram user sends /connect → generateLinkCode() → gets 6-char code
 * 2. User sends "link CODE" on WhatsApp → redeemLinkCode() → accounts merged
 */

import { Prisma } from '@prisma/client';
import type { NativeCalendar, Subscription, User, UserFeatureOverride } from '@prisma/client';
import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { prisma } from '../utils/prisma';
import { getUserById, getUserByTelegramId } from './user-service';
import { convertPrismaUserToConfig, UserConfig } from '../types';
import { invalidateFeatureAccessCache } from './subscription-service';
import { removeUserFromCache, updateUserInCache } from './reminder-cache';
import { invalidateDueGate } from './native-reminders/due-gate';
import { clearDeletedUserCaches } from '../lib/user-moderation';

const LINK_CODE_TTL = 300; // 5 minutes

interface LinkCodeData {
  telegramId: number;
}

/**
 * Generate a 6-character uppercase link code for a Telegram user
 * Stores in Redis with 5-minute TTL. Calling again invalidates the previous code.
 */
export async function generateLinkCode(telegramId: number): Promise<string> {
  // Generate 6-char uppercase alphanumeric code
  const code = Array.from({ length: 6 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');

  const data: LinkCodeData = { telegramId };

  // Store code → telegramId mapping
  await redis.set(
    REDIS_KEYS.linkCode(code),
    JSON.stringify(data),
    { ex: LINK_CODE_TTL }
  );

  // Store reverse mapping (invalidates previous code for this user)
  await redis.set(
    REDIS_KEYS.linkUser(telegramId),
    code,
    { ex: LINK_CODE_TTL }
  );

  return code;
}

export interface LinkResult {
  success: boolean;
  error?: 'invalid_or_expired' | 'telegram_user_not_found' | 'already_linked' | 'phone_in_use' | 'unknown';
  user?: UserConfig;
  /** The WhatsApp account's Google connection did not move (the Telegram account is paired or has its own): reconnect it from the dashboard */
  reconnectGoogle?: boolean;
}

/**
 * A subscription's kind, then when the access it gives runs out (epoch ms), by
 * the rules in subscription-service: a comp never runs out (no period end, the
 * expiry cron skips it), a paid plan (ACTIVE, or CANCELED until the period ends)
 * at currentPeriodEnd, a trial at trialEndsAt, and EXPIRED already has.
 */
function accessRank(sub: Subscription): [kind: number, endsAt: number] {
  if (sub.status === 'EXPIRED') return [0, 0];
  if (sub.compedBy != null) return [3, 0];
  if (sub.status === 'TRIALING') return [1, sub.trialEndsAt.getTime()];
  return sub.plan !== 'FREE' && sub.currentPeriodEnd ? [2, sub.currentPeriodEnd.getTime()] : [0, 0];
}

/**
 * Whether subscription a runs longer than b. Kind first: a paid row beats a trial
 * that ends later, since it carries the plan a renewal keeps (renewSubscription
 * leaves plan as it is, and an old renew invoice can still be paid). Within a
 * kind, the later end wins.
 */
function runsLonger(a: Subscription, b: Subscription): boolean {
  const [aKind, aEnds] = accessRank(a);
  const [bKind, bEnds] = accessRank(b);
  return aKind !== bKind ? aKind > bKind : aEnds > bEnds;
}

/**
 * W's profile and setup, as a new account starts them (the schema defaults, and what
 * getOrCreateUser sets). T takes W's value for each field where T's is still the starting
 * one, so a T that /start connect made seconds ago ends up with W's setup and an
 * established T keeps what it chose. Name (getOrCreateUser's 'User'), location with
 * locationForced, and language have their own rules (setupFromW).
 * Never copied: ids and bookkeeping (id, telegramId, createdAt, updatedAt,
 * reminderStartAt), admin and moderation state (isAdmin, suspendedAt/By/Reason) and
 * Telegram delivery state (unreachableSince). Set by the merge itself: the WhatsApp ids,
 * messagingPlatform, pairingId, and the calendar setup (calendarSource,
 * googleRefreshToken, calendarAssignments). There is no timezone column: it is resolved
 * from location.
 */
const NEW_ACCOUNT = {
  englishName: '', gender: 'male', culture: 'default', globalRules: [] as string[],
  textSummaryEnabled: true, voiceSummaryEnabled: true, voiceInputEnabled: false, voicePreference: 'default',
  voiceStyle: 'natural', weatherEnabled: true, includeWeeklyInLookahead: false, includeLookaheadInTomorrow: false,
  lookaheadAlways7Days: false, preferredMorningHour: 7, preferredEveningHour: 19,
  dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6],
  remindersEnabled: false, defaultReminderMinutes: null as number | null, pickupRemindersEnabled: true,
} satisfies Partial<User>;
type SetupField = keyof typeof NEW_ACCOUNT | 'name' | 'location' | 'locationForced' | 'language';

/** A Telegram account this young was made by the /start connect that sent the link code. */
const FRESH_ACCOUNT_MS = 24 * 60 * 60 * 1000;

/** The setup fields T takes from W (see NEW_ACCOUNT). */
function setupFromW(w: User, t: User): Partial<Pick<User, SetupField>> {
  const data: Partial<Record<SetupField, unknown>> = {};
  for (const field of Object.keys(NEW_ACCOUNT) as (keyof typeof NEW_ACCOUNT)[]) {
    const start = NEW_ACCOUNT[field];
    if (t[field] == null || JSON.stringify(t[field]) === JSON.stringify(start)) data[field] = w[field];
  }
  if (!t.name.trim() || t.name === 'User') data.name = w.name;
  // The location and whether the user confirmed it go together.
  if (!t.location) {
    data.location = w.location;
    data.locationForced = w.locationForced;
  }
  // T's language is the Telegram client's; the user chose W's.
  if (Date.now() - t.createdAt.getTime() < FRESH_ACCOUNT_MS) data.language = w.language;
  return data as Partial<Pick<User, SetupField>>;
}

/** Override grants only ever grant: a grant set on either side survives, else T's value, else W's. */
function mergeOverrides(t: UserFeatureOverride, w: UserFeatureOverride) {
  const grant = (a: boolean | null, b: boolean | null) => (a === true || b === true ? true : a ?? b);
  return {
    unlimitedSummaries: grant(t.unlimitedSummaries, w.unlimitedSummaries),
    remindersEnabled: grant(t.remindersEnabled, w.remindersEnabled),
    voiceEventsEnabled: grant(t.voiceEventsEnabled, w.voiceEventsEnabled),
    unlimitedCalendars: grant(t.unlimitedCalendars, w.unlimitedCalendars),
    earlyAdopter: t.earlyAdopter || w.earlyAdopter,
    grantedBy: t.grantedBy ?? w.grantedBy,
    grantedAt: t.grantedAt ?? w.grantedAt,
    reason: t.reason ?? w.reason,
  };
}

/** Two default calendars (both primary), or two the user named alike, with the same privacy, are one calendar. */
function isSameCalendar(a: NativeCalendar, b: NativeCalendar): boolean {
  if (a.privacy !== b.privacy) return false;
  return a.name === b.name || (a.labels.includes('primary') && b.labels.includes('primary'));
}

/**
 * Fold the WhatsApp-only user W into the Telegram user T and delete W, inside
 * the caller's transaction. Everything W has moves to T, so the delete clears
 * the schema's ON DELETE RESTRICT relations (calendars, created events,
 * pairings, the per-user rows); T takes W's setup (setupFromW) and, when T can
 * take it, W's Google connection. A moved pairing shares T's calendars, as
 * accepting an invite does. Otherwise a moved calendar keeps its privacy (W's
 * go PRIVATE when W's pairing ends, by the merge or by P meanwhile) and a fold
 * needs the same privacy on both sides, so the merge shows nobody an event
 * their pairing did not share.
 * Returns T's pairingId after the merge, and whether W's Google connection
 * stayed behind.
 */
async function mergeWhatsAppUser(
  tx: Prisma.TransactionClient,
  waOnlyUserId: number,
  telegramUserId: number
): Promise<{ pairingId: string | null; reconnectGoogle: boolean }> {
  const w = await tx.user.findUniqueOrThrow({ where: { id: waOnlyUserId } });
  const t = await tx.user.findUniqueOrThrow({ where: { id: telegramUserId } });
  const tIsNative = t.calendarSource === 'NATIVE';

  // Pairing: only NATIVE users pair, one partner each. W's pairing moves to T
  // when T can take it; otherwise W is unpaired with unlink()'s writes. Each
  // step is a conditional write, as acceptInvite's are. Taking the pairing row
  // waits for an unlink of it in flight and re-checks it is still ACTIVE (count
  // 0: P unlinked after the read, so W is unpaired). T's write refuses a T that
  // accepted an invite or switched to Google after the read above.
  let pairingId = t.pairingId;
  let moved = false;
  const wPairing = w.pairingId ? await tx.pairing.findUnique({ where: { id: w.pairingId } }) : null;
  const wInvited = wPairing?.inviterUserId === w.id;
  const taken = wPairing?.status === 'ACTIVE' && (await tx.pairing.updateMany({
    where: { id: wPairing.id, status: 'ACTIVE', ...(wInvited ? { inviterUserId: w.id } : { inviteeUserId: w.id }) },
    data: wInvited ? { inviterUserId: t.id } : { inviteeUserId: t.id },
  })).count === 1;
  if (wPairing && taken) {
    moved = !t.pairingId && tIsNative && (await tx.user.updateMany({
      where: { id: t.id, pairingId: null, calendarSource: 'NATIVE' },
      data: { pairingId: wPairing.id },
    })).count === 1;
    if (moved) {
      pairingId = wPairing.id;
    } else {
      await tx.pairing.update({
        where: { id: wPairing.id },
        data: { status: 'UNLINKED', unlinkedAt: new Date(), unlinkedByUserId: w.id },
      });
      await tx.user.updateMany({ where: { pairingId: wPairing.id }, data: { pairingId: null } });
      // T's pairing as it is now: none if T and W were paired with each other.
      pairingId = (await tx.user.findUniqueOrThrow({ where: { id: t.id }, select: { pairingId: true } })).pairingId;
    }
  }
  // W's pairing history now names T too.
  await tx.pairing.updateMany({ where: { inviterUserId: w.id }, data: { inviterUserId: t.id } });
  await tx.pairing.updateMany({ where: { inviteeUserId: w.id }, data: { inviteeUserId: t.id } });
  await tx.pairing.updateMany({ where: { unlinkedByUserId: w.id }, data: { unlinkedByUserId: t.id } });
  await tx.pairingInvite.updateMany({ where: { acceptedByUserId: w.id }, data: { acceptedByUserId: t.id } });
  // W's own invites cascade with W.

  // A moved pairing shares T's calendars at the default permission, as
  // acceptInvite does, before the fold: T's primary and W's shared one are then
  // one calendar, so what 'primary' resolves to stays the couple's. A pairing
  // that was ACTIVE when read and did not move (the merge ended it, or P did
  // meanwhile) shared W's calendars with P only: they come over PRIVATE and
  // fold only into private ones, so nothing in them (P's events too) reaches
  // T's partner.
  if (moved) {
    await tx.nativeCalendar.updateMany({
      where: { ownerUserId: t.id, privacy: 'PRIVATE', isDeleted: false },
      data: { privacy: 'SHARED_EDITOR' },
    });
  } else if (wPairing?.status === 'ACTIVE') {
    await tx.nativeCalendar.updateMany({ where: { ownerUserId: w.id }, data: { privacy: 'PRIVATE' } });
  }

  // Calendars. W's default calendar folds into T's (they are named after each
  // profile, so the names rarely match); the rest move over, soft-deleted ones
  // too. T keeps one primary calendar. A Google user has no live native
  // calendars (oauth-callback soft-deletes them), so for one W's arrive deleted.
  if (tIsNative) {
    const live = (ownerUserId: number) =>
      tx.nativeCalendar.findMany({ where: { ownerUserId, isDeleted: false }, orderBy: { createdAt: 'asc' } });
    const tCalendars = await live(t.id);
    const wCalendars = await live(w.id);
    const folded = new Set<string>();
    let tHasPrimary = tCalendars.some(c => c.labels.includes('primary'));
    for (const wCalendar of wCalendars) {
      const into = tCalendars.find(c => !folded.has(c.id) && isSameCalendar(c, wCalendar));
      if (into) {
        folded.add(into.id);
        await tx.nativeEvent.updateMany({ where: { calendarId: wCalendar.id }, data: { calendarId: into.id } });
        await tx.nativeCalendar.delete({ where: { id: wCalendar.id } });
      } else if (wCalendar.labels.includes('primary')) {
        if (tHasPrimary) {
          await tx.nativeCalendar.update({
            where: { id: wCalendar.id },
            data: { labels: wCalendar.labels.filter(l => l !== 'primary') },
          });
        }
        tHasPrimary = true;
      }
    }
  }
  await tx.nativeCalendar.updateMany({
    where: { ownerUserId: w.id },
    data: { ownerUserId: t.id, ...(tIsNative ? {} : { isDeleted: true }) },
  });

  // Events and reminders W created, was reminded of, or marked done.
  await tx.nativeEvent.updateMany({ where: { creatorUserId: w.id }, data: { creatorUserId: t.id } });
  await tx.nativeEvent.updateMany({ where: { forUserId: w.id }, data: { forUserId: t.id } });
  await tx.nativeReminderState.updateMany({ where: { doneByUserId: w.id }, data: { doneByUserId: t.id } });

  // Subscription (userId is unique): the one that runs longer stays; a tie keeps T's.
  const tSub = await tx.subscription.findUnique({ where: { userId: t.id } });
  const wSub = await tx.subscription.findUnique({ where: { userId: w.id } });
  if (wSub && (!tSub || runsLonger(wSub, tSub))) {
    if (tSub) await tx.subscription.delete({ where: { id: tSub.id } });
    await tx.subscription.update({ where: { id: wSub.id }, data: { userId: t.id } });
  } else if (wSub) {
    await tx.subscription.delete({ where: { id: wSub.id } });
  }

  // Usage counter and override are one per user: T's stays, W's moves only into
  // a gap. With an override on both sides their grants merge (mergeOverrides).
  const tUsage = await tx.usageCounter.findUnique({ where: { userId: t.id } });
  if (tUsage) await tx.usageCounter.deleteMany({ where: { userId: w.id } });
  else await tx.usageCounter.updateMany({ where: { userId: w.id }, data: { userId: t.id } });

  const tOverride = await tx.userFeatureOverride.findUnique({ where: { userId: t.id } });
  const wOverride = await tx.userFeatureOverride.findUnique({ where: { userId: w.id } });
  if (wOverride && !tOverride) {
    await tx.userFeatureOverride.update({ where: { id: wOverride.id }, data: { userId: t.id } });
  } else if (wOverride && tOverride) {
    await tx.userFeatureOverride.update({ where: { id: tOverride.id }, data: mergeOverrides(tOverride, wOverride) });
    await tx.userFeatureOverride.delete({ where: { id: wOverride.id } });
  }

  await tx.userActivity.updateMany({ where: { userId: w.id }, data: { userId: t.id } });
  await tx.userFeedback.updateMany({ where: { userId: w.id }, data: { userId: t.id } });
  // A Google sign-in W left half-done is minutes old; it is restarted from T.
  await tx.oAuthState.deleteMany({ where: { userId: BigInt(w.id) } });

  // W's Google connection moves when T has none and is unpaired (only NATIVE
  // users pair): the stored token, still encrypted, and W's calendar choices.
  // T is then on Google, so its native calendars, W's moved ones included, are
  // soft-deleted as commitGoogleToken does (either/or per user). The write
  // re-checks both conditions, as the pairing move does. Otherwise T keeps its
  // setup, and the user is told to reconnect Google.
  let reconnectGoogle = false;
  if (w.calendarSource === 'GOOGLE' && w.googleRefreshToken) {
    const tookGoogle = !pairingId && !t.googleRefreshToken && (await tx.user.updateMany({
      where: { id: t.id, pairingId: null, googleRefreshToken: '' },
      data: {
        calendarSource: 'GOOGLE',
        googleRefreshToken: w.googleRefreshToken,
        calendarAssignments: w.calendarAssignments ?? Prisma.DbNull,
      },
    })).count === 1;
    if (tookGoogle) {
      await tx.nativeCalendar.updateMany({ where: { ownerUserId: t.id, isDeleted: false }, data: { isDeleted: true } });
    } else {
      reconnectGoogle = true;
    }
  }

  // W goes before T takes its WhatsApp ids: they are unique. W was found by the
  // id the link came from, so W's ids are the ones to take; a BSUID-only W has
  // no phone to give.
  await tx.user.delete({ where: { id: w.id } });
  await tx.user.update({
    where: { id: t.id },
    data: {
      ...setupFromW(w, t),
      whatsappPhone: w.whatsappPhone || null,
      whatsappBsuid: w.whatsappBsuid || null,
      messagingPlatform: 'all',
    },
  });

  return { pairingId, reconnectGoogle };
}

/**
 * After a merge commits: W's caches go, T's timezone is resolved again (from
 * the location T may have taken from W), T's reminder-cache entry is rebuilt
 * from T as it is now (the reminder run reads the pairing, calendar source,
 * token and language from there until the hourly sync), and the reminder pass
 * wakes for the reminders T took over. Best effort: the merge has already
 * happened. T's feature access is invalidated by the caller, as for a plain link.
 */
async function afterMerge(wUserId: number, tUserId: number): Promise<void> {
  await clearDeletedUserCaches(wUserId);
  invalidateDueGate();
  try {
    await redis.del(REDIS_KEYS.userTimezone(tUserId));
    const t = await getUserById(tUserId);
    if (!t) return;
    // Who belongs in the cache is the hourly sync's rule, as in the settings route.
    const remindable = t.remindersEnabled && t.telegramId !== null && !t.suspendedAt && !t.unreachableSince &&
      (!!t.googleRefreshToken || t.calendarSource === 'NATIVE');
    if (!remindable) {
      await removeUserFromCache(t.id);
      return;
    }
    await updateUserInCache({
      id: t.id,
      telegramId: t.telegramId?.toString() ?? '',
      googleRefreshToken: t.googleRefreshToken, // Decrypted by convertPrismaUserToConfig
      calendarAssignments: t.calendarAssignments,
      calendarSource: t.calendarSource,
      pairingId: t.pairingId,
      defaultReminderMinutes: t.defaultReminderMinutes ?? null,
      language: t.language,
      name: t.name,
      pickupRemindersEnabled: t.pickupRemindersEnabled ?? true,
      location: t.location,
    });
  } catch (err) {
    console.warn(`[AccountLink] Cache refresh after merging into ${tUserId} failed:`, err);
  }
}

/**
 * Redeem a link code to connect a WhatsApp phone to a Telegram account.
 * If a WA-only user exists with this phone, everything they have moves to the
 * Telegram user, their record is deleted, and the phone goes to the Telegram user.
 */
export async function redeemLinkCode(code: string, whatsappPhone: string): Promise<LinkResult> {
  // Look up code in Redis
  const raw = await redis.get<string>(REDIS_KEYS.linkCode(code));
  if (!raw) {
    return { success: false, error: 'invalid_or_expired' };
  }

  let data: LinkCodeData;
  try {
    // Upstash may return already-parsed object or raw string
    data = typeof raw === 'string' ? JSON.parse(raw) : raw as unknown as LinkCodeData;
  } catch {
    return { success: false, error: 'invalid_or_expired' };
  }

  // Look up Telegram user
  const telegramUser = await getUserByTelegramId(data.telegramId);
  if (!telegramUser) {
    return { success: false, error: 'telegram_user_not_found' };
  }

  // Check if TG user already has a WhatsApp phone
  if (telegramUser.whatsappPhone) {
    return { success: false, error: 'already_linked' };
  }

  try {
    // Check if a WA-only user exists with this phone, or with this BSUID when
    // WhatsApp sends one instead (a user known by username only)
    const isBsuid = !whatsappPhone.match(/^\+?\d+$/);
    const waOnlyUser = await prisma.user.findUnique({
      where: isBsuid ? { whatsappBsuid: whatsappPhone } : { whatsappPhone: whatsappPhone }
    });

    if (waOnlyUser && waOnlyUser.id !== telegramUser.id && waOnlyUser.telegramId !== null) {
      // The phone belongs to another Telegram account, not a WhatsApp-only one.
      return { success: false, error: 'phone_in_use' };
    }

    let reconnectGoogle = false;
    if (waOnlyUser && waOnlyUser.id !== telegramUser.id) {
      ({ reconnectGoogle } = await prisma.$transaction((tx) =>
        mergeWhatsAppUser(tx, waOnlyUser.id, telegramUser.id)
      ));
      await afterMerge(waOnlyUser.id, telegramUser.id);

      console.log(`[AccountLink] Merged WA-only user ${waOnlyUser.id} into TG user ${telegramUser.id}`);
    } else if (!waOnlyUser) {
      // No WA-only user — just update TG user
      await prisma.user.update({
        where: { id: telegramUser.id },
        data: {
          ...(isBsuid ? { whatsappBsuid: whatsappPhone } : { whatsappPhone: whatsappPhone }),
          messagingPlatform: 'all',
        },
      });

      console.log(`[AccountLink] Linked WhatsApp ${whatsappPhone} to TG user ${telegramUser.id}`);
    }
    // If waOnlyUser.id === telegramUser.id, the user is already linked (shouldn't happen)

    // Clean up Redis
    await redis.del(REDIS_KEYS.linkCode(code));
    await redis.del(REDIS_KEYS.linkUser(data.telegramId));

    // Invalidate feature access cache
    await invalidateFeatureAccessCache(telegramUser.id);

    // Return updated user
    const updatedUser = await prisma.user.findUnique({ where: { id: telegramUser.id } });
    return {
      success: true,
      user: updatedUser ? convertPrismaUserToConfig(updatedUser) : undefined,
      ...(reconnectGoogle ? { reconnectGoogle } : {}),
    };
  } catch (error) {
    console.error('[AccountLink] Error redeeming link code:', error);
    return { success: false, error: 'unknown' };
  }
}
