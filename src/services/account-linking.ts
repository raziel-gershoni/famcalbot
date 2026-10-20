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
import { setUserMenuButton } from './telegram/bot';
import { clearOtherPrimaries } from './calendar-provider/primary';
import { hasGoogleChoices } from './native-calendar/onboarding';
import { liveGoogleChoices } from '../lib/google-state';
import type { CalendarAssignment } from '../types';

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
  /** The WhatsApp account's Google connection did not move (the Telegram account is paired, has its own, or has its own calendar in use): reconnect it from the dashboard */
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
 * established T keeps what it chose. Name and language (Telegram's on a fresh T), and
 * location with locationForced, have their own rules (setupFromW).
 * Never copied: ids and bookkeeping (id, telegramId, createdAt, updatedAt,
 * reminderStartAt), admin and moderation state (isAdmin, suspendedAt/By/Reason) and
 * Telegram delivery state (unreachableSince). Set by the merge itself: the WhatsApp ids,
 * messagingPlatform, pairingId, and the Google connection (googleRefreshToken,
 * calendarAssignments; calendarSource is a legacy column the merge leaves). There is
 * no timezone column: it is resolved from location.
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
const isFresh = (t: User) => Date.now() - t.createdAt.getTime() < FRESH_ACCOUNT_MS;

/** The setup fields T takes from W (see NEW_ACCOUNT). */
function setupFromW(w: User, t: User): Partial<Pick<User, SetupField>> {
  const data: Partial<Record<SetupField, unknown>> = {};
  for (const field of Object.keys(NEW_ACCOUNT) as (keyof typeof NEW_ACCOUNT)[]) {
    const start = NEW_ACCOUNT[field];
    if (t[field] == null || JSON.stringify(t[field]) === JSON.stringify(start)) data[field] = w[field];
  }
  // A fresh T's name and language are Telegram's from seconds ago (the profile's,
  // the client's); the user chose W's. 'User' is getOrCreateUser's stand-in for
  // no name, so it never replaces one.
  const fresh = isFresh(t);
  const wNamed = !!w.name.trim() && w.name !== 'User';
  if ((fresh && wNamed) || !t.name.trim() || t.name === 'User') data.name = w.name;
  // The location and whether the user confirmed it go together.
  if (!t.location) {
    data.location = w.location;
    data.locationForced = w.locationForced;
  }
  if (fresh) data.language = w.language;
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

/**
 * A calendar's setup as it starts (the schema defaults). When W's calendar folds
 * into T's, T's row takes W's value of each field where T's is still the
 * starting one, and its labels where they are still the default calendar's
 * primary + yours, or none (ensurePrimaryNativeCalendar). The default calendar
 * is named after its owner, so a T calendar still named after T takes a name W
 * chose for W's (one that is not W's own name) and otherwise follows T's name
 * after the merge. T's 'primary' stays as it is. Privacy is not setup here: a
 * fold needs it equal.
 */
const NEW_CALENDAR = {
  color: '#039BE5', rules: [] as string[], personName: null as string | null,
  personEnglishName: null as string | null, personGender: null as string | null,
} satisfies Partial<NativeCalendar>;
type CalendarSetupField = keyof typeof NEW_CALENDAR | 'name' | 'labels';

/** The setup T's calendar takes from W's calendar folding into it (see NEW_CALENDAR). */
function calendarSetupFromW(
  from: NativeCalendar,
  into: NativeCalendar,
  names: { t: string; w: string; merged: string }
): Partial<Pick<NativeCalendar, CalendarSetupField>> {
  const data: Partial<Record<CalendarSetupField, unknown>> = {};
  for (const field of Object.keys(NEW_CALENDAR) as (keyof typeof NEW_CALENDAR)[]) {
    if (into[field] == null || JSON.stringify(into[field]) === JSON.stringify(NEW_CALENDAR[field])) data[field] = from[field];
  }
  if (into.name === names.t.trim()) data.name = from.name === names.w.trim() ? names.merged.trim() : from.name;
  const primary = into.labels.includes('primary');
  if (JSON.stringify(into.labels) === JSON.stringify(primary ? ['primary', 'yours'] : [])) {
    data.labels = [...(primary ? ['primary'] : []), ...from.labels.filter(l => l !== 'primary')];
  }
  return data as Partial<Pick<NativeCalendar, CalendarSetupField>>;
}

/** Two default calendars (both primary), or two the user named alike, with the same privacy, are one calendar. */
function isSameCalendar(a: NativeCalendar, b: NativeCalendar): boolean {
  if (a.privacy !== b.privacy) return false;
  return a.name === b.name || (a.labels.includes('primary') && b.labels.includes('primary'));
}

/** The Google choice labelled primary, if any. */
function googlePrimaryOf(assignments: unknown): string | undefined {
  return Array.isArray(assignments)
    ? (assignments as CalendarAssignment[]).find(a => Array.isArray(a?.labels) && a.labels.includes('primary'))?.calendarId
    : undefined;
}

/**
 * Fold the WhatsApp-only user W into the Telegram user T and delete W, inside
 * the caller's transaction. Everything W has moves to T, so the delete clears
 * the schema's ON DELETE RESTRICT relations (calendars, created events,
 * pairings, the per-user rows); T takes W's setup (setupFromW) and, when T has
 * none of its own, W's Google connection. T's primary calendar gives way to W's when
 * it holds no live events and T keeps no partner of its own, and otherwise
 * W's folds into it or comes over as another calendar. A moved pairing
 * shares T's own calendars, as accepting an invite does. Otherwise a moved
 * calendar keeps its privacy (W's go PRIVATE when W's pairing ends, by the
 * merge or by P meanwhile, and P's too when the merge ends it) and a fold
 * needs the same privacy on both sides, so the merge shows nobody an event
 * their pairing did not share. Anyone pairs and keeps FamCal beside Google ("Google
 * as a connection"), and T ends with one primary across both lists (T's own wins).
 * Returns T's pairingId after the merge, whether W's Google connection stayed
 * behind, and whether T's language changed.
 */
async function mergeWhatsAppUser(
  tx: Prisma.TransactionClient,
  waOnlyUserId: number,
  telegramUserId: number
): Promise<{ pairingId: string | null; reconnectGoogle: boolean; languageChanged: boolean }> {
  const w = await tx.user.findUniqueOrThrow({ where: { id: waOnlyUserId } });
  const t = await tx.user.findUniqueOrThrow({ where: { id: telegramUserId } });
  // What T takes from W's setup (written last; the calendar fold names T's calendar by it).
  const setup = setupFromW(w, t);
  // Read before W's arrive: T's live calendars, its primary (the one
  // getMainNativeCalendar picks), and whether it holds live events (the
  // primary step). W's Google connection is its token.
  const wHasGoogle = !!w.googleRefreshToken;
  const tCalendarsBefore = await tx.nativeCalendar.findMany({
    where: { ownerUserId: t.id, isDeleted: false },
    orderBy: { createdAt: 'asc' },
  });
  const tPrimary = tCalendarsBefore.find(c => c.labels.includes('primary'));
  const liveEvents = async (calendarIds: string[]) =>
    calendarIds.length ? tx.nativeEvent.count({ where: { calendarId: { in: calendarIds }, isDeleted: false } }) : 0;
  const tPrimaryEmpty = !!tPrimary && (await liveEvents([tPrimary.id])) === 0;

  // Pairing: one partner each. W's pairing moves to T
  // when T can take it; otherwise W is unpaired with unlink()'s writes. Each
  // step is a conditional write, as acceptInvite's are. Taking the pairing row
  // waits for an unlink of it in flight and re-checks it is still ACTIVE (count
  // 0: P unlinked after the read, so W is unpaired). T's write refuses a T that
  // accepted an invite after the read above.
  let pairingId = t.pairingId;
  let moved = false;
  const wPairing = w.pairingId ? await tx.pairing.findUnique({ where: { id: w.pairingId } }) : null;
  const wInvited = wPairing?.inviterUserId === w.id;
  const taken = wPairing?.status === 'ACTIVE' && (await tx.pairing.updateMany({
    where: { id: wPairing.id, status: 'ACTIVE', ...(wInvited ? { inviterUserId: w.id } : { inviteeUserId: w.id }) },
    data: wInvited ? { inviterUserId: t.id } : { inviteeUserId: t.id },
  })).count === 1;
  if (wPairing && taken) {
    moved = !t.pairingId && (await tx.user.updateMany({
      where: { id: t.id, pairingId: null },
      data: { pairingId: wPairing.id },
    })).count === 1;
    if (moved) {
      pairingId = wPairing.id;
    } else {
      await tx.pairing.update({
        where: { id: wPairing.id },
        data: { status: 'UNLINKED', unlinkedAt: new Date(), unlinkedByUserId: w.id },
      });
      // W's partner: P, or T when T and W were paired with each other.
      const partners = await tx.user.findMany({ where: { pairingId: wPairing.id, id: { not: w.id } }, select: { id: true } });
      await tx.user.updateMany({ where: { pairingId: wPairing.id }, data: { pairingId: null } });
      // The partner's calendars go back to PRIVATE, as on unlink (W's below). Users
      // first, then calendars: the order acceptInvite locks them in.
      await tx.nativeCalendar.updateMany({
        where: { ownerUserId: { in: partners.map(p => p.id) }, privacy: { not: 'PRIVATE' } },
        data: { privacy: 'PRIVATE' },
      });
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

  // A pairing that was ACTIVE when read and did not move (the merge ended it,
  // or P did meanwhile) shared W's calendars with P only: they come over
  // PRIVATE and fold only into private ones, so nothing in them (P's events
  // too) reaches T's partner.
  if (!moved && wPairing?.status === 'ACTIVE') {
    await tx.nativeCalendar.updateMany({ where: { ownerUserId: w.id }, data: { privacy: 'PRIVATE' } });
  }

  // Calendars. A legacy Google W's were soft-deleted by an old connect, so they
  // arrive deleted and stay hidden. T's primary calendar,
  // if it held no live events before W's arrived (a fresh T's empty default),
  // gives way to W's: T's goes (its soft-deleted events cascade) and W's comes
  // over as it is, privacy and setup, as the main calendar. Not while T stays
  // paired with a partner of its own: T's primary is shared with them and W's
  // never was (W was unpaired, or W's pairing ended), so T's stays main and
  // what T adds stays where the partner sees it.
  const live = (ownerUserId: number) =>
    tx.nativeCalendar.findMany({ where: { ownerUserId, isDeleted: false }, orderBy: { createdAt: 'asc' } });
  const wCalendars = await live(w.id);
  const tKeepsPartner = !!pairingId && !moved;
  const wPrimary = tPrimaryEmpty && !tKeepsPartner ? wCalendars.find(c => c.labels.includes('primary')) : undefined;
  if (tPrimary && wPrimary) await tx.nativeCalendar.delete({ where: { id: tPrimary.id } });

  // Then a moved pairing shares T's own calendars at the default permission,
  // as acceptInvite does (W's keep what W chose with P). A primary T kept is
  // then shared like W's, so the two fold and what 'primary' resolves to
  // stays the couple's.
  if (moved) {
    await tx.nativeCalendar.updateMany({
      where: { ownerUserId: t.id, privacy: 'PRIVATE', isDeleted: false },
      data: { privacy: 'SHARED_EDITOR' },
    });
  }

  // W's default calendar folds into a primary T kept (they are named after
  // each profile, so the names rarely match), and T's row takes W's calendar
  // setup where T's is as it started (calendarSetupFromW); the rest move over,
  // soft-deleted ones too. T keeps one primary calendar.
  const tCalendars = await live(t.id);
  const names = { t: t.name, w: w.name, merged: setup.name ?? t.name };
  const folded = new Set<string>();
  let tHasPrimary = tCalendars.some(c => c.labels.includes('primary'));
  let wKeptPrimary: string | undefined; // W's primary, kept as T's only FamCal primary
  for (const wCalendar of wCalendars) {
    const into = wCalendar === wPrimary ? undefined : tCalendars.find(c => !folded.has(c.id) && isSameCalendar(c, wCalendar));
    if (into) {
      folded.add(into.id);
      await tx.nativeEvent.updateMany({ where: { calendarId: wCalendar.id }, data: { calendarId: into.id } });
      await tx.nativeCalendar.update({ where: { id: into.id }, data: calendarSetupFromW(wCalendar, into, names) });
      await tx.nativeCalendar.delete({ where: { id: wCalendar.id } });
    } else if (wCalendar.labels.includes('primary')) {
      if (tHasPrimary) {
        await tx.nativeCalendar.update({
          where: { id: wCalendar.id },
          data: { labels: wCalendar.labels.filter(l => l !== 'primary') },
        });
      } else {
        wKeptPrimary = wCalendar.id;
      }
      tHasPrimary = true;
    }
  }
  await tx.nativeCalendar.updateMany({
    where: { ownerUserId: w.id },
    data: { ownerUserId: t.id },
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

  // W's Google connection moves when T has none of its own: the token, still
  // encrypted, and W's calendar choices. T keeps its FamCal calendars, partner and
  // events beside it (Google is a connection). The write re-checks the token, as
  // the pairing move does. Otherwise T keeps its own, and the user is told to
  // reconnect Google.
  let reconnectGoogle = false;
  let tookGoogle = false;
  if (wHasGoogle) {
    tookGoogle = !t.googleRefreshToken && (await tx.user.updateMany({
      where: { id: t.id, googleRefreshToken: '' },
      data: {
        googleRefreshToken: w.googleRefreshToken,
        calendarAssignments: w.calendarAssignments ?? Prisma.DbNull,
      },
    })).count === 1;
    reconnectGoogle = !tookGoogle;
  }

  // One primary across T's two lists, once (spec §3, §4): T's own wins, its Google
  // primary, else the FamCal primary T established. A fresh T's empty default gives
  // way here as it does to W's calendar above, so a moved Google primary stays the
  // default W had.
  const tGooglePrimary = t.googleRefreshToken ? googlePrimaryOf(liveGoogleChoices(t)) : undefined;
  const tFamcalPrimary = tPrimary && !wPrimary && !(tPrimaryEmpty && !tKeepsPartner) ? tPrimary.id : undefined;
  const wGooglePrimary = tookGoogle ? googlePrimaryOf(liveGoogleChoices(w)) : undefined;
  const keep = tGooglePrimary ? { googleCalendarId: tGooglePrimary }
    : tFamcalPrimary ? { famcalId: tFamcalPrimary }
    : wGooglePrimary ? { googleCalendarId: wGooglePrimary }
    : undefined;
  if (keep) await clearOtherPrimaries(t.id, keep, tx);
  // W's Google came without a primary, so W's default was its first Google "yours"
  // (spec §3 rule 2). A fresh T's empty default that W's calendar did not replace gives
  // up primary then, as the lazy FamCal main of a user with Google choices has none.
  const tFreshMain = tPrimary && !wPrimary && tPrimaryEmpty && !tKeepsPartner ? tPrimary.id : undefined;
  if (!keep && tookGoogle && tFreshMain && hasGoogleChoices(w)) {
    const row = await tx.nativeCalendar.findUnique({ where: { id: tFreshMain }, select: { labels: true } });
    if (row?.labels.includes('primary')) {
      await tx.nativeCalendar.update({ where: { id: tFreshMain }, data: { labels: row.labels.filter(l => l !== 'primary') } });
      console.log(`[AccountLink] User ${t.id}: primary off the fresh FamCal default ${tFreshMain}; W's Google has no primary`);
    }
  }

  // The mirror case: T keeps Google choices of its own that count (with the token, or a legacy
  // Google user's without it; a FamCal user's stale ones are none, liveGoogleChoices) and had
  // no FamCal primary (a legacy Google user's FamCal was hidden), so T's default was its
  // Google one (spec §3 rule 1 or 2). W's FamCal primary, which came over as T's only one,
  // gives up primary then, as the lazy FamCal main beside Google choices has none.
  if (!keep && !tookGoogle && !tPrimary && wKeptPrimary && hasGoogleChoices(t)) {
    const row = await tx.nativeCalendar.findUnique({ where: { id: wKeptPrimary }, select: { labels: true } });
    if (row?.labels.includes('primary')) {
      await tx.nativeCalendar.update({ where: { id: wKeptPrimary }, data: { labels: row.labels.filter(l => l !== 'primary') } });
      console.log(`[AccountLink] User ${t.id}: primary off W's FamCal calendar ${wKeptPrimary}; T's Google choices keep the default`);
    }
  }

  // W goes before T takes its WhatsApp ids: they are unique. W was found by the
  // id the link came from, so W's ids are the ones to take; a BSUID-only W has
  // no phone to give.
  await tx.user.delete({ where: { id: w.id } });
  await tx.user.update({
    where: { id: t.id },
    data: {
      ...setup,
      whatsappPhone: w.whatsappPhone || null,
      whatsappBsuid: w.whatsappBsuid || null,
      messagingPlatform: 'all',
    },
  });

  const languageChanged = setup.language !== undefined && setup.language !== t.language;
  return { pairingId, reconnectGoogle, languageChanged };
}

/**
 * After a merge commits: W's caches go, T's timezone is resolved again (from
 * the location T may have taken from W), T's reminder-cache entry is rebuilt
 * from T as it is now (the reminder run reads the pairing, calendar source,
 * token and language from there until the hourly sync), the reminder pass
 * wakes for the reminders T took over, and a language T took from W relabels
 * T's Telegram menu button, as a settings change does. Best effort: the merge
 * has already happened. T's feature access is invalidated by the caller, as for
 * a plain link.
 */
async function afterMerge(wUserId: number, tUserId: number, languageChanged: boolean): Promise<void> {
  await clearDeletedUserCaches(wUserId);
  invalidateDueGate();
  try {
    await redis.del(REDIS_KEYS.userTimezone(tUserId));
    const t = await getUserById(tUserId);
    if (!t) return;
    if (languageChanged && t.telegramId) await setUserMenuButton(t.telegramId, t.language);
    // Who belongs in the cache is the hourly sync's rule, as in the settings route.
    const remindable = t.remindersEnabled && t.telegramId !== null && !t.suspendedAt && !t.unreachableSince;
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
      const merged = await prisma.$transaction((tx) =>
        mergeWhatsAppUser(tx, waOnlyUser.id, telegramUser.id)
      );
      reconnectGoogle = merged.reconnectGoogle;
      await afterMerge(waOnlyUser.id, telegramUser.id, merged.languageChanged);

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
