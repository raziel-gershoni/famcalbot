/**
 * A reminder's zman rule on the server: the stored or posted value as a ZmanSpec whose zman is a key the
 * module knows, and whether a community's set offers it. Light (sets.ts is data, no hebcal), so the store, the
 * write path and the validators can ask without loading the calculator. The shape check itself is the
 * client-safe src/lib/calendar-view/zman-spec.ts, shared with the editor.
 */

import { readZmanSpec, ZMAN_HOURS_MAX, ZMAN_OFFSET_MAX_MIN, type ZmanOpinion, type ZmanSpecValue } from '../../lib/calendar-view/zman-spec';
import { DEFAULT_COMMUNITY, ZMAN_KEYS, isCommunity, isZmanKey, zmanimOfSet, zmanimSet, type ZmanKey, type ZmanimCommunity } from './sets';
import type { ZmanSpec } from './compute';

/** A value as a spec whose zman (if it names one) is a known key, else null. */
export function asZmanSpec(raw: unknown): ZmanSpec | null {
  const spec = readZmanSpec(raw);
  if (!spec) return null;
  if ('zman' in spec) return isZmanKey(spec.zman) ? { zman: spec.zman, offsetMin: spec.offsetMin } : null;
  return spec;
}

/** The community a person follows (anything but a known one reads as the default). */
export function communityOfUser(user: { zmanimCommunity?: string | null }): ZmanimCommunity {
  return isCommunity(user.zmanimCommunity) ? user.zmanimCommunity : DEFAULT_COMMUNITY;
}

/**
 * The zmanim a reminder can be set to for a community: its set, in the order of the day, without the end of Shabbat
 * (the set has it for the pause's windows; it is not one of the luach's times a person asks to be reminded at).
 */
export function reminderZmanim(community: ZmanimCommunity): ZmanKey[] {
  return zmanimOfSet(community).filter((key) => key !== 'SHABBAT_ENDS');
}

/** Whether the community's set offers a reminder the spec's zman ("N halachic hours after sunrise" is in every set). */
export function offeredIn(spec: ZmanSpec, community: ZmanimCommunity): boolean {
  return 'halachicHours' in spec || reminderZmanim(community).includes(spec.zman);
}

/**
 * What the extraction model says about a zman (the `zman` field of a reminder, read by the parser): a zman NAME with
 * the opinion only if the person said one, or a number of halachic hours after sunrise, and an offset in clock
 * minutes (before is negative). The model classifies what was said; it never picks a key. Which key it is under a
 * person's set is the server's, here.
 */
export type ModelZman =
  | { name: string; opinion: string | null; offsetMinutes: number }
  | { halachicHours: number; offsetMinutes: number };

/** Why a model zman is refused: the set lacks it, it is not a zman this build knows, or a number is out of range. */
export type ZmanRefusal = 'not_offered' | 'unknown' | 'bad_offset';

/**
 * What a model zman becomes under a community's set:
 *  - `spec`: the stored rule;
 *  - `choose`: the name has several opinions in the set and none was said. Nothing is defaulted: the specs (2 or more,
 *    in the order of the day) are the buttons the person chooses from;
 *  - `refuse`: nothing is created.
 */
export type ZmanFromModel =
  | { kind: 'spec'; spec: ZmanSpecValue }
  | { kind: 'choose'; specs: ZmanSpecValue[] }
  | { kind: 'refuse'; reason: ZmanRefusal };

/** The opinions the model may name, the closed list of src/lib/calendar-view/zman-spec.ts. */
const OPINIONS: readonly ZmanOpinion[] = ['gra', 'mga', 'halachaBerura', 'yalkutYosef', 'baalHatanya'];

/** The opinion each key suffix carries in the key's own name (SOF_SHMA_MGA is the Magen Avraham's, PLAG_GRA the Vilna Gaon's). */
const SUFFIX_OPINIONS: ReadonlyArray<[suffix: string, opinion: ZmanOpinion]> = [
  ['_GRA', 'gra'],
  ['_MGA', 'mga'],
  ['_HALACHA_BERURA', 'halachaBerura'],
  ['_YALKUT_YOSEF', 'yalkutYosef'],
];

/** The opinion a key's own name carries, or null for a key with none. */
function opinionOfKey(key: ZmanKey): ZmanOpinion | null {
  return SUFFIX_OPINIONS.find(([suffix]) => key.endsWith(suffix))?.[1] ?? null;
}

/** The name a person says for a key: the key without the opinion it carries (SOF_SHMA_GRA and SOF_SHMA_MGA are both "SOF_SHMA"). */
function nameOfKey(key: ZmanKey): string {
  const suffix = SUFFIX_OPINIONS.find(([s]) => key.endsWith(s))?.[0];
  return suffix ? key.slice(0, -suffix.length) : key;
}

/**
 * The model's zman as the stored rule under `community`'s set, the choices when the name has several opinions in
 * the set and none was said, or a refusal. The only way model output becomes a ZmanSpecValue. `modelZman` is read
 * defensively: anything that is not the shape of ModelZman is `unknown`.
 *
 * The keys of a name are found from the set data, never from a list: the zmanim the community offers a reminder
 * (reminderZmanim) whose name is the one said. A named opinion picks the key whose set names it with that opinion, or
 * whose key carries it (a Chabad reader's GRA key holds the Baal HaTanya's times and answers to both). A name with
 * no opinion in the set and one said, or an opinion the set lacks, is `not_offered`: never switched to another.
 * A missing offset is 0; the offset is whole minutes within 12 hours, and hours are 0 to 12, else `bad_offset`.
 */
export function readZmanFromModel(modelZman: unknown, community: ZmanimCommunity): ZmanFromModel {
  const refuse = (reason: ZmanRefusal): ZmanFromModel => ({ kind: 'refuse', reason });
  if (typeof modelZman !== 'object' || modelZman === null || Array.isArray(modelZman)) return refuse('unknown');
  const o = modelZman as Record<string, unknown>;
  const hasName = o.name !== undefined && o.name !== null;
  const hasHours = o.halachicHours !== undefined && o.halachicHours !== null;
  if (hasName === hasHours) return refuse('unknown');

  const offset = o.offsetMinutes ?? 0;
  const offsetOk = typeof offset === 'number' && Number.isInteger(offset) && Math.abs(offset) <= ZMAN_OFFSET_MAX_MIN;

  if (hasHours) {
    const hours = o.halachicHours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > ZMAN_HOURS_MAX || !offsetOk) return refuse('bad_offset');
    const spec = readZmanSpec({ halachicHours: hours, offsetMin: offset });
    return spec ? { kind: 'spec', spec } : refuse('bad_offset');
  }

  if (typeof o.name !== 'string') return refuse('unknown');
  const name = o.name.trim().toUpperCase();
  if (!ZMAN_KEYS.some((key) => nameOfKey(key) === name)) return refuse('unknown');
  let opinion: ZmanOpinion | null = null;
  if (o.opinion !== undefined && o.opinion !== null && !(typeof o.opinion === 'string' && o.opinion.trim() === '')) {
    const said = typeof o.opinion === 'string' ? OPINIONS.find((known) => known.toLowerCase() === (o.opinion as string).trim().toLowerCase()) : undefined;
    if (!said) return refuse('unknown');
    opinion = said;
  }
  if (!offsetOk) return refuse('bad_offset');

  const set = zmanimSet(community);
  const offered = reminderZmanim(community).filter((key) => nameOfKey(key) === name);
  const keys = opinion ? offered.filter((key) => set.zmanim[key]?.opinion === opinion || opinionOfKey(key) === opinion) : offered;
  const specs: ZmanSpecValue[] = keys.map((key) => ({ zman: key, offsetMin: offset as number }));
  if (specs.length === 0) return refuse('not_offered');
  return specs.length === 1 ? { kind: 'spec', spec: specs[0] } : { kind: 'choose', specs };
}
