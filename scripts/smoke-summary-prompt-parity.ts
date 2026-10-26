// Smoke test for the summary prompts' Google outage guideline (spec §3.1 step 6, §9,
// edit 8): SummaryUserContext.googleUnavailable in src/services/claude.ts, the line it
// adds to src/prompts/calendar-summary/{en,he,ru}.ts, and the two bot texts the
// summaries send when Google Calendar can't be reached (bot.errors.googleUnreachable
// and bot.errors.googleOutageNote in messages/{en,he,ru}.json).
//
// Without the flag, every prompt must be exactly the prompt main@858886c builds (A-19,
// A-33): daily, tomorrow, /week and /nextweek, in en/he/ru, with and without reminders.
// scripts/fixtures/summary-prompts.json holds those prompts. It was taken inside an
// export of main@858886c with:
//   npx tsx scripts/smoke-summary-prompt-parity.ts --write-prompt-fixture
// (Plan C, Task C2, Step 2). That mode refuses to overwrite the file. Take a new
// snapshot only when the prompts for users without the flag are meant to change:
// delete the file, then run it again.
//
// With the flag, a daily or tomorrow prompt gains exactly one line, in its guidelines.
// The AI, the holiday lookup and Sentry are faked, and the clock is frozen per case.
// No network, no DB.
//
// Run under three clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-summary-prompt-parity.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-summary-prompt-parity.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-summary-prompt-parity.ts

import Module from 'node:module';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, CalendarEvent, CalendarLabel, ReminderInfo, UserConfig } from '../src/types';
import type { SummaryUserContext } from '../src/services/claude';
import type { LookaheadEvent, RecurrenceType, WeekLookahead } from '../src/services/week-lookahead';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Environment: fakes only, set before anything under test loads ----

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

// ---- Frozen clock: the prompts read "today" and the greeting hour from it ----

const RealDate = Date;
let frozen = RealDate.now();
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(frozen);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return frozen;
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// generateSummary logs its timings on every call; keep the output to the checks.
const consoleLog = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[AI Summary Timing]')) return;
  consoleLog(...args);
};

// ---- Fakes for the AI, the holiday lookup and Sentry ----

const prompts: string[] = [];
const captured: string[] = [];
/** What the holiday lookup answers for the case being built. */
let holidays: string[] = [];
let parasha: string | null = null;

const ModuleInternals = Module as unknown as {
  new (id: string): { filename: string; loaded: boolean; exports: unknown };
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
  _cache: Record<string, unknown>;
};
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts);
// claude.ts imports it, so point it at its ESM build.
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};
function stub(file: string, exports: Record<string, unknown>) {
  const filename = path.resolve(__dirname, '../src', file);
  const mod = new ModuleInternals(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  ModuleInternals._cache[filename] = mod;
}
stub('services/ai-provider.ts', {
  generateAICompletion: async (prompt: string) => {
    prompts.push(prompt);
    return { text: 'ok' };
  },
  streamAICompletion: async () => {
    throw new Error('not streamed in this test');
  },
});
stub('services/hebrew-holidays.ts', { getHolidaysForDate: async () => holidays, weekParashaFor: () => parasha });
stub('lib/error-capture.ts', {
  captureError: (_error: unknown, context: string) => { captured.push(context); },
  captureWarning: () => {},
  captureInfo: () => {},
});

// ---- Fixture data ----

type Lang = 'en' | 'he' | 'ru';
const LANGS: Lang[] = ['en', 'he', 'ru'];
const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TZ_OF: Record<Lang, string> = { en: NY, he: IL, ru: IL };

/** An instant from a wall-clock time in a zone. */
const at = (local: string, tz: string) => fromZonedTime(local, tz);
/** A timed Google value: RFC 3339 with the zone's offset, as Google sends it. */
const gtime = (local: string, tz: string) => formatInTimeZone(at(local, tz), tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
/** A timed FamCal value: UTC ISO, as the native provider sends it. */
const ntime = (local: string, tz: string) => at(local, tz).toISOString();
const addDays = (day: string, n: number) => {
  const d = new RealDate(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Every word the fixtures use, per language: names, calendars, titles and places. */
const WORDS = {
  en: {
    me: 'Raziel', meEn: 'Raziel', partner: 'Dana', partnerEn: 'Dana', kid1: 'Noa', kid2: 'Itai', family: 'Family', birthdays: 'Birthdays',
    rule: 'Mention parking for anything downtown', globalRule: 'Keep it short on weekdays',
    standup: 'Team standup', zoom: 'Zoom', dentist: 'Dentist', dentistAt: '12 Main St', dentistNote: 'Bring the insurance card\nand the x-rays',
    release: 'Release window', conference: 'Design conference', yoga: 'Yoga', sleepover: "Sleepover at Ben's", school: 'School', schoolAt: 'Oak School',
    soccer: 'Soccer - Noa and Itai', park: 'City Park', birthday: "Grandma Ruth's Birthday",
    pills: 'Take pills', haircut: 'Haircut', cake: 'Pick up the cake', plumber: 'Call the plumber', milk: 'Buy milk', pilates: 'Pilates', dinner: 'Family dinner',
    morningCall: 'Morning call', vet: 'Book the vet',
    teacher: 'Parent-teacher meeting', hair: 'Hair appointment', trip: 'Field trip', piano: 'Piano lesson', gas: 'Pay the gas bill', gift: 'Buy a gift', grandma: 'Call grandma',
    swim: 'Swimming', plants: 'Water the plants', checkup: 'Annual checkup',
  },
  he: {
    me: 'רזיאל', meEn: 'Raziel', partner: 'דנה', partnerEn: 'Dana', kid1: 'נועה', kid2: 'איתי', family: 'משפחה', birthdays: 'ימי הולדת',
    rule: 'לציין חניה לכל דבר במרכז העיר', globalRule: 'בימי חול לקצר',
    standup: 'ישיבת צוות', zoom: 'זום', dentist: 'רופא שיניים', dentistAt: 'רחוב הרצל 12', dentistNote: 'להביא את כרטיס הביטוח\nואת צילומי הרנטגן',
    release: 'חלון שחרור גרסה', conference: 'כנס עיצוב', yoga: 'יוגה', sleepover: 'לינה אצל בן', school: 'בית ספר', schoolAt: 'בית ספר אלון',
    soccer: 'כדורגל - נועה ואיתי', park: 'פארק העיר', birthday: 'יום ההולדת של סבתא רות',
    pills: 'לקחת כדורים', haircut: 'תספורת', cake: 'לאסוף את העוגה', plumber: 'להתקשר לאינסטלטור', milk: 'לקנות חלב', pilates: 'פילאטיס', dinner: 'ארוחת ערב משפחתית',
    morningCall: 'שיחת בוקר', vet: 'לקבוע תור לווטרינר',
    teacher: 'אסיפת הורים', hair: 'תור למספרה', trip: 'טיול שנתי', piano: 'שיעור פסנתר', gas: 'לשלם חשבון גז', gift: 'לקנות מתנה', grandma: 'להתקשר לסבתא',
    swim: 'שחייה', plants: 'להשקות את העציצים', checkup: 'בדיקה שנתית',
  },
  ru: {
    me: 'Алексей', meEn: 'Alexey', partner: 'Марина', partnerEn: 'Marina', kid1: 'Лиза', kid2: 'Миша', family: 'Семья', birthdays: 'Дни рождения',
    rule: 'Упоминай парковку для всего в центре', globalRule: 'В будни покороче',
    standup: 'Планёрка', zoom: 'Zoom', dentist: 'Стоматолог', dentistAt: 'ул. Герцля, 12', dentistNote: 'Взять страховой полис\nи снимки',
    release: 'Выкатка релиза', conference: 'Конференция по дизайну', yoga: 'Йога', sleepover: 'Ночёвка у Бена', school: 'Школа', schoolAt: 'Школа «Алон»',
    soccer: 'Футбол - Лиза и Миша', park: 'Городской парк', birthday: 'День рождения бабушки Раи',
    pills: 'Выпить таблетки', haircut: 'Стрижка', cake: 'Забрать торт', plumber: 'Позвонить сантехнику', milk: 'Купить молоко', pilates: 'Пилатес', dinner: 'Семейный ужин',
    morningCall: 'Утренний звонок', vet: 'Записаться к ветеринару',
    teacher: 'Родительское собрание', hair: 'Парикмахер', trip: 'Экскурсия', piano: 'Урок фортепиано', gas: 'Оплатить газ', gift: 'Купить подарок', grandma: 'Позвонить бабушке',
    swim: 'Плавание', plants: 'Полить цветы', checkup: 'Ежегодный осмотр',
  },
} as const;

/** The Google family: own, spouse, two kids, a shared family calendar and birthdays. */
function googleCalendars(l: Lang): CalendarAssignment[] {
  const w = WORDS[l];
  return [
    { calendarId: 'me@example.com', labels: ['primary', 'yours'], name: w.me, color: '#039BE5', rules: [w.rule] },
    { calendarId: 'partner@example.com', labels: ['spouse'], name: w.partner, color: '#039BE5', personName: w.partner, personEnglishName: w.partnerEn, personGender: 'female' },
    { calendarId: 'kid1@group.calendar.google.com', labels: ['kids'], name: w.kid1, color: '#33B679', personName: w.kid1 },
    { calendarId: 'kid2@group.calendar.google.com', labels: ['kids'], name: w.kid2, color: '#F4511E', personName: w.kid2 },
    { calendarId: 'family@group.calendar.google.com', labels: [], name: w.family, color: '#8E24AA' },
    { calendarId: 'addressbook#contacts@group.v.calendar.google.com', labels: ['birthdays'], name: w.birthdays, color: '#0B8043' },
  ];
}

/** A FamCal couple: own calendar, the partner's shared one and a family calendar. */
function famcalCalendars(l: Lang): CalendarAssignment[] {
  const w = WORDS[l];
  return [
    { calendarId: 'native:cmecalendar0000000000001', labels: ['primary', 'yours'], name: w.me, color: '#039BE5' },
    { calendarId: 'native:cpartnercalendar00000002', labels: ['spouse'], name: w.partner, color: '#039BE5', personName: w.partner, personEnglishName: w.partnerEn, personGender: 'female' },
    { calendarId: 'native:cfamilycalendar000000003', labels: [], name: w.family, color: '#8E24AA' },
  ];
}

const soloCalendars = (l: Lang): CalendarAssignment[] =>
  [{ calendarId: 'me@example.com', labels: ['primary', 'yours'], name: WORDS[l].me, color: '#039BE5' }];

const OWN: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };
const fromPartner = (l: Lang): ReminderInfo => ({ ownerIsViewer: true, creatorIsViewer: false, creatorName: WORDS[l].partner });
const forPartner = (l: Lang): ReminderInfo => ({ ownerIsViewer: false, creatorIsViewer: true, ownerName: WORDS[l].partner });

type Lists = { user: CalendarEvent[]; spouse: CalendarEvent[]; other: CalendarEvent[] };

/** The Google family's day, already shaped and categorized as prepareSummaryForUser hands it on. */
function googleFamilyDay(l: Lang, day: string): Lists {
  const w = WORDS[l];
  const tz = TZ_OF[l];
  const [me, partner, kid1, kid2, family, birthdays] = googleCalendars(l);
  const ev = (cal: CalendarAssignment, summary: string, start: string, end: string, more: Partial<CalendarEvent> = {}): CalendarEvent =>
    ({ summary, start, end, calendarName: cal.name, calendarId: cal.calendarId, eventType: 'default', eventId: `${cal.calendarId}:${summary}`, ...more });
  return {
    user: [
      ev(me, w.standup, gtime(`${day} 09:30:00`, tz), gtime(`${day} 09:45:00`, tz), { location: w.zoom }),
      ev(me, w.dentist, gtime(`${day} 14:00:00`, tz), gtime(`${day} 15:00:00`, tz), { location: w.dentistAt, description: w.dentistNote }),
      ev(me, w.release, gtime(`${day} 22:00:00`, tz), gtime(`${addDays(day, 1)} 02:00:00`, tz), { daySpan: 'endsLater' }),
    ],
    spouse: [
      ev(partner, w.conference, addDays(day, -1), addDays(day, 2), { daySpan: 'spansDay' }),
      ev(partner, w.yoga, gtime(`${day} 18:00:00`, tz), gtime(`${day} 19:00:00`, tz)),
    ],
    other: [
      ev(kid2, w.sleepover, gtime(`${addDays(day, -1)} 18:00:00`, tz), gtime(`${day} 10:00:00`, tz), { daySpan: 'continues' }),
      ev(kid1, w.school, gtime(`${day} 08:00:00`, tz), gtime(`${day} 13:50:00`, tz), { location: w.schoolAt }),
      ev(family, w.soccer, gtime(`${day} 16:00:00`, tz), gtime(`${day} 17:30:00`, tz), { location: w.park }),
      ev(birthdays, w.birthday, day, addDays(day, 1), { eventType: 'birthday' }),
    ],
  };
}

/** The FamCal couple's day with reminders: open, from and for the partner, carried over. */
function famcalReminderDay(l: Lang, day: string, tomorrow: boolean): Lists {
  const w = WORDS[l];
  const tz = TZ_OF[l];
  const [me, partner, family] = famcalCalendars(l);
  const ev = (cal: CalendarAssignment, summary: string, start: string, end: string, more: Partial<CalendarEvent> = {}): CalendarEvent =>
    ({ summary, start, end, calendarName: cal.name, calendarId: cal.calendarId, eventId: `${cal.calendarId}:${summary}`, ...more });
  const reminder = (cal: CalendarAssignment, summary: string, start: string, info: ReminderInfo): CalendarEvent =>
    ev(cal, summary, start, start, { eventType: 'reminder', reminder: info });
  if (tomorrow) {
    return {
      user: [
        reminder(me, w.pills, ntime(`${day} 07:00:00`, tz), OWN),
        ev(me, w.haircut, ntime(`${day} 11:00:00`, tz), ntime(`${day} 11:30:00`, tz)),
        reminder(me, w.morningCall, ntime(`${addDays(day, -1)} 10:00:00`, tz), { ...OWN, open: true, openSince: addDays(day, -1) }),
      ],
      spouse: [reminder(me, w.vet, day, forPartner(l))],
      other: [ev(family, w.dinner, ntime(`${day} 20:00:00`, tz), ntime(`${day} 22:00:00`, tz))],
    };
  }
  return {
    user: [
      reminder(me, w.pills, ntime(`${day} 07:00:00`, tz), { ...OWN, open: true }),
      ev(me, w.haircut, ntime(`${day} 11:00:00`, tz), ntime(`${day} 11:30:00`, tz)),
      reminder(partner, w.cake, ntime(`${day} 17:00:00`, tz), fromPartner(l)),
      reminder(me, w.plumber, ntime(`${addDays(day, -2)} 10:00:00`, tz), { ...OWN, open: true, openSince: addDays(day, -2) }),
    ],
    spouse: [
      reminder(me, w.milk, ntime(`${day} 17:00:00`, tz), forPartner(l)),
      ev(partner, w.pilates, ntime(`${day} 19:00:00`, tz), ntime(`${day} 20:00:00`, tz)),
    ],
    other: [ev(family, w.dinner, ntime(`${day} 20:00:00`, tz), ntime(`${day} 22:00:00`, tz))],
  };
}

/** The tomorrow summary's week block, in formatTomorrowLookahead's English lines. */
function tomorrowLookaheadText(l: Lang): string {
  const w = WORDS[l];
  return [
    `Friday: ${w.teacher} at 17:00 (${w.me})`,
    `Saturday: ${w.birthday} (Birthday)`,
    `Sunday: ${w.plants} (Reminder 18:00)`,
  ].join('\n');
}

const userRow = (l: Lang, culture: string) => ({
  id: 1, telegramId: 1001, name: WORDS[l].me, englishName: WORDS[l].meEn, gender: 'male', language: l, culture,
  globalRules: [WORDS[l].globalRule], isAdmin: false,
}) as unknown as UserConfig;

/** A lookahead event, listed on `day` in the user's zone. */
function la(
  l: Lang, today: string, cal: CalendarAssignment, label: CalendarLabel, summary: string, day: string, time: string | null,
  more: Partial<LookaheadEvent> & { recurrenceType?: RecurrenceType } = {}
): LookaheadEvent {
  const tz = TZ_OF[l];
  const start = time ? at(`${day} ${time}:00`, tz) : at(`${day} 00:00:00`, tz);
  const end = time ? new RealDate(start.getTime() + 60 * 60_000) : at(`${addDays(day, 1)} 00:00:00`, tz);
  const daysFromNow = Math.round((new RealDate(`${day}T12:00:00Z`).getTime() - new RealDate(`${today}T12:00:00Z`).getTime()) / 86_400_000);
  return {
    summary, start, end, day, calendarName: cal.name, calendarId: cal.calendarId, calendarLabel: label,
    recurrenceType: 'single', daysFromNow, isAllDay: !time, isBirthday: false, ...more,
  };
}

/** The label the lookahead gives an item on `cal` (getCalendarLabel). */
const labelOf = (cal: CalendarAssignment): CalendarLabel =>
  cal.labels.includes('primary') ? 'yours' : cal.labels.includes('spouse') ? 'spouse' : cal.labels.includes('kids') ? 'kids' : cal.labels.includes('birthdays') ? 'birthdays' : 'yours';

/** The end of the lookahead's last day, as week-lookahead.ts's endOfLocalDay gives it. */
const endOfDay = (day: string, tz: string) => new RealDate(at(`${addDays(day, 1)} 00:00:00`, tz).getTime() - 1);

/**
 * /week from Wednesday 09:00: the rest of the week. Without reminders it is the Google
 * family (kids and birthdays included); with reminders, the FamCal couple.
 */
function weekLookahead(l: Lang, culture: string, withReminders: boolean): { lookahead: WeekLookahead; calendars: CalendarAssignment[] } {
  const w = WORDS[l];
  const tz = TZ_OF[l];
  const today = '2026-10-14';
  const last = culture === 'jewish' ? '2026-10-17' : '2026-10-18';
  const item = (cal: CalendarAssignment, summary: string, day: string, time: string | null, more: Partial<LookaheadEvent> = {}) =>
    la(l, today, cal, labelOf(cal), summary, day, time, more);
  let calendars: CalendarAssignment[];
  let events: LookaheadEvent[];
  if (withReminders) {
    calendars = famcalCalendars(l);
    const [me, partner, family] = calendars;
    events = [
      item(partner, w.conference, today, null, { runningLabel: 'All day (began Tue, through Thu)' }),
      item(me, w.gas, '2026-10-15', '09:00', { reminder: OWN }),
      item(me, w.teacher, '2026-10-15', '17:00'),
      item(me, w.gift, '2026-10-16', null, { reminder: forPartner(l) }),
      item(partner, w.hair, '2026-10-16', '10:00'),
      item(partner, w.grandma, '2026-10-17', '11:00', { reminder: fromPartner(l) }),
      item(family, w.dinner, '2026-10-17', '20:00', { recurrenceType: 'weekly' }),
    ];
  } else {
    calendars = googleCalendars(l);
    const [me, partner, kid1, kid2, , birthdays] = calendars;
    events = [
      item(partner, w.conference, today, null, { runningLabel: 'All day (began Tue, through Thu)' }),
      item(kid2, w.piano, '2026-10-15', '16:00', { recurrenceType: 'weekly' }),
      item(me, w.teacher, '2026-10-15', '17:00'),
      item(kid1, w.trip, '2026-10-16', null),
      item(partner, w.hair, '2026-10-16', '10:00'),
      item(birthdays, w.birthday, '2026-10-17', null, { isBirthday: true, recurrenceType: 'yearly' }),
    ];
  }
  return { lookahead: { events, dateRange: { start: at(`${today} 09:00:00`, tz), end: endOfDay(last, tz) }, timezone: tz }, calendars };
}

/** /nextweek from Wednesday 09:00: next week's whole days, for the FamCal couple, with reminders. */
function nextWeekLookahead(l: Lang, culture: string): { lookahead: WeekLookahead; calendars: CalendarAssignment[] } {
  const w = WORDS[l];
  const tz = TZ_OF[l];
  const calendars = famcalCalendars(l);
  const [me, partner, family] = calendars;
  const today = '2026-10-14';
  const first = culture === 'jewish' ? '2026-10-18' : '2026-10-19';
  const last = addDays(first, 6);
  const item = (cal: CalendarAssignment, summary: string, day: string, time: string | null, more: Partial<LookaheadEvent> = {}) =>
    la(l, today, cal, labelOf(cal), summary, day, time, more);
  const events: LookaheadEvent[] = [
    item(family, w.swim, first, '16:30', { recurrenceType: 'weekly' }),
    item(me, w.checkup, addDays(first, 2), '08:15'),
    item(me, w.plants, addDays(first, 2), '18:00', { reminder: OWN }),
    item(partner, w.conference, addDays(first, 3), null),
    item(me, w.gift, addDays(first, 4), null, { reminder: forPartner(l) }),
  ];
  return { lookahead: { events, dateRange: { start: at(`${first} 00:00:00`, tz), end: endOfDay(last, tz) }, timezone: tz }, calendars };
}

// ---- The cases: every prompt kind, by name ----

type DailyCase = {
  kind: 'daily' | 'tomorrow'; language: Lang; culture: string; now: string; day: string; holidays?: string[];
  calendars: CalendarAssignment[]; lists: Lists; spouse: boolean; openRemindersMore: number; weekLookahead?: string;
};
type WeeklyCase = { kind: 'week' | 'nextweek'; language: Lang; culture: string; now: string; build: () => { lookahead: WeekLookahead; calendars: CalendarAssignment[] } };
type Case = DailyCase | WeeklyCase;
const isDaily = (c: Case): c is DailyCase => c.kind === 'daily' || c.kind === 'tomorrow';

const CASES: Record<string, Case> = {};
const CULTURE: Record<Lang, { family: string; reminders: string; empty: string; weekly: string }> = {
  en: { family: 'default', reminders: 'jewish', empty: 'default', weekly: 'default' },
  he: { family: 'jewish', reminders: 'default', empty: 'jewish', weekly: 'jewish' },
  ru: { family: 'jewish', reminders: 'default', empty: 'default', weekly: 'jewish' },
};
const HOLIDAY: Record<Lang, string> = { en: 'Rosh Chodesh Cheshvan', he: 'ראש חודש חשון', ru: 'Рош Ходеш Хешван' };
for (const l of LANGS) {
  const c = CULTURE[l];
  // Monday 12 Oct 2026 is Rosh Chodesh Cheshvan: a Jewish-culture family day names it.
  const familyDay = c.family === 'jewish' ? '2026-10-12' : '2026-10-14';
  CASES[`daily-${l}-family`] = {
    kind: 'daily', language: l, culture: c.family, now: `${familyDay} 07:00:00`, day: familyDay,
    holidays: c.family === 'jewish' ? [HOLIDAY[l]] : [], calendars: googleCalendars(l), lists: googleFamilyDay(l, familyDay), spouse: true, openRemindersMore: 0,
  };
  CASES[`daily-${l}-reminders`] = {
    kind: 'daily', language: l, culture: c.reminders, now: '2026-10-14 08:00:00', day: '2026-10-14',
    calendars: famcalCalendars(l), lists: famcalReminderDay(l, '2026-10-14', false), spouse: true, openRemindersMore: 2,
  };
  CASES[`daily-${l}-empty`] = {
    kind: 'daily', language: l, culture: c.empty, now: '2026-10-14 07:00:00', day: '2026-10-14',
    calendars: soloCalendars(l), lists: { user: [], spouse: [], other: [] }, spouse: false, openRemindersMore: 0,
  };
  CASES[`tomorrow-${l}-family`] = {
    kind: 'tomorrow', language: l, culture: c.family, now: '2026-10-14 19:00:00', day: '2026-10-15',
    calendars: googleCalendars(l), lists: googleFamilyDay(l, '2026-10-15'), spouse: true, openRemindersMore: 0, weekLookahead: tomorrowLookaheadText(l),
  };
  CASES[`tomorrow-${l}-reminders`] = {
    kind: 'tomorrow', language: l, culture: c.reminders, now: '2026-10-14 20:00:00', day: '2026-10-15',
    calendars: famcalCalendars(l), lists: famcalReminderDay(l, '2026-10-15', true), spouse: true, openRemindersMore: 1,
  };
  CASES[`week-${l}`] = { kind: 'week', language: l, culture: c.weekly, now: '2026-10-14 09:00:00', build: () => weekLookahead(l, c.weekly, false) };
  CASES[`week-${l}-reminders`] = { kind: 'week', language: l, culture: c.weekly, now: '2026-10-14 09:00:00', build: () => weekLookahead(l, c.weekly, true) };
  CASES[`nextweek-${l}-reminders`] = { kind: 'nextweek', language: l, culture: c.weekly, now: '2026-10-14 09:00:00', build: () => nextWeekLookahead(l, c.weekly) };
}
const DAILY_NAMES = Object.keys(CASES).filter(n => isDaily(CASES[n]));
const WEEKLY_NAMES = Object.keys(CASES).filter(n => !isDaily(CASES[n]));

const FIXTURE = path.resolve(__dirname, 'fixtures/summary-prompts.json');

/** Where two prompts first differ, for a failure message. */
function firstDifference(got: string, want: string): string {
  const a = got.split('\n');
  const b = want.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}:\n     got  ${JSON.stringify(a[i])}\n     want ${JSON.stringify(b[i])}`;
  }
  return 'nowhere';
}

/**
 * The one line `got` adds to `base`, and where. Fails unless `got` is `base` with
 * exactly one line inserted and nothing else changed.
 */
function insertedLine(base: string, got: string): { line: string; index: number } {
  const a = base.split('\n');
  const b = got.split('\n');
  assert(b.length === a.length + 1, `${b.length - a.length} lines added, not 1${b.length === a.length ? ` (${got === base ? 'no change' : firstDifference(got, base)})` : ''}`);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  assert(b.slice(i + 1).join('\n') === a.slice(i).join('\n'), `more than one line changed, from line ${i + 1}`);
  return { line: b[i], index: i };
}

async function main() {
  const { generateSummary, generateWeekLookahead, generateNextWeekSummary } = await import('../src/services/claude');
  const { getBotMessages } = await import('../src/lib/bot-messages');

  /** The prompt the AI gets for one case. `flag` is SummaryUserContext.googleUnavailable; undefined leaves it out. */
  async function promptFor(name: string, flag?: boolean): Promise<string> {
    const c = CASES[name];
    const tz = TZ_OF[c.language];
    frozen = at(c.now, tz).getTime();
    prompts.length = 0;
    if (isDaily(c)) {
      holidays = c.holidays ?? [];
      const w = WORDS[c.language];
      const userContext: SummaryUserContext = {
        culture: c.culture,
        globalRules: [w.globalRule],
        calendarAssignments: c.calendars,
        openRemindersMore: c.openRemindersMore,
        ...(flag === undefined ? {} : { googleUnavailable: flag }),
      };
      await generateSummary(
        c.lists.user, c.lists.spouse, c.lists.other,
        w.me, w.meEn, 'male',
        c.spouse ? w.partner : undefined, c.spouse ? w.partnerEn : undefined, c.spouse ? 'female' : undefined,
        c.calendars[0].calendarId, at(`${c.day} 12:00:00`, tz), false, undefined, undefined, c.language,
        userContext, false, c.weekLookahead, tz
      );
    } else {
      const { lookahead, calendars } = c.build();
      const user = userRow(c.language, c.culture);
      if (c.kind === 'week') await generateWeekLookahead(lookahead, user, c.language, undefined, false, undefined, calendars);
      else await generateNextWeekSummary(lookahead, user, c.language, undefined, false, undefined, calendars);
    }
    assert(prompts.length === 1, `${name}: ${prompts.length} prompts`);
    return prompts[0];
  }

  if (process.argv.includes('--write-prompt-fixture')) {
    if (existsSync(FIXTURE)) {
      console.error(`${path.relative(process.cwd(), FIXTURE)} exists. Delete it first to take a new snapshot.`);
      process.exit(1);
    }
    const snapshot: Record<string, string> = {};
    for (const name of Object.keys(CASES)) snapshot[name] = await promptFor(name);
    mkdirSync(path.dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`Wrote ${Object.keys(snapshot).length} prompts to ${path.relative(process.cwd(), FIXTURE)}`);
    process.exit(0);
  }

  assert(existsSync(FIXTURE), `${FIXTURE} is missing: take the snapshot first (see the header)`);
  const snapshot: Record<string, string> = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  // ---- Without the flag: main@858886c's prompts, byte for byte ----

  await check('the snapshot holds every case and nothing else (8 per language)', () => {
    const want = Object.keys(CASES);
    assert(JSON.stringify(Object.keys(snapshot)) === JSON.stringify(want), `snapshot cases: ${Object.keys(snapshot).join(', ')}`);
  });

  await check('without googleUnavailable, the daily and tomorrow prompts are byte-identical to main@858886c (en/he/ru, with and without reminders)', async () => {
    for (const name of DAILY_NAMES) {
      const prompt = await promptFor(name);
      assert(prompt === snapshot[name], `${name} differs at ${firstDifference(prompt, snapshot[name])}`);
    }
  });

  await check('googleUnavailable: false is the same as leaving it out', async () => {
    for (const name of DAILY_NAMES) {
      const prompt = await promptFor(name, false);
      assert(prompt === snapshot[name], `${name} differs at ${firstDifference(prompt, snapshot[name])}`);
    }
  });

  await check('the /week and /nextweek prompts are byte-identical to main@858886c (en/he/ru, with and without reminders)', async () => {
    for (const name of WEEKLY_NAMES) {
      const prompt = await promptFor(name);
      assert(prompt === snapshot[name], `${name} differs at ${firstDifference(prompt, snapshot[name])}`);
    }
  });

  await check('the snapshot covers both cultures, reminders, the "N more" line, holidays, kids and the tomorrow week block', () => {
    const all = Object.values(snapshot).join('\n');
    const needles = [
      '## Hebrew Calendar', '- **Reminders**', 'and 2 more open reminders', 'and 1 more open reminder"', 'היום: ראש חודש חשון', 'СЕГОДНЯ: Рош Ходеш Хешван',
      'WEEK LOOKAHEAD (events after tomorrow)', 'Pickup Order', '[Calendar: Birthdays]', '## הנחיות', '## Рекомендации', 'Next Week', 'Child: Noa',
    ];
    for (const needle of needles) {
      assert(all.includes(needle), `no case has ${JSON.stringify(needle)}`);
    }
    assert(!snapshot['daily-en-empty'].includes('- **Reminders**'), 'the empty day has the reminders guideline');
  });

  // ---- With the flag: exactly one guideline line ----

  /** The outage guideline, word for word, per language. */
  const GUIDELINE: Record<Lang, string> = {
    en: "- **Google Calendar**: Google Calendar couldn't be reached for this summary, so the lists hold only what loaded. Don't invent events or guess what's missing, and don't say nothing is planned just because a list is empty. A note about this is added after your summary, so don't mention it yourself.",
    he: '- **יומן Google**: לא ניתן היה להתחבר ליומן Google בזמן הכנת הסיכום, ולכן ברשימות יש רק את מה שנטען. אל תמציא אירועים ואל תנחש מה חסר, ואל תכתוב שאין אירועים רק כי רשימה ריקה. הערה על כך תתווסף אחרי הסיכום, אז אל תזכיר את זה בעצמך.',
    ru: '- **Google Календарь**: К Google Календарю не удалось подключиться, поэтому в списках только то, что успело загрузиться. Не придумывайте события и не гадайте, чего не хватает, и не пишите, что ничего не запланировано, только потому, что список пуст. Заметка об этом будет добавлена после сводки, так что сами о сбое не пишите.',
  };
  const GUIDELINES_HEADER: Record<Lang, string> = { en: '## Guidelines', he: '## הנחיות', ru: '## Рекомендации' };

  await check('with googleUnavailable, every daily and tomorrow prompt gains exactly one line, the outage guideline in its language', async () => {
    for (const name of DAILY_NAMES) {
      const { line } = insertedLine(snapshot[name], await promptFor(name, true));
      const want = GUIDELINE[CASES[name].language];
      assert(line === want, `${name}: the added line is\n     ${JSON.stringify(line)}\n     want ${JSON.stringify(want)}`);
    }
  });

  await check('the line sits in the guidelines, right after the reminders guideline when there is one', async () => {
    for (const name of DAILY_NAMES) {
      const base = snapshot[name].split('\n');
      const { index } = insertedLine(snapshot[name], await promptFor(name, true));
      const header = base.indexOf(GUIDELINES_HEADER[CASES[name].language]);
      const rule = base.indexOf('---');
      assert(header >= 0 && header < index && index <= rule, `${name}: line ${index + 1}, guidelines from ${header + 1} to ${rule + 1}`);
      const remindersAt = base.findIndex(l => /^- \*\*(Reminders|תזכורות|Напоминания)\*\*/.test(l));
      if (remindersAt >= 0) assert(index === remindersAt + 1, `${name}: line ${index + 1}, the reminders guideline is line ${remindersAt + 1}`);
    }
  });

  // ---- This week's parasha (docs: parasha brief, 2026-10-26) ----

  const PARASHA_LINE: Record<Lang, { label: string; ask: string }> = {
    en: { label: "- This week's Torah portion: Parashat Vayera", ask: "- Mention this week's Torah portion briefly, once, in the header or the greeting" },
    he: { label: '- פרשת השבוע: פרשת וירא', ask: '- ציין בקצרה, פעם אחת, את פרשת השבוע בכותרת או בברכה' },
    ru: { label: '- Недельная глава Торы: Глава Ваера', ask: '- Коротко, один раз, упомяните недельную главу Торы в заголовке или в приветствии' },
  };
  const PARASHA_TEXT: Record<Lang, string> = { en: 'Parashat Vayera', he: 'פרשת וירא', ru: 'Глава Ваера' };
  /** The prompt of a case while the parasha lookup answers `value`. */
  async function withParasha(name: string, value: string | null): Promise<string> {
    parasha = value;
    try {
      return await promptFor(name);
    } finally {
      parasha = null;
    }
  }

  await check('a Jewish-culture daily summary of today with a parasha gains its own line and one instruction line, outside Holidays (en/he/ru); without one the prompt is the golden one', async () => {
    for (const l of LANGS) {
      const name = `daily-${l}-${l === 'en' ? 'reminders' : 'family'}`;
      assert(CASES[name].culture === 'jewish', `${name} is not Jewish culture`);
      const prompt = await withParasha(name, PARASHA_TEXT[l]);
      const lines = prompt.split('\n');
      assert(lines.includes(PARASHA_LINE[l].label), `${name}: no parasha line`);
      assert(lines.includes(PARASHA_LINE[l].ask), `${name}: no instruction line`);
      assert(lines.length === snapshot[name].split('\n').length + 2, `${name}: ${lines.length - snapshot[name].split('\n').length} lines added, not 2`);
      assert(lines.filter(x => x !== PARASHA_LINE[l].label && x !== PARASHA_LINE[l].ask).join('\n') === snapshot[name], `${name}: something else changed`);
      assert(!lines.some(x => /Holidays|חגים\/מועדים|Праздники/.test(x) && x.includes(PARASHA_TEXT[l])), `${name}: the parasha is inside the holidays line`);
      assert(await withParasha(name, null) === snapshot[name], `${name}: differs without a parasha`);
    }
  });

  await check('no parasha line for a user who is not Jewish-culture, nor in a tomorrow summary (the day is not the user\'s today)', async () => {
    for (const l of LANGS) {
      const nonJewish = Object.keys(CASES).find(n => isDaily(CASES[n]) && CASES[n].kind === 'daily' && CASES[n].language === l && CASES[n].culture !== 'jewish');
      if (nonJewish) assert(await withParasha(nonJewish, PARASHA_TEXT[l]) === snapshot[nonJewish], `${nonJewish}: a parasha for a non-Jewish culture`);
      const tomorrow = `tomorrow-${l}-family`;
      assert(CASES[tomorrow].kind === 'tomorrow', `${tomorrow} is not a tomorrow case`);
      assert(await withParasha(tomorrow, PARASHA_TEXT[l]) === snapshot[tomorrow], `${tomorrow}: a parasha in the tomorrow summary`);
    }
  });

  // ---- The Hebrew anniversary count (docs/superpowers/specs/2026-10-25-hebrew-anniversary-count-design.md) ----

  const MARKER = ' [Year 7 since the original date]';
  const COUNT_GUIDELINE: Record<Lang, RegExp> = { en: /^- \*\*Year counts\*\*: /, he: /^- \*\*ספירת שנים\*\*: /, ru: /^- \*\*Счёт лет\*\*: / };
  /** `prompt` with the count's marker and guideline taken out: what the same prompt reads without a count. */
  const withoutCount = (prompt: string, l: Lang) => {
    const lines = prompt.split('\n').filter(line => !COUNT_GUIDELINE[l].test(line));
    assert(lines.length === prompt.split('\n').length - 1, `${l}: ${prompt.split('\n').length - lines.length} guideline lines, not 1`);
    return lines.join('\n').replace(MARKER, '');
  };

  await check('a count on a daily or tomorrow event adds its marker to the event line and one guideline line; take both out and the prompt is the golden one (en/he/ru)', async () => {
    for (const l of LANGS) {
      for (const name of [`daily-${l}-reminders`, `tomorrow-${l}-family`]) {
        const c = CASES[name] as DailyCase;
        const original = c.lists;
        c.lists = { ...original, user: original.user.map((e, i) => (i === 0 ? { ...e, anniversary: 7 } : e)) };
        let prompt: string;
        try {
          prompt = await promptFor(name);
        } finally {
          c.lists = original;
        }
        assert(prompt.split(MARKER).length === 2, `${name}: the marker appears ${prompt.split(MARKER).length - 1} times`);
        assert(withoutCount(prompt, l) === snapshot[name], `${name}: ${firstDifference(withoutCount(prompt, l), snapshot[name])}`);
      }
    }
  });

  await check('a count only on a day in the tomorrow summary\'s lookahead still adds the guideline (the lookahead lines end in the marker); take both out and the prompt is the golden one (en/he/ru)', async () => {
    for (const l of LANGS) {
      const name = `tomorrow-${l}-family`;
      const c = CASES[name] as DailyCase;
      const original = c.weekLookahead;
      c.weekLookahead = String(original).replace('(Birthday)', `(Birthday)${MARKER}`);
      let prompt: string;
      try {
        prompt = await promptFor(name);
      } finally {
        c.weekLookahead = original;
      }
      assert(prompt.split(MARKER).length === 2, `${name}: the marker appears ${prompt.split(MARKER).length - 1} times`);
      assert(withoutCount(prompt, l) === snapshot[name], `${name}: ${firstDifference(withoutCount(prompt, l), snapshot[name])}`);
    }
  });

  await check('a count on a /week or /nextweek event does the same in the week prompts (en/he/ru)', async () => {
    for (const l of LANGS) {
      for (const name of [`week-${l}-reminders`, `nextweek-${l}-reminders`]) {
        const c = CASES[name] as WeeklyCase;
        const build = c.build;
        c.build = () => {
          const made = build();
          made.lookahead.events[0] = { ...made.lookahead.events[0], anniversary: 7 };
          return made;
        };
        let prompt: string;
        try {
          prompt = await promptFor(name);
        } finally {
          c.build = build;
        }
        assert(prompt.split(MARKER).length === 2, `${name}: the marker appears ${prompt.split(MARKER).length - 1} times`);
        assert(withoutCount(prompt, l) === snapshot[name], `${name}: ${firstDifference(withoutCount(prompt, l), snapshot[name])}`);
      }
    }
  });

  await check('the count guideline is generic: it names nobody from the fixtures', async () => {
    for (const l of LANGS) {
      const c = CASES[`daily-${l}-reminders`] as DailyCase;
      const original = c.lists;
      c.lists = { ...original, user: original.user.map((e, i) => (i === 0 ? { ...e, anniversary: 7 } : e)) };
      let prompt: string;
      try {
        prompt = await promptFor(`daily-${l}-reminders`);
      } finally {
        c.lists = original;
      }
      const line = prompt.split('\n').find(x => COUNT_GUIDELINE[l].test(x)) ?? '';
      const w = WORDS[l];
      assert(line.length > 80 && ![w.me, w.partner, w.kid1, w.kid2].some(n => line.includes(n)), `${l}: ${line}`);
    }
  });

  // ---- The bot texts ----

  const SCRIPT: Record<Lang, RegExp> = { en: /^[\x20-\x7E\u2019\u26A0\uFE0F]+$/, he: /[\u05D0-\u05EA]/, ru: /[\u0400-\u04FF]/ };

  await check('bot.errors.googleUnreachable and googleOutageNote exist in en/he/ru, each in its own language', async () => {
    const seen = new Map<string, string>();
    for (const l of LANGS) {
      const t = await getBotMessages(l);
      for (const key of ['googleUnreachable', 'googleOutageNote']) {
        const text: unknown = t.errors?.[key];
        assert(typeof text === 'string' && text.trim().length > 0, `${l}: bot.errors.${key} is missing`);
        assert(SCRIPT[l].test(text), `${l}: bot.errors.${key} is not in ${l}: ${text}`);
        assert(text.includes('Google'), `${l}: bot.errors.${key} doesn't name Google: ${text}`);
        // One plain line: it is appended to an HTML summary and needs nothing filled in.
        assert(!/[\n<>&{}]/.test(text), `${l}: bot.errors.${key} is not one plain line: ${JSON.stringify(text)}`);
        assert(!seen.has(text), `${l}: bot.errors.${key} repeats ${seen.get(text)}`);
        seen.set(text, `${l}.${key}`);
      }
    }
  });

  await check('nothing above reported an error', () => {
    assert(captured.length === 0, `captureError: ${captured.join(', ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
