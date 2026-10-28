/**
 * A reminder's zman rule on the server: the stored or posted value as a ZmanSpec whose zman is a key the
 * module knows, and whether a community's set offers it. Light (sets.ts is data, no hebcal), so the store, the
 * write path and the validators can ask without loading the calculator. The shape check itself is the
 * client-safe src/lib/calendar-view/zman-spec.ts, shared with the editor.
 */

import { readZmanSpec } from '../../lib/calendar-view/zman-spec';
import { DEFAULT_COMMUNITY, isCommunity, isZmanKey, zmanimOfSet, type ZmanKey, type ZmanimCommunity } from './sets';
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
