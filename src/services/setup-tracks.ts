// The setup nudges ("Google as a connection" spec §2): which one a user gets, on what
// days, and when a Google one starts. The 07:00 cron (cron/handlers.ts), the admin card,
// its send and reset buttons all read them here.
//
// - location: from signup (or an admin reset), for everyone without one.
// - calendars: a Google token with no chosen calendars, at any account age.
// - reconnect: a legacy Google user (calendarSource GOOGLE) with no token while calendars are
//   stored (scope errors used to clear it). A FamCal user's stale choices with no token are
//   none (liveGoogleChoices), so they get no nudge.
// Connecting Google is optional, so there is no OAuth track. A token Google revoked is told
// by the summary's token line and the home's banner: the cron can't see it without a read.
// A Google track's days count from the day the cron first sees the user in that state, kept on
// the user's row (googleNudgeStartedAt: account data; a cache copy lives 30 days at most, the
// Privacy Policy's word); it nudges within GOOGLE_TRACK_WINDOW_DAYS of that start, and a user who
// stays in the state starts over a year on. A fresh connect, a disconnect and an admin reset start
// it over. Each sent attempt is marked in Redis for SETUP_ATTEMPT_TTL_SECONDS (30 days).

import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';
import { googleStateOf, type GoogleChoicesOwner, type GoogleState } from '../lib/google-state';

export type SetupTrack = 'calendars' | 'reconnect' | 'location';
export type GoogleTrack = Exclude<SetupTrack, 'location'>;
export const GOOGLE_TRACKS: readonly GoogleTrack[] = ['calendars', 'reconnect'];

/** The days (since the track's start) each attempt is sent on. */
export const SETUP_SCHEDULES: Record<SetupTrack, readonly number[]> = {
  calendars: [3, 6, 10],
  reconnect: [1, 4, 10],
  location: [5, 10],
};

/**
 * How long a sent attempt is remembered: the Privacy Policy's longest cache copy (30 days), and longer than the window of
 * every track (the location track's 14 days from signup, a Google track's GOOGLE_TRACK_WINDOW_DAYS), so no attempt is
 * sent twice.
 */
export const SETUP_ATTEMPT_TTL_SECONDS = 30 * 24 * 3600;
/** A Google track nudges only this many days from its start: past its last attempt, and within its marks' 30 days. */
export const GOOGLE_TRACK_WINDOW_DAYS = 30;
/** A user who stays in a Google state is nudged again (the track starts over) a year after its start. */
export const GOOGLE_TRACK_RESTART_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Google track a state starts, if any. */
export function googleTrackOf(state: GoogleState): GoogleTrack | null {
  if (state === 'choose') return 'calendars';
  if (state === 'reconnect') return 'reconnect';
  return null;
}

/** No Google choices stored: a JSON null, a database null or an empty list. */
const NO_CHOICES: Prisma.UserWhereInput[] = [
  { calendarAssignments: { equals: Prisma.JsonNull } },
  { calendarAssignments: { equals: Prisma.DbNull } },
  { calendarAssignments: { equals: [] } },
];

/** The users a Google track applies to, as a query (googleStateOf's 'choose' and 'reconnect',
 *  by liveGoogleChoices' rule): a token and no choices; or no token, the legacy Google marker
 *  (calendarSource, read only for this) and choices stored. */
export const GOOGLE_NUDGE_WHERE: Prisma.UserWhereInput[] = [
  { googleRefreshToken: { not: '' }, OR: NO_CHOICES },
  { googleRefreshToken: '', calendarSource: 'GOOGLE', NOT: NO_CHOICES },
];

/** The users whose Google choices count (liveGoogleChoices), as a query: choices stored, and a
 *  token or the legacy Google marker. */
export const LIVE_GOOGLE_CHOICES_WHERE: Prisma.UserWhereInput = {
  NOT: NO_CHOICES,
  OR: [{ googleRefreshToken: { not: '' } }, { calendarSource: 'GOOGLE' }],
};

/** The nudge an admin may send this user: the Google state's, else location, else none. */
export function applicableSetupReminder(user: GoogleChoicesOwner & { location?: string | null }): SetupTrack | null {
  return googleTrackOf(googleStateOf(user)) ?? (user.location ? null : 'location');
}

/** The attempt due after `days`, or null before the first. */
export function dueAttempt(days: number, schedule: readonly number[]): number | null {
  for (let i = schedule.length - 1; i >= 0; i--) {
    if (days >= schedule[i]) return i;
  }
  return null;
}

export const daysSince = (start: Date, now: Date = new Date()) => Math.floor((now.getTime() - start.getTime()) / DAY_MS);

/** The user's Google track start, as the row keeps it (null: the cron hasn't seen them in a Google state since the last reset). */
export interface GoogleTrackHolder {
  id: number;
  googleNudgeStartedAt: Date | null;
}

/**
 * When the user's Google track started, written as now on first sight and again a year on (GOOGLE_TRACK_RESTART_DAYS)
 * for a user still in that state. The 07:00 run only.
 */
export async function googleTrackStart(user: GoogleTrackHolder, now: Date = new Date()): Promise<Date> {
  const stored = user.googleNudgeStartedAt;
  if (stored && daysSince(stored, now) < GOOGLE_TRACK_RESTART_DAYS) return stored;
  await prisma.user.update({ where: { id: user.id }, data: { googleNudgeStartedAt: now } });
  if (stored) console.log(`[setup-tracks] user ${user.id}: the Google track started ${daysSince(stored, now)} days ago, so it starts over`);
  return now;
}

/** The attempt of a Google track due after `days`, or null: before its first, and past its window. */
export function dueGoogleAttempt(days: number, track: GoogleTrack): number | null {
  return days < GOOGLE_TRACK_WINDOW_DAYS ? dueAttempt(days, SETUP_SCHEDULES[track]) : null;
}

/**
 * Every Redis key of the user's setup tracks: each track's attempts, and the Google tracks' start keys an older build
 * left (the start is on the user's row now; those keys are only ever deleted).
 */
export function setupTrackKeys(userId: number): string[] {
  const attempts = (Object.keys(SETUP_SCHEDULES) as SetupTrack[]).flatMap((track) =>
    SETUP_SCHEDULES[track].map((_day, i) => REDIS_KEYS.setupReminder(userId, track, i))
  );
  return [...attempts, ...GOOGLE_TRACKS.map((track) => REDIS_KEYS.setupTrackStart(userId, track))];
}

/** A fresh connect (or a disconnect): both Google tracks start over, their start and attempts cleared. Never throws; a failure is logged. */
export async function clearGoogleTracks(userId: number): Promise<void> {
  const keys = GOOGLE_TRACKS.flatMap((track) => [
    REDIS_KEYS.setupTrackStart(userId, track),
    ...SETUP_SCHEDULES[track].map((_day, i) => REDIS_KEYS.setupReminder(userId, track, i)),
  ]);
  try {
    await prisma.user.updateMany({ where: { id: userId }, data: { googleNudgeStartedAt: null } });
    await redis.del(...keys);
  } catch (error) {
    console.error(`[setup-tracks] user ${userId}: starting the Google tracks over failed`, error);
    captureError(error, 'setup-tracks-clear', { user_id: userId }, 'warning');
  }
}
