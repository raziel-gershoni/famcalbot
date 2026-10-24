// The shared calendar reader (calendar home spec §2): one read over the sources that
// apply to a user, for the calendar home's range route and the summaries (Plan C).
//
// This file picks the sources, builds the window and runs the halves in parallel. The
// halves do the reading: famcal.ts (§2.4) and google.ts (§2.5, §2.6). Nothing here
// buckets into days: day membership is daySpanOf's, applied by the caller
// (shapeEventsForDay for a summary, toRangeDays for the home).

import type { UserConfig } from '../../types';
import { startOfLocalDay } from '../../utils/day-events';
import { readFamcal } from './famcal';
import { readGoogle } from './google';
import type { DayKey, FamcalRead, GoogleRead, RangeRead, ReadItem, ReadRangeOptions, SourceName } from './types';

/**
 * The sources that apply to a user: the one place that decides it ("Google as a
 * connection" spec §4). Every user has FamCal (created lazily); Google applies while the
 * user has a token. User.calendarSource is not read: it is a legacy column.
 */
export function sourcesFor(user: Pick<UserConfig, 'googleRefreshToken'>): SourceName[] {
  return user.googleRefreshToken ? ['famcal', 'google'] : ['famcal'];
}

type Half<R> = { read: R; items: ReadItem[]; colours?: Readonly<Record<string, string>> };

/**
 * The items of [fromKey, toKey) in `opts.tz`, with each read source's status.
 *
 * - Window: [max(startOfLocalDay(fromKey), notBefore), startOfLocalDay(toKey)),
 *   half-open, no padding. Both halves select by overlap with it. An empty window is a
 *   caller's bug and throws a RangeError.
 * - Sources: opts.sources ∩ sourcesFor(user); absent = every applicable one. A source
 *   that doesn't apply or wasn't asked for is left out of the result (no key, no read,
 *   no query).
 * - The halves run in parallel and never reject the read: one that throws reports
 *   `error` (FamCal with the cause; Google as 'unknown').
 * - Items: FamCal in the provider's order, then Google in the order of the choices,
 *   stably sorted by start as calendar.ts:159 sorts. An item without a start is
 *   dropped.
 * - Only Google takes the cache options; the default is 'bypass' (summaries never use
 *   the cache).
 *
 * `user` must be a fresh DB row (verifyUserAuth's, or the summary's getAllUsers row),
 * never the reminder cache's rebuilt user, whose token may be an hour old.
 */
export async function readRange(user: UserConfig, fromKey: DayKey, toKey: DayKey, opts: ReadRangeOptions): Promise<RangeRead> {
  const dayStart = startOfLocalDay(fromKey, opts.tz);
  const from = opts.notBefore && opts.notBefore.getTime() > dayStart.getTime() ? new Date(opts.notBefore.getTime()) : dayStart;
  const to = startOfLocalDay(toKey, opts.tz);
  if (!(from.getTime() < to.getTime())) {
    throw new RangeError(`readRange: empty window [${from.toISOString()}, ${to.toISOString()}) for ${fromKey}..${toKey} in ${opts.tz}`);
  }
  const window = { from, to };

  const applicable = sourcesFor(user);
  const wanted = opts.sources ? applicable.filter((s) => opts.sources?.includes(s)) : applicable;

  const famcalP: Promise<Half<FamcalRead>> | null = wanted.includes('famcal')
    ? readFamcal(user, window, { calendarIds: opts.calendarIds }).catch(
        (cause: unknown): Half<FamcalRead> => ({ read: { status: 'error', cause }, items: [] })
      )
    : null;
  const googleP: Promise<Half<GoogleRead>> | null = wanted.includes('google')
    ? readGoogle(user, window, {
        tz: opts.tz,
        calendarIds: opts.calendarIds,
        deadlineMs: opts.deadlineMs,
        googleCache: opts.googleCache ?? 'bypass',
        defer: opts.defer,
      }).catch((cause: unknown): Half<GoogleRead> => ({ read: { status: 'error', reason: 'unknown', cause }, items: [] }))
    : null;
  const [famcal, google] = await Promise.all([famcalP, googleP]);

  const hasStart = (item: ReadItem) => !!item.event.start;
  // Array#sort is stable, so equal starts keep the order of the choices (calendar.ts:159).
  const googleItems = (google?.items ?? [])
    .filter(hasStart)
    .sort((a, b) => new Date(a.event.start).getTime() - new Date(b.event.start).getTime());

  return {
    window,
    items: [...(famcal?.items ?? []).filter(hasStart), ...googleItems],
    ...(famcal ? { famcal: famcal.read } : {}),
    ...(google ? { google: google.read } : {}),
    ...(google?.colours ? { googleColours: google.colours } : {}),
  };
}
