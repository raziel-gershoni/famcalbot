/**
 * The three communities' sets of zmanim (halachic times), as data: for each zman the rule that
 * finds it on a day, the direction it rounds to the minute, and the opinion it is named with.
 * compute.ts is the one place that reads them. Plan:
 * docs/superpowers/plans/2026-10-28-zmanim-reminders.md (the owner's decisions of 2026-10-28).
 *
 * Server only (through compute.ts, which loads @hebcal/core): nothing here reaches the Mini App
 * bundle. The client gets computed times in the DTO.
 *
 * Units used by the rules:
 *   - "the day" is the stretch between the set's sunrise and sunset, split in 12 halachic hours
 *     (shaot zmaniyot); "the frame" is the set's own sunrise and sunset (see Frame);
 *   - a "halachic minute" (zm) is 1/60 of that hour; a "clock minute" is 60 seconds.
 *
 * The Sephardi set follows Zmanei Yosef in Israel (the Ohr HaChaim calendar of Rav Ovadia Yosef),
 * read from the research report's formulas (never copied code): the hour runs from the elevation
 * sunrise to the elevation sunset, dawn and nightfall are halachic minutes, and abroad the same
 * formulas run at sea level. The Ashkenazi set is the Israeli luach's: sea level, degrees for
 * dawn and nightfall. The Chabad set is the Baal HaTanya's: the day runs from netz amiti (the sun
 * 1.583 degrees below the horizon) to shkiah amitis, and the sea-level sunrise and sunset are only
 * shown.
 */

export const COMMUNITIES = ['sephardi', 'ashkenazi', 'chabad'] as const;
export type ZmanimCommunity = (typeof COMMUNITIES)[number];

/** The set a person gets until they choose (owner decision 1). */
export const DEFAULT_COMMUNITY: ZmanimCommunity = 'sephardi';

export function isCommunity(value: unknown): value is ZmanimCommunity {
  return typeof value === 'string' && (COMMUNITIES as readonly string[]).includes(value);
}

/**
 * Every zman any set can offer, in the order they fall in a day. These keys are stored in a
 * reminder's zmanSpec, so a key is never renamed or reused. A key names the zman and how the day
 * is cut; the opinion a set names it with is in its entry (see Opinion), because the Chabad set's
 * *_GRA keys run on the Baal HaTanya's day.
 */
export const ZMAN_KEYS = [
  'ALOT',
  'MISHEYAKIR',
  'NETZ',
  'SOF_SHMA_MGA',
  'SOF_SHMA_GRA',
  'SOF_TFILA',
  'CHATZOT',
  'MINCHA_GEDOLA',
  'MINCHA_KETANA',
  'PLAG_HALACHA_BERURA',
  'PLAG_YALKUT_YOSEF',
  'PLAG_GRA',
  'CANDLE_LIGHTING',
  'SHKIA',
  'TZEIT',
  'TZEIT_LECHUMRA',
  'SHABBAT_ENDS',
  'CHATZOT_HALAYLA',
] as const;
export type ZmanKey = (typeof ZMAN_KEYS)[number];

export function isZmanKey(value: unknown): value is ZmanKey {
  return typeof value === 'string' && (ZMAN_KEYS as readonly string[]).includes(value);
}

/** Which way a zman rounds to the minute: `earlier` floors it, `later` ceils it. */
export type Round = 'earlier' | 'later';

/** The opinion a zman is named with beside its name (owner: every displayed zman names it). */
export type Opinion = 'gra' | 'mga' | 'halachaBerura' | 'yalkutYosef' | 'baalHatanya';

/**
 * Which sunrise and sunset the day is measured between.
 *  - `horizon`: the top edge of the sun on the horizon. With `elevation: 'israel'` the horizon is
 *    the one seen from the person's elevation (Israel only; abroad it is sea level, as Zmanei Yosef
 *    does); with `'never'` it is sea level.
 *  - `angle`: the sun's centre this many degrees below the horizon (the Baal HaTanya's netz amiti).
 */
export type Frame = { kind: 'horizon'; elevation: 'israel' | 'never' } | { kind: 'angle'; degrees: number };

/** What a rule measures a clock-minute offset from. */
export type Sun = 'frameSunset' | 'seaLevelSunset';

/** How to find a zman on a day. `zman` rules read another zman of the same set (unrounded). */
export type Rule =
  | { op: 'seaLevelSunrise' }
  | { op: 'frameSunset' }
  | { op: 'seaLevelSunset' }
  /** The sun's centre `degrees` below the horizon; rising = in the morning. */
  | { op: 'angle'; degrees: number; rising: boolean }
  /** The frame's sunrise plus `hours` halachic hours (it is the day's hour, the same for every rule). */
  | { op: 'hoursFromSunrise'; hours: number }
  /** The frame's sunset plus `hours` halachic hours (negative: before). */
  | { op: 'hoursFromSunset'; hours: number }
  /** The frame's sunrise plus `zm` halachic minutes (negative: before). */
  | { op: 'zmFromSunrise'; zm: number }
  /** The frame's sunset plus `zm` halachic minutes. */
  | { op: 'zmFromSunset'; zm: number }
  /** `minutes` clock minutes from the sunset (negative: before). */
  | { op: 'clockFromSunset'; from: Sun; minutes: number }
  /** Another zman of the set plus `hours` halachic hours. */
  | { op: 'hoursFromZman'; zman: ZmanKey; hours: number }
  /** The middle of the frame's day: sunrise plus 6 hours. */
  | { op: 'midday' }
  /** After midday: the later of `minutes` clock minutes and `hours` halachic hours. */
  | { op: 'afterMidday'; minutes: number; hours: number }
  /** The middle of the night: from the frame's sunset to the next morning's sunrise. */
  | { op: 'midnight' }
  /** The start of the Magen Avraham's day plus `hours` of its hours (see ZmanimSet.mgaDay). */
  | { op: 'mgaHours'; hours: number };

export interface ZmanEntry {
  rule: Rule;
  round: Round;
  opinion?: Opinion;
}

export interface ZmanimSet {
  id: ZmanimCommunity;
  frame: Frame;
  /**
   * The Magen Avraham's day, split in 12 for his hours: from `begin` to `end`. Absent where the set
   * has no Magen Avraham zman.
   */
  mgaDay?: { begin: Rule; end: Rule };
  zmanim: Partial<Record<ZmanKey, ZmanEntry>>;
}

/**
 * The direction each zman rounds, as Zmanei Yosef rounds it (the `round` of each zman in its
 * published data): a time that ENDS something rounds earlier (the latest Shema and tefila, midday,
 * sunset, candle lighting), a time that STARTS something rounds later (the earliest tallit and
 * tefillin, mincha, plag, nightfall, the end of Shabbat). Exceptions, as Zmanei Yosef has them:
 *   - ALOT rounds earlier, though it starts the day;
 *   - NETZ rounds later (the sun is up from the next minute);
 *   - CHATZOT_HALAYLA rounds later.
 */
const ROUND: Record<ZmanKey, Round> = {
  ALOT: 'earlier',
  MISHEYAKIR: 'later',
  NETZ: 'later',
  SOF_SHMA_MGA: 'earlier',
  SOF_SHMA_GRA: 'earlier',
  SOF_TFILA: 'earlier',
  CHATZOT: 'earlier',
  MINCHA_GEDOLA: 'later',
  MINCHA_KETANA: 'later',
  PLAG_HALACHA_BERURA: 'later',
  PLAG_YALKUT_YOSEF: 'later',
  PLAG_GRA: 'later',
  CANDLE_LIGHTING: 'earlier',
  SHKIA: 'earlier',
  TZEIT: 'later',
  TZEIT_LECHUMRA: 'later',
  SHABBAT_ENDS: 'later',
  CHATZOT_HALAYLA: 'later',
};

/** An entry with the shared rounding for its zman. */
function entry(zman: ZmanKey, rule: Rule, opinion?: Opinion): ZmanEntry {
  return { rule, round: ROUND[zman], ...(opinion ? { opinion } : {}) };
}

/** Candle lighting is 20 clock minutes before sunset in every set (owner decision 4). */
const CANDLES_MIN = -20;

/**
 * Sephardi: Zmanei Yosef / the Ohr HaChaim calendar. Hours from the elevation sunrise to the elevation
 * sunset; dawn 72 and nightfall 13.5 halachic minutes (20 for the stricter nightfall); the Magen
 * Avraham's day from 72 halachic minutes before sunrise to 72 after sunset; the end of Shabbat 30
 * clock minutes after sunset. The sunrise shown (NETZ) is the sea-level one (Zmanei Yosef's
 * "mishor"). Two plags are two zmanim (owner decision 2).
 */
const SEPHARDI: ZmanimSet = {
  id: 'sephardi',
  frame: { kind: 'horizon', elevation: 'israel' },
  mgaDay: { begin: { op: 'zmFromSunrise', zm: -72 }, end: { op: 'zmFromSunset', zm: 72 } },
  zmanim: {
    ALOT: entry('ALOT', { op: 'zmFromSunrise', zm: -72 }),
    MISHEYAKIR: entry('MISHEYAKIR', { op: 'zmFromSunrise', zm: -60 }),
    NETZ: entry('NETZ', { op: 'seaLevelSunrise' }),
    SOF_SHMA_MGA: entry('SOF_SHMA_MGA', { op: 'mgaHours', hours: 3 }, 'mga'),
    SOF_SHMA_GRA: entry('SOF_SHMA_GRA', { op: 'hoursFromSunrise', hours: 3 }, 'gra'),
    SOF_TFILA: entry('SOF_TFILA', { op: 'hoursFromSunrise', hours: 4 }),
    CHATZOT: entry('CHATZOT', { op: 'midday' }),
    MINCHA_GEDOLA: entry('MINCHA_GEDOLA', { op: 'afterMidday', minutes: 30, hours: 0.5 }),
    MINCHA_KETANA: entry('MINCHA_KETANA', { op: 'hoursFromSunrise', hours: 9.5 }),
    PLAG_HALACHA_BERURA: entry('PLAG_HALACHA_BERURA', { op: 'hoursFromSunset', hours: -1.25 }, 'halachaBerura'),
    PLAG_YALKUT_YOSEF: entry('PLAG_YALKUT_YOSEF', { op: 'hoursFromZman', zman: 'TZEIT', hours: -1.25 }, 'yalkutYosef'),
    CANDLE_LIGHTING: entry('CANDLE_LIGHTING', { op: 'clockFromSunset', from: 'frameSunset', minutes: CANDLES_MIN }),
    SHKIA: entry('SHKIA', { op: 'frameSunset' }),
    TZEIT: entry('TZEIT', { op: 'zmFromSunset', zm: 13.5 }),
    TZEIT_LECHUMRA: entry('TZEIT_LECHUMRA', { op: 'zmFromSunset', zm: 20 }),
    SHABBAT_ENDS: entry('SHABBAT_ENDS', { op: 'clockFromSunset', from: 'frameSunset', minutes: 30 }),
    CHATZOT_HALAYLA: entry('CHATZOT_HALAYLA', { op: 'midnight' }),
  },
};

/**
 * Israeli Ashkenazi: sea level. Dawn 16.1 degrees, tallit and tefillin 11.5, nightfall and the end
 * of Shabbat 8.5; the Magen Avraham's day from 16.1 degrees before sunrise to 16.1 after sunset.
 * Mincha gedola keeps the 30-minute floor Sephardi has (the later of 30 minutes and half an hour).
 */
const ASHKENAZI: ZmanimSet = {
  id: 'ashkenazi',
  frame: { kind: 'horizon', elevation: 'never' },
  mgaDay: { begin: { op: 'angle', degrees: 16.1, rising: true }, end: { op: 'angle', degrees: 16.1, rising: false } },
  zmanim: {
    ALOT: entry('ALOT', { op: 'angle', degrees: 16.1, rising: true }),
    MISHEYAKIR: entry('MISHEYAKIR', { op: 'angle', degrees: 11.5, rising: true }),
    NETZ: entry('NETZ', { op: 'seaLevelSunrise' }),
    SOF_SHMA_MGA: entry('SOF_SHMA_MGA', { op: 'mgaHours', hours: 3 }, 'mga'),
    SOF_SHMA_GRA: entry('SOF_SHMA_GRA', { op: 'hoursFromSunrise', hours: 3 }, 'gra'),
    SOF_TFILA: entry('SOF_TFILA', { op: 'hoursFromSunrise', hours: 4 }),
    CHATZOT: entry('CHATZOT', { op: 'midday' }),
    MINCHA_GEDOLA: entry('MINCHA_GEDOLA', { op: 'afterMidday', minutes: 30, hours: 0.5 }),
    MINCHA_KETANA: entry('MINCHA_KETANA', { op: 'hoursFromSunrise', hours: 9.5 }),
    PLAG_GRA: entry('PLAG_GRA', { op: 'hoursFromSunset', hours: -1.25 }, 'gra'),
    CANDLE_LIGHTING: entry('CANDLE_LIGHTING', { op: 'clockFromSunset', from: 'frameSunset', minutes: CANDLES_MIN }),
    SHKIA: entry('SHKIA', { op: 'frameSunset' }),
    TZEIT: entry('TZEIT', { op: 'angle', degrees: 8.5, rising: false }),
    SHABBAT_ENDS: entry('SHABBAT_ENDS', { op: 'angle', degrees: 8.5, rising: false }),
    CHATZOT_HALAYLA: entry('CHATZOT_HALAYLA', { op: 'midnight' }),
  },
};

/**
 * Chabad: the Baal HaTanya. The day runs from netz amiti to shkiah amitis (the sun's centre 1.583
 * degrees below the horizon), and every hour-based zman is cut on it; the *_GRA keys therefore hold
 * the Baal HaTanya's times here and are named with that opinion. Dawn 16.9 degrees, tallit and
 * tefillin 10.2, nightfall 6, the end of Shabbat 8.5. Mincha gedola is 6.5 hours after netz amiti,
 * mincha ketana 2.5 hours before shkiah amitis, plag 1.25 before it. The sunrise and sunset shown
 * are sea level, and candle lighting counts back from the sea-level sunset. There is no Magen
 * Avraham zman and no second plag in this tradition's luach.
 */
const CHABAD: ZmanimSet = {
  id: 'chabad',
  frame: { kind: 'angle', degrees: 1.583 },
  zmanim: {
    ALOT: entry('ALOT', { op: 'angle', degrees: 16.9, rising: true }),
    MISHEYAKIR: entry('MISHEYAKIR', { op: 'angle', degrees: 10.2, rising: true }),
    NETZ: entry('NETZ', { op: 'seaLevelSunrise' }),
    SOF_SHMA_GRA: entry('SOF_SHMA_GRA', { op: 'hoursFromSunrise', hours: 3 }, 'baalHatanya'),
    SOF_TFILA: entry('SOF_TFILA', { op: 'hoursFromSunrise', hours: 4 }),
    CHATZOT: entry('CHATZOT', { op: 'midday' }),
    MINCHA_GEDOLA: entry('MINCHA_GEDOLA', { op: 'hoursFromSunrise', hours: 6.5 }),
    MINCHA_KETANA: entry('MINCHA_KETANA', { op: 'hoursFromSunset', hours: -2.5 }),
    PLAG_GRA: entry('PLAG_GRA', { op: 'hoursFromSunset', hours: -1.25 }, 'baalHatanya'),
    CANDLE_LIGHTING: entry('CANDLE_LIGHTING', { op: 'clockFromSunset', from: 'seaLevelSunset', minutes: CANDLES_MIN }),
    SHKIA: entry('SHKIA', { op: 'seaLevelSunset' }),
    TZEIT: entry('TZEIT', { op: 'angle', degrees: 6, rising: false }),
    SHABBAT_ENDS: entry('SHABBAT_ENDS', { op: 'angle', degrees: 8.5, rising: false }),
    CHATZOT_HALAYLA: entry('CHATZOT_HALAYLA', { op: 'midnight' }),
  },
};

const SETS: Record<ZmanimCommunity, ZmanimSet> = { sephardi: SEPHARDI, ashkenazi: ASHKENAZI, chabad: CHABAD };

export function zmanimSet(community: ZmanimCommunity): ZmanimSet {
  return SETS[community];
}

/**
 * The zmanim a community offers, in the order of the day: what a reminder can be set to. The
 * end of Shabbat is in the set because the pause windows need it; the editor may leave it out.
 */
export function zmanimOfSet(community: ZmanimCommunity): ZmanKey[] {
  const set = SETS[community];
  return ZMAN_KEYS.filter(key => set.zmanim[key] !== undefined);
}
