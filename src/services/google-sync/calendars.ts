// FamCal's own Google calendars, one per copy link (google-sync spec §3): create (or adopt on a
// retry), rename, Remove and Keep. Google calls only; the worker (worker.ts) writes the link
// rows around them, and the hard delete (user-moderation.ts) runs the same Remove and Keep.
//
// SAFETY. Remove deletes a Google calendar. It only ever deletes the link's own
// googleCalendarId, and only after reading that calendar again and finding this link's token
// ([famcal:<linkId>]) in its description. When the user added their own events there, only
// the events marked famcalSync=<linkId> go and the calendar stays. Nothing here touches any
// other calendar.
//
// Every call is counted against the user's run budget (client.ts). Errors are Google's and
// reach the caller, which sorts them (rate limit, token, scopes, gone, transient).

import type { calendar_v3 } from '@googleapis/calendar';
import { getBotMessages } from '../../lib/bot-messages';
import { classifyGoogleError } from '../calendar-read/google-map';
import { counted, type CallBudget, type SyncGoogle } from './client';
import { SYNC_MARKER, linkToken } from './markers';

type GEvent = calendar_v3.Schema$Event;

export { linkToken };

/** A Hebrew or Arabic letter: the name is then isolated (FSI … PDI) so "FamCal · " stays put. */
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** The copy calendar's name in the user's language: "FamCal · <name>", the name bidi-isolated when it is right-to-left. */
export async function copyName(language: string, name: string): Promise<string> {
  const t = (await getBotMessages(language)).googleSync;
  const shown = RTL.test(name) ? `⁨${name}⁩` : name;
  return String(t.calendarName).replace('{name}', shown);
}

/** The description while FamCal keeps the calendar up to date, ending with the link's token. */
export async function managedDescription(language: string, name: string, linkId: string): Promise<string> {
  const t = (await getBotMessages(language)).googleSync;
  return `${String(t.descriptionManaged).replace('{name}', name)}\n\n${linkToken(linkId)}`;
}

/** The description after Keep: FamCal no longer updates it. The token stays, so a later Remove still knows it. */
export async function keptDescription(language: string, linkId: string): Promise<string> {
  const t = (await getBotMessages(language)).googleSync;
  return `${String(t.descriptionKept)}\n\n${linkToken(linkId)}`;
}

/** What the copy calendar calls need of a link. */
export interface CopyLink {
  id: string;
  googleCalendarId: string | null;
}

/** Every calendarList entry the user owns (hidden ones too), page by page. */
async function ownedCalendars(g: SyncGoogle, budget: CallBudget): Promise<calendar_v3.Schema$CalendarListEntry[]> {
  const out: calendar_v3.Schema$CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const res = await counted(budget, () => g.api.calendarList.list({ minAccessRole: 'owner', showHidden: true, maxResults: 250, ...(pageToken ? { pageToken } : {}) }));
    out.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/** The user's own calendar carrying this link's token in its description, if any. */
function tokenCalendar(owned: readonly calendar_v3.Schema$CalendarListEntry[], linkId: string): string | null {
  const token = linkToken(linkId);
  return owned.find((c) => c.id && (c.description ?? '').includes(token))?.id ?? null;
}

/**
 * The link's Google calendar found by its token in the user's calendar list, for a link with
 * no stored id: a create can make the calendar and fail before the id is stored, so a
 * turn-off or the hard delete looks before taking "no id" for "nothing in Google".
 */
export async function findCopyCalendarId(g: SyncGoogle, budget: CallBudget, linkId: string): Promise<string | null> {
  return tokenCalendar(await ownedCalendars(g, budget), linkId);
}

/** `base`, or "<base> (2)", "(3)", … when another of the user's calendars already has the name. */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The link's Google calendar, made now or found again (spec §3 Creating the calendar). A
 * retry while 'creating' first looks for the link's token in the user's calendar list and
 * adopts that calendar, so a crash between Google's answer and the stored id never makes a
 * second one. A new one gets the name (de-duplicated against the user's own calendars), the
 * description with the token and the zone. Nothing writes its calendarList entry: Google
 * refuses calendarList.patch for this grant with 401 "Invalid Credentials" (production,
 * 2026-10-21), which reads as a dead token. The copies need no calendar default anyway: each
 * carries reminders { useDefault: false, overrides: [] } (push.ts NO_ALERTS).
 */
export async function ensureCopyCalendar(
  g: SyncGoogle,
  budget: CallBudget,
  link: CopyLink,
  facts: { language: string; name: string; zone: string },
): Promise<{ googleCalendarId: string; adopted: boolean }> {
  const owned = await ownedCalendars(g, budget);
  const found = tokenCalendar(owned, link.id);
  let id: string;
  let adopted = false;
  if (found) {
    id = found;
    adopted = true;
  } else {
    const base = await copyName(facts.language, facts.name);
    const taken = new Set(owned.flatMap((c) => [c.summary, c.summaryOverride]).filter((s): s is string => Boolean(s)));
    const made = await counted(budget, async () =>
      g.api.calendars.insert({ requestBody: { summary: freeName(base, taken), description: await managedDescription(facts.language, facts.name, link.id), timeZone: facts.zone } }));
    if (!made.data.id) throw new Error('Google answered calendars.insert with no id');
    id = made.data.id;
  }
  return { googleCalendarId: id, adopted };
}

/** A FamCal rename on the copy calendar (spec §3 Rename): the name and the description that quotes it. A 404/410 (the calendar gone) reaches the caller, which sets the link 'gone'. */
export async function renameCopyCalendar(g: SyncGoogle, budget: CallBudget, link: CopyLink & { googleCalendarId: string }, facts: { language: string; name: string }): Promise<void> {
  await counted(budget, async () =>
    g.api.calendars.patch({ calendarId: link.googleCalendarId, requestBody: { summary: await copyName(facts.language, facts.name), description: await managedDescription(facts.language, facts.name, link.id) } }));
}

/** The link's calendar, read again: ours (the token in its description), someone else's, or gone. */
async function readCopyCalendar(g: SyncGoogle, budget: CallBudget, link: CopyLink & { googleCalendarId: string }): Promise<'ours' | 'foreign' | 'gone'> {
  try {
    const res = await counted(budget, () => g.api.calendars.get({ calendarId: link.googleCalendarId }));
    return (res.data.description ?? '').includes(linkToken(link.id)) ? 'ours' : 'foreign';
  } catch (error) {
    if (classifyGoogleError(error) === 'gone') return 'gone';
    throw error;
  }
}

/** Every event of the copy calendar, masters and exceptions, page by page. */
async function listCopyEvents(g: SyncGoogle, budget: CallBudget, calendarId: string, privateExtendedProperty?: string): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await counted(budget, () =>
      g.api.events.list({ calendarId, singleEvents: false, showDeleted: false, maxResults: 2500, ...(privateExtendedProperty ? { privateExtendedProperty: [privateExtendedProperty] } : {}), ...(pageToken ? { pageToken } : {}) }));
    out.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/** What a Remove or Keep did in Google. */
export type TurnOffOutcome = 'deleted' | 'emptied' | 'kept' | 'gone' | 'foreign';

/**
 * Remove (spec §3): the calendar read again first, and touched only when it is the link's own
 * (its token in the description). When every event in it is FamCal's copy (marked with this
 * link, or an occurrence of one), the calendar is deleted (calendars.delete, which
 * calendar.app.created allows on the calendars the app made). When the user added their own,
 * only the events marked famcalSync=<linkId> are deleted and the calendar stays. A calendar
 * already gone is done; one without the token is never touched ('foreign').
 */
export async function removeCopyCalendar(g: SyncGoogle, budget: CallBudget, link: CopyLink & { googleCalendarId: string }): Promise<TurnOffOutcome> {
  const state = await readCopyCalendar(g, budget, link);
  if (state !== 'ours') return state;
  const calendarId = link.googleCalendarId;
  const events = await listCopyEvents(g, budget, calendarId);
  const ours = new Set(events.filter((e) => e.extendedProperties?.private?.[SYNC_MARKER] === link.id && e.id).map((e) => e.id!));
  const isOurs = (e: GEvent) => (e.id ? ours.has(e.id) : false) || (e.recurringEventId ? ours.has(e.recurringEventId) : false);
  if (events.every(isOurs)) {
    try {
      await counted(budget, () => g.api.calendars.delete({ calendarId }));
    } catch (error) {
      if (classifyGoogleError(error) !== 'gone') throw error;
    }
    return 'deleted';
  }
  // The user's own events stay, and so does the calendar: only FamCal's marked masters go
  // (their occurrences with them), listed again by the marker so nothing else is in the list.
  const marked = await listCopyEvents(g, budget, calendarId, `${SYNC_MARKER}=${link.id}`);
  for (const e of marked) {
    if (!e.id || e.recurringEventId || e.extendedProperties?.private?.[SYNC_MARKER] !== link.id) continue;
    try {
      await counted(budget, () => g.api.events.delete({ calendarId, eventId: e.id! }));
    } catch (error) {
      if (classifyGoogleError(error) !== 'gone') throw error;
    }
  }
  return 'emptied';
}

/** Keep (spec §3): the calendar read again, and when it is the link's own its description says FamCal no longer updates it. */
export async function keepCopyCalendar(g: SyncGoogle, budget: CallBudget, link: CopyLink & { googleCalendarId: string }, language: string): Promise<TurnOffOutcome> {
  const state = await readCopyCalendar(g, budget, link);
  if (state !== 'ours') return state;
  await counted(budget, async () => g.api.calendars.patch({ calendarId: link.googleCalendarId, requestBody: { description: await keptDescription(language, link.id) } }));
  return 'kept';
}

/** Whether the copy calendar itself is gone (calendars.get answers 404 or 410): the 404 split of spec §4. */
export async function copyCalendarGone(g: SyncGoogle, budget: CallBudget, googleCalendarId: string): Promise<boolean> {
  try {
    await counted(budget, () => g.api.calendars.get({ calendarId: googleCalendarId }));
    return false;
  } catch (error) {
    if (classifyGoogleError(error) === 'gone') return true;
    throw error;
  }
}
