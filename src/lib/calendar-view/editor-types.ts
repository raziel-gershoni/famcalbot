// The calendar home's editing API, as the client and the routes share it (home editing
// spec §3). Type-only and client-safe: it imports nothing.
//
// Times are wall times, never instants: 'YYYY-MM-DDTHH:mm' for a timed item and
// 'YYYY-MM-DD' for an all-day one, read on the user's clock (EditorInfoResponse.tz). An
// all-day item's end is its last day, inclusive. A reminder has one time: its end is its
// start, and a date-only reminder is an all-day one.

export const TITLE_MAX = 200;
export const LOCATION_MAX = 200;
export const NOTES_MAX = 2000;

export type ItemKind = 'event' | 'reminder';
/** Which occurrences a change or a delete applies to. A one-off item has only 'single'. */
export type EditScope = 'single' | 'following' | 'all';
/** How a new item repeats; the rule is built on the server, anchored on the start. */
export type RepeatChoice = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** A calendar the user may add events to. */
export interface EditorCalendar {
  /** 'native:<cuid>'. */
  id: string;
  name: string;
  color: string | null;
  /** The user's main calendar: the default, and where reminders go. */
  main: boolean;
  /** The user's own; false for the partner's SHARED_EDITOR calendar. */
  mine: boolean;
  /** The partner's name, on theirs. */
  ownerName?: string;
}

/** GET /api/calendar/editor?user_id= */
export interface EditorInfoResponse {
  /** What the user can add. With neither, the home has no "+". */
  kinds: { event: boolean; reminder: boolean };
  /** The writable calendars, the user's first. Empty when kinds.event is false. */
  calendars: EditorCalendar[];
  /** The active partner, or null. canRemind: they can be pinged, so a reminder can be for them. */
  partner: { name: string; canRemind: boolean } | null;
  /** The user's timezone, the one the wall times are in. */
  tz: string;
}

/** How a series repeats, as its rule says; the client words it ("Every Tuesday"). */
export interface RepeatInfo {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  /** Weekday codes of the rule's BYDAY ('MO'..'SU'); empty when the rule has none (it follows the start). */
  byDay: string[];
  /** The rule has an end (UNTIL or COUNT), as a series cut by "this one and the ones after" does. */
  ends: boolean;
}

/** GET /api/calendar/item?user_id=&key= */
export interface ItemEditInfoResponse {
  kind: ItemKind;
  canEdit: boolean;
  canDelete: boolean;
  /** This occurrence as it stands now. Empty text is ''. */
  occurrence: {
    start: string;
    end: string;
    allDay: boolean;
    title: string;
    location: string;
    description: string;
  };
  series: {
    recurring: boolean;
    /** The series' own first start, in the occurrence's form. */
    start: string;
    /** null for a one-off, and for a rule that isn't daily, weekly, monthly or yearly. */
    repeat: RepeatInfo | null;
  };
  /** id is null when the calendar is the partner's private one (a reminder they set for the user). */
  calendar: { id: string | null; name: string; color: string | null };
  /** A reminder for the partner: their name. Otherwise null. */
  forName: string | null;
  scopes: EditScope[];
}

/** POST /api/calendar/items */
export interface CreateItemBody {
  user_id: string | number;
  initData?: string;
  kind: ItemKind;
  title: string;
  location?: string;
  description?: string;
  allDay: boolean;
  start: string;
  /** Events only; a timed event's default is an hour after the start, an all-day one's its start day. */
  end?: string;
  repeat?: RepeatChoice;
  /** Events only: 'native:<cuid>' of a calendar from the editor info; default the main one. */
  calendarId?: string;
  /** Reminders only: for the partner. */
  forPartner?: boolean;
}

/** PATCH /api/calendar/items: only what the editor changed needs to be in `changes`. */
export interface UpdateItemBody {
  user_id: string | number;
  initData?: string;
  /** The item's key, as ItemDTO.key. */
  key: string;
  scope: EditScope;
  changes: {
    title?: string;
    location?: string;
    description?: string;
    allDay?: boolean;
    start?: string;
    end?: string;
  };
}

/** DELETE /api/calendar/items */
export interface DeleteItemBody {
  user_id: string | number;
  initData?: string;
  key: string;
  scope: EditScope;
}

/**
 * What a write answers (private, no-store):
 * 200 { status: 'ok', key? }: key names the created or changed item when it lives on;
 * 400 { error: 'invalid', field } or { error: 'bad_request' } for a body that isn't JSON;
 * 403 { error: 'not_allowed' }; 404 { error: 'not_found' }; 409 { error: 'changed' } (the
 * occurrence is gone); 500 { error: 'internal_error' }. Auth and the rate limit answer
 * 400/401/403/404/429 with { error } as every route does.
 */
export type WriteResponse =
  | { status: 'ok'; key?: string }
  | { error: 'invalid'; field: string }
  | { error: 'bad_request' | 'not_allowed' | 'not_found' | 'changed' | 'internal_error' };
