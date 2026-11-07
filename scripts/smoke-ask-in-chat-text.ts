// Smoke test for the words of a guest answer (src/services/ask-in-chat/text.ts with bot.askInChat in
// messages/{en,he,ru}.json; spec docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §6, rulings 2, 11 and 14):
//   - every line of §6's table in en, he and ru, exactly: a day, a part of the day, a range and a time, each free,
//     busy throughout or busy in part; an event crossing midnight ("until 02:00", "from 22:00"); an instant;
//   - in Hebrew every time, range and dd.MM is a left-to-right isolate; Russian capitalises the weekday;
//   - the weekday is the day the key names, whatever the zone; a Hebrew date asked is echoed;
//   - two ranges are joined as a list; 3 days give 3 lines;
//   - with Google unread no line claims free time, a free day has no line, and with nothing busy at all the answer is
//     "couldn't check";
//   - the "which day?" and "up to 3 days" lines name the bot; no line holds an event's title.
// Re-runs itself under UTC, Asia/Jerusalem and America/New_York. Pure: no network, no database.
//
//   npx tsx scripts/smoke-ask-in-chat-text.ts

import { spawn } from 'node:child_process';
import en from '../messages/en.json';
import he from '../messages/he.json';
import ru from '../messages/ru.json';
import { busyIntervals, judgeWindow } from '../src/services/ask-in-chat/busy';
import { askAnswerText, leadRtl, noDateText, tooManyDaysText, type AskAnswer, type AskTexts, type AskWords } from '../src/services/ask-in-chat/text';
import type { AskRange } from '../src/services/ask-in-chat/window';
import type { CalendarEvent } from '../src/types';
import type { Locale } from '../src/utils/locale';

const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ASK_TEXT_SMOKE_CHILD';

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      zone =>
        new Promise<{ zone: string; code: number; text: string }>(resolve => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', chunk => (text += chunk));
          child.stderr.on('data', chunk => (text += chunk));
          child.on('close', code => resolve({ zone, code: code ?? 1, text }));
        })
    )
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

const IL = 'Asia/Jerusalem';
const FRI = '2026-11-13';
const SAT = '2026-11-14';
const SUN = '2026-11-15';
const L = '⁦'; // LEFT-TO-RIGHT ISOLATE
const P = '⁩'; // POP DIRECTIONAL ISOLATE
const NB = ' ';

const MESSAGES = { en, he, ru } as const;
const words = (locale: Locale): AskWords => ({
  t: MESSAGES[locale].bot.askInChat as AskTexts,
  locale,
  botUsername: 'famcal_test_bot',
  ...(locale === 'ru' ? { genitive: ru.calendarHome.hebrewMonthGenitive } : {}),
});

const ev = (start: string, end: string): CalendarEvent => ({ summary: 'SECRET-TITLE', start, end, calendarName: 'Mine', calendarId: 'native:mine' });
const local = (day: string, hhmm: string) => `${day}T${hhmm}:00+02:00`;
const busy = (day: string, ...spans: Array<[string, string]>) => spans.map(([a, b]) => ev(local(day, a), local(day, b)));

const SOME = busy(FRI, ['10:00', '11:30'], ['19:00', '21:00']);
const EVENING = busy(FRI, ['19:00', '21:00']);
const ALL_DAY = [ev(FRI, SAT)];
const NIGHTS = [ev(local('2026-11-12', '22:00'), local(FRI, '02:00')), ev(local(FRI, '22:00'), local(SAT, '01:00'))];

function answerOf(events: CalendarEvent[], range: AskRange, days: string[] = [FRI], extra: Partial<AskAnswer> = {}): AskAnswer {
  return {
    range,
    hebrewAsked: false,
    tz: IL,
    days: days.map(day => ({ day, judged: judgeWindow(range, day, busyIntervals(events, day, IL, []), IL) })),
    ...extra,
  };
}
const text = (locale: Locale, answer: AskAnswer) => askAnswerText(answer, words(locale));
const same = (got: string, want: string, label: string) => assert(got === want, `${label}:\n  got  ${show(got)}\n  want ${show(want)}`);

function main() {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  const DAY: AskRange = { kind: 'day' };
  const EVE: AskRange = { kind: 'part', part: 'evening' };
  const AT20: AskRange = { kind: 'at', time: '20:00' };
  const RANGE: AskRange = { kind: 'between', from: '18:00', to: '20:00' };

  check('a day: busy in part (two ranges joined), free all day, busy all day; en, he, ru', () => {
    same(text('en', answerOf(SOME, DAY)), 'Friday 13.11: busy 10:00-11:30 and 19:00-21:00, free the rest of the day', 'en some');
    same(text('he', answerOf(SOME, DAY)), `יום שישי ${L}13.11${P}: תפוס ${L}10:00–11:30${P} ו-${L}19:00–21:00${P}, שאר היום פנוי`, 'he some');
    same(text('ru', answerOf(SOME, DAY)), `Пятница, 13.11: занято 10:00–11:30 и 19:00–21:00, в${NB}остальное время свободно`, 'ru some');
    same(text('en', answerOf([], DAY)), 'Friday 13.11: free all day', 'en free');
    same(text('he', answerOf([], DAY)), `יום שישי ${L}13.11${P}: פנוי כל היום`, 'he free');
    same(text('ru', answerOf([], DAY)), 'Пятница, 13.11: весь день свободно', 'ru free');
    same(text('en', answerOf(ALL_DAY, DAY)), 'Friday 13.11: busy all day', 'en all');
    same(text('he', answerOf(ALL_DAY, DAY)), `יום שישי ${L}13.11${P}: תפוס כל היום`, 'he all');
    same(text('ru', answerOf(ALL_DAY, DAY)), 'Пятница, 13.11: занято весь день', 'ru all');
  });

  check('a part of the day and a range: busy in part, free, busy throughout', () => {
    same(text('en', answerOf(EVENING, EVE)), 'Friday 13.11, evening: busy 19:00-21:00, free the rest', 'en some');
    same(text('he', answerOf(EVENING, EVE)), `יום שישי ${L}13.11${P}, בערב: תפוס ${L}19:00–21:00${P}, בשאר הזמן פנוי`, 'he some');
    same(text('ru', answerOf(EVENING, EVE)), `Пятница, 13.11, вечером: занято 19:00–21:00, в${NB}остальное время свободно`, 'ru some');
    same(text('en', answerOf([], RANGE)), 'Friday 13.11, 18:00-20:00: free', 'en free range');
    same(text('he', answerOf([], RANGE)), `יום שישי ${L}13.11${P}, ${L}18:00–20:00${P}: פנוי`, 'he free range');
    same(text('ru', answerOf([], RANGE)), 'Пятница, 13.11, 18:00–20:00: свободно', 'ru free range');
    same(text('en', answerOf(ALL_DAY, EVE)), 'Friday 13.11, evening: busy throughout', 'en all');
    same(text('he', answerOf(ALL_DAY, EVE)), `יום שישי ${L}13.11${P}, בערב: תפוס כל הזמן`, 'he all');
    same(text('ru', answerOf(ALL_DAY, EVE)), 'Пятница, 13.11, вечером: всё время занято', 'ru all');
  });

  check('a time: busy shows the whole busy stretch it falls in; free', () => {
    same(text('en', answerOf(EVENING, AT20)), 'Friday 13.11, 20:00: busy (19:00-21:00)', 'en busy');
    same(text('he', answerOf(EVENING, AT20)), `יום שישי ${L}13.11${P}, ${L}20:00${P}: תפוס (${L}19:00–21:00${P})`, 'he busy');
    same(text('ru', answerOf(EVENING, AT20)), 'Пятница, 13.11, 20:00: занято (19:00–21:00)', 'ru busy');
    same(text('en', answerOf([], AT20)), 'Friday 13.11, 20:00: free', 'en free');
    same(text('he', answerOf([], AT20)), `יום שישי ${L}13.11${P}, ${L}20:00${P}: פנוי`, 'he free');
    same(text('ru', answerOf([], AT20)), 'Пятница, 13.11, 20:00: свободно', 'ru free');
  });

  check('events crossing midnight: "until 02:00" and "from 22:00"; an instant is one time; an all-day event in a time window is 00:00-24:00', () => {
    same(text('en', answerOf(NIGHTS, DAY)), 'Friday 13.11: busy until 02:00 and from 22:00, free the rest of the day', 'en');
    same(text('he', answerOf(NIGHTS, DAY)), `יום שישי ${L}13.11${P}: תפוס עד ${L}02:00${P} ומ־${L}22:00${P}, שאר היום פנוי`, 'he');
    same(text('ru', answerOf(NIGHTS, DAY)), `Пятница, 13.11: занято до 02:00 и с${NB}22:00, в${NB}остальное время свободно`, 'ru');
    same(text('en', answerOf([ev(local(FRI, '20:15'), local(FRI, '20:15'))], AT20)), 'Friday 13.11, 20:00: busy (20:15)', 'instant');
    same(text('en', answerOf([ev('2026-11-12', '2026-11-15')], AT20)), 'Friday 13.11, 20:00: busy (00:00-24:00)', 'multi-day all-day');
  });

  check('the weekday is the day the key names, whatever the process zone; 3 days give 3 lines, each with its date', () => {
    const lines = text('en', answerOf(SOME, DAY, [FRI, SAT, SUN])).split('\n');
    assert(lines.length === 3, show(lines));
    same(lines[1], 'Saturday 14.11: free all day', 'Saturday');
    same(lines[2], 'Sunday 15.11: free all day', 'Sunday');
    same(text('ru', answerOf([], DAY, [SUN])), 'Воскресенье, 15.11: весь день свободно', 'ru Sunday');
  });

  check('a Hebrew date asked is echoed after the date, in each language', () => {
    const tu = '2027-01-23';
    const a = (locale: Locale) => text(locale, { ...answerOf([], DAY, [tu]), hebrewAsked: true });
    same(a('en'), "Saturday 23.01 (15 Sh'vat): free all day", 'en');
    same(a('he'), `יום שבת ${L}23.01${P} (ט״ו בשבט): פנוי כל היום`, 'he');
    same(a('ru'), 'Суббота, 23.01 (15 швата): весь день свободно', 'ru');
  });

  check('Google unread: busy lines without a free claim, then the Google line; a free day has no line; nothing busy at all is "couldn\'t check"', () => {
    const gap = { googleGap: 'unavailable' as const };
    same(text('en', answerOf(SOME, DAY, [FRI], gap)), "Friday 13.11: busy 10:00-11:30 and 19:00-21:00\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'en day');
    same(text('en', answerOf(EVENING, EVE, [FRI], gap)), "Friday 13.11, evening: busy 19:00-21:00\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'en window');
    same(text('en', answerOf(EVENING, AT20, [FRI], gap)), "Friday 13.11, 20:00: busy (19:00-21:00)\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'en at');
    same(text('en', answerOf(EVENING, DAY, [FRI, SAT], gap)), "Friday 13.11: busy 19:00-21:00\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'a free Saturday has no line');
    same(text('en', answerOf([], DAY, [FRI, SAT], gap)), "Couldn't check the calendar right now. Try again in a minute.", 'nothing busy');
    same(text('he', answerOf(SOME, DAY, [FRI], gap)), `יום שישי ${L}13.11${P}: תפוס ${L}10:00–11:30${P} ו-${L}19:00–21:00${P}\nאת Google Calendar לא הצלחנו לקרוא, אז התשובה לפי FamCal בלבד.`, 'he');
    same(text('ru', answerOf(SOME, DAY, [FRI], gap)), 'Пятница, 13.11: занято 10:00–11:30 и 19:00–21:00\nGoogle Календарь сейчас недоступен, поэтому ответ только по FamCal.', 'ru');
    for (const locale of ['en', 'he', 'ru'] as const) {
      const t = MESSAGES[locale].bot.askInChat;
      const out = text(locale, answerOf(SOME, DAY, [FRI, SAT], gap)) + text(locale, answerOf(EVENING, EVE, [FRI], gap));
      for (const free of [t.day.some.split('{ranges}')[1], t.window.some.split('{ranges}')[1], t.day.free.split('{date}')[1], t.window.free.split('{when}')[1]]) {
        assert(!out.includes(free), `${locale}: a free claim "${free}" in ${show(out)}`);
      }
    }
  });

  check('the "which day?" and "up to 3 days" lines name the bot', () => {
    same(noDateText(words('en')), 'Which day? Reply to the message that names it, or write it after the mention, e.g. @famcal_test_bot Friday evening.', 'en noDate');
    same(tooManyDaysText(words('he')), 'אפשר לבדוק עד 3 ימים בכל פעם. כתבו יום אחד, למשל: @famcal_test_bot שישי', 'he tooManyDays');
    same(noDateText(words('ru')), `О${NB}каком дне речь? Ответьте на сообщение, где он назван, или напишите его после упоминания, например: @famcal_test_bot пятница вечером`, 'ru noDate');
  });

  check('no answer holds an event\'s title, and none has HTML', () => {
    for (const locale of ['en', 'he', 'ru'] as const) {
      for (const [events, range] of [[SOME, DAY], [EVENING, EVE], [EVENING, AT20], [NIGHTS, DAY]] as const) {
        const out = text(locale, answerOf([...events], range));
        assert(!out.includes('SECRET-TITLE') && !/[<>]/.test(out), `${locale}: ${show(out)}`);
      }
    }
  });

  check('every Hebrew answer shape starts with a right-to-left letter (or U+200F): Telegram lays a paragraph out by its first strong character', () => {
    const firstStrong = (s: string): 'rtl' | 'ltr' | 'none' => {
      let depth = 0;
      for (const ch of s) {
        if ('\u2066\u2067\u2068'.includes(ch)) depth++;
        else if (ch === '\u2069') depth = Math.max(0, depth - 1);
        else if (depth === 0) {
          if (ch === '\u200F' || /\p{Script=Hebrew}/u.test(ch)) return 'rtl';
          if (/[\p{Script=Latin}\p{Script=Cyrillic}\u200E]/u.test(ch)) return 'ltr';
        }
      }
      return 'none';
    };
    const gap = { googleGap: 'unavailable' as const };
    const t = he.bot.askInChat;
    const shapes: Record<string, string> = {
      day: text('he', answerOf(SOME, DAY)),
      window: text('he', answerOf(EVENING, EVE)),
      time: text('he', answerOf(EVENING, AT20)),
      range: text('he', answerOf([], RANGE)),
      severalDays: text('he', answerOf(SOME, DAY, [FRI, SAT, SUN])),
      hebrewDate: text('he', { ...answerOf([], DAY, ['2027-01-23']), hebrewAsked: true }),
      partial: text('he', answerOf(SOME, DAY, [FRI], gap)),
      unavailable: text('he', answerOf([], DAY, [FRI], gap)),
      whichDay: noDateText(words('he')),
      tooManyDays: tooManyDaysText(words('he')),
      noAccount: leadRtl(t.noAccount, 'he'),
      rateLimited: leadRtl(t.rateLimited, 'he'),
      failure: leadRtl(t.unavailable, 'he'),
    };
    for (const [name, out] of Object.entries(shapes)) assert(firstStrong(out) === 'rtl', `${name}: ${show(out)}`);
    assert(leadRtl('FamCal: busy', 'he').startsWith('\u200F') && leadRtl('13.11 תפוס', 'he').startsWith('\u200F'), 'a Latin or digit start gets U+200F');
    assert(leadRtl('FamCal', 'en') === 'FamCal', 'other languages are untouched');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] !== '1') void runChildren();
else main();
