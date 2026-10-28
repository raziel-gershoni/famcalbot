// A reminder's zman rule as it is stored (NativeEvent.zmanSpec) and as the Mini App reads it. Client-safe and
// pure: it imports nothing, so the editor's code can share it with the server. The zmanim themselves (the keys, how
// each is found) are src/services/zmanim, which is server only: here a zman is just a string, and the server checks
// it against its list (src/services/zmanim/spec.ts).
//
// Two forms, both with an offset in ordinary clock minutes (before is negative):
//   { zman, offsetMin }            "10 minutes before the latest time for Shema (GRA)"
//   { halachicHours, offsetMin }   "3 halachic hours after sunrise"

export type ZmanSpecValue = { zman: string; offsetMin: number } | { halachicHours: number; offsetMin: number };

/** The editor's offset: whole clock minutes, in steps of 5, up to 12 hours either way. */
export const ZMAN_OFFSET_STEP_MIN = 5;
export const ZMAN_OFFSET_MAX_MIN = 720;
/** "N halachic hours after sunrise": the editor offers whole hours 1 to 12; the server takes anything from 0 to 12. */
export const ZMAN_HOURS_MIN = 1;
export const ZMAN_HOURS_MAX = 12;

/** The mode the editor's body names: a plain time, or a zman. */
export type TimeMode = 'time' | 'zman';

/** The editor's pick for "N halachic hours after sunrise", beside the zmanim's keys. */
export const HOURS_PICK = 'hours';

/** Whose opinion a zman is named with beside its name (src/services/zmanim/sets.ts Opinion). */
export type ZmanOpinion = 'gra' | 'mga' | 'halachaBerura' | 'yalkutYosef' | 'baalHatanya';

const isWholeMinutes = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= ZMAN_OFFSET_MAX_MIN;

/**
 * A stored or posted value as a spec, or null when it is not one: an object with exactly one of `zman` (a
 * non-empty string) and `halachicHours` (0 to 12), and `offsetMin` in whole minutes within 12 hours. The result
 * is a fresh object with only those keys. Whether a zman key exists is the server's to say.
 */
export function readZmanSpec(raw: unknown): ZmanSpecValue | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !isWholeMinutes(o.offsetMin)) return null;
  if (typeof o.zman === 'string' && o.zman.length > 0 && o.zman.length <= 40) return { zman: o.zman, offsetMin: o.offsetMin };
  if (typeof o.halachicHours === 'number' && Number.isFinite(o.halachicHours) && o.halachicHours >= 0 && o.halachicHours <= ZMAN_HOURS_MAX) {
    return { halachicHours: o.halachicHours, offsetMin: o.offsetMin };
  }
  return null;
}

/** Whether two specs (or two absences) are the same rule. */
export function sameZmanSpec(a: ZmanSpecValue | null | undefined, b: ZmanSpecValue | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.offsetMin !== b.offsetMin) return false;
  if ('zman' in a) return 'zman' in b && a.zman === b.zman;
  return 'halachicHours' in b && a.halachicHours === b.halachicHours;
}

/**
 * What the due-time code asks of a person's zmanim, so the pure readers (due.ts, the home's DTO, the digests) never
 * load the calculator: the server builds one per person (src/services/zmanim/reminder-clock.ts) and hands it in.
 */
export interface ZmanClock {
  /** Where the times are counted: the person's own saved place, or (none saved) their zone's main city. */
  source: 'saved' | 'zone';
  /** The instant of `spec` on the civil day `day` (yyyy-MM-dd, in the person's zone), or null where there is none. Logged by the clock. */
  instant(day: string, spec: ZmanSpecValue): Date | null;
  /** The opinion the person's set names this zman with (the Baal HaTanya's for a Chabad reader's GRA keys), or null for none. */
  opinion(zman: string): ZmanOpinion | null;
}

/**
 * What the editor needs to offer zmanim and to show today's time of each (GET /api/calendar/editor, `zmanim`): the
 * person's community, where their times are counted from, and the instants of today at that place. The client never
 * computes a zman: it adds the offset to one of these.
 */
export interface ZmanimInfo {
  community: 'sephardi' | 'ashkenazi' | 'chabad';
  /** 'saved': the person's own place. 'zone': none saved, their timezone's main city stands in. 'none': nothing to count from. */
  place: 'saved' | 'zone' | 'none';
  /** The civil day (yyyy-MM-dd, the person's zone) the instants are for: today. */
  day: string;
  /** The zmanim the community's set offers a reminder, in the order of the day; `at` is null where the sun does not make it today (or no place). */
  zmanim: Array<{ key: string; opinion: ZmanOpinion | null; at: string | null }>;
  /** N halachic hours after sunrise today, for N = 1..12 (index 0 is 1 hour); null where there is no sunrise. */
  hours: Array<string | null>;
}
