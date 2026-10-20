// The marks FamCal's Google copies carry (google-sync spec §2, Markers). Pure, so the
// Google readers' rules (calendar-read/google-map.ts, calendar.ts) and the worker share
// one copy.
//
// Every copied event carries extendedProperties.private { famcalSync: <linkId>,
// famcalSeries: <seriesId> }, and each copy calendar's description ends with the link's
// token [famcal:<linkId>]. The move's famcalMovedFrom (calendar-move/mapper.ts
// MOVED_FROM) is a different key: a moved event is the user's own and is shown.

/** The private property naming the copy link an event belongs to. */
export const SYNC_MARKER = 'famcalSync';
/** The private property naming the FamCal series an event copies. */
export const SYNC_SERIES_MARKER = 'famcalSeries';

/** Whether a Google event is one of FamCal's copies, which FamCal never reads back. */
export function isSyncCopy(event: { extendedProperties?: { private?: Record<string, string> | null } | null }): boolean {
  return Boolean(event.extendedProperties?.private?.[SYNC_MARKER]);
}

/** The fixed token a copy calendar's description ends with (spec §2 Markers; never translated). */
export const linkToken = (linkId: string) => `[famcal:${linkId}]`;
