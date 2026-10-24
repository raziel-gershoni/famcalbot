// One copy item pushed to Google (google-sync spec §4, Each item): the FamCal series rebuilt
// from its current state with the move's mapper (calendar-move/mapper.ts, the one converter),
// and written to the link's Google calendar by the least that brings Google in line.
//
// - Gone from the copy (missing, deleted, a reminder, moved out of the link's calendar, or
//   on a calendar the link's user no longer owns): deleted in Google, 404/410 counting as
//   done; never inserted: just dropped. A one-off that ended over 30 days ago and was never
//   copied is dropped too.
// - New: inserted under a deterministic id (syncEventId); a 409 means it is there already
//   (a retry after a timeout or a deploy), so it is adopted and written in full. A 409 whose
//   event is a deleted one (events.get: 'cancelled') takes the next generation instead.
// - Structural change (the rule, the start or all-day of a series, a removed override or
//   exdate, a one-off becoming a series or back): the master is deleted and inserted again
//   with the next generation, so no stale exception survives.
// - Otherwise the master is written in full (events.update: a full replace, so a cleared
//   note or place is cleared) when its hash changed, and every instance patch is replayed;
//   an override-only change patches just the slots whose hash changed. Every patch carries
//   the whole occurrence (the mapper's 'whole' exceptions).
// - Hebrew series: one single event per year over the horizon (hebrew.ts), each titled
//   "Title (N)" by the anniversary count. Their ids are deterministic per slot (singleEventId),
//   the item's slotHashes hold one hash per slot, and an old one-master RDATE copy is replaced
//   by the singles on its next push (pushHebrew).
// - What the mapper can't express is 'unsupported': its Google copy (if any) is deleted,
//   it is logged once, and it is tried again only after the next FamCal change.
//
// A push records the dirtySeq it read as pushedSeq, so a write that lands mid-push leaves the
// item dirty. Google's errors reach the worker, which sorts them; a 404/410 on a write is
// split here (copyCalendarGone): the calendar gone ends the link (CalendarGone), the event
// gone is reinserted with the next generation, and a second one in a row is 'error'.
// Logs carry ids, never a title.

import { createHash } from 'crypto';
import type { calendar_v3 } from '@googleapis/calendar';
import type { NativeEvent, NativeEventInstance, Prisma } from '@prisma/client';
import { TIMEZONE } from '../../config/constants';
import { captureError } from '../../lib/error-capture';
import { prisma } from '../../utils/prisma';
import { classifyGoogleError } from '../calendar-read/google-map';
import { toGoogleEvent, toGoogleHebrewSingles, type GoogleCopy } from '../calendar-move/mapper';
import { instanceAt } from '../calendar-move/move';
import { copyCalendarGone } from './calendars';
import { counted, type CallBudget, type SyncGoogle } from './client';
import { genKeyOf, HEBREW_FROM_KEY, HEBREW_GEN_PREFIX, HEBREW_SINGLE_PREFIX, HEBREW_SINGLES_KEY, hebrewHorizonFrom, hebrewSlots, hebrewWindow, storedHebrewFrom } from './hebrew';
import { SYNC_MARKER, SYNC_SERIES_MARKER } from './markers';

type GEvent = calendar_v3.Schema$Event;

const DAY_MS = 86_400_000;
/** A one-off that ended longer ago than this isn't copied (spec §1 Not copied). */
export const ONE_OFF_LOOKBACK_MS = 30 * DAY_MS;
/** lastError of an item whose Google event was found gone once: a second time is 'error'. */
export const EVENT_GONE = 'event_gone';

/** The copy calendar itself is gone (calendars.get answered 404/410): the link goes to 'gone'. */
export class CalendarGone extends Error {
  constructor() {
    super('The copy calendar is gone from Google');
    this.name = 'CalendarGone';
  }
}

/** A mapped override whose instance Google doesn't produce: the series can't be copied. */
class InstanceMissing extends Error {}

/** The link a push writes to: its calendar must have a Google calendar by now. */
export interface PushLink {
  id: string;
  userId: number;
  nativeCalendarId: string;
  googleCalendarId: string;
}

/** The item as the worker read it. */
export interface PushItem {
  id: string;
  nativeEventId: string;
  googleEventId: string | null;
  generation: number;
  masterHash: string | null;
  slotHashes: Prisma.JsonValue;
  dirtySeq: number;
  status: string;
  lastError: string | null;
}

export type PushOutcome = 'pushed' | 'clean' | 'removed' | 'dropped' | 'unsupported' | 'error';

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/** Bytes as base32hex (RFC 4648 §7), lower case, no padding: Google's event id alphabet (a–v, 0–9). */
function base32hex(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The deterministic Google event id of a series' copy: base32hex of sha256(linkId:seriesId:generation),
 * 52 characters of a–v and 0–9 (events.insert takes 5 to 1024 of them). The same push retried
 * asks for the same id, so Google answers 409 instead of making a second event.
 */
export function syncEventId(linkId: string, seriesId: string, generation: number): string {
  return base32hex(createHash('sha256').update(`${linkId}:${seriesId}:${generation}`).digest());
}

/**
 * The Google event id of one single of a Hebrew series' copy: base32hex of
 * sha256(linkId:seriesId:hs:<slot ISO>), the same alphabet as syncEventId. It has no generation: a
 * single is never revived from a stale state, an insert that finds its id (409) writes over it, so a
 * state lost (a re-enable) adopts the events already there and a retry never doubles one.
 * Only a single the user deleted in Google (whose id Google then holds for good) moves to a later
 * generation, kept in the item's hashes (HEBREW_GEN_PREFIX); generation 0 is the id above.
 */
export function singleEventId(linkId: string, seriesId: string, slot: Date, generation = 0): string {
  return base32hex(createHash('sha256').update(`${linkId}:${seriesId}:hs:${slot.toISOString()}${generation > 0 ? `:g${generation}` : ''}`).digest());
}

/** A single's generation, from the item's stored hashes. */
const genOf = (stored: Record<string, string>, singleKey: string): number => Number(stored[genKeyOf(singleKey)]) || 0;

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22);

/** What the item stored: the master's two hashes, '<structure>:<body>'. */
function readMasterHash(raw: string | null): { structure: string; body: string } | null {
  if (!raw) return null;
  const at = raw.indexOf(':');
  return at === -1 ? null : { structure: raw.slice(0, at), body: raw.slice(at + 1) };
}

function readSlotHashes(raw: Prisma.JsonValue): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** Every Google event copy carries no alerts (FamCal's own are the alert source) and the sync markers. */
const NO_ALERTS: GEvent['reminders'] = { useDefault: false, overrides: [] };

/** The copy as Google gets it, and what decides how it is written. */
interface Planned {
  copy: GoogleCopy;
  body: GEvent;
  /** Changes here need the master deleted and inserted again. */
  structure: string;
  bodyHash: string;
  /** One per override ('<hash>') and skipped slot ('x'), by slot. */
  slots: Record<string, string>;
  /** The exception patch hashes, by slot. */
  patches: Map<string, string>;
}

type Built = { ok: true; planned: Planned } | { ok: false; reason: string };

/**
 * The series' copy, built with the mapper, or why it can't be. A mapper refusal
 * (mapped.ok false) is a plain 'can't be copied'; a throw from the mapper
 * or hebcal is a code bug, so it also goes to Sentry as an error (ids only, never the title)
 * before the item is marked unreadable.
 */
function build(link: PushLink, item: PushItem, series: NativeEvent, overrides: NativeEventInstance[]): Built {
  let mapped: ReturnType<typeof toGoogleEvent>;
  try {
    mapped = toGoogleEvent(series, overrides, { exceptions: 'whole' });
  } catch (error) {
    captureError(error, 'google-sync-build', { user_id: link.userId, link_id: link.id, item_id: item.id, series_id: series.id }, 'error');
    return { ok: false, reason: `unreadable: ${error instanceof Error ? error.name : typeof error}` };
  }
  if (!mapped.ok) return { ok: false, reason: mapped.reason };
  const { copy } = mapped;
  const body: GEvent = {
    ...copy.event,
    status: 'confirmed',
    reminders: NO_ALERTS,
    extendedProperties: { private: { [SYNC_MARKER]: link.id, [SYNC_SERIES_MARKER]: series.id } },
  };
  const recurring = Boolean(body.recurrence?.length);
  const structure = hashOf({
    recurring,
    allDay: copy.allDay,
    start: recurring ? body.start : null,
    rules: (body.recurrence ?? []).filter((line) => !/^EXDATE[;:]/i.test(line)),
  });
  const slots: Record<string, string> = {};
  const patches = new Map<string, string>();
  for (const x of copy.exceptions) {
    const h = hashOf(x.patch);
    slots[x.slot.toISOString()] = h;
    patches.set(x.slot.toISOString(), h);
  }
  if (recurring) {
    for (const d of [...series.exdates, ...overrides.filter((o) => o.status === 'CANCELLED').map((o) => o.originalStartsAt)]) slots[d.toISOString()] = 'x';
  }
  return { ok: true, planned: { copy, body, structure, bodyHash: hashOf(body), slots, patches } };
}

/** How the planned copy is written over what the item stored. */
function modeOf(item: PushItem, planned: Planned): 'insert' | 'rebuild' | 'master' | 'slots' | 'none' {
  if (!item.googleEventId) return 'insert';
  const prev = readMasterHash(item.masterHash);
  // No stored hash with an event in Google (a re-enable, a push cut short): what Google holds
  // is unknown, so it is replaced whole.
  if (!prev || prev.structure !== planned.structure) return 'rebuild';
  const before = readSlotHashes(item.slotHashes);
  for (const [slot, was] of Object.entries(before)) {
    if (slot.startsWith('~')) continue;
    const now = planned.slots[slot];
    if (now === undefined) return 'rebuild'; // a removed override or exdate
    if ((was === 'x') !== (now === 'x')) return 'rebuild'; // an overridden slot cancelled
  }
  if (prev.body !== planned.bodyHash) return 'master';
  for (const [slot, h] of planned.patches) if (before[slot] !== h) return 'slots';
  return 'none';
}

/** An event delete where gone (404/410) is done. */
async function deleteEvent(g: SyncGoogle, budget: CallBudget, calendarId: string, eventId: string): Promise<void> {
  try {
    await counted(budget, () => g.api.events.delete({ calendarId, eventId }));
  } catch (error) {
    if (classifyGoogleError(error) !== 'gone') throw error;
  }
}

/** The event ids of one series in the copy calendar (events.list on its series marker), paged. */
async function listSeriesEventIds(g: SyncGoogle, budget: CallBudget, calendarId: string, seriesId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await counted(budget, () =>
      g.api.events.list({ calendarId, privateExtendedProperty: [`${SYNC_SERIES_MARKER}=${seriesId}`], showDeleted: false, singleEvents: false, maxResults: 2500, ...(pageToken ? { pageToken } : {}) })
    );
    for (const e of res.data.items ?? []) if (e.id) ids.push(e.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

/**
 * Every Google event of an item's copy deleted (404/410 counting as done): the singles its state
 * names, else the one master; `hebrew` (the series is, or was last read as, a Hebrew one) with no
 * singles flag also sweeps the series' marker, for a state lost between an old copy and the
 * singles. The item's own row is the caller's.
 */
async function deleteCopy(g: SyncGoogle, budget: CallBudget, link: PushLink, item: PushItem, hebrew = false): Promise<void> {
  const calendarId = link.googleCalendarId;
  const stored = readSlotHashes(item.slotHashes);
  if (stored[HEBREW_SINGLES_KEY] === '1') {
    for (const key of Object.keys(stored)) {
      if (key.startsWith(HEBREW_SINGLE_PREFIX)) await deleteEvent(g, budget, calendarId, singleEventId(link.id, item.nativeEventId, new Date(key.slice(HEBREW_SINGLE_PREFIX.length)), genOf(stored, key)));
    }
    return;
  }
  if (item.googleEventId) await deleteEvent(g, budget, calendarId, item.googleEventId);
  if (hebrew && item.googleEventId) {
    for (const id of await listSeriesEventIds(g, budget, calendarId, item.nativeEventId)) await deleteEvent(g, budget, calendarId, id);
  }
}

/** Generations an insert moves past when each id answers 409 with a deleted event under it. */
const DEAD_ID_TRIES = 3;

/**
 * Whether the event under this id is live. events.get returns a deleted event too, as
 * 'cancelled' (Google: "The get method always returns them"); a 404/410 is deleted too.
 */
async function liveEvent(g: SyncGoogle, budget: CallBudget, calendarId: string, eventId: string): Promise<boolean> {
  try {
    const res = await counted(budget, () => g.api.events.get({ calendarId, eventId }));
    return res.data.status !== 'cancelled';
  } catch (error) {
    if (classifyGoogleError(error) === 'gone') return false;
    throw error;
  }
}

/** A 409 from an insert: an event with that id is there already. */
function isDuplicate(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  return Boolean(e) && [e!.status, e!.response?.status, e!.code].includes(409);
}

/** Event gone under a write (404/410), as opposed to the calendar: spec §4's 404 split. */
class EventGone extends Error {}

/**
 * Push one item. Returns what it did; throws Google's errors the worker sorts (token,
 * scopes, rate limit, transient), BudgetSpent, or CalendarGone.
 */
export async function pushItem(g: SyncGoogle, budget: CallBudget, link: PushLink, item: PushItem, now: Date): Promise<PushOutcome> {
  let current = item;
  for (let round = 0; ; round++) {
    try {
      return await pushOnce(g, budget, link, current, now);
    } catch (error) {
      if (!(error instanceof EventGone)) throw error;
      // The second 404 in a row on the same item: no more retries until FamCal changes it.
      if (round > 0 || current.lastError === EVENT_GONE) {
        // The event id stays (a reinsert this push made may be there): with no master hash, the
        // push after the next FamCal change replaces it whole, so nothing is left behind.
        await prisma.googleSyncItem.update({
          where: { id: current.id },
          data: { status: 'error', lastError: `${EVENT_GONE}_again`, pushedSeq: current.dirtySeq, attempts: 0, nextAttemptAt: null, masterHash: null },
        });
        console.warn(`[google-sync] link ${link.id} item ${current.id}: its Google event was gone twice; left in error`);
        return 'error';
      }
      console.log(`[google-sync] link ${link.id} item ${current.id}: its Google event ${current.googleEventId ?? '-'} is gone; inserting it again (generation ${current.generation + 1})`);
      const next = { googleEventId: null, generation: current.generation + 1, masterHash: null, slotHashes: {}, lastError: EVENT_GONE };
      await prisma.googleSyncItem.update({ where: { id: current.id }, data: next });
      current = { ...current, ...next };
    }
  }
}

async function pushOnce(g: SyncGoogle, budget: CallBudget, link: PushLink, item: PushItem, now: Date): Promise<PushOutcome> {
  const readSeq = item.dirtySeq;
  const calendarId = link.googleCalendarId;
  const ids = `link ${link.id} item ${item.id} series ${item.nativeEventId}`;
  const series = await prisma.nativeEvent.findUnique({
    where: { id: item.nativeEventId },
    include: { instances: true, calendar: { select: { ownerUserId: true, isDeleted: true } } },
  });

  /** The item's copy leaves Google: its event deleted (gone counts as done), the row dropped unless a write landed meanwhile. */
  const removeFromCopy = async (outcome: 'removed' | 'dropped'): Promise<PushOutcome> => {
    await deleteCopy(g, budget, link, item, Boolean(series?.hebrewRule));
    const { count } = await prisma.googleSyncItem.deleteMany({ where: { id: item.id, dirtySeq: readSeq } });
    if (count === 0) {
      // A write landed during the push: the row stays dirty, with nothing in Google, for the next push to decide.
      await prisma.googleSyncItem.update({ where: { id: item.id }, data: { googleEventId: null, masterHash: null, slotHashes: {}, generation: item.generation + (item.googleEventId ? 1 : 0) } });
    }
    console.log(`[google-sync] ${ids}: ${outcome === 'removed' ? 'removed from the copy' : 'not copied (an old one-off)'}${item.googleEventId ? ` (event ${item.googleEventId})` : ''}`);
    return outcome;
  };

  const inCopy = series && !series.isDeleted && series.kind === 'EVENT' && series.calendarId === link.nativeCalendarId
    && series.calendar.ownerUserId === link.userId && !series.calendar.isDeleted;
  if (!series || !inCopy) return removeFromCopy('removed');
  if (!series.rrule && !item.googleEventId && series.endsAt.getTime() < now.getTime() - ONE_OFF_LOOKBACK_MS) return removeFromCopy('dropped');

  const stored = readSlotHashes(item.slotHashes);
  if (series.hebrewRule) return pushHebrew(g, budget, link, item, series, stored, now, removeFromCopy);
  if (stored[HEBREW_SINGLES_KEY] === '1') {
    // The series stopped being a Hebrew one: its singles go, and the master goes in as a new item.
    await deleteCopy(g, budget, link, item);
    await prisma.googleSyncItem.update({ where: { id: item.id }, data: { googleEventId: null, masterHash: null, slotHashes: {} } });
    return pushOnce(g, budget, link, { ...item, googleEventId: null, masterHash: null, slotHashes: {} }, now);
  }
  const built = build(link, item, series, series.instances);
  if (built.ok === false) return markUnsupported(g, budget, link, item, built.reason);
  const { planned } = built;
  const mode = modeOf(item, planned);

  let eventId = item.googleEventId;
  let generation = item.generation;
  let replay: 'all' | 'changed' | 'none' = 'none';
  try {
    if (mode === 'rebuild' && eventId) {
      await deleteEvent(g, budget, calendarId, eventId);
      generation += 1;
      eventId = null;
    }
    if (mode === 'insert' || mode === 'rebuild') {
      let id = syncEventId(link.id, series.id, generation);
      for (let tries = 1; ; tries++) {
        try {
          await counted(budget, () => g.api.events.insert({ calendarId, requestBody: { ...planned.body, id } }));
          break;
        } catch (error) {
          if (!isDuplicate(error)) throw error;
        }
        if (await liveEvent(g, budget, calendarId, id)) {
          // Already there (a retry after a timeout or a deploy): adopted and written whole.
          // One Google won't write (gone) is left for the next generation, below.
          eventId = id;
          await counted(budget, () => g.api.events.update({ calendarId, eventId: id, requestBody: planned.body }));
          break;
        }
        // A deleted event holds the id (Google keeps deleted ids): a copy removed from this
        // calendar whose generation was lost with its row (the series left the copy and came
        // back). Reviving it could bring back its old exceptions, so the next generation goes in.
        if (tries >= DEAD_ID_TRIES) throw new Error(`events.insert answered 409 on ${DEAD_ID_TRIES} generations in a row, each id held by a deleted event`);
        console.log(`[google-sync] ${ids}: the id of generation ${generation} is a deleted event's; inserting generation ${generation + 1}`);
        generation += 1;
        id = syncEventId(link.id, series.id, generation);
      }
      eventId = id;
      // Stored at once, so a failure in the replay below never loses the event: the master is
      // written again next time, and every override (marked '?') patched again.
      await prisma.googleSyncItem.update({
        where: { id: item.id },
        data: { googleEventId: id, generation, masterHash: `${planned.structure}:`, slotHashes: Object.fromEntries(Object.entries(planned.slots).map(([k, v]) => [k, planned.patches.has(k) ? '?' : v])) },
      });
      replay = 'all';
    } else if (mode === 'master') {
      await counted(budget, () => g.api.events.update({ calendarId, eventId: eventId!, requestBody: planned.body }));
      replay = 'all';
    } else if (mode === 'slots') {
      replay = 'changed';
    }
    if (replay !== 'none') {
      for (const x of planned.copy.exceptions) {
        const key = x.slot.toISOString();
        if (replay === 'changed' && stored[key] === planned.patches.get(key)) continue;
        const instance = await instanceAt(g.api, calendarId, eventId!, x.slot, x.originalStart, planned.copy.allDay, planned.copy.zone, (request) => counted(budget, request));
        if (!instance) throw new InstanceMissing();
        await counted(budget, () => g.api.events.patch({ calendarId, eventId: instance, requestBody: { ...x.patch, reminders: NO_ALERTS } }));
      }
    }
  } catch (error) {
    if (error instanceof InstanceMissing) return markUnsupported(g, budget, link, { ...item, googleEventId: eventId, generation }, 'override slot Google does not yield');
    if (classifyGoogleError(error) === 'gone' && eventId !== null) {
      if (await copyCalendarGone(g, budget, calendarId)) throw new CalendarGone();
      throw new EventGone();
    }
    if (classifyGoogleError(error) === 'gone' && (await copyCalendarGone(g, budget, calendarId))) throw new CalendarGone();
    throw error;
  }

  await prisma.googleSyncItem.update({
    where: { id: item.id },
    data: {
      googleEventId: eventId, generation, masterHash: `${planned.structure}:${planned.bodyHash}`, slotHashes: planned.slots,
      pushedSeq: readSeq, attempts: 0, nextAttemptAt: null, status: 'ok', lastError: null,
    },
  });
  if (mode !== 'none') console.log(`[google-sync] ${ids}: ${mode} (event ${eventId}, generation ${generation})`);
  return mode === 'none' ? 'clean' : 'pushed';
}

/** One planned single of a Hebrew series' copy. */
interface PlannedSingle {
  key: string;
  /** The Google event id; a later generation's once the first one's is held by an event the user deleted. */
  id: string;
  body: GEvent;
  hash: string;
}

/**
 * A Hebrew series' push (anniversary count spec, decision 5): one single event per slot of the
 * horizon, written by the least that brings Google in line with the item's stored state.
 *
 * - The state is the item's slotHashes: HEBREW_SINGLES_KEY '1', HEBREW_FROM_KEY, and one
 *   '~s:<slot ISO>' per single, holding its body's hash ('?' while it is being written). It is
 *   saved before the first write, so a push cut short loses no id, and again if a write fails.
 * - An item with a Google event and no singles flag is an old RDATE master (or a state wiped by
 *   a re-enable): the master is deleted and the series' events sweep (events.list on its marker)
 *   removes any that is not planned; the planned ids that are already there are written over
 *   (a 409 on insert is answered by an update), so no year is ever doubled.
 * - A slot no longer planned (an exdate, a cancelled instance, the horizon moving on) has its
 *   event deleted (404/410 counting as done); a changed body is written whole (events.update).
 * - Google's errors reach the worker as for any item; a 404/410 on a write asks whether the
 *   copy calendar itself is gone (CalendarGone). A single missing in Google is written again.
 */
async function pushHebrew(
  g: SyncGoogle,
  budget: CallBudget,
  link: PushLink,
  item: PushItem,
  series: NativeEvent & { instances: NativeEventInstance[] },
  stored: Record<string, string>,
  now: Date,
  removeFromCopy: (outcome: 'removed' | 'dropped') => Promise<PushOutcome>
): Promise<PushOutcome> {
  const readSeq = item.dirtySeq;
  const calendarId = link.googleCalendarId;
  const ids = `link ${link.id} item ${item.id} series ${item.nativeEventId}`;
  const zone = series.timeZone || TIMEZONE;
  const hebrewFrom = hebrewHorizonFrom(storedHebrewFrom(stored), now, zone);

  const plan = new Map<string, PlannedSingle>();
  try {
    const slots = hebrewSlots(series, series.instances, hebrewWindow(hebrewFrom, zone));
    if (slots.length === 0) return removeFromCopy('removed');
    const mapped = toGoogleHebrewSingles(series, series.instances, slots);
    if (!mapped.ok) return markUnsupported(g, budget, link, item, mapped.reason);
    for (const { slot, event } of mapped.singles) {
      const body: GEvent = {
        ...event,
        status: 'confirmed',
        reminders: NO_ALERTS,
        extendedProperties: { private: { [SYNC_MARKER]: link.id, [SYNC_SERIES_MARKER]: series.id } },
      };
      const key = `${HEBREW_SINGLE_PREFIX}${slot.toISOString()}`;
      plan.set(key, { key, id: singleEventId(link.id, series.id, slot, genOf(stored, key)), body, hash: hashOf(body) });
    }
  } catch (error) {
    captureError(error, 'google-sync-build', { user_id: link.userId, link_id: link.id, item_id: item.id, series_id: series.id }, 'error');
    return markUnsupported(g, budget, link, item, `unreadable: ${error instanceof Error ? error.name : typeof error}`);
  }

  const known = stored[HEBREW_SINGLES_KEY] === '1';
  /** Generation per single ('~g:<slot ISO>' → n), for the ones moved to a later id. */
  const gens: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored)) if (k.startsWith(HEBREW_GEN_PREFIX)) gens[k] = v;
  /** What Google holds, as far as the item knows: slot key → body hash, or '?'. */
  const state: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored)) if (known && k.startsWith(HEBREW_SINGLE_PREFIX)) state[k] = v;
  // The flag that the state names every event of the series: set from the start for a new copy,
  // and only once an old master's sweep is done for an old one (so a cut-short migration repeats it).
  let flagged = known || !item.googleEventId;
  const meta = () => ({ ...gens, ...(flagged ? { [HEBREW_SINGLES_KEY]: '1' } : {}), [HEBREW_FROM_KEY]: String(hebrewFrom) });
  const marker = item.googleEventId ?? syncEventId(link.id, series.id, item.generation);
  const save = (extra: Partial<{ pushedSeq: number; attempts: number; nextAttemptAt: null; status: string; lastError: null }> = {}) =>
    prisma.googleSyncItem.update({ where: { id: item.id }, data: { googleEventId: marker, masterHash: null, slotHashes: { ...state, ...meta() }, ...extra } });

  let wrote = false;
  try {
    if (!known && item.googleEventId) {
      // An old master (or a lost state): out first, then anything else of the series that is not planned.
      await deleteEvent(g, budget, calendarId, item.googleEventId);
      const planned = new Set([...plan.values()].map((p) => p.id));
      for (const id of await listSeriesEventIds(g, budget, calendarId, series.id)) if (!planned.has(id)) await deleteEvent(g, budget, calendarId, id);
      wrote = true;
    }
    flagged = true;
    // Saved before any write: the planned slots changed are marked '?', the stale ones still named.
    const before = { ...state };
    for (const p of plan.values()) if (state[p.key] !== p.hash) state[p.key] = '?';
    const stale = Object.keys(state).filter((k) => !plan.has(k));
    if (wrote || stale.length > 0 || [...plan.values()].some((p) => state[p.key] === '?') || stored[HEBREW_FROM_KEY] !== String(hebrewFrom) || !known) await save();

    for (const key of stale) {
      await deleteEvent(g, budget, calendarId, singleEventId(link.id, series.id, new Date(key.slice(HEBREW_SINGLE_PREFIX.length)), genOf(stored, key)));
      delete state[key];
      delete gens[genKeyOf(key)];
      wrote = true;
    }
    for (const p of plan.values()) {
      if (state[p.key] === p.hash) continue;
      const exists = before[p.key] !== undefined && before[p.key] !== '?';
      const insert = () => counted(budget, () => g.api.events.insert({ calendarId, requestBody: { ...p.body, id: p.id } }));
      const update = () => counted(budget, () => g.api.events.update({ calendarId, eventId: p.id, requestBody: p.body }));
      // A single written before is changed in place; a new one (or a state lost) is inserted, and a 409 means it is
      // there already, so it is written whole. A single the user deleted in Google is created again: Google holds a
      // deleted event's id for good (insert answers 409, update 404/410), so it goes in under the next generation's id.
      let attempt: 'update' | 'insert' = exists ? 'update' : 'insert';
      let sawGone = false;
      let afterDuplicate = false;
      let bumps = 0;
      const nextId = () => {
        bumps += 1;
        if (bumps > DEAD_ID_TRIES) throw new Error(`a yearly event's id was held by a deleted event on ${DEAD_ID_TRIES} generations in a row`);
        const generation = genOf(gens, p.key) + 1;
        gens[genKeyOf(p.key)] = String(generation);
        p.id = singleEventId(link.id, series.id, new Date(p.key.slice(HEBREW_SINGLE_PREFIX.length)), generation);
        console.log(`[google-sync] ${ids}: a yearly event was deleted in Google and its id is held; writing it again as generation ${generation}`);
      };
      for (;;) {
        try {
          await (attempt === 'update' ? update() : insert());
          break;
        } catch (error) {
          if (attempt === 'update' && classifyGoogleError(error) === 'gone') {
            if (afterDuplicate) nextId();
            attempt = 'insert';
            sawGone = true;
            afterDuplicate = false;
          } else if (attempt === 'insert' && isDuplicate(error)) {
            if (sawGone) nextId();
            else {
              attempt = 'update';
              afterDuplicate = true;
            }
          } else {
            throw error;
          }
        }
      }
      state[p.key] = p.hash;
      wrote = true;
    }
  } catch (error) {
    // What was written stays in the state, for the retry to start from (and to name for deletion later).
    await save().catch((saveError) => captureError(saveError, 'google-sync-hebrew-state', { user_id: link.userId, link_id: link.id, item_id: item.id, series_id: series.id }, 'error'));
    if (classifyGoogleError(error) === 'gone' && (await copyCalendarGone(g, budget, calendarId))) throw new CalendarGone();
    throw error;
  }

  await save({ pushedSeq: readSeq, attempts: 0, nextAttemptAt: null, status: 'ok', lastError: null });
  if (wrote) console.log(`[google-sync] ${ids}: ${plan.size} yearly events in sync (horizon from Hebrew year ${hebrewFrom})`);
  return wrote ? 'pushed' : 'clean';
}

/**
 * A series the mapper can't express (spec §4 Unsupported): its Google copy, if any, deleted
 * (a copy that holds other occurrences than FamCal is worse than none), 'unsupported' with
 * the reason, clean at the seq it read. Logged once, when it becomes unsupported.
 */
async function markUnsupported(g: SyncGoogle, budget: CallBudget, link: PushLink, item: PushItem, reason: string): Promise<PushOutcome> {
  await deleteCopy(g, budget, link, item);
  await prisma.googleSyncItem.update({
    where: { id: item.id },
    data: {
      status: 'unsupported', lastError: reason, pushedSeq: item.dirtySeq, attempts: 0, nextAttemptAt: null,
      googleEventId: null, masterHash: null, slotHashes: {}, generation: item.generation + (item.googleEventId ? 1 : 0),
    },
  });
  if (item.status !== 'unsupported') console.warn(`[google-sync] link ${link.id} item ${item.id} series ${item.nativeEventId}: can't be copied (${reason})`);
  return 'unsupported';
}
