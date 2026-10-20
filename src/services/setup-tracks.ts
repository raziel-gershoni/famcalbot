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
// A Google track's days count from the day the cron first sees the user in that state; a
// fresh connect starts both over.

import { Prisma } from '@prisma/client';
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

/** How long a sent attempt is remembered: the location track's window (14 days) is shorter. */
export const LOCATION_ATTEMPT_TTL_SECONDS = 30 * 24 * 3600;
/** A Google track's start and attempts: a user who stays in that state is nudged again after a year at most. */
export const GOOGLE_TRACK_TTL_SECONDS = 365 * 24 * 3600;

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

/** When a Google track started for this user, if the cron has seen them in its state. */
export async function readGoogleTrackStart(userId: number, track: GoogleTrack): Promise<Date | null> {
  const raw = await redis.get<string | number>(REDIS_KEYS.setupTrackStart(userId, track));
  const ms = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The track's start, stored as now on first sight. */
export async function googleTrackStart(userId: number, track: GoogleTrack, now: Date = new Date()): Promise<Date> {
  const stored = await readGoogleTrackStart(userId, track);
  if (stored) return stored;
  await redis.set(REDIS_KEYS.setupTrackStart(userId, track), String(now.getTime()), { ex: GOOGLE_TRACK_TTL_SECONDS });
  return now;
}

/** Every key of the user's setup tracks: each track's attempts, and the Google tracks' starts. */
export function setupTrackKeys(userId: number): string[] {
  const attempts = (Object.keys(SETUP_SCHEDULES) as SetupTrack[]).flatMap((track) =>
    SETUP_SCHEDULES[track].map((_day, i) => REDIS_KEYS.setupReminder(userId, track, i))
  );
  return [...attempts, ...GOOGLE_TRACKS.map((track) => REDIS_KEYS.setupTrackStart(userId, track))];
}

/** A fresh connect: both Google tracks start over. Never throws; a failure is logged. */
export async function clearGoogleTracks(userId: number): Promise<void> {
  const keys = GOOGLE_TRACKS.flatMap((track) => [
    REDIS_KEYS.setupTrackStart(userId, track),
    ...SETUP_SCHEDULES[track].map((_day, i) => REDIS_KEYS.setupReminder(userId, track, i)),
  ]);
  try {
    await redis.del(...keys);
  } catch (error) {
    captureError(error, 'setup-tracks-clear', { user_id: userId }, 'warning');
  }
}
