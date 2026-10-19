// The calendar home's editing requests (home editing spec §3, §4): the editor's info for
// the "+", an item's edit info for the sheet's pencil, and create, edit and delete through
// /api/calendar/items. Client components only. Nothing here touches window at import.
//
// The init data goes in the header (and, for a write, the body), as the other Mini App
// requests send it; in a browser the session cookie rides along. user_id is the page's
// own, a Telegram id or a DB id, never swapped. Nothing here throws: a request that fails
// or answers in a form this file does not know reads as `failed`. A read that has not
// answered in time is aborted, so the pencil or the "+" never waits on it for good. A write
// has no time limit of ours: a Google split or repeat change is many Google calls one after
// another, and an abort would show "Couldn't save" while the server goes on and the write
// lands. It waits for the server's answer, or for the platform's own limit, which fails it.

import { INIT_DATA_HEADER, initDataHeaders, readInitData } from '../read-init-data';
import type {
  CreateItemBody,
  DeleteItemBody,
  EditorInfoResponse,
  ItemEditInfoResponse,
  UpdateItemBody,
} from './editor-types';

/** A read that has not answered by then reads as failed. Writes have none (see above). */
const READ_TIME_LIMIT_MS = 15_000;

/** What a write came to, for the editor to word. */
export type WriteOutcome =
  | { kind: 'ok'; key: string | null }
  | { kind: 'invalid'; field: string | null }
  | { kind: 'notAllowed' }
  | { kind: 'notFound' }
  | { kind: 'changed' }
  | { kind: 'busy' }
  /** 3b, Google: the connection needs the user (a dead token, or a write scope not granted). */
  | { kind: 'reconnect'; reason: 'token' | 'scopes' }
  | { kind: 'failed' };

/** The home's dependency for the editing requests, so a smoke can fake them. */
export interface EditingApi {
  editor: (userId: number) => Promise<EditorInfoResponse | null>;
  item: (userId: number, key: string) => Promise<ItemEditInfoResponse | null>;
  create: (userId: number, body: Omit<CreateItemBody, 'user_id' | 'initData'>) => Promise<WriteOutcome>;
  update: (userId: number, body: Omit<UpdateItemBody, 'user_id' | 'initData'>) => Promise<WriteOutcome>;
  remove: (userId: number, body: Omit<DeleteItemBody, 'user_id' | 'initData'>) => Promise<WriteOutcome>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEditorInfo(value: unknown): value is EditorInfoResponse {
  if (!isObject(value) || !isObject(value.kinds)) return false;
  return typeof value.kinds.event === 'boolean' && typeof value.kinds.reminder === 'boolean' && Array.isArray(value.calendars) && typeof value.tz === 'string';
}

function isItemInfo(value: unknown): value is ItemEditInfoResponse {
  if (!isObject(value) || !isObject(value.occurrence) || !isObject(value.series) || !isObject(value.calendar)) return false;
  const o = value.occurrence;
  return (
    (value.kind === 'event' || value.kind === 'reminder') &&
    typeof value.canEdit === 'boolean' &&
    typeof value.canDelete === 'boolean' &&
    typeof o.start === 'string' &&
    typeof o.end === 'string' &&
    typeof o.allDay === 'boolean' &&
    typeof o.title === 'string' &&
    typeof value.series.recurring === 'boolean' &&
    typeof value.series.start === 'string' &&
    typeof value.series.zone === 'string' &&
    typeof value.tz === 'string' &&
    Array.isArray(value.scopes) &&
    isItemInfoExtras(value)
  );
}

const optional = (value: unknown, type: 'boolean' | 'string') => value === undefined || typeof value === type;

/** The 3b fields are optional (an older server omits them), but a present one must be the type the editor reads. */
function isItemInfoExtras(value: Record<string, unknown>): boolean {
  const series = value.series as Record<string, unknown>;
  const rule = series.rule;
  const ruleOk =
    rule === undefined ||
    (isObject(rule) && ['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom'].includes(rule.choice as string) && optional(rule.words, 'string') && optional(rule.until, 'string'));
  return (
    ruleOk &&
    optional(series.first, 'boolean') &&
    optional(value.canMoveCalendar, 'boolean') &&
    (value.moveTargets === undefined || (Array.isArray(value.moveTargets) && value.moveTargets.every((id) => typeof id === 'string'))) &&
    optional(value.canChangeRecipient, 'boolean') &&
    optional(value.forPartner, 'boolean') &&
    optional(value.editableInGoogleOnly, 'boolean') &&
    (value.source === undefined || value.source === 'famcal' || value.source === 'google')
  );
}

/**
 * One request, a read with a time limit and a write without one. Resolves to the status and
 * the parsed body (null when not JSON), or null when it failed.
 */
async function send(url: string, init: { method: string; body?: unknown }): Promise<{ status: number; body: unknown } | null> {
  const limited = init.method === 'GET';
  const controller = limited && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = limited ? setTimeout(() => controller?.abort(), READ_TIME_LIMIT_MS) : null;
  try {
    const initData = readInitData();
    const res = await fetch(url, {
      method: init.method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: init.body === undefined ? initDataHeaders() : { 'Content-Type': 'application/json', ...(initData ? { [INIT_DATA_HEADER]: initData } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(initData && isObject(init.body) ? { ...init.body, initData } : init.body) }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function read<T>(url: string, ok: (value: unknown) => value is T): Promise<T | null> {
  const res = await send(url, { method: 'GET' });
  return res && res.status === 200 && ok(res.body) ? res.body : null;
}

/** A write's answer as an outcome. */
function outcomeOf(res: { status: number; body: unknown } | null): WriteOutcome {
  if (!res) return { kind: 'failed' };
  const body = isObject(res.body) ? res.body : {};
  if (res.status === 200) return body.status === 'ok' ? { kind: 'ok', key: typeof body.key === 'string' ? body.key : null } : { kind: 'failed' };
  if (res.status === 400 && body.error === 'invalid') return { kind: 'invalid', field: typeof body.field === 'string' ? body.field : null };
  if (res.status === 403 && body.error === 'not_allowed') return { kind: 'notAllowed' };
  if (res.status === 403 && body.error === 'reconnect') return { kind: 'reconnect', reason: body.reason === 'scopes' ? 'scopes' : 'token' };
  if (res.status === 404) return { kind: 'notFound' };
  if (res.status === 409) return { kind: 'changed' };
  if (res.status === 429) return { kind: 'busy' };
  return { kind: 'failed' };
}

const write = (method: string, userId: number, body: object) => send('/api/calendar/items', { method, body: { user_id: userId, ...body } }).then(outcomeOf);

export const REAL_EDITING: EditingApi = {
  editor: (userId) => read(`/api/calendar/editor?${new URLSearchParams({ user_id: String(userId) })}`, isEditorInfo),
  item: (userId, key) => read(`/api/calendar/item?${new URLSearchParams({ user_id: String(userId), key })}`, isItemInfo),
  create: (userId, body) => write('POST', userId, body),
  update: (userId, body) => write('PATCH', userId, body),
  remove: (userId, body) => write('DELETE', userId, body),
};
