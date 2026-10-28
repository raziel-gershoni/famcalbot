// Live evaluation: does extraction recognise reminders in Hebrew, English and Russian, and
// leave everything else as it was?
//
// Runs a phrase table through processTextWithGemini() with the reminder rules on - the path
// forwarded and typed text take - on the production model and thinking level (MEDIUM).
// Voice notes get the same rules from the same prompt builder. Each case checks the parsed
// result: a reminder's kind, who it is for, its single time, recurrence and anchor; that
// near-misses stay events; that "I did it" creates nothing; that "stop reminding me"
// deletes the whole series; and that moving a reminder sets one time and no end.
//
// Expected: every case passes. Re-run after any change to the extraction prompt, the
// reminder rules, the parser or the model.
//
// COSTS MONEY: one Gemini call per case per run. It calls the model whenever the repo's
// .env holds a key, with or without -r dotenv/config: loading the app loads @prisma/client,
// which reads .env itself.
//
// Run:
//   NODE_OPTIONS='--conditions=import' npx tsx -r dotenv/config scripts/eval-native-reminders.ts
// Lists the cases and prompt sizes without calling the model:
//   NODE_OPTIONS='--conditions=import' npx tsx scripts/eval-native-reminders.ts --dry-run
// Options (env): EVAL_RUNS=1
//   EVAL_ONLY=both     only the cases whose label starts with that word (the "remind us" ones: 9 calls)
//   EVAL_ONLY=zman     only the reminders by a halachic time (zman) and their controls: 20 calls. A zman is the reminder's
//                      time: allDay, no clock time, a name (or halachic hours) and an offset; the opinion is null unless
//                      it was said (FamCal asks the person which one; the model must never pick), no day unless one was said.
//   EVAL_FAIL_FAST=1   stop at the first failing case

import { formatInTimeZone } from 'date-fns-tz';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { ReminderPromptContext } from '../src/services/voice/gemini-voice';
import type { CalendarAssignment } from '../src/types';

const RUNS = Number(process.env.EVAL_RUNS || 1);
const ONLY = process.env.EVAL_ONLY || '';
const FAIL_FAST = process.env.EVAL_FAIL_FAST === '1';
const TZ = 'Asia/Jerusalem';

type Language = 'en' | 'he' | 'ru';

/** The user and the partner, named as each user's own language would store them. */
const PEOPLE: Record<Language, ReminderPromptContext> = {
  en: { userName: 'Raziel', partnerName: 'Dana' },
  he: { userName: 'רזיאל', userEnglishName: 'Raziel', partnerName: 'דנה', partnerEnglishName: 'Dana' },
  ru: { userName: 'Разиэль', userEnglishName: 'Raziel', partnerName: 'Дана', partnerEnglishName: 'Dana' },
};

/** A built-in calendar pair, seen from the user's side. */
const CALENDARS: CalendarAssignment[] = [
  { calendarId: 'native:cmain00000000000000000001', name: 'Raziel', labels: ['primary', 'yours'], color: '#4285f4' },
  { calendarId: 'native:cdana00000000000000000002', name: 'Dana', labels: ['spouse'], color: '#e67c73', personName: 'Dana', personGender: 'female' },
];

const day = (d: Date) => formatInTimeZone(d, TZ, 'yyyy-MM-dd');
const clock = (d: Date) => formatInTimeZone(d, TZ, 'HH:mm');
const weekdayOf = (d: Date) => formatInTimeZone(d, TZ, 'EEE');
/** The local date `n` days after `now`'s, by the calendar, not by 24-hour steps. */
function dayFrom(now: Date, n: number): string {
  const [y, m, d] = day(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A failure reason, or null when the result is right. */
export type Expect = (results: VoiceIntentResult[], now: Date) => string | null;
export type Case = { language: Language; label: string; text: string; expect: Expect };

const describeAll = (results: VoiceIntentResult[]) =>
  results.map(r => (r.event ? `${r.intent}:${r.event.kind ?? 'event'}` : `${r.intent}${r.error ? ` (${r.error})` : ''}`)).join(', ');

interface ReminderWant {
  forPerson?: 'self' | 'partner' | 'both';
  /** Days after today, on the user's clock (0 = today). */
  inDays?: number;
  /** The weekday it falls on, within the coming week ('Thu'). */
  weekday?: string;
  /** A timed reminder at this local time. */
  time?: string;
  allDay?: boolean;
  /** Starts this many minutes from now, inclusive. */
  minutesFromNow?: [number, number];
  /** Repeats weekly on this day code. */
  weekly?: string;
  anchor?: { description: RegExp; offsetMinutes: number };
  /** Repeats every day. */
  daily?: boolean;
  /**
   * Timed by a halachic time: a name with the opinion the person said (null when none was) and an offset, or halachic hours
   * and an offset. The reminder is then date-only with no clock time. No day is read unless `inDays` or `weekday` says one was.
   */
  zman?: { name: string; opinion: string | null; offsetMinutes: number } | { halachicHours: number; offsetMinutes: number };
}

/** An object's fields in key order, so two zmans compare by what they say. */
const sortedKeys = (o: object) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1));

function checkReminder(ev: ParsedEvent, want: ReminderWant, now: Date): string | null {
  if (ev.kind !== 'reminder') return `kind ${ev.kind ?? 'event'}`;
  const problems: string[] = [];
  if (want.forPerson && ev.forPerson !== want.forPerson) problems.push(`forPerson ${ev.forPerson}`);
  if (want.anchor) {
    if (!ev.anchor) problems.push(`no anchor (starts ${isNaN(ev.startTime.getTime()) ? 'never' : `${day(ev.startTime)} ${clock(ev.startTime)}`})`);
    else {
      if (!want.anchor.description.test(ev.anchor.description)) problems.push(`anchor "${ev.anchor.description}"`);
      if (ev.anchor.offsetMinutes !== want.anchor.offsetMinutes) problems.push(`offset ${ev.anchor.offsetMinutes}`);
    }
    return problems.join('; ') || null;
  }
  if (ev.anchor) problems.push(`unexpected anchor ${JSON.stringify(ev.anchor)}`);
  if (want.zman) {
    if (!ev.zman) problems.push(`no zman (starts ${isNaN(ev.startTime.getTime()) ? 'never' : `${day(ev.startTime)} ${ev.allDay ? 'all day' : clock(ev.startTime)}`})`);
    else {
      if (JSON.stringify(sortedKeys(ev.zman)) !== JSON.stringify(sortedKeys(want.zman))) problems.push(`zman ${JSON.stringify(ev.zman)}`);
      if (!ev.allDay) problems.push(`timed ${clock(ev.startTime)}`);
      // The day is the person's to say; with none said the model leaves it null and FamCal picks the next time that has not passed
      if (want.inDays === undefined && want.weekday === undefined && ev.zmanDaySaid) problems.push(`day ${day(ev.startTime)} read from nothing`);
    }
  } else if (ev.zman) {
    problems.push(`unexpected zman ${JSON.stringify(ev.zman)}`);
  }
  if (isNaN(ev.startTime.getTime())) return [...problems, 'no time'].join('; ');
  if (ev.endTime.getTime() !== ev.startTime.getTime()) problems.push('has a duration');
  if (want.allDay !== undefined && ev.allDay !== want.allDay) problems.push(ev.allDay ? 'all day' : `timed ${clock(ev.startTime)}`);
  if (want.time && (ev.allDay || clock(ev.startTime) !== want.time)) problems.push(`time ${ev.allDay ? 'none' : clock(ev.startTime)}`);
  if (want.inDays !== undefined && day(ev.startTime) !== dayFrom(now, want.inDays)) problems.push(`date ${day(ev.startTime)}`);
  if (want.weekday) {
    const daysAhead = (ev.startTime.getTime() - now.getTime()) / 864e5;
    if (weekdayOf(ev.startTime) !== want.weekday || daysAhead < -1 || daysAhead > 8) problems.push(`date ${day(ev.startTime)} (${weekdayOf(ev.startTime)})`);
  }
  if (want.minutesFromNow) {
    const minutes = (ev.startTime.getTime() - now.getTime()) / 6e4;
    if (minutes < want.minutesFromNow[0] || minutes > want.minutesFromNow[1]) problems.push(`starts in ${Math.round(minutes)} min`);
  }
  if (want.daily) {
    if (ev.recurrence?.frequency !== 'daily') problems.push(`recurrence ${JSON.stringify(ev.recurrence ?? null)}`);
  } else if (want.weekly) {
    const r = ev.recurrence;
    if (r?.frequency !== 'weekly' || !r.daysOfWeek?.includes(want.weekly)) problems.push(`recurrence ${JSON.stringify(r ?? null)}`);
  } else if (ev.recurrence) {
    problems.push(`unexpected recurrence ${JSON.stringify(ev.recurrence)}`);
  }
  return problems.join('; ') || null;
}

/** One reminder is created, as wanted. */
const reminder = (want: ReminderWant): Expect => (results, now) => {
  const creates = results.filter(r => r.intent === 'create' && r.event);
  if (creates.length !== 1) return `${creates.length} creates: ${describeAll(results)}`;
  return checkReminder(creates[0].event!, want, now);
};

/** One ordinary event is created: not a reminder, and timed ones keep a duration. */
const staysEvent: Expect = results => {
  const creates = results.filter(r => r.intent === 'create' && r.event);
  if (creates.length !== 1) return `${creates.length} creates: ${describeAll(results)}`;
  const ev = creates[0].event!;
  if (ev.kind === 'reminder') return 'became a reminder';
  return !ev.allDay && ev.endTime <= ev.startTime ? 'no duration' : null;
};

/** Nothing is created, edited or deleted. */
const nothing: Expect = results =>
  (results.some(r => r.event || r.eventReference || r.editRequest) ? `acted: ${describeAll(results)}` : null);

/** The whole series is deleted. */
const deletesSeries = (description: RegExp): Expect => results => {
  const r = results[0];
  if (results.length !== 1 || r.intent !== 'delete') return describeAll(results);
  if (r.scope !== 'all') return `scope ${r.scope}`;
  return description.test(r.eventReference?.description ?? '') ? null : `description "${r.eventReference?.description}"`;
};

/** Only today's occurrence is skipped: a single-scope delete whose reference says "today". */
const skipsToday = (description: RegExp): Expect => results => {
  const r = results[0];
  if (results.length !== 1 || r.intent !== 'delete') return describeAll(results);
  if (r.scope !== 'single') return `scope ${r.scope}`;
  if (r.eventReference?.timeHint !== 'today') return `timeHint ${r.eventReference?.timeHint}`;
  return description.test(r.eventReference?.description ?? '') ? null : `description "${r.eventReference?.description}"`;
};

/** An edit that moves the start to `time` and leaves the end alone. */
const movesTo = (time: string): Expect => results => {
  const r = results[0];
  if (results.length !== 1 || r.intent !== 'edit') return describeAll(results);
  if (r.editRequest?.newStartTime !== time) return `newStartTime ${r.editRequest?.newStartTime}`;
  return r.editRequest.newEndTime || r.editRequest.newEndDate ? `end ${r.editRequest.newEndDate ?? ''} ${r.editRequest.newEndTime ?? ''}` : null;
};

/** Two reminders in one message, one for the user and one for the partner. */
const twoReminders: Expect = results => {
  const creates = results.filter(r => r.intent === 'create' && r.event);
  const got = creates.map(r => (r.event!.kind === 'reminder' ? r.event!.forPerson : 'event')).sort().join(',');
  return got === 'partner,self' ? null : `got [${got}]: ${describeAll(results)}`;
};

/** Exported for scripts/smoke-zman-model.ts, which checks the zman cases' expectations offline (no model call). */
export const ALL_CASES: Case[] = [
  // Timed, for the user.
  { language: 'en', label: 'timed', text: 'Remind me to call the plumber on Thursday at 10', expect: reminder({ forPerson: 'self', weekday: 'Thu', time: '10:00' }) },
  { language: 'he', label: 'timed', text: 'תזכיר לי להתקשר לאינסטלטור ביום חמישי בעשר', expect: reminder({ forPerson: 'self', weekday: 'Thu', time: '10:00' }) },
  { language: 'ru', label: 'timed', text: 'Напомни мне позвонить сантехнику в четверг в 10', expect: reminder({ forPerson: 'self', weekday: 'Thu', time: '10:00' }) },
  // For the partner, by name.
  { language: 'en', label: 'partner by name', text: 'Remind Dana to buy milk tomorrow', expect: reminder({ forPerson: 'partner', inDays: 1, allDay: true }) },
  { language: 'he', label: 'partner by name', text: 'תזכיר לדנה לקנות חלב מחר', expect: reminder({ forPerson: 'partner', inDays: 1, allDay: true }) },
  { language: 'ru', label: 'partner by name', text: 'Напомни Дане купить молоко завтра', expect: reminder({ forPerson: 'partner', inDays: 1, allDay: true }) },
  // For the partner, by role.
  { language: 'en', label: 'partner by role', text: 'Remind my wife to call the bank tomorrow at 9', expect: reminder({ forPerson: 'partner', inDays: 1, time: '09:00' }) },
  { language: 'he', label: 'partner by role', text: 'תזכיר לאשתי להתקשר לבנק מחר בתשע', expect: reminder({ forPerson: 'partner', inDays: 1, time: '09:00' }) },
  { language: 'ru', label: 'partner by role', text: 'Напомни жене позвонить в банк завтра в 9', expect: reminder({ forPerson: 'partner', inDays: 1, time: '09:00' }) },
  // A date with no time.
  { language: 'en', label: 'date only', text: 'Remind me on Friday to pay the electricity bill', expect: reminder({ forPerson: 'self', weekday: 'Fri', allDay: true }) },
  { language: 'he', label: 'date only', text: 'תזכיר לי ביום שישי לשלם את החשמל', expect: reminder({ forPerson: 'self', weekday: 'Fri', allDay: true }) },
  { language: 'ru', label: 'date only', text: 'Напомни в пятницу оплатить электричество', expect: reminder({ forPerson: 'self', weekday: 'Fri', allDay: true }) },
  // No date and no time: today.
  { language: 'en', label: 'no date', text: 'Remind me to buy batteries', expect: reminder({ forPerson: 'self', inDays: 0, allDay: true }) },
  { language: 'he', label: 'no date', text: 'תזכיר לי לקנות סוללות', expect: reminder({ forPerson: 'self', inDays: 0, allDay: true }) },
  { language: 'ru', label: 'no date', text: 'Напомни купить батарейки', expect: reminder({ forPerson: 'self', inDays: 0, allDay: true }) },
  // Part of the day.
  { language: 'en', label: 'part of day', text: 'Remind me tomorrow evening to pack the bags', expect: reminder({ inDays: 1, time: '20:00' }) },
  { language: 'he', label: 'part of day', text: 'תזכיר לי מחר בבוקר לקחת את התרופה', expect: reminder({ inDays: 1, time: '09:00' }) },
  { language: 'ru', label: 'part of day', text: 'Напомни завтра после обеда забрать посылку', expect: reminder({ inDays: 1, time: '16:00' }) },
  // Relative.
  { language: 'en', label: 'relative', text: 'Remind me in 20 minutes to take the laundry out', expect: reminder({ minutesFromNow: [15, 25] }) },
  { language: 'he', label: 'relative', text: 'תזכיר לי בעוד חצי שעה לכבות את התנור', expect: reminder({ minutesFromNow: [25, 35] }) },
  { language: 'ru', label: 'relative', text: 'Напомни через 20 минут выключить духовку', expect: reminder({ minutesFromNow: [15, 25] }) },
  // Repeating.
  { language: 'en', label: 'repeating', text: 'Remind me every Sunday at 8 to take out the trash', expect: reminder({ weekly: 'SU', time: '08:00' }) },
  { language: 'he', label: 'repeating', text: 'תזכיר לי כל יום ראשון בשמונה להוציא את הזבל', expect: reminder({ weekly: 'SU', time: '08:00' }) },
  { language: 'ru', label: 'repeating', text: 'Напоминай каждое воскресенье в 8 выносить мусор', expect: reminder({ weekly: 'SU', time: '08:00' }) },
  // Relative to another event.
  { language: 'en', label: 'anchor', text: 'Remind me an hour before the dentist to bring the forms', expect: reminder({ anchor: { description: /dentist/i, offsetMinutes: -60 } }) },
  { language: 'he', label: 'anchor', text: 'תזכיר לי שעה לפני רופא השיניים להביא את הטפסים', expect: reminder({ anchor: { description: /שיניים/, offsetMinutes: -60 } }) },
  { language: 'ru', label: 'anchor', text: 'Напомни за час до стоматолога взять документы', expect: reminder({ anchor: { description: /стоматолог/i, offsetMinutes: -60 } }) },
  // "Don't forget to..." is a reminder, not a delete.
  { language: 'en', label: "don't forget", text: "Don't forget to water the plants tomorrow", expect: reminder({ forPerson: 'self', inDays: 1, allDay: true }) },
  { language: 'he', label: "don't forget", text: 'אל תשכח להשקות את העציצים מחר', expect: reminder({ forPerson: 'self', inDays: 1, allDay: true }) },
  { language: 'ru', label: "don't forget", text: 'Не забудь полить цветы завтра', expect: reminder({ forPerson: 'self', inDays: 1, allDay: true }) },
  // Near-misses that must stay events.
  { language: 'en', label: 'stays an event', text: 'Dentist Thursday at 10', expect: staysEvent },
  { language: 'he', label: 'stays an event', text: 'רופא שיניים ביום חמישי בעשר', expect: staysEvent },
  { language: 'ru', label: 'stays an event', text: 'Стоматолог в четверг в 10', expect: staysEvent },
  { language: 'en', label: 'stays an event', text: "Don't forget - parent-teacher meeting next Tuesday at 16:30 in room 204", expect: staysEvent },
  // A finished task creates nothing.
  { language: 'en', label: 'done', text: 'I did it', expect: nothing },
  { language: 'he', label: 'done', text: 'סיימתי', expect: nothing },
  { language: 'ru', label: 'done', text: 'Сделал', expect: nothing },
  // "Stop reminding me" deletes the series.
  { language: 'en', label: 'stop reminding', text: 'Stop reminding me about the vitamins', expect: deletesSeries(/vitamin/i) },
  { language: 'he', label: 'stop reminding', text: 'תפסיק להזכיר לי על הוויטמינים', expect: deletesSeries(/ויטמינ/) },
  { language: 'ru', label: 'stop reminding', text: 'Хватит напоминать про витамины', expect: deletesSeries(/витамин/i) },
  // "Skip today's reminder" skips one occurrence.
  { language: 'en', label: 'skip today', text: "Skip today's vitamins reminder", expect: skipsToday(/vitamin/i) },
  { language: 'he', label: 'skip today', text: 'תדלג על התזכורת של הוויטמינים היום', expect: skipsToday(/ויטמינ/) },
  { language: 'ru', label: 'skip today', text: 'Пропусти сегодняшнее напоминание про витамины', expect: skipsToday(/витамин/i) },
  // Moving a reminder sets one time.
  { language: 'en', label: 'move', text: 'Move the plumber reminder to 5pm', expect: movesTo('17:00') },
  { language: 'he', label: 'move', text: 'תזיז את התזכורת של האינסטלטור לחמש בערב', expect: movesTo('17:00') },
  { language: 'ru', label: 'move', text: 'Перенеси напоминание про сантехника на пять вечера', expect: movesTo('17:00') },
  // Two reminders in one message.
  { language: 'en', label: 'two reminders', text: 'Remind me to call mom at 5, and remind Dana to buy bread tomorrow', expect: twoReminders },
  // "Remind us" is for the user and the partner together ("remind me" and "remind Dana" above stay self and partner).
  { language: 'en', label: 'both: us', text: 'Remind us to renew the car insurance on Sunday', expect: reminder({ forPerson: 'both', weekday: 'Sun', allDay: true }) },
  { language: 'he', label: 'both: us', text: 'תזכיר לנו לחדש את ביטוח הרכב ביום ראשון', expect: reminder({ forPerson: 'both', weekday: 'Sun', allDay: true }) },
  { language: 'ru', label: 'both: us', text: 'Напомни нам продлить страховку на машину в воскресенье', expect: reminder({ forPerson: 'both', weekday: 'Sun', allDay: true }) },
  { language: 'en', label: 'both: both of us', text: 'Remind both of us to sign the kindergarten form tomorrow morning', expect: reminder({ forPerson: 'both', inDays: 1, time: '09:00' }) },
  { language: 'he', label: 'both: both of us', text: 'תזכיר לשנינו לחתום על טופס הגן מחר בבוקר', expect: reminder({ forPerson: 'both', inDays: 1, time: '09:00' }) },
  { language: 'ru', label: 'both: both of us', text: 'Напомни нам обоим подписать анкету для сада завтра утром', expect: reminder({ forPerson: 'both', inDays: 1, time: '09:00' }) },
  { language: 'en', label: 'both: me and Dana', text: 'Remind me and Dana to call the landlord on Wednesday at 6pm', expect: reminder({ forPerson: 'both', weekday: 'Wed', time: '18:00' }) },
  { language: 'he', label: 'both: me and Dana', text: 'תזכיר לי ולדנה להתקשר לבעל הדירה ביום רביעי בשש בערב', expect: reminder({ forPerson: 'both', weekday: 'Wed', time: '18:00' }) },
  { language: 'ru', label: 'both: me and Dana', text: 'Напомни мне и Дане позвонить хозяину квартиры в среду в шесть вечера', expect: reminder({ forPerson: 'both', weekday: 'Wed', time: '18:00' }) },

  // A reminder by a halachic time (zman). Phrased differently from the prompt's own examples (smoke-native-reminder-creation.ts
  // checks that). The opinion is null unless said: with none said FamCal asks, the model never picks.
  { language: 'en', label: 'zman: shema', text: 'Please remind me twelve minutes before sof zman kriat Shema to call my father', expect: reminder({ forPerson: 'self', zman: { name: 'SOF_SHMA', opinion: null, offsetMinutes: -12 } }) },
  { language: 'he', label: 'zman: shema', text: 'תזכיר לי 12 דקות לפני סוף זמן קריאת שמע להתקשר לאבא', expect: reminder({ forPerson: 'self', zman: { name: 'SOF_SHMA', opinion: null, offsetMinutes: -12 } }) },
  { language: 'ru', label: 'zman: shema', text: 'Напомни мне за 12 минут до конца времени Шма позвонить отцу', expect: reminder({ forPerson: 'self', zman: { name: 'SOF_SHMA', opinion: null, offsetMinutes: -12 } }) },
  { language: 'en', label: 'zman: sunset daily', text: 'Remind me every day half an hour before sunset to bring in the laundry', expect: reminder({ forPerson: 'self', daily: true, zman: { name: 'SHKIA', opinion: null, offsetMinutes: -30 } }) },
  { language: 'he', label: 'zman: sunset daily', text: 'תזכיר לי כל יום 20 דקות לפני השקיעה להכניס את הכביסה', expect: reminder({ forPerson: 'self', daily: true, zman: { name: 'SHKIA', opinion: null, offsetMinutes: -20 } }) },
  { language: 'ru', label: 'zman: sunset daily', text: 'Напоминай мне каждый день за полчаса до заката убирать бельё', expect: reminder({ forPerson: 'self', daily: true, zman: { name: 'SHKIA', opinion: null, offsetMinutes: -30 } }) },
  { language: 'en', label: 'zman: opinion said', text: 'Tomorrow remind me at plag according to Yalkut Yosef to check the oven', expect: reminder({ forPerson: 'self', inDays: 1, zman: { name: 'PLAG', opinion: 'yalkutYosef', offsetMinutes: 0 } }) },
  { language: 'he', label: 'zman: opinion said', text: 'תזכיר לי מחר 40 דקות לפני סוף זמן קריאת שמע לפי המג״א לקום', expect: reminder({ forPerson: 'self', inDays: 1, zman: { name: 'SOF_SHMA', opinion: 'mga', offsetMinutes: -40 } }) },
  { language: 'ru', label: 'zman: opinion said', text: 'Напомни завтра за 20 минут до плага по Алаха Бруря проверить духовку', expect: reminder({ forPerson: 'self', inDays: 1, zman: { name: 'PLAG', opinion: 'halachaBerura', offsetMinutes: -20 } }) },
  { language: 'en', label: 'zman: nightfall', text: 'Remind me fifteen minutes after tzeit hakochavim to start the dishwasher', expect: reminder({ forPerson: 'self', zman: { name: 'TZEIT', opinion: null, offsetMinutes: 15 } }) },
  { language: 'ru', label: 'zman: nightfall', text: 'Напомни в пятницу спустя 15 минут после выхода звёзд позвонить маме', expect: reminder({ forPerson: 'self', weekday: 'Fri', zman: { name: 'TZEIT', opinion: null, offsetMinutes: 15 } }) },
  { language: 'en', label: 'zman: friday candles', text: 'Every Friday remind me an hour and a half before candle lighting to start cooking', expect: reminder({ forPerson: 'self', weekly: 'FR', zman: { name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes: -90 } }) },
  { language: 'he', label: 'zman: friday candles for both', text: 'תזכיר לנו בכל יום שישי שעה לפני הדלקת נרות להכין את השולחן', expect: reminder({ forPerson: 'both', weekly: 'FR', zman: { name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes: -60 } }) },
  { language: 'ru', label: 'zman: friday candles', text: 'Напоминай каждую пятницу за полтора часа до зажигания свечей ставить еду', expect: reminder({ forPerson: 'self', weekly: 'FR', zman: { name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes: -90 } }) },
  { language: 'he', label: 'zman: halachic hours', text: 'תזכיר לי כל יום ארבע שעות זמניות אחרי הנץ החמה לקחת ויטמין', expect: reminder({ forPerson: 'self', daily: true, zman: { halachicHours: 4, offsetMinutes: 0 } }) },
  // A bare "chatzot" is halachic noon; only the midnight words are CHATZOT_HALAYLA (twelve hours apart, with no button to catch a slip)
  { language: 'en', label: 'zman: chatzot', text: 'Remind me ten minutes before chatzot to put the pot on', expect: reminder({ forPerson: 'self', zman: { name: 'CHATZOT', opinion: null, offsetMinutes: -10 } }) },
  { language: 'ru', label: 'zman: halachic midnight', text: 'Напомни через полчаса после халахической полуночи лечь спать', expect: reminder({ forPerson: 'self', zman: { name: 'CHATZOT_HALAYLA', opinion: null, offsetMinutes: 30 } }) },
  // Controls: a clock time, a bare midnight and an event at sunset stay what they were
  { language: 'ru', label: 'zman control: clock time', text: 'Напомни завтра в 17:30 забрать халы', expect: reminder({ forPerson: 'self', inDays: 1, time: '17:30' }) },
  { language: 'he', label: 'zman control: midnight', text: 'תזכיר לי בחצות לכבות את המחשב', expect: reminder({ forPerson: 'self', time: '00:00' }) },
  { language: 'en', label: 'zman control: event', text: 'Dinner at sunset on Friday at my parents house', expect: staysEvent },
];

const CASES = ALL_CASES.filter(c => c.label.startsWith(ONLY));

async function main() {
  const { AI_MODEL, AI_MODEL_ID, getExtractionThinkingLevel } = await import('../src/config/ai-models');
  const { buildEventExtractionPrompt } = await import('../src/services/voice/gemini-voice');
  const { processTextWithGemini } = await import('../src/services/forward-event/gemini-text');

  console.log(`\n=== ${AI_MODEL}, thinking ${getExtractionThinkingLevel(AI_MODEL_ID) ?? 'API default'}, ${CASES.length} cases${ONLY ? ` (only "${ONLY}")` : ''}, ${RUNS} run(s) each`);

  if (process.argv.includes('--dry-run')) {
    for (const language of ['en', 'he', 'ru'] as const) {
      const prompt = buildEventExtractionPrompt(language, CALENDARS, TZ, 'text', undefined, PEOPLE[language]);
      console.log(`  ${language} prompt: ${prompt.length} characters`);
    }
    for (const c of CASES) console.log(`  ${c.language}  ${c.label.padEnd(16)} ${c.text}`);
    // The app modules leave handles open (Redis, Sentry); nothing is pending.
    process.exit(0);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. Run with -r dotenv/config.');
    process.exit(2);
  }

  let failures = 0;
  const passedBy: Record<Language, [number, number]> = { en: [0, 0], he: [0, 0], ru: [0, 0] };
  for (const c of CASES) {
    const problems: string[] = [];
    for (let run = 0; run < RUNS; run++) {
      const now = new Date();
      try {
        const { intentResults } = await processTextWithGemini(c.text, c.language, CALENDARS, TZ, PEOPLE[c.language]);
        const problem = c.expect(intentResults, now);
        if (problem) problems.push(problem);
      } catch (err) {
        problems.push(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const ok = problems.length === 0;
    if (!ok) failures++;
    passedBy[c.language][0] += ok ? 1 : 0;
    passedBy[c.language][1] += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.language}  ${c.label.padEnd(16)} ${c.text}${ok ? '' : `\n          ${problems.join(' | ')}`}`);
    if (!ok && FAIL_FAST) break;
  }

  console.log(`\n  by language: ${(['en', 'he', 'ru'] as const).map(l => `${l} ${passedBy[l][0]}/${passedBy[l][1]}`).join(', ')}`);
  console.log(failures === 0 ? '\nALL CASES PASSED' : `\n${failures} case(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// Run directly it evaluates; imported by a smoke it only offers the cases.
if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
