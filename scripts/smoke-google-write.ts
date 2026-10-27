// Smoke test for writing to Google Calendar (3b spec §3.2, §3.3 Google half, §7 "A new
// smoke-google-write"): the shared write path the bot and the home use
// (src/services/calendar.ts under calendar-provider/google-provider.ts), and the home's
// Google items (calendar-write/google-item.ts through write.ts and item-info.ts).
//
// The real @googleapis/calendar client, its auth library and gaxios run. Only gaxios's
// transport is replaced: a small in-memory Google Calendar answers each request (events,
// their instances and exceptions, calendarList, move), and its errors are real
// GaxiosErrors, shaped by google-auth-library as production sees them. Faked besides:
// the stamp's Upstash client (records each stamp), the shared Redis, error capture,
// analytics, the user's timezone lookup and the database (a Google user needs none).
// No network, no database.
//
// Run under both clocks; nothing may depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-google-write.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-google-write.ts

import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RRule } from 'rrule';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, UserConfig } from '../src/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

process.env.GOOGLE_CLIENT_ID ||= 'fake-client-id';
process.env.GOOGLE_CLIENT_SECRET ||= 'fake-client-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://stamp-redis.smoke.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke-token';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    reset();
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.stack ?? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- The fake Google Calendar, behind gaxios's transport ----

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';

interface CalMeta { summary: string; accessRole: string; primary?: boolean; timeZone: string; backgroundColor: string }
type Req = { method: string; path: string; params: Row; body: Row | undefined };
type Answer = { status: number; data: unknown };

const cals = new Map<string, CalMeta>();
const evs = new Map<string, Map<string, Row>>();
const gone = new Set<string>();
const calls: Req[] = [];
let seq = 0;
let tokenAnswer: Answer | null = null;
/** One-shot (or n-shot) failures, matched in order. */
let rules: { match: (r: Req) => boolean; answer: Answer; left: number }[] = [];

const apiBody = (code: number, reason: string, message: string) => ({ error: { code, message, errors: [{ domain: 'global', reason, message }] } });
const fail = (status: number, reason: string, message = reason): Answer => ({ status, data: apiBody(status, reason, message) });
function failOn(match: (r: Req) => boolean, answer: Answer, times = 1) {
  rules.push({ match, answer, left: times });
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const writeLog = () => writes().map((c) => `${c.method} ${c.path}`);
const eventsOf = (cal: string) => evs.get(cal) ?? new Map<string, Row>();
const stored = (cal: string, id: string) => eventsOf(cal).get(id);

/** Google's dateTime: the wall time with its offset. */
const dt = (instant: Date, zone: string) => formatInTimeZone(instant, zone, "yyyy-MM-dd'T'HH:mm:ssXXX");
const at = (local: string, zone = IL) => fromZonedTime(local, zone);
const utcStamp = (d: Date) => formatInTimeZone(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");

/** EXDATE/RDATE values of a line as instants (timed) or dates. */
function lineValues(line: string, zone: string): Array<{ date?: string; instant?: Date }> {
  const colon = line.indexOf(':');
  const head = line.slice(0, colon);
  const tzid = /TZID=([^;:]+)/i.exec(head)?.[1];
  return line.slice(colon + 1).split(',').map((v) => {
    if (/^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
    const wall = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}`;
    return { instant: v.endsWith('Z') ? new Date(`${wall}Z`) : fromZonedTime(wall, tzid ?? zone) };
  });
}

/** The fake's own expansion of a master: slots as Google would list them (exceptions not applied). */
function slotsOf(cal: string, m: Row): Row[] {
  const rr = (m.recurrence ?? []).find((l: string) => /^RRULE:/i.test(l));
  if (!rr) return [];
  const zone = m.start.timeZone ?? cals.get(cal)?.timeZone ?? IL;
  const allDay = Boolean(m.start.date);
  const parts = rr.slice(6).split(';');
  const until = parts.find((p: string) => /^UNTIL=/i.test(p))?.slice(6);
  const countPart = parts.find((p: string) => /^COUNT=/i.test(p));
  const count = countPart ? Number(countPart.slice(6)) : undefined;
  const rest = parts.filter((p: string) => !/^(UNTIL|COUNT)=/i.test(p)).join(';');
  const opts = RRule.parseString(rest);
  const startFloat = allDay ? new Date(`${m.start.date}T00:00:00Z`) : new Date(`${formatInTimeZone(new Date(m.start.dateTime), zone, "yyyy-MM-dd'T'HH:mm:ss")}Z`);
  const durMs = allDay ? Date.parse(m.end.date) - Date.parse(m.start.date) : Date.parse(m.end.dateTime) - Date.parse(m.start.dateTime);
  const floats = new RRule({ ...opts, dtstart: startFloat }).all((_d, i) => i < (count ?? 400));
  const ex = (m.recurrence ?? []).filter((l: string) => /^EXDATE[:;]/i.test(l)).flatMap((l: string) => lineValues(l, zone));
  const out: Row[] = [];
  for (const f of floats) {
    if (allDay) {
      const date = f.toISOString().slice(0, 10);
      if (until && date.replace(/-/g, '') > until.slice(0, 8)) break;
      if (ex.some((e: Row) => e.date === date)) continue;
      const end = new Date(Date.parse(`${date}T00:00:00Z`) + durMs).toISOString().slice(0, 10);
      out.push({ id: `${m.id}_${date.replace(/-/g, '')}`, originalStartTime: { date }, start: { date }, end: { date: end } });
      continue;
    }
    const instant = fromZonedTime(f.toISOString().slice(0, 19), zone);
    if (until) {
      if (/^\d{8}$/.test(until)) {
        if (formatInTimeZone(instant, zone, 'yyyyMMdd') > until) break;
      } else if (until.endsWith('Z')) {
        if (utcStamp(instant) > until) break;
      } else if (f.toISOString().replace(/[-:]/g, '').slice(0, 15) > until) break;
    }
    if (ex.some((e: Row) => e.instant?.getTime() === instant.getTime())) continue;
    const tz = m.start.timeZone;
    out.push({
      id: `${m.id}_${utcStamp(instant)}`,
      originalStartTime: { dateTime: dt(instant, zone), ...(tz ? { timeZone: tz } : {}) },
      start: { dateTime: dt(instant, zone), ...(tz ? { timeZone: tz } : {}) },
      end: { dateTime: dt(new Date(instant.getTime() + durMs), zone), ...(m.end.timeZone ? { timeZone: m.end.timeZone } : {}) },
    });
  }
  return out;
}

const SERIES_FIELDS = ['summary', 'description', 'location', 'colorId', 'reminders', 'visibility', 'transparency', 'attendees', 'organizer', 'creator', 'eventType', 'locked', 'attendeesOmitted', 'conferenceData', 'attachments', 'extendedProperties', 'htmlLink', 'status'];

/** A master's instances: its slots with its exceptions over them, plus exceptions with no slot (strays). */
function instancesOf(cal: string, m: Row): Row[] {
  const exceptions = [...eventsOf(cal).values()].filter((e) => e.recurringEventId === m.id);
  const slots = slotsOf(cal, m).map((s) => {
    const own = exceptions.find((e) => e.id === s.id);
    if (own) return own;
    const base: Row = {};
    for (const f of SERIES_FIELDS) if (m[f] !== undefined) base[f] = structuredClone(m[f]);
    return { ...base, status: 'confirmed', ...s, recurringEventId: m.id };
  });
  const strays = exceptions.filter((e) => !slots.some((s) => s.id === e.id));
  return [...slots, ...strays];
}

/** The event an id names: a stored one (master, one-off, exception), or an unmodified instance. */
function findEvent(cal: string, id: string): Row | undefined {
  const own = stored(cal, id);
  if (own) return own;
  const masterId = id.split('_')[0];
  const m = stored(cal, masterId);
  if (!m || masterId === id) return undefined;
  return instancesOf(cal, m).find((i) => i.id === id);
}

function badRecurrence(body: Row | undefined): string | null {
  for (const line of body?.recurrence ?? []) {
    if (!/^(RRULE|EXDATE|RDATE)[:;]/i.test(line)) return `bad line ${line}`;
    if (/^RRULE:/i.test(line) && /(^|;)UNTIL=/i.test(line) && /(^|;)COUNT=/i.test(line)) return 'Invalid recurrence rule.';
  }
  return null;
}

const instantOf = (s: Row | undefined, zone: string) => (s?.dateTime ? new Date(s.dateTime) : s?.date ? fromZonedTime(`${s.date}T00:00:00`, zone) : null);

function serve(req: Req): Answer {
  const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
  // users/me/calendarList[/id]
  if (seg[0] === 'users') {
    if (seg.length === 3) {
      const min = req.params.minAccessRole;
      const items = [...cals.entries()]
        .filter(([, c]) => !min || (min === 'writer' ? ['owner', 'writer'].includes(c.accessRole) : true))
        .map(([id, c]) => ({ id, ...c }));
      return { status: 200, data: { items } };
    }
    const c = cals.get(seg[3]);
    return c ? { status: 200, data: { id: seg[3], ...c } } : fail(404, 'notFound', 'Not Found');
  }
  // calendars/{cal}/events[/{id}[/instances|/move]]
  const cal = seg[1];
  const meta = cals.get(cal);
  if (!meta) return fail(404, 'notFound', 'Not Found');
  const writable = ['owner', 'writer'].includes(meta.accessRole);
  const id = seg[3];
  const tail = seg[4];
  if (req.method !== 'GET' && !writable) return fail(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.');
  if (!id && req.method === 'POST') {
    const bad = badRecurrence(req.body);
    if (bad) return fail(400, 'invalid', bad);
    if (req.body?.recurrence?.length && req.body.start?.dateTime && !req.body.start.timeZone) return fail(400, 'invalid', 'Missing time zone definition for start time.');
    const nid = `new${++seq}`;
    const ev = { ...structuredClone(req.body), id: nid, status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${nid}` };
    if (!evs.has(cal)) evs.set(cal, new Map());
    eventsOf(cal).set(nid, ev);
    return { status: 200, data: ev };
  }
  if (tail === 'instances') {
    const m = stored(cal, id);
    if (!m || !m.recurrence) return fail(404, 'notFound', 'Not Found');
    let list = instancesOf(cal, m);
    if (!req.params.showDeleted) list = list.filter((i) => i.status !== 'cancelled');
    const zone = m.start.timeZone ?? meta.timeZone;
    if (req.params.timeMin) list = list.filter((i) => instantOf(i.end, zone)! > new Date(req.params.timeMin));
    if (req.params.timeMax) list = list.filter((i) => instantOf(i.start, zone)! < new Date(req.params.timeMax));
    if (req.params.originalStart) {
      const want = String(req.params.originalStart);
      list = list.filter((i) => (i.originalStartTime?.date ? i.originalStartTime.date === want : new Date(i.originalStartTime.dateTime).getTime() === new Date(want).getTime()));
    }
    if (req.params.maxResults) list = list.slice(0, Number(req.params.maxResults));
    return { status: 200, data: { items: structuredClone(list) } };
  }
  if (tail === 'move') {
    const ev = stored(cal, id);
    if (!ev) return fail(404, 'notFound', 'Not Found');
    if (ev.recurringEventId) return fail(400, 'invalid', 'Cannot move an instance of a recurring event.');
    const dest = String(req.params.destination);
    const dmeta = cals.get(dest);
    if (!dmeta) return fail(404, 'notFound', 'Not Found');
    if (!['owner', 'writer'].includes(dmeta.accessRole)) return fail(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.');
    if (!evs.has(dest)) evs.set(dest, new Map());
    for (const e of [...eventsOf(cal).values()].filter((x) => x.id === id || x.recurringEventId === id)) {
      eventsOf(cal).delete(e.id);
      eventsOf(dest).set(e.id, e);
    }
    return { status: 200, data: ev };
  }
  if (req.method === 'GET') {
    const ev = findEvent(cal, id);
    if (!ev) return gone.has(`${cal}|${id}`) ? fail(410, 'deleted', 'Resource has been deleted') : fail(404, 'notFound', 'Not Found');
    return { status: 200, data: structuredClone(ev) };
  }
  if (req.method === 'PATCH') {
    const ev = findEvent(cal, id);
    if (!ev) return fail(404, 'notFound', 'Not Found');
    if (ev.recurringEventId && req.body?.recurrence) return fail(400, 'invalid', 'An instance has no recurrence.');
    const bad = badRecurrence(req.body);
    if (bad) return fail(400, 'invalid', bad);
    const next = { ...structuredClone(ev), ...structuredClone(req.body ?? {}) };
    eventsOf(cal).set(id, next);
    return { status: 200, data: next };
  }
  if (req.method === 'DELETE') {
    const ev = findEvent(cal, id);
    if (!ev || ev.status === 'cancelled') return gone.has(`${cal}|${id}`) ? fail(410, 'deleted', 'Resource has been deleted') : fail(404, 'notFound', 'Not Found');
    if (ev.recurringEventId) {
      eventsOf(cal).set(id, { ...ev, status: 'cancelled' });
    } else {
      for (const e of [...eventsOf(cal).values()]) if (e.id === id || e.recurringEventId === id) eventsOf(cal).delete(e.id);
    }
    gone.add(`${cal}|${id}`);
    return { status: 204, data: '' };
  }
  return fail(400, 'invalid', `unknown ${req.method} ${req.path}`);
}

const calendarRequire = createRequire(require.resolve('@googleapis/calendar'));
const gaxiosModule = calendarRequire('gaxios') as { Gaxios: { prototype: { _defaultAdapter: (opts: Row) => Promise<unknown> } } };

function installFakeGoogle(): void {
  const authGaxios = createRequire(calendarRequire.resolve('google-auth-library'))('gaxios');
  const commonGaxios = createRequire(calendarRequire.resolve('googleapis-common'))('gaxios');
  if (authGaxios !== gaxiosModule || commonGaxios !== gaxiosModule) {
    console.error('FAIL  the Google client loads more than one gaxios; refusing to run without the fake');
    process.exit(1);
  }
  gaxiosModule.Gaxios.prototype._defaultAdapter = async function (opts: Row) {
    const url = new URL(String(opts.url));
    let answer: Answer;
    if (`${url.origin}${url.pathname}` === TOKEN_URL) {
      answer = tokenAnswer ?? { status: 200, data: { access_token: 'fake-access', expires_in: 3600, token_type: 'Bearer' } };
    } else {
      if (!url.href.startsWith(API)) throw new Error(`unexpected URL ${url.href}`);
      const params: Row = { ...Object.fromEntries(url.searchParams), ...(opts.params ?? {}) };
      const body = typeof opts.data === 'string' ? JSON.parse(opts.data) : opts.data;
      const req: Req = { method: String(opts.method ?? 'GET').toUpperCase(), path: url.pathname.slice('/calendar/v3'.length), params, body: body === undefined ? undefined : structuredClone(body) };
      calls.push(req);
      const rule = rules.find((r) => r.left > 0 && r.match(req));
      if (rule) {
        rule.left--;
        answer = rule.answer;
      } else {
        answer = serve(req);
      }
    }
    return { config: opts, data: answer.data, headers: {}, status: answer.status, statusText: String(answer.status), request: { responseURL: String(opts.url) } };
  };
}

// ---- Recorders and stubs ----

const stamps: string[] = [];
const captured: { ctx: string; error: unknown; extra: Row | undefined; severity?: string }[] = [];
const tracked: { userId: number; action: string; meta: Row }[] = [];
const consoleLines: string[] = [];
const TZS: Record<number, string> = {};

class FakeUpstash {
  async set(key: string) {
    stamps.push(key);
    return 'OK';
  }
  async get() {
    return null;
  }
}

const SRC = path.resolve(__dirname, '../src');
const noModel = (model: string) => new Proxy({}, { get: (_m, op) => async () => { throw new Error(`no database in this smoke (${model}.${String(op)})`); } });
/** Each user's FamCal main calendar (Google as a connection: everyone has FamCal), labelled
 *  yours only, as the lazy one is beside a Google primary. The database holds nothing else. */
const famcalMain = (ownerUserId: number) => ({
  id: `fam-${ownerUserId}`, ownerUserId, name: 'Noa', color: '#039BE5', labels: ['yours'], rules: [], privacy: 'PRIVATE',
  isDeleted: false, personName: null, personEnglishName: null, personGender: null, createdAt: new Date(0), updatedAt: new Date(0),
});
const ownerIn = (where: Row | undefined): number => where?.ownerUserId ?? where?.OR?.[0]?.ownerUserId;
const noDb = new Proxy({}, {
  get: (_t, model) => (model === 'then' ? undefined : model === 'nativeCalendar'
    ? { findMany: async (a: Row) => [famcalMain(ownerIn(a?.where))], findFirst: async (a: Row) => famcalMain(ownerIn(a?.where)) }
    // listUserCalendars hides FamCal's copy calendars (google-sync S2); nobody here has one
    : model === 'googleSyncLink' ? { findMany: async () => [] }
    : noModel(String(model))),
});
/** The reminders switch is on and no plan here has reminders, so no feature check reaches the database. */
const fakeRedis = new Proxy({} as Row, {
  get: (_t, p) => (p === 'then' ? undefined : p === 'get'
    ? async (key: string) => (key === 'nrem:enabled' ? true : key.startsWith('feature:access:') ? { allowed: false } : null)
    : async () => null),
});
const stubs: Record<string, object> = {
  '@upstash/redis': { Redis: FakeUpstash },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: noDb, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, ctx: string, extra?: Row, severity?: string) => { captured.push({ ctx, error, extra, severity }); },
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  },
  [`${SRC}/lib/timezone.ts`]: {
    resolveUserTimezone: async (u: { id: number }) => TZS[u.id] ?? IL,
    resolveTimezoneForLocation: async () => null,
  },
  [`${SRC}/services/hebrew-holidays.ts`]: { getHolidaysForDate: async () => [], weekParashaFor: () => null },
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (userId: number, action: string, meta: Row) => { tracked.push({ userId, action, meta }); },
    trackActivity: async () => undefined,
  },
};
stubs[require.resolve('@upstash/redis')] = stubs['@upstash/redis'];

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  // @hebcal/core ships ESM only and can't be required; nothing here uses it (claude.ts and
  // the holidays module are reached through the write modules' imports).
  if (request.startsWith('@hebcal/')) return {};
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {
    // an unresolvable request is left for the real loader to report
  }
  const stub = stubs[request in stubs ? request : resolved];
  return stub ?? realLoad.call(this, request, parent, isMain);
};
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map((name) => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Fixtures ----

const NOA_CAL = 'noa@gmail.com';
const FAMILY = 'family@group.calendar.google.com';
const HOLIDAYS = 'en.jewish#holiday@group.v.calendar.google.com';
const WORK = 'work@group.calendar.google.com';
const NY_CAL = 'ny@group.calendar.google.com';
const DANA = 'dana@gmail.com';

const ASSIGNMENTS: CalendarAssignment[] = [
  { calendarId: NOA_CAL, labels: ['primary', 'yours'], name: 'Noa', color: '#7986cb' },
  { calendarId: FAMILY, labels: ['kids'], name: 'Family', color: '#33b679' },
  { calendarId: HOLIDAYS, labels: [], name: 'Holidays', color: '#16a765' },
  { calendarId: NY_CAL, labels: [], name: 'New York', color: '#4986e7' },
  { calendarId: DANA, labels: ['spouse'], name: 'Dana', color: '#f4511e', personName: 'Dana' },
];

function user(id: number, tz: string, o: Partial<UserConfig> = {}): UserConfig {
  TZS[id] = tz;
  return {
    id, telegramId: 1000 + id, name: 'Noa', language: 'en', location: 'Tel Aviv', calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token',
    calendarAssignments: structuredClone(ASSIGNMENTS), pairingId: null, ...o,
  } as unknown as UserConfig;
}
const NOA = user(7, IL);
const NOA_NY = user(8, NY);

function reset() {
  cals.clear();
  evs.clear();
  gone.clear();
  calls.length = 0;
  stamps.length = 0;
  captured.length = 0;
  tracked.length = 0;
  rules = [];
  tokenAnswer = null;
  seq = 0;
  cals.set(NOA_CAL, { summary: 'noa@gmail.com', accessRole: 'owner', primary: true, timeZone: IL, backgroundColor: '#9fc6e7' });
  cals.set(FAMILY, { summary: 'Family', accessRole: 'writer', timeZone: IL, backgroundColor: '#33b679' });
  cals.set(HOLIDAYS, { summary: 'Jewish Holidays', accessRole: 'reader', timeZone: IL, backgroundColor: '#16a765' });
  cals.set(WORK, { summary: 'Work', accessRole: 'owner', timeZone: IL, backgroundColor: '#ff887c' });
  cals.set(NY_CAL, { summary: 'NY', accessRole: 'owner', timeZone: NY, backgroundColor: '#4986e7' });
  cals.set(DANA, { summary: 'dana@gmail.com', accessRole: 'writer', timeZone: IL, backgroundColor: '#f4511e' });
}

/** A stored event (master or one-off) on `cal`, its times as wall times in `zone`. */
function seed(cal: string, id: string, o: { start: string; end?: string; zone?: string; allDay?: boolean; recurrence?: string[]; noZone?: boolean } & Row): Row {
  const { start, end, zone = IL, allDay, recurrence, noZone, ...extra } = o;
  const ev: Row = {
    id, status: 'confirmed', summary: `Event ${id}`, htmlLink: `https://calendar.google.com/event?eid=${id}`,
    organizer: { email: cal, self: true }, creator: { email: cal, self: true }, eventType: 'default', ...extra,
  };
  if (allDay) {
    ev.start = { date: start };
    ev.end = { date: end ?? new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) };
  } else {
    const s = at(start, zone);
    const e = end ? at(end, zone) : new Date(s.getTime() + 3_600_000);
    ev.start = { dateTime: dt(s, zone), ...(noZone ? {} : { timeZone: zone }) };
    ev.end = { dateTime: dt(e, zone), ...(noZone ? {} : { timeZone: zone }) };
  }
  if (recurrence) ev.recurrence = recurrence;
  if (!evs.has(cal)) evs.set(cal, new Map());
  eventsOf(cal).set(id, ev);
  return ev;
}

/** An exception: the instance of `masterId` at `slotId` with `fields` over it. */
function seedException(cal: string, slotId: string, fields: Row): Row {
  const inst = findEvent(cal, slotId);
  assert(inst, `no instance ${slotId}`);
  const ev = { ...structuredClone(inst), ...fields };
  eventsOf(cal).set(slotId, ev);
  return ev;
}

const inst = (masterId: string, local: string, zone = IL) => `${masterId}_${utcStamp(at(local, zone))}`;
const instDay = (masterId: string, day: string) => `${masterId}_${day.replace(/-/g, '')}`;
/** A stored event that isn't cancelled (deleting an occurrence cancels it, as Google does). */
const alive = (cal: string, id: string) => Boolean(stored(cal, id)) && stored(cal, id)!.status !== 'cancelled';
const visible = (cal: string, masterId: string) => instancesOf(cal, stored(cal, masterId)!).filter((i) => i.status !== 'cancelled');
const rrLines = () => writes().flatMap((c) => (c.body?.recurrence ?? []) as string[]).filter((l) => /^RRULE:/i.test(l));

const WEEKLY_TUE = (o: Row = {}) => seed(NOA_CAL, 'wk', { start: '2026-10-06T10:00:00', summary: 'Team sync', recurrence: ['RRULE:FREQ=WEEKLY'], ...o });

const load = (rel: string): Promise<Row> => import(path.join(SRC, rel));

const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };

async function main() {
  installFakeGoogle();
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    (console as Row)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
  }

  const { googleProvider } = await load('services/calendar-provider/google-provider.ts');
  const { wouldRefuseFixedDays } = await load('services/calendar-provider/native-provider.ts');
  const write = await load('services/calendar-write/write.ts');
  const info = await load('services/calendar-write/item-info.ts');
  // Loaded apart: until it exists, its checks fail one by one instead of the whole run.
  const gitem = await load('services/calendar-write/google-item.ts').catch((err: Error) => {
    quiet.error(`google-item.ts did not load: ${err.message.split('\n')[0]}`);
    return {} as Row;
  });
  const validate = await load('services/calendar-write/validate.ts');
  const { writeResponse } = await load('services/calendar-write/respond.ts');

  const update = (u: UserConfig, cal: string, id: string, data: Row) => googleProvider.updateEvent(u, cal, id, data);
  const remove = (u: UserConfig, cal: string, id: string, opts: Row) => googleProvider.deleteEvent(u, cal, id, opts);
  const patchCmd = (raw: Row) => {
    const parsed = validate.parseUpdate(raw);
    assert(parsed.ok, `parseUpdate refused ${show(raw)}: ${show(parsed)}`);
    return parsed.value;
  };
  const deleteCmd = (raw: Row) => {
    const parsed = validate.parseDelete(raw);
    assert(parsed.ok, `parseDelete refused ${show(raw)}: ${show(parsed)}`);
    return parsed.value;
  };
  const createCmd = (raw: Row) => {
    const parsed = validate.parseCreate(raw);
    assert(parsed.ok, `parseCreate refused ${show(raw)}: ${show(parsed)}`);
    return parsed.value;
  };
  const gkey = (cal: string, id: string) => `google|${cal}|${id}`;
  const editInfo = async (u: UserConfig, key: string) => {
    const k = validate.parseAnyItemKey(key);
    assert(k, `key ${key} did not parse`);
    return info.itemInfoFor(u, k, TZS[u.id]);
  };

  // ---- Errors: one classifier for every write, real GaxiosErrors ----

  await check('errors: a 403 on a read-only calendar is FORBIDDEN, not a dead token; what is logged is the class and status, never the request (titles)', async () => {
    seed(HOLIDAYS, 'h1', { start: '2026-10-20T10:00:00' });
    cals.get(HOLIDAYS)!.accessRole = 'writer';
    failOn((r) => r.method === 'PATCH', fail(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.'));
    const r = await update(NOA, HOLIDAYS, 'h1', { title: 'Zebra Private Title', scope: 'single' });
    assertSame([r.success, r.error], [false, 'FORBIDDEN'], 'result');
    const e = captured.find((c) => c.ctx === 'calendar-update-event')?.error as Row;
    assert(e && e.status === 403 && /forbidden/.test(e.message) && /requiredAccessLevel/.test(e.message), `captured ${show(e)} ${e?.message}`);
    assert(!('config' in e) && !('response' in e) && !show(captured.map((c) => [String((c.error as Error)?.message), c.extra])).includes('Zebra'), 'the request reached the log');
  });

  await check('errors: a 403 for missing scopes stays PERMISSION_DENIED (the grant-write flow)', async () => {
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    failOn((r) => r.method === 'PATCH', fail(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.'));
    const r = await update(NOA, NOA_CAL, 'e1', { title: 'x' });
    assertSame(r.error, 'PERMISSION_DENIED', 'error');
  });

  await check('errors: a dead refresh token (invalid_grant) and a 401 are TOKEN_EXPIRED', async () => {
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    tokenAnswer = { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    assertSame((await update(NOA, NOA_CAL, 'e1', { title: 'x' })).error, 'TOKEN_EXPIRED', 'invalid_grant');
    tokenAnswer = null;
    failOn((r) => r.method === 'DELETE', fail(401, 'authError', 'Invalid Credentials'));
    assertSame((await remove(NOA, NOA_CAL, 'e1', { scope: 'single' })).error, 'TOKEN_EXPIRED', '401');
  });

  await check('errors: 404 and 410 are NOT_FOUND', async () => {
    assertSame((await update(NOA, NOA_CAL, 'missing', { title: 'x' })).error, 'NOT_FOUND', 'patch 404');
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    assert((await remove(NOA, NOA_CAL, 'e1', { scope: 'single' })).success, 'first delete');
    assertSame((await remove(NOA, NOA_CAL, 'e1', { scope: 'single' })).error, 'NOT_FOUND', 'delete 410');
  });

  await check('errors: a rate limit (429, or a 403 with a rate-limit reason) and a 5xx are UNKNOWN_ERROR with retryable', async () => {
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    failOn((r) => r.method === 'PATCH', fail(429, 'rateLimitExceeded', 'Rate Limit Exceeded'));
    const a = await update(NOA, NOA_CAL, 'e1', { title: 'x' });
    assertSame([a.error, a.retryable], ['UNKNOWN_ERROR', true], '429');
    failOn((r) => r.method === 'PATCH', fail(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded'));
    const b = await update(NOA, NOA_CAL, 'e1', { title: 'x' });
    assertSame([b.error, b.retryable], ['UNKNOWN_ERROR', true], '403 rate limit');
    failOn((r) => r.method === 'POST', fail(500, 'backendError', 'Backend Error'));
    const c = await googleProvider.createEvent(NOA, NOA_CAL, { title: 'x', startTime: at('2026-10-20T10:00:00'), endTime: at('2026-10-20T11:00:00') });
    assertSame([c.error, c.retryable], ['UNKNOWN_ERROR', true], '500 on insert');
  });

  await check('errors: a create on a calendar the user only reads is FORBIDDEN', async () => {
    const r = await googleProvider.createEvent(NOA, HOLIDAYS, { title: 'x', startTime: at('2026-10-20T10:00:00'), endTime: at('2026-10-20T11:00:00') });
    assertSame(r.error, 'FORBIDDEN', 'create');
  });

  await check('errors: "this one and the ones after" delete refused by Google (not the organizer) is FORBIDDEN', async () => {
    WEEKLY_TUE();
    failOn((r) => r.method === 'PATCH', fail(403, 'forbiddenForNonOrganizer', 'Shared properties can only be changed by the organizer of the event.'));
    const r = await remove(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { scope: 'following', recurringEventId: 'wk' });
    assertSame(r.error, 'FORBIDDEN', 'delete following');
  });

  await check('errors: a refused move (cannotChangeOrganizer) is FORBIDDEN', async () => {
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    failOn((r) => r.path.endsWith('/move'), fail(403, 'cannotChangeOrganizer', 'Cannot change the organizer of an instance.'));
    const r = await googleProvider.moveEvent(NOA, { eventId: 'e1', fromCalendarId: NOA_CAL, toCalendarId: FAMILY });
    assertSame(r.error, 'FORBIDDEN', 'move');
  });

  // ---- The stamp after every write ----

  await check('stamp: every write stamps the user\'s cache once, a failed one too', async () => {
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    await update(NOA, NOA_CAL, 'e1', { title: 'x' });
    failOn((r) => r.method === 'PATCH', fail(500, 'backendError', 'Backend Error'));
    await update(NOA, NOA_CAL, 'e1', { title: 'y' });
    await googleProvider.createEvent(NOA, NOA_CAL, { title: 'x', startTime: at('2026-10-21T10:00:00'), endTime: at('2026-10-21T11:00:00') });
    await googleProvider.moveEvent(NOA, { eventId: 'e1', fromCalendarId: NOA_CAL, toCalendarId: FAMILY });
    await remove(NOA, FAMILY, 'e1', { scope: 'single' });
    assertSame(stamps, Array(5).fill('gcal:stamp:7'), 'stamps');
  });

  // ---- Zone ----

  await check('zone: a new event is written in the user\'s zone, not Asia/Jerusalem', async () => {
    const r = await googleProvider.createEvent(NOA_NY, NOA_CAL, { title: 'Lunch', startTime: at('2026-10-20T12:00:00', NY), endTime: at('2026-10-20T13:00:00', NY), recurrence: ['RRULE:FREQ=WEEKLY'] });
    assert(r.success, `create ${show(r)}`);
    const body = writes()[0].body!;
    assertSame([body.start.timeZone, body.end.timeZone, new Date(body.start.dateTime).toISOString()], [NY, NY, at('2026-10-20T12:00:00', NY).toISOString()], 'start');
  });

  await check('zone: an edit is written in the event\'s own zone; with none, the calendar\'s; then the user\'s', async () => {
    seed(NOA_CAL, 'lon', { start: '2026-10-20T10:00:00', zone: 'Europe/London' });
    await update(NOA, NOA_CAL, 'lon', { startTime: at('2026-10-20T11:00:00', 'Europe/London'), endTime: at('2026-10-20T12:00:00', 'Europe/London') });
    assertSame(writes()[0].body!.start.timeZone, 'Europe/London', 'own zone');
    calls.length = 0;
    seed(NY_CAL, 'nz', { start: '2026-10-20T10:00:00', zone: NY, noZone: true });
    await update(NOA, NY_CAL, 'nz', { startTime: at('2026-10-20T11:00:00', NY), endTime: at('2026-10-20T12:00:00', NY) });
    assertSame(writes()[0].body!.start.timeZone, NY, 'the calendar\'s zone');
    calls.length = 0;
    seed(NY_CAL, 'nz2', { start: '2026-10-20T10:00:00', zone: NY, noZone: true });
    failOn((r) => r.method === 'GET' && r.path.startsWith('/users/me/calendarList/'), fail(404, 'notFound', 'Not Found'));
    await update(NOA_NY, NY_CAL, 'nz2', { startTime: at('2026-10-20T11:00:00', NY), endTime: at('2026-10-20T12:00:00', NY) });
    assertSame(writes()[0].body!.start.timeZone, NY, 'the user\'s zone');
  });

  // ---- 'all' with a time change: the master shifts, history stays ----

  await check('all: the bot\'s time change on an occurrence shifts the master on its own day and keeps every earlier occurrence', async () => {
    WEEKLY_TUE();
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), {
      startTime: at('2026-10-20T11:30:00'), endTime: at('2026-10-20T12:30:00'), scope: 'all', recurringEventId: 'wk',
    });
    assert(r.success, `update ${show(r)}`);
    const m = stored(NOA_CAL, 'wk')!;
    assertSame([new Date(m.start.dateTime).toISOString(), new Date(m.end.dateTime).toISOString(), m.start.timeZone], [at('2026-10-06T11:30:00').toISOString(), at('2026-10-06T12:30:00').toISOString(), IL], 'master');
    const first = visible(NOA_CAL, 'wk').slice(0, 3).map((i) => new Date(i.start.dateTime).toISOString());
    assertSame(first, ['2026-10-06T11:30:00', '2026-10-13T11:30:00', '2026-10-20T11:30:00'].map((l) => at(l).toISOString()), 'history kept, across DST at 11:30 local');
    assertSame(r.instanceId, inst('wk', '2026-10-20T11:30:00'), 'the opened occurrence\'s new id');
  });

  await check('all: a day move shifts the master by the same days; an all-day series by whole days', async () => {
    WEEKLY_TUE();
    await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { startTime: at('2026-10-21T10:00:00'), endTime: at('2026-10-21T11:00:00'), scope: 'all', recurringEventId: 'wk' });
    assertSame(new Date(stored(NOA_CAL, 'wk')!.start.dateTime).toISOString(), at('2026-10-07T10:00:00').toISOString(), 'timed');
    seed(NOA_CAL, 'ad', { start: '2026-10-10', allDay: true, recurrence: ['RRULE:FREQ=DAILY'] });
    await update(NOA, NOA_CAL, instDay('ad', '2026-10-20'), { startTime: at('2026-10-22T00:00:00'), endTime: at('2026-10-22T23:59:00'), allDay: true, scope: 'all', recurringEventId: 'ad' });
    const m = stored(NOA_CAL, 'ad')!;
    assertSame([m.start.date, m.end.date, m.start.dateTime, visible(NOA_CAL, 'ad')[0].start.date], ['2026-10-12', '2026-10-13', undefined, '2026-10-12'], 'all-day');
  });

  await check('all: the shift is on the wall clock in the event\'s zone, across its own DST change', async () => {
    seed(NY_CAL, 'nyw', { start: '2026-10-27T09:00:00', zone: NY, recurrence: ['RRULE:FREQ=WEEKLY'] });
    await update(NOA, NY_CAL, inst('nyw', '2026-11-10T09:00:00', NY), { startTime: at('2026-11-10T10:00:00', NY), endTime: at('2026-11-10T11:00:00', NY), scope: 'all', recurringEventId: 'nyw' });
    const m = stored(NY_CAL, 'nyw')!;
    assertSame([new Date(m.start.dateTime).toISOString(), m.start.timeZone], [at('2026-10-27T10:00:00', NY).toISOString(), NY], '10:00 EDT');
  });

  await check('all: a day move carries the UNTIL with the series, so its last occurrence stays', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261124T215959Z'] });
    const before = visible(NOA_CAL, 'wk').length;
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { startTime: at('2026-10-21T10:00:00'), endTime: at('2026-10-21T11:00:00'), scope: 'all', recurringEventId: 'wk' });
    assert(r.success, `update ${show(r)}`);
    const shown = visible(NOA_CAL, 'wk').map((i) => new Date(i.start.dateTime).toISOString());
    assertSame([before, shown.length, shown[shown.length - 1]], [8, 8, at('2026-11-25T10:00:00').toISOString()], 'occurrences');
    assertSame(stored(NOA_CAL, 'wk')!.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261125T215959Z'], 'rule');
    seed(NOA_CAL, 'adu', { start: '2026-10-10', allDay: true, recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261020'] });
    await update(NOA, NOA_CAL, instDay('adu', '2026-10-15'), { startTime: at('2026-10-17T00:00:00'), endTime: at('2026-10-17T23:59:00'), allDay: true, scope: 'all', recurringEventId: 'adu' });
    assertSame([stored(NOA_CAL, 'adu')!.recurrence, visible(NOA_CAL, 'adu').length], [['RRULE:FREQ=DAILY;UNTIL=20261022'], 11], 'all-day');
  });

  await check('following: a day move carries the UNTIL with the new part (from a later occurrence, and from the first, run as "all"), so the last occurrence stays', async () => {
    const until = ['RRULE:FREQ=WEEKLY;UNTIL=20261124T215959Z'];
    WEEKLY_TUE({ recurrence: until });
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-27T10:00:00'), { startTime: at('2026-10-28T10:00:00'), endTime: at('2026-10-28T11:00:00'), scope: 'following', recurringEventId: 'wk' });
    assert(r.success, `later ${show(r)}`);
    const tail = visible(NOA_CAL, r.eventId).map((i) => new Date(i.start.dateTime).toISOString());
    assertSame([visible(NOA_CAL, 'wk').length + tail.length, tail[tail.length - 1]], [8, at('2026-11-25T10:00:00').toISOString()], 'later');
    reset();
    WEEKLY_TUE({ recurrence: until });
    const f = await update(NOA, NOA_CAL, inst('wk', '2026-10-06T10:00:00'), { startTime: at('2026-10-07T10:00:00'), endTime: at('2026-10-07T11:00:00'), scope: 'following', recurringEventId: 'wk' });
    assert(f.success && f.eventId === 'wk', `first ${show(f)}`);
    assertSame(visible(NOA_CAL, 'wk').length, 8, 'first');
  });

  await check('all: a time or day change moves the EXDATE and RDATE values with the series, so an excluded occurrence stays excluded', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE;TZID=Asia/Jerusalem:20261013T100000', 'RDATE:20261231T080000Z'] });
    assertSame(visible(NOA_CAL, 'wk').length, 4, 'before');
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { startTime: at('2026-10-20T11:00:00'), endTime: at('2026-10-20T12:00:00'), scope: 'all', recurringEventId: 'wk' });
    assert(r.success, `update ${show(r)}`);
    const shown = visible(NOA_CAL, 'wk').map((i) => new Date(i.start.dateTime).toISOString());
    assertSame(shown.length, 4, `after (got ${show(shown)})`);
    assert(!shown.includes(at('2026-10-13T11:00:00').toISOString()), 'the excluded occurrence came back');
    assertSame(stored(NOA_CAL, 'wk')!.recurrence, ['RRULE:FREQ=WEEKLY;COUNT=5', `EXDATE:${utcStamp(at('2026-10-13T11:00:00'))}`, `RDATE:${utcStamp(at('2026-12-31T11:00:00'))}`], 'lines');
    seed(NOA_CAL, 'adx', { start: '2026-10-10', allDay: true, recurrence: ['RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20261012'] });
    await update(NOA, NOA_CAL, instDay('adx', '2026-10-11'), { startTime: at('2026-10-13T00:00:00'), endTime: at('2026-10-13T23:59:00'), allDay: true, scope: 'all', recurringEventId: 'adx' });
    assertSame([stored(NOA_CAL, 'adx')!.recurrence, visible(NOA_CAL, 'adx').length], [['RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20261014'], 4], 'all-day');
  });

  // ---- 'all' on a yearly series: by its years (editor upgrades spec §1, one rule with FamCal's) ----

  const dayOf = (i: Row) => (i.start.date ?? formatInTimeZone(new Date(i.start.dateTime), IL, 'yyyy-MM-dd')) as string;

  await check('all, yearly far: 1985 picked on this year\'s occurrence is the master\'s first date; an EXDATE on a later year stays; the opened occurrence keeps its id; the editor\'s path too', async () => {
    const exdate = `EXDATE:${utcStamp(at('2028-03-02T10:00:00'))}`;
    seed(NOA_CAL, 'yr', { start: '2020-03-02T10:00:00', summary: 'Birthday', recurrence: ['RRULE:FREQ=YEARLY', exdate] });
    const r = await update(NOA, NOA_CAL, inst('yr', '2026-03-02T10:00:00'), { startTime: at('1985-03-02T10:00:00'), endTime: at('1985-03-02T11:00:00'), scope: 'all', recurringEventId: 'yr' });
    assert(r.success, `update ${show(r)}`);
    const m = stored(NOA_CAL, 'yr')!;
    assertSame([new Date(m.start.dateTime).toISOString(), new Date(m.end.dateTime).toISOString(), m.recurrence], [at('1985-03-02T10:00:00').toISOString(), at('1985-03-02T11:00:00').toISOString(), ['RRULE:FREQ=YEARLY', exdate]], 'the master from 1985 (the day shift gave 1979)');
    assertSame(r.instanceId, inst('yr', '2026-03-02T10:00:00'), 'the opened occurrence');
    const days = visible(NOA_CAL, 'yr').map(dayOf);
    assertSame([days[0], days.includes('2027-03-02'), days.includes('2028-03-02')], ['1985-03-02', true, false], 'every year on 2 March, 2028 still excluded');
    reset();
    seed(NOA_CAL, 'yr', { start: '2020-03-02T10:00:00', summary: 'Birthday', recurrence: ['RRULE:FREQ=YEARLY'] });
    const key = gkey(NOA_CAL, inst('yr', '2026-03-02T10:00:00'));
    const item = await write.updateItem(NOA, patchCmd({ key, scope: 'all', changes: { start: '1985-03-02T10:00', end: '1985-03-02T11:00' } }), IL);
    assertSame([item.status, new Date(stored(NOA_CAL, 'yr')!.start.dateTime).toISOString()], ['ok', at('1985-03-02T10:00:00').toISOString()], 'the home\'s edit');
  });

  await check('all, yearly near: 28 Feb moved to 1 Mar keeps the first year (1 Mar 2020, not 29 Feb); 31 Dec moved to 1 Jan (all day) starts on 1 Jan of the year after', async () => {
    seed(NOA_CAL, 'feb', { start: '2020-02-28T10:00:00', recurrence: ['RRULE:FREQ=YEARLY'] });
    const r = await update(NOA, NOA_CAL, inst('feb', '2026-02-28T10:00:00'), { startTime: at('2026-03-01T10:00:00'), endTime: at('2026-03-01T11:00:00'), scope: 'all', recurringEventId: 'feb' });
    assertSame([r.success, new Date(stored(NOA_CAL, 'feb')!.start.dateTime).toISOString(), r.instanceId], [true, at('2020-03-01T10:00:00').toISOString(), inst('feb', '2026-03-01T10:00:00')], 'from 1 Mar 2020');
    assertSame(visible(NOA_CAL, 'feb').slice(0, 5).map(dayOf), ['2020-03-01', '2021-03-01', '2022-03-01', '2023-03-01', '2024-03-01'], 'leap years too');
    seed(NOA_CAL, 'nye', { start: '2020-12-31', allDay: true, recurrence: ['RRULE:FREQ=YEARLY'] });
    const n = await update(NOA, NOA_CAL, instDay('nye', '2026-12-31'), { startTime: at('2027-01-01T00:00:00'), endTime: at('2027-01-01T23:59:00'), allDay: true, scope: 'all', recurringEventId: 'nye' });
    const m = stored(NOA_CAL, 'nye')!;
    assertSame([n.success, m.start.date, m.end.date, n.instanceId], [true, '2021-01-01', '2021-01-02', instDay('nye', '2027-01-01')], 'from 1 Jan 2021');
  });

  await check('all, yearly far forward: a later year is the first date; its COUNT becomes its last date, an EXDATE before the new start goes and a later one moves with its year', async () => {
    seed(NOA_CAL, 'fwd', { start: '2020-03-02T10:00:00', recurrence: ['RRULE:FREQ=YEARLY;COUNT=20', `EXDATE:${utcStamp(at('2022-03-02T10:00:00'))},${utcStamp(at('2031-03-02T10:00:00'))}`] });
    const r = await update(NOA, NOA_CAL, inst('fwd', '2026-03-02T10:00:00'), { startTime: at('2030-03-05T10:00:00'), endTime: at('2030-03-05T11:00:00'), scope: 'all', recurringEventId: 'fwd' });
    assert(r.success, `update ${show(r)}`);
    const m = stored(NOA_CAL, 'fwd')!;
    assertSame([new Date(m.start.dateTime).toISOString(), m.recurrence], [at('2030-03-05T10:00:00').toISOString(), [`RRULE:FREQ=YEARLY;UNTIL=${utcStamp(at('2039-03-05T23:59:59'))}`, `EXDATE:${utcStamp(at('2031-03-05T10:00:00'))}`]], 'the master');
    assertSame(r.instanceId, inst('fwd', '2030-03-05T10:00:00'), 'the opened year is before the new first date: the key is that date');
    const days = visible(NOA_CAL, 'fwd').map(dayOf);
    assertSame([days[0], days[1], days[days.length - 1], days.length], ['2030-03-05', '2032-03-05', '2039-03-05', 9], 'from 2030 to 2039, 2031 excluded');
  });

  await check('all, yearly back onto the master\'s own day: the opened exception, moved on its own, comes back to it; asked for the times it shows, it stays', async () => {
    seed(NOA_CAL, 'own', { start: '2020-03-02T10:00:00', summary: 'Birthday', recurrence: ['RRULE:FREQ=YEARLY'] });
    const slotId = inst('own', '2026-03-02T10:00:00');
    seedException(NOA_CAL, slotId, { summary: 'Party', start: { dateTime: at('2026-03-05T10:00:00').toISOString(), timeZone: IL }, end: { dateTime: at('2026-03-05T11:00:00').toISOString(), timeZone: IL } });
    const resend = await update(NOA, NOA_CAL, slotId, { startTime: at('2026-03-05T10:00:00'), endTime: at('2026-03-05T11:00:00'), scope: 'all', recurringEventId: 'own' });
    assertSame([resend.success, writes().filter((c) => c.path.includes(slotId)).length, new Date(stored(NOA_CAL, slotId)!.start.dateTime).toISOString()], [true, 0, at('2026-03-05T10:00:00').toISOString()], 'the times it shows: the exception untouched');
    const r = await update(NOA, NOA_CAL, slotId, { startTime: at('2026-03-02T10:00:00'), endTime: at('2026-03-02T11:00:00'), scope: 'all', recurringEventId: 'own' });
    const ex = stored(NOA_CAL, slotId)!;
    assertSame([r.success, r.instanceId, new Date(stored(NOA_CAL, 'own')!.start.dateTime).toISOString()], [true, slotId, at('2020-03-02T10:00:00').toISOString()], 'the master stays');
    assertSame([new Date(ex.start.dateTime).toISOString(), new Date(ex.end.dateTime).toISOString(), ex.summary], [at('2026-03-02T10:00:00').toISOString(), at('2026-03-02T11:00:00').toISOString(), 'Party'], 'the exception back on 2 March, its title kept');
  });

  await check('all, yearly near onto 29 Feb: a COUNT whose years change becomes the moved last slot\'s date (one rule with FamCal\'s)', async () => {
    seed(NOA_CAL, 'leap', { start: '2020-03-01T10:00:00', recurrence: ['RRULE:FREQ=YEARLY;COUNT=5'] });
    const r = await update(NOA, NOA_CAL, inst('leap', '2024-03-01T10:00:00'), { startTime: at('2024-02-29T10:00:00'), endTime: at('2024-02-29T11:00:00'), scope: 'all', recurringEventId: 'leap' });
    const m = stored(NOA_CAL, 'leap')!;
    assertSame([r.success, new Date(m.start.dateTime).toISOString(), m.recurrence], [true, at('2020-02-29T10:00:00').toISOString(), [`RRULE:FREQ=YEARLY;UNTIL=${utcStamp(at('2024-02-29T23:59:59'))}`]], 'the master');
    assertSame(visible(NOA_CAL, 'leap').map(dayOf), ['2020-02-29', '2024-02-29'], 'the leap years in its span');
  });

  await check('all, yearly: an RDATE (an extra date) keeps its own day and time, in its year plus the move\'s years; an EXDATE moves with its slot', async () => {
    const lines = (exdate: string) => ['RRULE:FREQ=YEARLY', `EXDATE:${utcStamp(at(exdate))}`, `RDATE:${utcStamp(at('2027-06-15T14:00:00'))}`];
    seed(NOA_CAL, 'rd', { start: '2020-03-02T10:00:00', recurrence: lines('2028-03-02T10:00:00') });
    await update(NOA, NOA_CAL, inst('rd', '2026-03-02T10:00:00'), { startTime: at('2026-03-05T10:00:00'), endTime: at('2026-03-05T11:00:00'), scope: 'all', recurringEventId: 'rd' });
    assertSame(stored(NOA_CAL, 'rd')!.recurrence, lines('2028-03-05T10:00:00'), 'near: the RDATE stays on 15 June 14:00, the EXDATE on 5 March');
    seed(NOA_CAL, 'nye', { start: '2020-12-31T10:00:00', recurrence: lines('2028-12-31T10:00:00') });
    await update(NOA, NOA_CAL, inst('nye', '2026-12-31T10:00:00'), { startTime: at('2027-01-01T10:00:00'), endTime: at('2027-01-01T11:00:00'), scope: 'all', recurringEventId: 'nye' });
    assertSame(stored(NOA_CAL, 'nye')!.recurrence, ['RRULE:FREQ=YEARLY', `EXDATE:${utcStamp(at('2029-01-01T10:00:00'))}`, `RDATE:${utcStamp(at('2028-06-15T14:00:00'))}`], 'across the year: both a year on, the RDATE on its own day');
  });

  await check('all: a day move on a series with fixed days (BYDAY, BYMONTHDAY) is FIXED_DAYS, and nothing is written; a time alone is fine', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { startTime: at('2026-10-21T10:00:00'), endTime: at('2026-10-21T11:00:00'), scope: 'all', recurringEventId: 'wk' });
    assertSame([r.error, writes().length], ['FIXED_DAYS', 0], 'BYDAY day move');
    seed(NOA_CAL, 'mo', { start: '2026-10-15T10:00:00', recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=15'] });
    const m = await update(NOA, NOA_CAL, inst('mo', '2026-11-15T10:00:00'), { startTime: at('2026-11-20T10:00:00'), endTime: at('2026-11-20T11:00:00'), scope: 'following', recurringEventId: 'mo' });
    assertSame([m.error, writes().length], ['FIXED_DAYS', 0], 'BYMONTHDAY following');
    const t = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { startTime: at('2026-10-20T09:00:00'), endTime: at('2026-10-20T10:00:00'), scope: 'all', recurringEventId: 'wk' });
    assert(t.success, `time alone ${show(t)}`);
  });

  await check('fixed days: wouldRefuseFixedDays reads the Google master; a read error logs and doesn\'t block', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
    const move = { startTime: at('2026-10-21T10:00:00'), endTime: at('2026-10-21T11:00:00'), scope: 'all', recurringEventId: 'wk' };
    assertSame(await wouldRefuseFixedDays(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), move), true, 'BYDAY');
    assertSame(await wouldRefuseFixedDays(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { ...move, startTime: at('2026-10-20T09:00:00'), endTime: at('2026-10-20T10:00:00') }), false, 'time alone');
    seed(NOA_CAL, 'plain', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY'] });
    assertSame(await wouldRefuseFixedDays(NOA, NOA_CAL, inst('plain', '2026-10-20T10:00:00'), { ...move, recurringEventId: 'plain' }), false, 'a rule that follows its start');
    captured.length = 0;
    assertSame(await wouldRefuseFixedDays(NOA, NOA_CAL, 'gone_20261020T070000Z', { ...move, recurringEventId: 'gone' }), false, 'read error');
    assert(captured.length === 1, `logged ${captured.length}`);
    assertSame(writes().length, 0, 'it only reads');
  });

  // ---- 'following' ----

  await check('following: the master ends one second before the cut (UTC Z), the tail keeps the COUNT left in slots, EXDATEs split at the cut, never UNTIL with COUNT', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10', 'EXDATE;TZID=Asia/Jerusalem:20261013T100000', 'EXDATE:20261103T080000Z'] });
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-27T10:00:00'), { location: 'Room 2', scope: 'following', recurringEventId: 'wk' });
    assert(r.success, `update ${show(r)}`);
    assertSame(stored(NOA_CAL, 'wk')!.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261027T075959Z', 'EXDATE;TZID=Asia/Jerusalem:20261013T100000'], 'master');
    const tail = stored(NOA_CAL, r.eventId)!;
    assertSame(tail.recurrence, ['RRULE:FREQ=WEEKLY;COUNT=7', 'EXDATE:20261103T080000Z'], 'tail');
    assert(rrLines().every((l) => !(/UNTIL=/.test(l) && /COUNT=/.test(l))), `UNTIL with COUNT: ${show(rrLines())}`);
    assertSame(new Date(tail.start.dateTime).toISOString(), at('2026-10-27T10:00:00').toISOString(), 'the tail starts exactly at the cut');
    assertSame(r.instanceId, `${r.eventId}_${utcStamp(at('2026-10-27T10:00:00'))}`, 'the key follows the opened occurrence');
    const all = [...visible(NOA_CAL, 'wk'), ...visible(NOA_CAL, r.eventId)].map((i) => new Date(i.start.dateTime).toISOString());
    assertSame(all.length, 8, `still 10 slots, two exdated (got ${show(all)})`);
  });

  await check('following: the tail takes the cut instance as shown (title, HTML notes, colour, alerts, visibility, transparency), never ids, guests, Meet, files or properties', async () => {
    WEEKLY_TUE({ conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/x' }] }, extendedProperties: { private: { a: '1' } }, attachments: [{ fileUrl: 'u' }] });
    const cutId = inst('wk', '2026-10-20T10:00:00');
    seedException(NOA_CAL, cutId, {
      summary: 'Team sync (moved)', description: '<b>Agenda</b>', colorId: '5', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
      visibility: 'private', transparency: 'transparent', start: { dateTime: dt(at('2026-10-20T10:30:00'), IL), timeZone: IL }, end: { dateTime: dt(at('2026-10-20T11:30:00'), IL), timeZone: IL },
    });
    const r = await update(NOA, NOA_CAL, cutId, { location: 'Room 2', scope: 'following', recurringEventId: 'wk' });
    const body = writes().find((c) => c.method === 'POST')!.body!;
    const picked = Object.fromEntries(['summary', 'description', 'location', 'colorId', 'reminders', 'visibility', 'transparency'].map((k) => [k, body[k]]));
    assertSame(picked, { summary: 'Team sync (moved)', description: '<b>Agenda</b>', location: 'Room 2', colorId: '5', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] }, visibility: 'private', transparency: 'transparent' }, 'fields');
    for (const k of ['id', 'iCalUID', 'recurringEventId', 'originalStartTime', 'attendees', 'conferenceData', 'attachments', 'extendedProperties', 'organizer', 'htmlLink', 'etag']) assert(!(k in body), `${k} copied`);
    assertSame(new Date(stored(NOA_CAL, r.eventId)!.start.dateTime).toISOString(), at('2026-10-20T10:00:00').toISOString(), 'the tail starts at the cut\'s slot, not where the exception moved it');
  });

  await check('following: exceptions Google kept past the new end are deleted (strays), and the count is logged', async () => {
    WEEKLY_TUE();
    seedException(NOA_CAL, inst('wk', '2026-11-10T10:00:00'), { summary: 'Renamed later' });
    seedException(NOA_CAL, inst('wk', '2026-10-13T10:00:00'), { summary: 'Renamed earlier' });
    await update(NOA, NOA_CAL, inst('wk', '2026-10-27T10:00:00'), { title: 'New', scope: 'following', recurringEventId: 'wk' });
    assert(!alive(NOA_CAL, inst('wk', '2026-11-10T10:00:00')), 'the stray is still there');
    assertSame(stored(NOA_CAL, inst('wk', '2026-10-13T10:00:00'))?.summary, 'Renamed earlier', 'an earlier exception stays');
    assert(consoleLines.some((l) => /stray/i.test(l) && /1/.test(l)), `no logged count: ${show(consoleLines.slice(-5))}`);
  });

  await check('following: an all-day series ends the day before the cut, as a date; an UNTIL carries to the tail', async () => {
    seed(NOA_CAL, 'ad', { start: '2026-10-10', allDay: true, recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261031'] });
    const r = await update(NOA, NOA_CAL, instDay('ad', '2026-10-20'), { title: 'x', scope: 'following', recurringEventId: 'ad' });
    assertSame(stored(NOA_CAL, 'ad')!.recurrence, ['RRULE:FREQ=DAILY;UNTIL=20261019'], 'master');
    assertSame([stored(NOA_CAL, r.eventId)!.recurrence, stored(NOA_CAL, r.eventId)!.start.date], [['RRULE:FREQ=DAILY;UNTIL=20261031'], '2026-10-20'], 'tail');
  });

  await check('following: a time change starts the tail at the new time; a calendar change puts the tail on the destination', async () => {
    WEEKLY_TUE();
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { startTime: at('2026-10-20T11:00:00'), endTime: at('2026-10-20T12:00:00'), scope: 'following', recurringEventId: 'wk', toCalendarId: FAMILY });
    assert(r.success, show(r));
    assertSame([r.calendarId, Boolean(stored(FAMILY, r.eventId)), Boolean(stored(NOA_CAL, r.eventId))], [FAMILY, true, false], 'on the destination');
    assertSame(new Date(stored(FAMILY, r.eventId)!.start.dateTime).toISOString(), at('2026-10-20T11:00:00').toISOString(), 'new time');
    assertSame(stored(NOA_CAL, 'wk')!.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261020T065959Z'], 'the head stays on the source');
  });

  await check('following: at the first slot it runs as "all" (no split, no empty head), also when the earlier ones are cancelled', async () => {
    WEEKLY_TUE();
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-06T10:00:00'), { title: 'Renamed', scope: 'following', recurringEventId: 'wk' });
    assertSame([writeLog(), stored(NOA_CAL, 'wk')!.summary, stored(NOA_CAL, 'wk')!.recurrence], [[`PATCH /calendars/${encodeURIComponent(NOA_CAL)}/events/wk`], 'Renamed', ['RRULE:FREQ=WEEKLY']], 'in place');
    assertSame(r.instanceId, inst('wk', '2026-10-06T10:00:00'), 'same key');
    reset();
    WEEKLY_TUE();
    await remove(NOA, NOA_CAL, inst('wk', '2026-10-06T10:00:00'), { scope: 'single' });
    calls.length = 0;
    await update(NOA, NOA_CAL, inst('wk', '2026-10-13T10:00:00'), { title: 'Renamed', scope: 'following', recurringEventId: 'wk' });
    assert(!writes().some((c) => c.method === 'POST'), `split: ${show(writeLog())}`);
    assertSame(stored(NOA_CAL, 'wk')!.summary, 'Renamed', 'in place after a cancelled first');
  });

  await check('following delete: the master ends before the cut and strays go; from the first slot the series is deleted', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10'] });
    seedException(NOA_CAL, inst('wk', '2026-11-03T10:00:00'), { summary: 'Later one' });
    const r = await remove(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { scope: 'following', recurringEventId: 'wk' });
    assert(r.success, show(r));
    assertSame(stored(NOA_CAL, 'wk')!.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261020T065959Z'], 'master');
    assertSame(visible(NOA_CAL, 'wk').length, 2, 'two left');
    assert(!writes().some((c) => c.method === 'POST'), 'no tail');
    reset();
    WEEKLY_TUE();
    await remove(NOA, NOA_CAL, inst('wk', '2026-10-06T10:00:00'), { scope: 'following', recurringEventId: 'wk' });
    assertSame([writeLog(), Boolean(stored(NOA_CAL, 'wk'))], [[`DELETE /calendars/${encodeURIComponent(NOA_CAL)}/events/wk`], false], 'the whole series');
  });

  // ---- Repeat change: replace from the cut ----

  await check('repeat: from a later occurrence the master is cut, a new event takes the new rule (no end for Never-ended), strays go', async () => {
    WEEKLY_TUE();
    seedException(NOA_CAL, inst('wk', '2026-11-03T10:00:00'), { summary: 'Later one' });
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { rrule: 'RRULE:FREQ=DAILY', scope: 'following', recurringEventId: 'wk' });
    assert(r.success, show(r));
    assertSame(stored(NOA_CAL, 'wk')!.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261020T065959Z'], 'master');
    assertSame(stored(NOA_CAL, r.eventId)!.recurrence, ['RRULE:FREQ=DAILY'], 'new rule');
    assert(!alive(NOA_CAL, inst('wk', '2026-11-03T10:00:00')), 'stray left');
    assertSame(r.instanceId, `${r.eventId}_${utcStamp(at('2026-10-20T10:00:00'))}`, 'key');
  });

  await check('repeat: an UNTIL carries over as it is; a COUNT becomes the UNTIL of its last occurrence (end of that day, UTC)', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261124T080000Z'] });
    const a = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { rrule: 'RRULE:FREQ=DAILY', scope: 'following', recurringEventId: 'wk' });
    assertSame(stored(NOA_CAL, a.eventId)!.recurrence, ['RRULE:FREQ=DAILY;UNTIL=20261124T080000Z'], 'UNTIL');
    reset();
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'] });
    const b = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { rrule: 'RRULE:FREQ=DAILY', scope: 'following', recurringEventId: 'wk' });
    assertSame(stored(NOA_CAL, b.eventId)!.recurrence, [`RRULE:FREQ=DAILY;UNTIL=${utcStamp(at('2026-11-10T23:59:59'))}`], 'COUNT → UNTIL');
  });

  await check('repeat: from the first slot a new event is inserted, then the master (and its exceptions) deleted', async () => {
    WEEKLY_TUE();
    seedException(NOA_CAL, inst('wk', '2026-10-13T10:00:00'), { summary: 'Renamed' });
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-06T10:00:00'), { rrule: 'RRULE:FREQ=DAILY', scope: 'following', recurringEventId: 'wk' });
    assertSame(writeLog().map((l) => l.split(' ')[0]), ['POST', 'DELETE'], 'insert, then delete');
    assertSame([Boolean(stored(NOA_CAL, 'wk')), Boolean(stored(NOA_CAL, inst('wk', '2026-10-13T10:00:00'))), stored(NOA_CAL, r.eventId)?.recurrence], [false, false, ['RRULE:FREQ=DAILY']], 'replaced');
  });

  await check('repeat: Never from a later occurrence leaves the earlier ones and a one-off at the occurrence as shown; from the first, a one-off', async () => {
    WEEKLY_TUE();
    const cutId = inst('wk', '2026-10-20T10:00:00');
    seedException(NOA_CAL, cutId, { start: { dateTime: dt(at('2026-10-20T10:30:00'), IL), timeZone: IL }, end: { dateTime: dt(at('2026-10-20T11:30:00'), IL), timeZone: IL } });
    const r = await update(NOA, NOA_CAL, cutId, { rrule: null, scope: 'following', recurringEventId: 'wk' });
    const one = stored(NOA_CAL, r.eventId)!;
    assertSame([one.recurrence, new Date(one.start.dateTime).toISOString(), r.instanceId], [undefined, at('2026-10-20T10:30:00').toISOString(), r.eventId], 'one-off at the occurrence');
    assertSame(stored(NOA_CAL, 'wk')!.recurrence, ['RRULE:FREQ=WEEKLY;UNTIL=20261020T065959Z'], 'head');
    reset();
    WEEKLY_TUE();
    const f = await update(NOA, NOA_CAL, inst('wk', '2026-10-06T10:00:00'), { rrule: null, scope: 'following', recurringEventId: 'wk' });
    assertSame([Boolean(stored(NOA_CAL, 'wk')), stored(NOA_CAL, f.eventId)?.recurrence], [false, undefined], 'one-off');
  });

  await check('repeat: a one-off gets the rule patched onto it, keeping its id; the key is its first occurrence', async () => {
    seed(NOA_CAL, 'one', { start: '2026-10-20T10:00:00' });
    const r = await update(NOA, NOA_CAL, 'one', { rrule: 'RRULE:FREQ=WEEKLY', scope: 'single' });
    assertSame([writeLog()[0], stored(NOA_CAL, 'one')!.recurrence, r.instanceId], [`PATCH /calendars/${encodeURIComponent(NOA_CAL)}/events/one`, ['RRULE:FREQ=WEEKLY'], inst('one', '2026-10-20T10:00:00')], 'one-off → series');
  });

  await check('repeat: a set-weekdays series moved to another day with one of the five rules is never refused', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
    const r = await update(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { rrule: 'RRULE:FREQ=WEEKLY', startTime: at('2026-10-21T10:00:00'), endTime: at('2026-10-21T11:00:00'), scope: 'following', recurringEventId: 'wk' });
    assert(r.success, show(r));
    assertSame(new Date(stored(NOA_CAL, r.eventId)!.start.dateTime).toISOString(), at('2026-10-21T10:00:00').toISOString(), 'moved');
  });

  await check('repeat: the home\'s "this one and the ones after" day move on a weekly event Google saved with its own day (BYDAY=TU from a Tuesday) sends weekly again; it is a repeat change, not refused, and the new part follows its new start', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
    const r = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')), scope: 'following', changes: { repeat: 'weekly', start: '2026-10-21T10:00', end: '2026-10-21T11:00' } }), IL);
    assert(r.status === 'ok' && typeof r.key === 'string', show(r));
    const inserted = writes().filter((c) => c.method === 'POST' && c.path === `/calendars/${encodeURIComponent(NOA_CAL)}/events`).map((c) => c.body);
    assertSame(inserted.map((b) => [b?.recurrence, new Date(b?.start?.dateTime).toISOString()]), [[['RRULE:FREQ=WEEKLY'], at('2026-10-21T10:00:00').toISOString()]], 'a weekly rule from Wednesday the 21st');
  });

  await check('recurrence lines: RRULE, EXDATE and RDATE lines pass as they are; a bare rule gets RRULE:', async () => {
    await googleProvider.createEvent(NOA, NOA_CAL, {
      title: 'x', startTime: at('2026-10-20T10:00:00'), endTime: at('2026-10-20T11:00:00'),
      recurrence: ['FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20261021', 'rdate:20261030T080000Z'],
    });
    assertSame(writes()[0].body!.recurrence, ['RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20261021', 'rdate:20261030T080000Z'], 'lines');
  });

  // ---- The home: editor calendars, item info, eligibility ----

  await check('editor: the chosen Google calendars the user can write, read live; main is the primary; a spouse\'s is marked', async () => {
    const list = (await gitem.googleEditorCalendars(NOA)).calendars;
    assertSame(list, [
      { id: NOA_CAL, name: 'Noa', color: '#4285f4', main: true, mine: true },
      { id: FAMILY, name: 'Family', color: '#33b679', main: false, mine: true },
      { id: NY_CAL, name: 'New York', color: '#3f51b5', main: false, mine: true },
      { id: DANA, name: 'Dana', color: '#f4511e', main: false, mine: false, ownerName: 'Dana' },
    ], 'calendars');
    const e = await info.editorInfo(NOA, IL);
    assertSame([e.kinds, e.partner, e.calendars.map((c: Row) => c.id), e.tz], [{ event: true, reminder: false }, null, ['native:fam-7', NOA_CAL, FAMILY, NY_CAL, DANA], IL], 'editor info: the FamCal main, then the Google rows');
  });

  await check('editor: a built-in calendar user\'s leftover token and choices are a connection now (Google as a connection): Google rows, item and write', async () => {
    const native = user(9, IL, { calendarSource: 'NATIVE' });
    assertSame((await gitem.googleEditorCalendars(native)).calendars.length, 4, 'Google rows');
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    assert((await editInfo(native, gkey(NOA_CAL, 'e1'))) !== 'not_found', 'no Google item');
    assertSame((await write.createItem(native, createCmd({ kind: 'event', title: 'x', allDay: false, start: '2026-10-22T18:00', calendarId: NOA_CAL }), IL)).status, 'ok', 'Google create');
  });

  await check('editor: a calendar list that can\'t be read drops only the Google rows (the FamCal "+" stays), logged', async () => {
    failOn((r) => r.path === '/users/me/calendarList', fail(401, 'authError', 'Invalid Credentials'));
    const e = await info.editorInfo(NOA, IL);
    assertSame([e.kinds, e.calendars.map((c: Row) => c.id)], [{ event: true, reminder: false }, ['native:fam-7']], 'FamCal rows only');
    assert(captured.length >= 1, 'not logged');
  });

  await check('editor: a dead token or missing scopes on the calendar list is one warning (the reconnect banner tells the user), never an error, and the list\'s reader captures nothing of its own (no raw Google error); an OAuth client Google rejects stays an error', async () => {
    const list = (r: Req) => r.method === 'GET' && r.path === '/users/me/calendarList';
    const levels = () => captured.map((c) => `${c.ctx}:${c.severity ?? 'error'}`);
    tokenAnswer = { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    assertSame((await gitem.googleEditorCalendars(NOA)).failure, 'token', 'invalid_grant class');
    assertSame(levels(), ['calendar-editor-google:warning'], 'invalid_grant');
    tokenAnswer = null;
    captured.length = 0;
    failOn(list, fail(401, 'authError', 'Invalid Credentials'), 20);
    assertSame((await gitem.googleEditorCalendars(NOA)).failure, 'token', '401 class');
    assertSame(levels(), ['calendar-editor-google:warning'], '401');
    rules = [];
    captured.length = 0;
    failOn(list, fail(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.'), 20);
    assertSame((await gitem.googleEditorCalendars(NOA)).failure, 'scopes', 'scopes class');
    assertSame(levels(), ['calendar-editor-google:warning'], 'scopes');
    rules = [];
    captured.length = 0;
    tokenAnswer = { status: 401, data: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } };
    assertSame((await gitem.googleEditorCalendars(NOA)).failure, 'config', 'invalid_client class');
    assertSame(levels(), ['calendar-editor-google:error'], 'invalid_client');
    tokenAnswer = null;
  });

  await check('item info: a series occurrence, read live (calendar role, instance, master): wall times, the rule classified, plain notes, scopes, moves', async () => {
    WEEKLY_TUE({ description: '<p>Bring <b>snacks</b></p>', location: 'Office' });
    const r = await editInfo(NOA, gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')));
    assert(r !== 'not_found', 'not found');
    assertSame({ kind: r.kind, canEdit: r.canEdit, canDelete: r.canDelete, occurrence: r.occurrence }, {
      kind: 'event', canEdit: true, canDelete: true,
      occurrence: { start: '2026-10-20T10:00', end: '2026-10-20T11:00', allDay: false, title: 'Team sync', location: 'Office', description: 'Bring snacks' },
    }, 'occurrence');
    assertSame({ recurring: r.series.recurring, start: r.series.start, fixedDays: r.series.fixedDays, zone: r.series.zone, rule: r.series.rule, first: r.series.first, freq: r.series.repeat?.freq }, {
      recurring: true, start: '2026-10-06T10:00', fixedDays: false, zone: IL, rule: { choice: 'weekly' }, first: false, freq: 'weekly',
    }, 'series');
    assertSame({ calendar: r.calendar, forName: r.forName, scopes: r.scopes, canMoveCalendar: r.canMoveCalendar, moveTargets: r.moveTargets, canChangeRecipient: r.canChangeRecipient, source: r.source, googleOnly: r.editableInGoogleOnly ?? false, tz: r.tz }, {
      calendar: { id: NOA_CAL, name: 'Noa', color: '#4285f4' }, forName: null, scopes: ['single', 'following', 'all'], canMoveCalendar: true,
      moveTargets: [NOA_CAL, FAMILY, NY_CAL, DANA, 'native:fam-7'], canChangeRecipient: false, source: 'google', googleOnly: false, tz: IL,
    }, 'the rest');
    const first = await editInfo(NOA, gkey(NOA_CAL, inst('wk', '2026-10-06T10:00:00')));
    assert(first !== 'not_found' && first.series.first === true, 'first');
  });

  // Editor upgrades spec §2, ruling E: a Google event's alert is shown, never written.
  await check('alerts, item info: the nearest popup (else the nearest email) is the read-only alert, else the default; a lead off the list or over a day is shown as it is', async () => {
    const lead = async (id: string, reminders: Row | undefined) => {
      seed(NOA_CAL, id, { start: '2026-10-20T10:00:00', ...(reminders ? { reminders } : {}) });
      const r = await editInfo(NOA, gkey(NOA_CAL, id));
      assert(r !== 'not_found', 'not found');
      return [r.alert, r.alertReadOnly];
    };
    const popup = (...minutes: number[]) => ({ useDefault: false, overrides: minutes.map((m) => ({ method: 'popup', minutes: m })) });
    assertSame(await lead('a1', popup(1440, 30)), [30, true], 'the nearest popup');
    assertSame(await lead('a2', { useDefault: false, overrides: [{ method: 'email', minutes: 60 }, { method: 'email', minutes: 1440 }] }), [60, true], 'else the nearest email');
    assertSame(await lead('a3', { useDefault: false, overrides: [{ method: 'email', minutes: 10 }, { method: 'popup', minutes: 120 }] }), [120, true], 'a popup beats a nearer email');
    assertSame(await lead('a4', { useDefault: true }), ['default', true], 'Google\'s own default: none of its own');
    assertSame(await lead('a5', undefined), ['default', true], 'no reminders');
    assertSame(await lead('a6', popup(2880)), [2880, true], 'two days, over the list');
    assertSame(await lead('a7', popup(45)), [45, true], 'off the list');
  });

  await check('alerts, writes: an alert for a Google calendar or a Google item is 400 field alert and nothing is written', async () => {
    const created = await write.createItem(NOA, createCmd({ kind: 'event', title: 'x', allDay: false, start: '2026-10-22T18:00', calendarId: FAMILY, alert: 15 }), IL);
    assertSame([created, writes().length], [{ status: 'invalid', field: 'alert' }, 0], 'create');
    WEEKLY_TUE();
    const key = gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00'));
    for (const scope of ['single', 'all'] as const) {
      assertSame(await write.updateItem(NOA, patchCmd({ key, scope, changes: { alert: 'none' } }), IL), { status: 'invalid', field: 'alert' }, `patch ${scope}`);
    }
    assertSame(await write.updateItem(NOA, patchCmd({ key, scope: 'all', changes: { title: 'y', alert: 5 } }), IL), { status: 'invalid', field: 'alert' }, 'with other changes');
    assertSame(writes().length, 0, 'wrote');
  });

  await check('item info: set weekdays and other parts are custom; an UNTIL in UTC is its day; all-day dates are inclusive', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261124T075959Z'] });
    const a = await editInfo(NOA, gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')));
    assert(a !== 'not_found', 'nf');
    // UNTIL 07:59:59Z on the 24th is 09:59:59 there, before that Tuesday's 10:00: the last is Thursday the 19th.
    assertSame([a.series.rule, a.series.fixedDays], [{ choice: 'custom', until: '2026-11-19' }, true], 'custom with an end');
    stored(NOA_CAL, 'wk')!.recurrence = ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261124T080000Z'];
    const a2 = await editInfo(NOA, gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')));
    assert(a2 !== 'not_found', 'nf');
    assertSame(a2.series.rule, { choice: 'custom', until: '2026-11-24' }, 'an UNTIL on the last one');
    seed(NOA_CAL, 'tu', { start: '2026-10-06T10:00:00', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
    const b = await editInfo(NOA, gkey(NOA_CAL, inst('tu', '2026-10-20T10:00:00')));
    assert(b !== 'not_found' && b.series.rule?.choice === 'weekly', `BYDAY on its start's day ${show(b !== 'not_found' && b.series.rule)}`);
    seed(NOA_CAL, 'trip', { start: '2026-10-20', end: '2026-10-23', allDay: true });
    const c = await editInfo(NOA, gkey(NOA_CAL, 'trip'));
    assert(c !== 'not_found', 'nf trip');
    assertSame([c.occurrence.start, c.occurrence.end, c.occurrence.allDay, c.scopes, c.series.rule, c.series.first], ['2026-10-20', '2026-10-22', true, ['single'], { choice: 'none' }, true], 'all-day one-off');
  });

  await check('eligibility: guests (rooms too), unknown guests, not the organizer, a special type or a lock make it Google-only; a read-only calendar shows no line', async () => {
    const cases: [string, Row, boolean][] = [
      ['own, no guests', {}, true],
      ['only self as attendee', { attendees: [{ email: NOA_CAL, self: true, organizer: true }] }, true],
      ['a guest', { attendees: [{ email: NOA_CAL, self: true, organizer: true }, { email: 'x@y.com' }] }, false],
      ['a room', { attendees: [{ email: NOA_CAL, self: true, organizer: true }, { email: 'room@resource.calendar.google.com', resource: true }] }, false],
      ['guests omitted', { attendeesOmitted: true }, false],
      ['someone else organizes, no attendees', { organizer: { email: 'boss@x.com' } }, true],
      ['an invite', { organizer: { email: 'boss@x.com' }, attendees: [{ email: NOA_CAL, self: true }] }, false],
      ['a birthday', { eventType: 'birthday' }, false],
      ['from Gmail', { eventType: 'fromGmail' }, false],
      ['no type', { eventType: undefined }, true],
      ['locked', { locked: true }, false],
    ];
    for (const [name, extra, editable] of cases) {
      reset();
      seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00', ...extra });
      const r = await editInfo(NOA, gkey(NOA_CAL, 'e1'));
      assert(r !== 'not_found', `${name}: not found`);
      assertSame([r.canEdit, r.canDelete, r.editableInGoogleOnly ?? false], [editable, editable, !editable], name);
    }
    reset();
    seed(HOLIDAYS, 'h1', { start: '2026-10-20T10:00:00' });
    const ro = await editInfo(NOA, gkey(HOLIDAYS, 'h1'));
    assert(ro !== 'not_found', 'read-only: not found');
    assertSame([ro.canEdit, ro.canDelete, ro.editableInGoogleOnly ?? false, ro.canMoveCalendar ?? false], [false, false, false, false], 'read-only');
  });

  await check('item info: a calendar the user didn\'t choose, a gone event and a cancelled occurrence are not found; ids never come from the client', async () => {
    seed(WORK, 'w1', { start: '2026-10-20T10:00:00' });
    assertSame(await editInfo(NOA, gkey(WORK, 'w1')), 'not_found', 'not chosen');
    assert(!calls.some((c) => c.path.includes(encodeURIComponent(WORK))), 'Google was asked about a calendar the user didn\'t choose');
    assertSame(await editInfo(NOA, gkey(NOA_CAL, 'nope')), 'not_found', 'gone');
    WEEKLY_TUE();
    await remove(NOA, NOA_CAL, inst('wk', '2026-10-20T10:00:00'), { scope: 'single' });
    assertSame(await editInfo(NOA, gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00'))), 'not_found', 'cancelled');
    assertSame(validate.parseAnyItemKey('google|cal-without-event|'), null, 'no event id');
    assertSame(validate.parseAnyItemKey('google||e1'), null, 'no calendar');
  });

  // ---- The home's writes ----

  await check('create: a Google calendar id goes to Google in the user\'s zone, checked against the writable list; the key is the first occurrence', async () => {
    const r = await write.createItem(NOA, createCmd({ kind: 'event', title: 'Swim', allDay: false, start: '2026-10-22T18:00', end: '2026-10-22T19:00', repeat: 'weekly', calendarId: FAMILY }), IL);
    assertSame(r.status, 'ok', show(r));
    const body = writes()[0].body!;
    assertSame([body.summary, body.recurrence, body.start.timeZone, new Date(body.start.dateTime).toISOString()], ['Swim', ['RRULE:FREQ=WEEKLY'], IL, at('2026-10-22T18:00:00').toISOString()], 'insert');
    const id = [...eventsOf(FAMILY).keys()][0];
    assertSame(r.key, gkey(FAMILY, `${id}_${utcStamp(at('2026-10-22T18:00:00'))}`), 'key');
    assertSame(tracked.map((t) => [t.action, t.meta.provider, t.meta.source]), [['voice_event_created', 'google', 'app']], 'analytics');
    for (const cal of [HOLIDAYS, WORK]) {
      calls.length = 0;
      const refused = await write.createItem(NOA, createCmd({ kind: 'event', title: 'x', allDay: false, start: '2026-10-22T18:00', calendarId: cal }), IL);
      assertSame([refused, writes().length], [{ status: 'invalid', field: 'calendarId' }, 0], cal);
    }
    const all = await write.createItem(NOA, createCmd({ kind: 'event', title: 'Trip', allDay: true, start: '2026-10-22', end: '2026-10-24' }), IL);
    assertSame([all.status, stored(NOA_CAL, all.key.split('|')[2])?.start, stored(NOA_CAL, all.key.split('|')[2])?.end], ['ok', { date: '2026-10-22', timeZone: IL }, { date: '2026-10-25', timeZone: IL }], 'no calendar: the primary; all-day dates');
    assertSame(await write.createItem(NOA, createCmd({ kind: 'reminder', title: 'x', allDay: false, start: '2026-10-22T18:00' }), IL), { status: 'not_allowed' }, 'a reminder without the plan');
  });

  await check('edit: only the changed fields are written; notes only when changed, as plain text', async () => {
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00', summary: 'Dentist', description: '<p>Bring <b>card</b></p>', location: 'Clinic' });
    const r = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'e1'), scope: 'single', changes: { title: 'Dentist', location: 'Clinic 2', description: 'Bring card', start: '2026-10-20T10:00', end: '2026-10-20T11:00' } }), IL);
    assertSame(r, { status: 'ok', key: gkey(NOA_CAL, 'e1') }, 'result');
    assertSame(writes().map((c) => c.body), [{ location: 'Clinic 2' }], 'only the location');
    calls.length = 0;
    await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'e1'), scope: 'single', changes: { description: 'New notes' } }), IL);
    assertSame(writes().map((c) => c.body), [{ description: 'New notes' }], 'notes');
    calls.length = 0;
    assertSame(await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'e1'), scope: 'single', changes: { title: 'Dentist' } }), IL), { status: 'ok', key: gkey(NOA_CAL, 'e1') }, 'no change');
    assertSame(writes().length, 0, 'a no-op wrote');
    assertSame(tracked.map((t) => [t.action, t.meta.provider, t.meta.changed_fields]), [['calendar_item_edited', 'google', ['location']], ['calendar_item_edited', 'google', ['description']]], 'analytics');
  });

  await check('edit: a time change on an occurrence with "all" shifts the series; a repeat change forces "following"; a calendar change refuses "single"', async () => {
    WEEKLY_TUE();
    const key = gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00'));
    const a = await write.updateItem(NOA, patchCmd({ key, scope: 'all', changes: { start: '2026-10-20T11:00', end: '2026-10-20T12:00' } }), IL);
    assertSame([a, new Date(stored(NOA_CAL, 'wk')!.start.dateTime).toISOString()], [{ status: 'ok', key: gkey(NOA_CAL, inst('wk', '2026-10-20T11:00:00')) }, at('2026-10-06T11:00:00').toISOString()], 'all');
    reset();
    WEEKLY_TUE();
    const b = await write.updateItem(NOA, patchCmd({ key, scope: 'single', changes: { repeat: 'daily' } }), IL);
    assert(b.status === 'ok', show(b));
    assertSame([stored(NOA_CAL, 'wk')!.recurrence, tracked[0].meta.scope], [['RRULE:FREQ=WEEKLY;UNTIL=20261020T065959Z'], 'following'], 'forced following');
    assertSame(await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, inst('wk', '2026-10-06T10:00:00')), scope: 'single', changes: { calendarId: FAMILY } }), IL), { status: 'invalid', field: 'scope' }, 'single');
  });

  await check('edit: the same rule picked again writes nothing; a recipient change is refused', async () => {
    WEEKLY_TUE();
    const key = gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00'));
    assertSame(await write.updateItem(NOA, patchCmd({ key, scope: 'single', changes: { repeat: 'weekly' } }), IL), { status: 'ok', key }, 'same');
    assertSame(writes().length, 0, 'wrote');
    assertSame(await write.updateItem(NOA, patchCmd({ key, scope: 'all', changes: { forWho: 'partner' } }), IL), { status: 'invalid', field: 'forWho' }, 'recipient');
    // A Google event has no reminder to mark done: "each marks their own Done" is refused, not dropped.
    assertSame(await write.updateItem(NOA, patchCmd({ key, scope: 'all', changes: { eachMarksDone: false } }), IL), { status: 'invalid', field: 'eachMarksDone' }, 'each marks their own Done');
    assertSame(writes().length, 0, 'wrote');
  });

  await check('richer repeats, item info: series.spec says a Google rule (an UTC UNTIL as its wall day); a rule the sheet can\'t say has none and keeps its words\' parts', async () => {
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261124T080000Z'] });
    const a = await editInfo(NOA, gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')));
    assert(a !== 'not_found', 'nf');
    assertSame(a.series.spec, { freq: 'weekly', interval: 2, byDay: ['TU', 'TH'], until: '2026-11-19' }, 'the spec: the last slot at or before the UNTIL (every other week, so the 19th)');
    assertSame(a.series.repeat, { freq: 'weekly', interval: 2, byDay: ['TU', 'TH'], ends: true, until: '2026-11-19' }, 'the parts');
    seed(NOA_CAL, 'nth', { start: '2026-10-13T10:00:00', summary: 'Club', recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=5'] });
    const n = await editInfo(NOA, gkey(NOA_CAL, inst('nth', '2026-11-10T10:00:00')));
    assert(n !== 'not_found', 'nf');
    assertSame(n.series.spec, { freq: 'monthly', interval: 1, monthly: 'weekday', count: 5 }, 'the second Tuesday');
    seed(NOA_CAL, 'odd', { start: '2026-10-06T10:00:00', summary: 'Odd', recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=1MO,3FR'] });
    const o = await editInfo(NOA, gkey(NOA_CAL, inst('odd', '2026-11-02T10:00:00')));
    assert(o !== 'not_found', 'nf');
    assertSame([o.series.spec, o.series.repeat?.byDayOrdinals], [undefined, [1, 3]], 'custom: no spec');
  });

  await check('richer repeats, create: a spec goes through the one builder to Google (a timed UNTIL in UTC, an all-day one a date); a Hebrew spec and a bad spec are 400 repeat and write nothing', async () => {
    const make = async (repeat: unknown, over: Row = {}) => write.createItem(NOA, createCmd({ kind: 'event', title: 'Swim', allDay: false, start: '2026-10-22T18:00', end: '2026-10-22T19:00', repeat, calendarId: FAMILY, ...over }), IL);
    const rule = async (repeat: unknown, over: Row = {}) => {
      calls.length = 0;
      const r = await make(repeat, over);
      assert(r.status === 'ok', `${show(repeat)} ${show(r)}`);
      return writes()[0].body!.recurrence;
    };
    assertSame(await rule({ freq: 'weekly', interval: 2, byDay: ['MO'], until: '2026-12-01' }), ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;WKST=SU;UNTIL=20261201T215959Z'], 'timed: Thursday start, Monday chip, until at the end of the day in Israel (UTC)');
    assertSame(await rule({ freq: 'monthly', interval: 1, monthly: 'weekday', count: 4 }, { start: '2026-10-13T18:00', end: '2026-10-13T19:00' }), ['RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=4'], 'the second Tuesday, 4 times');
    assertSame(await rule({ freq: 'monthly', interval: 1, monthly: 'last' }, { start: '2026-10-29T18:00', end: '2026-10-29T19:00' }), ['RRULE:FREQ=MONTHLY;BYDAY=-1TH'], 'the last Thursday');
    assertSame(await rule({ freq: 'daily', interval: 3, until: '2026-12-01' }, { allDay: true, start: '2026-10-22', end: '2026-10-22' }), ['RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261201'], 'all-day: a date');
    assertSame(await rule('daily'), ['RRULE:FREQ=DAILY'], 'a string is its spec');
    calls.length = 0;
    for (const [name, repeat, over] of [
      ['a Hebrew spec', { freq: 'hebrew', interval: 1 }, {}],
      ['a last weekday off the last week', { freq: 'monthly', interval: 1, monthly: 'last' }, {}],
      ['an until before the start', { freq: 'daily', interval: 1, until: '2026-10-21' }, {}],
    ] as [string, Row, Row][]) {
      assertSame([await make(repeat, over), writes().length], [{ status: 'invalid', field: 'repeat' }, 0], name);
    }
  });

  await check('richer repeats, edit: a spec equal to the stored rule writes nothing; a changed one is a "following" rule; a changed end counts from the first occurrence, an unchanged one carries, Never removes it; a Hebrew spec is 400 repeat', async () => {
    WEEKLY_TUE();
    const key = gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00'));
    assertSame(await write.updateItem(NOA, patchCmd({ key, scope: 'following', changes: { repeat: { freq: 'weekly', interval: 1, byDay: ['TU'] } } }), IL), { status: 'ok', key }, 'same spec');
    assertSame(writes().length, 0, 'wrote');
    const changed = await write.updateItem(NOA, patchCmd({ key, scope: 'single', changes: { repeat: { freq: 'weekly', interval: 2, byDay: ['TU', 'FR'] } } }), IL);
    assert(changed.status === 'ok', show(changed));
    const inserted = writes().find((w) => w.method === 'POST' && /\/events$/.test(w.path));
    assertSame(inserted?.body?.recurrence, ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,FR;WKST=SU'], 'the new part\'s rule');
    assertSame([tracked[0].meta.scope, stored(NOA_CAL, 'wk')!.recurrence], ['following', ['RRULE:FREQ=WEEKLY;UNTIL=20261020T065959Z']], 'forced following, the master cut');
    // Ends: a COUNT series, cut after two slots.
    reset();
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'] });
    const cut = gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00'));
    const recurrenceOfNewPart = () => writes().find((w) => w.method === 'POST' && /\/events$/.test(w.path))?.body?.recurrence;
    assert((await write.updateItem(NOA, patchCmd({ key: cut, scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, count: 5 } } }), IL)).status === 'ok', 'count 5');
    assertSame(recurrenceOfNewPart(), ['RRULE:FREQ=DAILY;COUNT=3'], 'five in all, two before the cut');
    reset();
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'] });
    assert((await write.updateItem(NOA, patchCmd({ key: cut, scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, count: 6 } } }), IL)).status === 'ok', 'count 6');
    assertSame(recurrenceOfNewPart(), ['RRULE:FREQ=DAILY;UNTIL=20261110T215959Z'], 'an unchanged count carries as the end of the old rule\'s last day (10 November, Israel)');
    reset();
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261231T215959Z'] });
    assert((await write.updateItem(NOA, patchCmd({ key: cut, scope: 'following', changes: { repeat: { freq: 'daily', interval: 1 } } }), IL)).status === 'ok', 'never');
    assertSame(recurrenceOfNewPart(), ['RRULE:FREQ=DAILY'], 'Never removes the stored end');
    reset();
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261231T215959Z'] });
    assert((await write.updateItem(NOA, patchCmd({ key: cut, scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, until: '2026-12-15' } } }), IL)).status === 'ok', 'until');
    assertSame(recurrenceOfNewPart(), ['RRULE:FREQ=DAILY;UNTIL=20261215T215959Z'], 'a new until');
    reset();
    WEEKLY_TUE();
    assertSame([await write.updateItem(NOA, patchCmd({ key: cut, scope: 'following', changes: { repeat: { freq: 'hebrew', interval: 1 } } }), IL), await write.updateItem(NOA, patchCmd({ key: cut, scope: 'following', changes: { repeat: { freq: 'monthly', interval: 1, monthly: 'last' } } }), IL), writes().length], [{ status: 'invalid', field: 'repeat' }, { status: 'invalid', field: 'repeat' }, 0], 'Hebrew, and a last weekday off the last week');
  });

  await check('richer repeats, edit: a fixed-day Google series moved with its shown spec restated is a "following" rule on the new start (the chips gain the day); without it the move is refused', async () => {
    seed(NOA_CAL, 'tt', { start: '2026-10-06T10:00:00', summary: 'Class', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH'] });
    const key = gkey(NOA_CAL, inst('tt', '2026-10-22T10:00:00'));
    const move = { start: '2026-10-21T10:00', end: '2026-10-21T11:00' };
    assertSame(await write.updateItem(NOA, patchCmd({ key, scope: 'following', changes: move }), IL), { status: 'invalid', field: 'start' }, 'refused alone');
    reset();
    seed(NOA_CAL, 'tt', { start: '2026-10-06T10:00:00', summary: 'Class', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH'] });
    const r = await write.updateItem(NOA, patchCmd({ key, scope: 'following', changes: { ...move, repeat: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] } } }), IL);
    assert(r.status === 'ok', show(r));
    assertSame(writes().find((w) => w.method === 'POST' && /\/events$/.test(w.path))?.body?.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU,WE,TH'], 'Wednesday joins');
  });

  await check('richer repeats, edit: the client\'s restated body on a single-day BYDAY Google series (Tuesday moved to Thursday) is a following tail FREQ=WEEKLY from there; a bot-style BYMONTHDAY moved to the 15th likewise; an untouched plain weekly writes nothing', async () => {
    seed(NOA_CAL, 'tu1', { start: '2026-10-06T10:00:00', summary: 'Sync', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
    const key = gkey(NOA_CAL, inst('tu1', '2026-10-20T10:00:00'));
    const r = await write.updateItem(NOA, patchCmd({ key, scope: 'following', changes: { start: '2026-10-22T10:00', end: '2026-10-22T11:00', repeat: { freq: 'weekly', interval: 1, byDay: ['TH'] } } }), IL);
    assert(r.status === 'ok', show(r));
    assertSame(writes().find((w) => w.method === 'POST' && /\/events$/.test(w.path))?.body?.recurrence, ['RRULE:FREQ=WEEKLY'], 'a tail on Thursdays');
    reset();
    seed(NOA_CAL, 'rent', { start: '2026-10-14T10:00:00', summary: 'Rent', recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=14'] });
    const d = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, inst('rent', '2026-11-14T10:00:00')), scope: 'following', changes: { start: '2026-11-15T10:00', end: '2026-11-15T11:00', repeat: { freq: 'monthly', interval: 1, monthly: 'day' } } }), IL);
    assert(d.status === 'ok', show(d));
    assertSame(writes().find((w) => w.method === 'POST' && /\/events$/.test(w.path))?.body?.recurrence, ['RRULE:FREQ=MONTHLY'], 'monthly on the 15th');
    reset();
    WEEKLY_TUE();
    const k2 = gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00'));
    assertSame(await write.updateItem(NOA, patchCmd({ key: k2, scope: 'following', changes: { repeat: { freq: 'weekly', interval: 1, byDay: ['TU'] } } }), IL), { status: 'ok', key: k2 }, 'untouched');
    assertSame(writes().length, 0, 'wrote');
  });

  await check('richer repeats, edit: a Google split head (UNTIL a period past its last occurrence) shown as "until 20 Oct" and given a denser rule with the end untouched ends on the 20th, not on its UNTIL', async () => {
    seed(NOA_CAL, 'hd', { start: '2026-10-13T10:00:00', summary: 'Swim', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261027T075959Z'] });
    const key = gkey(NOA_CAL, inst('hd', '2026-10-13T10:00:00'));
    const info = await editInfo(NOA, key);
    assert(info !== 'not_found', 'nf');
    assertSame(info.series.spec?.until, '2026-10-20', 'the sheet shows the last occurrence\'s day');
    const r = await write.updateItem(NOA, patchCmd({ key, scope: 'following', changes: { repeat: { freq: 'daily', interval: 1, until: '2026-10-20' } } }), IL);
    assert(r.status === 'ok', show(r));
    const sent = writes().map((w) => w.body?.recurrence).filter(Boolean).flat() as string[];
    assertSame(sent, ['RRULE:FREQ=DAILY;UNTIL=20261020T205959Z'], 'ends at the close of the 20th there');
  });

  await check('richer repeats, edit: a Google every-2-weeks Sun+Tue rule with no WKST keeps Monday weeks when only the end changes', async () => {
    seed(NOA_CAL, 'bi', { start: '2026-10-25T10:00:00', summary: 'Club', recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU'] });
    const r = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, inst('bi', '2026-11-03T10:00:00')), scope: 'following', changes: { repeat: { freq: 'weekly', interval: 2, byDay: ['SU', 'TU'], count: 5 } } }), IL);
    assert(r.status === 'ok', show(r));
    const rule = writes().find((w) => w.method === 'POST' && /\/events$/.test(w.path))?.body?.recurrence?.[0];
    assert(/WKST=MO/.test(rule), `kept Monday: ${rule}`);
  });

  await check('year floor: a yearly Google series may move to 1950 as a FamCal item may (one rule); a weekly one keeps 2000', async () => {
    seed(NOA_CAL, 'yr', { start: '2026-10-20T10:00:00', summary: 'Birthday', recurrence: ['RRULE:FREQ=YEARLY'] });
    const yearly = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, inst('yr', '2026-10-20T10:00:00')), scope: 'single', changes: { start: '1950-10-20T10:00', end: '1950-10-20T11:00' } }), IL);
    assert(yearly.status === 'ok', `yearly to 1950: ${show(yearly)}`);
    reset();
    WEEKLY_TUE();
    const weekly = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')), scope: 'single', changes: { start: '1950-10-20T10:00', end: '1950-10-20T11:00' } }), IL);
    assertSame(weekly, { status: 'invalid', field: 'start' }, 'weekly to 1950');
  });

  await check('move: the move comes first, then the patch on the destination; the key names the destination', async () => {
    seed(NOA_CAL, 'one', { start: '2026-10-20T10:00:00', summary: 'Dentist' });
    const r = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'one'), scope: 'single', changes: { calendarId: FAMILY, title: 'Dentist 2' } }), IL);
    assertSame(r, { status: 'ok', key: gkey(FAMILY, 'one') }, 'result');
    assertSame(writeLog(), [`POST /calendars/${encodeURIComponent(NOA_CAL)}/events/one/move`, `PATCH /calendars/${encodeURIComponent(FAMILY)}/events/one`], 'order');
    assertSame(stored(FAMILY, 'one')?.summary, 'Dentist 2', 'patched there');
    assertSame(tracked.map((t) => t.meta.changed_fields), [['title', 'calendar']], 'analytics');
  });

  await check('move: a series moves whole with "all" (the master, its key the same occurrence on the destination)', async () => {
    WEEKLY_TUE();
    const r = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')), scope: 'all', changes: { calendarId: FAMILY } }), IL);
    assertSame([r, writeLog()], [{ status: 'ok', key: gkey(FAMILY, inst('wk', '2026-10-20T10:00:00')) }, [`POST /calendars/${encodeURIComponent(NOA_CAL)}/events/wk/move`]], 'moved');
  });

  await check('move: a failed move writes nothing else; a patch that fails after a move is logged, and the new key is returned and stamped', async () => {
    seed(NOA_CAL, 'one', { start: '2026-10-20T10:00:00' });
    failOn((r) => r.path.endsWith('/move'), fail(403, 'cannotChangeOrganizer', 'Cannot change the organizer.'));
    const a = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'one'), scope: 'single', changes: { calendarId: FAMILY, title: 'x' } }), IL);
    assertSame([a, writeLog().length], [{ status: 'not_allowed' }, 1], 'move refused');
    calls.length = 0;
    stamps.length = 0;
    captured.length = 0;
    failOn((r) => r.method === 'PATCH', fail(500, 'backendError', 'Backend Error'));
    const b = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'one'), scope: 'single', changes: { calendarId: FAMILY, title: 'x' } }), IL);
    assertSame(b, { status: 'ok', key: gkey(FAMILY, 'one') }, 'ok after the move');
    assert(captured.some((c) => c.ctx === 'calendar-google-item-patch-after-move'), `not logged: ${show(captured.map((c) => c.ctx))}`);
    assert(stamps.length >= 2, `stamps ${stamps.length}`);
  });

  await check('move: "following" from the first occurrence with a calendar change (run as "all"): a patch that fails after the move is logged, and the new key is returned', async () => {
    WEEKLY_TUE();
    failOn((r) => r.method === 'PATCH', fail(500, 'backendError', 'Backend Error'));
    const first = inst('wk', '2026-10-06T10:00:00');
    const r = await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, first), scope: 'following', changes: { calendarId: FAMILY, title: 'x' } }), IL);
    assertSame([r, Boolean(stored(FAMILY, 'wk'))], [{ status: 'ok', key: gkey(FAMILY, first) }, true], 'ok after the move');
    assert(captured.some((c) => c.ctx === 'calendar-update-following-patch-after-move'), `not logged: ${show(captured.map((c) => c.ctx))}`);
  });

  await check('delete: each scope goes to Google; a refused one is notAllowed, a gone one changed', async () => {
    WEEKLY_TUE();
    const r = await write.deleteItem(NOA, deleteCmd({ key: gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')), scope: 'single' }));
    assertSame([r, writeLog()], [{ status: 'ok' }, [`DELETE /calendars/${encodeURIComponent(NOA_CAL)}/events/${inst('wk', '2026-10-20T10:00:00')}`]], 'single');
    const all = await write.deleteItem(NOA, deleteCmd({ key: gkey(NOA_CAL, inst('wk', '2026-10-27T10:00:00')), scope: 'all' }));
    assertSame([all, Boolean(stored(NOA_CAL, 'wk'))], [{ status: 'ok' }, false], 'all');
    seed(NOA_CAL, 'guests', { start: '2026-10-20T10:00:00', attendees: [{ email: NOA_CAL, self: true, organizer: true }, { email: 'x@y.com' }] });
    assertSame(await write.deleteItem(NOA, deleteCmd({ key: gkey(NOA_CAL, 'guests'), scope: 'single' })), { status: 'not_allowed' }, 'with guests');
    assertSame(await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'guests'), scope: 'single', changes: { title: 'x' } }), IL), { status: 'not_allowed' }, 'edit with guests');
    assertSame(await write.deleteItem(NOA, deleteCmd({ key: gkey(WORK, 'x'), scope: 'single' })), { status: 'not_found' }, 'not chosen');
  });

  await check('outcomes: a dead token or missing scopes answer reconnect; refused notAllowed; gone changed; transient failed; a fixed-days move the start', async () => {
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    const edit = () => write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'e1'), scope: 'single', changes: { title: 'x' } }), IL);
    failOn((r) => r.method === 'PATCH', fail(401, 'authError', 'Invalid Credentials'));
    assertSame(await edit(), { status: 'reconnect', reason: 'token' }, 'token');
    failOn((r) => r.method === 'PATCH', fail(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.'));
    assertSame(await edit(), { status: 'reconnect', reason: 'scopes' }, 'scopes');
    failOn((r) => r.method === 'PATCH', fail(403, 'forbiddenForNonOrganizer', 'Shared properties can only be changed by the organizer of the event.'));
    assertSame(await edit(), { status: 'not_allowed' }, 'forbidden');
    failOn((r) => r.method === 'PATCH', fail(404, 'notFound', 'Not Found'));
    assertSame(await edit(), { status: 'changed' }, 'gone');
    failOn((r) => r.method === 'PATCH', fail(429, 'rateLimitExceeded', 'Rate Limit Exceeded'));
    assertSame(await edit(), { status: 'failed' }, 'transient');
    WEEKLY_TUE({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
    assertSame(await write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, inst('wk', '2026-10-20T10:00:00')), scope: 'all', changes: { start: '2026-10-21T10:00', end: '2026-10-21T11:00' } }), IL), { status: 'invalid', field: 'start' }, 'fixed days');
    const res = writeResponse({ status: 'reconnect', reason: 'token' });
    assertSame([res.status, await res.json()], [403, { error: 'reconnect', reason: 'token' }], 'wire: reconnect');
    const failed = writeResponse({ status: 'failed' });
    assertSame([failed.status, await failed.json()], [500, { error: 'internal_error' }], 'wire: failed');
  });

  await check('outcomes: a create whose calendar list can\'t be read answers by the failure (dead token reconnect, missing token reconnect, Google down failed), not a bad calendar', async () => {
    const create = (o: Row = {}) => write.createItem(NOA, createCmd({ kind: 'event', title: 'x', allDay: false, start: '2026-10-22T18:00', ...o }), IL);
    const list = (r: Req) => r.method === 'GET' && r.path === '/users/me/calendarList';
    tokenAnswer = { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    assertSame(await create({ calendarId: FAMILY }), { status: 'reconnect', reason: 'token' }, 'invalid_grant, a calendar');
    assertSame(await create(), { status: 'reconnect', reason: 'token' }, 'invalid_grant, no calendar');
    tokenAnswer = null;
    failOn(list, fail(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.'), 20);
    assertSame(await create({ calendarId: FAMILY }), { status: 'reconnect', reason: 'scopes' }, 'scopes');
    rules = [];
    failOn(list, fail(503, 'backendError', 'Backend Error'), 50);
    assertSame(await create({ calendarId: FAMILY }), { status: 'failed' }, '503, a calendar');
    assertSame(await create(), { status: 'failed' }, '503, no calendar');
    rules = [];
    // The list's reader rewrites any 403 to GOOGLE_TOKEN_EXPIRED; Google's own error says it is a rate limit.
    failOn(list, fail(403, 'rateLimitExceeded', 'Rate Limit Exceeded'), 20);
    assertSame(await create({ calendarId: FAMILY }), { status: 'failed' }, 'a 403 rate limit');
    rules = [];
    const noToken = user(10, IL, { googleRefreshToken: undefined });
    assertSame(await write.createItem(noToken, createCmd({ kind: 'event', title: 'x', allDay: false, start: '2026-10-22T18:00', calendarId: FAMILY }), IL), { status: 'reconnect', reason: 'token' }, 'no refresh token, a calendar');
    assertSame(await write.createItem(noToken, createCmd({ kind: 'event', title: 'x', allDay: false, start: '2026-10-22T18:00' }), IL), { status: 'reconnect', reason: 'token' }, 'no refresh token, no calendar');
    assertSame(writes().length, 0, 'something was written');
    assert(captured.some((c) => c.ctx === 'calendar-editor-google'), 'the failed list was not logged');
  });

  await check('outcomes: a move whose calendar list can\'t be read answers by the failure (dead token reconnect, Google down failed), not a bad calendar', async () => {
    seed(NOA_CAL, 'e1', { start: '2026-10-20T10:00:00' });
    const move = () => write.updateItem(NOA, patchCmd({ key: gkey(NOA_CAL, 'e1'), scope: 'single', changes: { calendarId: FAMILY } }), IL);
    const list = (r: Req) => r.method === 'GET' && r.path === '/users/me/calendarList';
    failOn(list, fail(401, 'authError', 'Invalid Credentials'), 20);
    assertSame(await move(), { status: 'reconnect', reason: 'token' }, 'token');
    rules = [];
    failOn(list, fail(503, 'backendError', 'Backend Error'), 50);
    assertSame(await move(), { status: 'failed' }, '503');
    rules = [];
    assertSame([writes().length, alive(NOA_CAL, 'e1')], [0, true], 'written');
    assertSame(await move(), { status: 'ok', key: gkey(FAMILY, 'e1') }, 'the move once the list reads');
  });

  await check('keys: the item route reads famcal| and google| keys; a PATCH or DELETE body takes either; a calendar of the other kind is the cross-source move (smoke-calendar-move)', async () => {
    assertSame(validate.parseAnyItemKey(`google|${HOLIDAYS}|abc_20261020T070000Z`), { source: 'google', calendarId: HOLIDAYS, eventId: 'abc_20261020T070000Z' }, 'google');
    const fam = validate.parseAnyItemKey('famcal|abc123#2026-10-20T07:00:00.000Z');
    assertSame([fam?.source, fam?.seriesCuid], ['famcal', 'abc123'], 'famcal');
    assert(validate.parseUpdate({ key: gkey(NOA_CAL, 'e1'), scope: 'single', changes: { calendarId: 'native:abc' } }).ok, 'a FamCal calendar for a Google item: the move');
    assert(validate.parseUpdate({ key: 'famcal|abc', scope: 'single', changes: { calendarId: FAMILY } }).ok, 'a Google calendar for a FamCal item: the move');
    assertSame(validate.parseUpdate({ key: gkey(NOA_CAL, 'e1'), scope: 'single', changes: { calendarId: 'native:' } }), { ok: false, field: 'calendarId' }, 'an empty FamCal id');
    assert(validate.parseDelete({ key: gkey(NOA_CAL, 'e1'), scope: 'single' }).ok, 'delete');
    assert(validate.parseCreate({ kind: 'event', title: 'x', allDay: false, start: '2026-10-22T18:00', calendarId: FAMILY }).ok, 'create on Google');
  });

  for (const level of ['log', 'warn', 'error', 'info'] as const) (console as Row)[level] = quiet[level];
  const titles = ['Team sync', 'Dentist', 'Swim', 'Bring'];
  const leaked = captured.filter((c) => titles.some((t) => show(c.extra ?? {}).includes(t)));
  results.push({ name: 'logs: no title reaches an error context', ok: leaked.length === 0, reason: show(leaked.map((l) => l.ctx)) });

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? 'OK ' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${passed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  quiet.error(err);
  process.exit(1);
});
