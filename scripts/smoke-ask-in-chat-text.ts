// Smoke test for the words of a guest answer (src/services/ask-in-chat/text.ts with bot.askInChat in
// messages/{en,he,ru}.json; spec docs/superpowers/specs/2026-11-07-ask-in-chat-design.md §6, rulings 2, 11 and 14, and
// docs/superpowers/specs/2026-11-08-ask-in-chat-people-design.md §4, the owner's decisions 1, 2 and 4):
//   - every line of the 2026-11-08 spec's table in en, he and ru, exactly: each day's first line (the date, and the
//     time asked), then a person's line for a day, a part of the day, a range and a time, each free, busy throughout or
//     busy in part; an event crossing midnight ("until 02:00", "from 22:00"); an instant;
//   - in Hebrew every time, range and dd.MM is a left-to-right isolate; Russian capitalises the weekday;
//   - the weekday is the day the key names, whatever the zone; a Hebrew date asked is echoed;
//   - two ranges are joined as a list; 3 days give 3 first lines;
//   - the people: with no one in particular asked, the caller's line always and the others only when busy (every line
//     when that leaves none); a group or everyone asked, each of its lines busy or free; the order is the caller, the
//     partner, the kids, the family; a person with no name gets the language's word;
//   - with Google unread no line claims free time, a day with no line left has no first line either, and with nothing
//     left the answer is "couldn't check";
//   - every line starts in the answer's direction: a Hebrew line with a Latin name gets U+200F, an English line with a
//     Hebrew name U+200E; the "which day?" and "up to 3 days" lines name the bot; no line holds an event's title.
// Re-runs itself under UTC, Asia/Jerusalem and America/New_York. Pure: no network, no database.
//
//   npx tsx scripts/smoke-ask-in-chat-text.ts

import { spawn } from 'node:child_process';
import en from '../messages/en.json';
import he from '../messages/he.json';
import ru from '../messages/ru.json';
import { busyIntervals, judgeWindow } from '../src/services/ask-in-chat/busy';
import type { Person } from '../src/services/ask-in-chat/people';
import { askAnswerText, leadLtr, leadRtl, noDateText, tooManyDaysText, type AskAnswer, type AskTexts, type AskWords } from '../src/services/ask-in-chat/text';
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
const RLM = '‏';
const LRM = '‎';

const MESSAGES = { en, he, ru } as const;
const words = (locale: Locale): AskWords => ({
  t: MESSAGES[locale].bot.askInChat as AskTexts,
  locale,
  botUsername: 'famcal_test_bot',
  ...(locale === 'ru' ? { genitive: ru.calendarHome.hebrewMonthGenitive } : {}),
});

const person = (key: string, kind: Person['kind'], name: string | null): Person => ({ key, kind, name, aliases: [], calendarIds: [] });
const NAME = { en: 'Raziel', he: 'רזיאל', ru: 'Разиэль' } as const;
const me = (locale: Locale) => person('me', 'me', NAME[locale]);
const DANA = person('partner', 'partner', 'Dana');
const MAYA = person('kid:maya', 'kid', 'Maya');
const KIDS = person('kid:', 'kid', null);
const FAMILY = person('family', 'family', null);

const ev = (start: string, end: string): CalendarEvent => ({ summary: 'SECRET-TITLE', start, end, calendarName: 'Mine', calendarId: 'native:mine' });
const local = (day: string, hhmm: string) => `${day}T${hhmm}:00+02:00`;
const busy = (day: string, ...spans: Array<[string, string]>) => spans.map(([a, b]) => ev(local(day, a), local(day, b)));

const SOME = busy(FRI, ['10:00', '11:30'], ['19:00', '21:00']);
const EVENING = busy(FRI, ['19:00', '21:00']);
const ALL_DAY = [ev(FRI, SAT)];
const NIGHTS = [ev(local('2026-11-12', '22:00'), local(FRI, '02:00')), ev(local(FRI, '22:00'), local(SAT, '01:00'))];

type Cast = Array<[Person, CalendarEvent[]]>;
/** An answer whose people each have their own events. */
function answerOf(cast: Cast, range: AskRange, days: string[] = [FRI], extra: Partial<AskAnswer> = {}): AskAnswer {
  return {
    range,
    hebrewAsked: false,
    tz: IL,
    asked: null,
    days: days.map(day => ({ day, lines: cast.map(([who, events]) => ({ person: who, judged: judgeWindow(range, day, busyIntervals(events, day, IL, []), IL) })) })),
    ...extra,
  };
}
/** The caller alone. */
const solo = (locale: Locale, events: CalendarEvent[], range: AskRange, days?: string[], extra?: Partial<AskAnswer>) => answerOf([[me(locale), events]], range, days, extra);
const text = (locale: Locale, answer: AskAnswer) => askAnswerText(answer, words(locale));
const same = (got: string, want: string, label: string) => assert(got === want, `${label}:\n  got  ${show(got)}\n  want ${show(want)}`);

function main() {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  const DAY: AskRange = { kind: 'day' };
  const EVE: AskRange = { kind: 'part', part: 'evening' };
  const AT20: AskRange = { kind: 'at', time: '20:00' };
  const RANGE: AskRange = { kind: 'between', from: '18:00', to: '20:00' };

  check('a day: busy in part (two ranges joined), free all day, busy all day; en, he, ru', () => {
    same(text('en', solo('en', SOME, DAY)), 'Friday 13.11:\nRaziel: busy 10:00-11:30 and 19:00-21:00, free the rest of the day', 'en some');
    same(text('he', solo('he', SOME, DAY)), `יום שישי ${L}13.11${P}:\nרזיאל: יש תוכניות ${L}10:00–11:30${P} ו-${L}19:00–21:00${P}, שאר היום פנוי`, 'he some');
    same(text('ru', solo('ru', SOME, DAY)), `Пятница, 13.11:\nРазиэль: есть планы с${NB}10:00 до 11:30 и с${NB}19:00 до 21:00, в${NB}остальное время свободно`, 'ru some');
    same(text('en', solo('en', [], DAY)), 'Friday 13.11:\nRaziel: free all day', 'en free');
    same(text('he', solo('he', [], DAY)), `יום שישי ${L}13.11${P}:\nרזיאל: כל היום פנוי`, 'he free');
    same(text('ru', solo('ru', [], DAY)), 'Пятница, 13.11:\nРазиэль: весь день свободен', 'ru free');
    same(text('en', solo('en', ALL_DAY, DAY)), 'Friday 13.11:\nRaziel: busy all day', 'en all');
    same(text('he', solo('he', ALL_DAY, DAY)), `יום שישי ${L}13.11${P}:\nרזיאל: יש תוכניות כל היום`, 'he all');
    same(text('ru', solo('ru', ALL_DAY, DAY)), 'Пятница, 13.11:\nРазиэль: планы на весь день', 'ru all');
  });

  check('a part of the day and a range: busy in part, free, busy throughout', () => {
    same(text('en', solo('en', EVENING, EVE)), 'Friday 13.11, evening:\nRaziel: busy 19:00-21:00, free the rest', 'en some');
    same(text('he', solo('he', EVENING, EVE)), `יום שישי ${L}13.11${P}, בערב:\nרזיאל: יש תוכניות ${L}19:00–21:00${P}, שאר הזמן פנוי`, 'he some');
    same(text('ru', solo('ru', EVENING, EVE)), `Пятница, 13.11, вечером:\nРазиэль: есть планы с${NB}19:00 до 21:00, в${NB}остальное время свободно`, 'ru some');
    same(text('en', solo('en', [], RANGE)), 'Friday 13.11, 18:00-20:00:\nRaziel: free', 'en free range');
    same(text('he', solo('he', [], RANGE)), `יום שישי ${L}13.11${P}, ${L}18:00–20:00${P}:\nרזיאל: אין תוכניות`, 'he free range');
    same(text('ru', solo('ru', [], RANGE)), `Пятница, 13.11, с${NB}18:00 до 20:00:\nРазиэль: планов нет`, 'ru free range');
    same(text('en', solo('en', ALL_DAY, EVE)), 'Friday 13.11, evening:\nRaziel: busy throughout', 'en all');
    same(text('he', solo('he', ALL_DAY, EVE)), `יום שישי ${L}13.11${P}, בערב:\nרזיאל: הלו״ז מלא`, 'he all');
    same(text('ru', solo('ru', ALL_DAY, EVE)), 'Пятница, 13.11, вечером:\nРазиэль: всё время занято', 'ru all');
  });

  check('a time: busy shows the whole busy stretch it falls in; free', () => {
    same(text('en', solo('en', EVENING, AT20)), 'Friday 13.11, 20:00:\nRaziel: busy (19:00-21:00)', 'en busy');
    same(text('he', solo('he', EVENING, AT20)), `יום שישי ${L}13.11${P}, ${L}20:00${P}:\nרזיאל: יש תוכניות (${L}19:00–21:00${P})`, 'he busy');
    same(text('ru', solo('ru', EVENING, AT20)), `Пятница, 13.11, 20:00:\nРазиэль: есть планы (с${NB}19:00 до 21:00)`, 'ru busy');
    same(text('en', solo('en', [], AT20)), 'Friday 13.11, 20:00:\nRaziel: free', 'en free');
    same(text('he', solo('he', [], AT20)), `יום שישי ${L}13.11${P}, ${L}20:00${P}:\nרזיאל: אין תוכניות`, 'he free');
    same(text('ru', solo('ru', [], AT20)), 'Пятница, 13.11, 20:00:\nРазиэль: планов нет', 'ru free');
  });

  check('events crossing midnight: "until 02:00" and "from 22:00"; an instant is one time; an all-day event in a time window is 00:00-24:00', () => {
    same(text('en', solo('en', NIGHTS, DAY)), 'Friday 13.11:\nRaziel: busy until 02:00 and from 22:00, free the rest of the day', 'en');
    same(text('he', solo('he', NIGHTS, DAY)), `יום שישי ${L}13.11${P}:\nרזיאל: יש תוכניות עד ${L}02:00${P} ומ־${L}22:00${P}, שאר היום פנוי`, 'he');
    same(text('ru', solo('ru', NIGHTS, DAY)), `Пятница, 13.11:\nРазиэль: есть планы до 02:00 и с${NB}22:00, в${NB}остальное время свободно`, 'ru');
    same(text('en', solo('en', [ev(local(FRI, '20:15'), local(FRI, '20:15'))], AT20)), 'Friday 13.11, 20:00:\nRaziel: busy (20:15)', 'instant');
    same(text('en', solo('en', [ev('2026-11-12', '2026-11-15')], AT20)), 'Friday 13.11, 20:00:\nRaziel: busy (00:00-24:00)', 'multi-day all-day');
    same(text('ru', solo('ru', [ev('2026-11-12', '2026-11-15')], AT20)), `Пятница, 13.11, 20:00:\nРазиэль: есть планы (с${NB}00:00 до 24:00)`, 'ru multi-day all-day');
  });

  check('the weekday is the day the key names, whatever the process zone; 3 days give 3 first lines, each with its date', () => {
    const lines = text('en', solo('en', SOME, DAY, [FRI, SAT, SUN])).split('\n');
    assert(lines.length === 6, show(lines));
    same(lines[2], 'Saturday 14.11:', 'Saturday');
    same(lines[3], 'Raziel: free all day', 'Saturday\'s line');
    same(lines[4], 'Sunday 15.11:', 'Sunday');
    same(text('ru', solo('ru', [], DAY, [SUN])), 'Воскресенье, 15.11:\nРазиэль: весь день свободен', 'ru Sunday');
  });

  check('a Hebrew date asked is echoed after the date, in each language', () => {
    const tu = '2027-01-23';
    const a = (locale: Locale) => text(locale, { ...solo(locale, [], DAY, [tu]), hebrewAsked: true });
    same(a('en'), "Saturday 23.01 (15 Sh'vat):\nRaziel: free all day", 'en');
    same(a('he'), `יום שבת ${L}23.01${P} (ט״ו בשבט):\nרזיאל: כל היום פנוי`, 'he');
    same(a('ru'), 'Суббота, 23.01 (15 швата):\nРазиэль: весь день свободен', 'ru');
  });

  const FAMILY_CAST: Cast = [[me('en'), []], [DANA, EVENING], [MAYA, []], [KIDS, busy(FRI, ['16:00', '17:00'])], [FAMILY, ALL_DAY]];

  check('no one in particular asked: the caller\'s line always, the others only when busy, in order', () => {
    same(text('en', answerOf(FAMILY_CAST, DAY)), [
      'Friday 13.11:',
      'Raziel: free all day',
      'Dana: busy 19:00-21:00, free the rest of the day',
      'Kids: busy 16:00-17:00, free the rest of the day',
      'Family: busy all day',
    ].join('\n'), 'everyone busy but Maya');
    same(text('en', answerOf([[me('en'), []], [DANA, []], [MAYA, []]], EVE)), 'Friday 13.11, evening:\nRaziel: free', 'nobody else busy');
  });

  check('no one in particular asked and no line of the caller\'s: every line, when nobody is busy', () => {
    same(text('en', answerOf([[DANA, []], [MAYA, []]], DAY)), 'Friday 13.11:\nDana: free all day\nMaya: free all day', 'all free');
    same(text('en', answerOf([[DANA, []], [MAYA, EVENING]], DAY)), 'Friday 13.11:\nMaya: busy 19:00-21:00, free the rest of the day', 'one busy');
  });

  check('a group or everyone asked: each of its lines, busy or free; one person asked: only theirs', () => {
    same(text('en', answerOf(FAMILY_CAST, DAY, [FRI], { asked: new Set(['kid:maya', 'kid:']) })), 'Friday 13.11:\nMaya: free all day\nKids: busy 16:00-17:00, free the rest of the day', 'the kids');
    same(text('en', answerOf(FAMILY_CAST, AT20, [FRI], { asked: new Set(['partner']) })), 'Friday 13.11, 20:00:\nDana: busy (19:00-21:00)', 'the partner');
    same(text('en', answerOf(FAMILY_CAST, AT20, [FRI], { asked: new Set(['kid:maya']) })), 'Friday 13.11, 20:00:\nMaya: free', 'one kid, free');
    const all = text('en', answerOf(FAMILY_CAST, DAY, [FRI], { asked: new Set(['me', 'partner', 'kid:maya', 'kid:', 'family']) })).split('\n');
    same(show(all.map(l => l.split(':')[0])), show(['Friday 13.11', 'Raziel', 'Dana', 'Maya', 'Kids', 'Family']), 'everyone');
  });

  check('a person with no name gets the language\'s word: Me, Partner, Kids, Family in each language', () => {
    const unnamed: Cast = [[person('me', 'me', null), ALL_DAY], [person('partner', 'partner', null), ALL_DAY], [KIDS, ALL_DAY], [FAMILY, ALL_DAY]];
    same(text('en', answerOf(unnamed, DAY)).split('\n').slice(1).map(l => l.split(':')[0]).join('|'), 'Me|Partner|Kids|Family', 'en');
    same(text('he', answerOf(unnamed, DAY)).split('\n').slice(1).map(l => l.split(':')[0]).join('|'), 'אני|בן או בת הזוג|הילדים|המשפחה', 'he');
    same(text('ru', answerOf(unnamed, DAY)).split('\n').slice(1).map(l => l.split(':')[0]).join('|'), 'Я|Партнёр|Дети|Семья', 'ru');
  });

  check('Google unread: busy lines without a free claim, then the Google line; a day or a person with nothing busy has no line; nothing busy at all is "couldn\'t check"', () => {
    const gap = { googleGap: 'unavailable' as const };
    same(text('en', solo('en', SOME, DAY, [FRI], gap)), "Friday 13.11:\nRaziel: busy 10:00-11:30 and 19:00-21:00\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'en day');
    same(text('en', solo('en', EVENING, EVE, [FRI], gap)), "Friday 13.11, evening:\nRaziel: busy 19:00-21:00\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'en window');
    same(text('en', solo('en', EVENING, AT20, [FRI], gap)), "Friday 13.11, 20:00:\nRaziel: busy (19:00-21:00)\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'en at');
    same(text('en', solo('en', EVENING, DAY, [FRI, SAT], gap)), "Friday 13.11:\nRaziel: busy 19:00-21:00\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'a free Saturday has no line');
    same(text('en', answerOf(FAMILY_CAST, DAY, [FRI], { ...gap, asked: new Set(['me', 'kid:maya', 'kid:']) })), "Friday 13.11:\nKids: busy 16:00-17:00\nGoogle Calendar couldn't be read, so this is from FamCal alone.", 'the free ones asked have no line');
    same(text('en', solo('en', [], DAY, [FRI, SAT], gap)), "Couldn't check the calendar right now. Try again in a minute.", 'nothing busy');
    same(text('he', solo('he', SOME, DAY, [FRI], gap)), `יום שישי ${L}13.11${P}:\nרזיאל: יש תוכניות ${L}10:00–11:30${P} ו-${L}19:00–21:00${P}\nאת Google Calendar לא הצלחנו לקרוא, אז התשובה לפי FamCal בלבד.`, 'he');
    same(text('ru', solo('ru', SOME, DAY, [FRI], gap)), `Пятница, 13.11:\nРазиэль: есть планы с${NB}10:00 до 11:30 и с${NB}19:00 до 21:00\nGoogle Календарь сейчас недоступен, поэтому ответ только по FamCal.`, 'ru');
    for (const locale of ['en', 'he', 'ru'] as const) {
      const t = MESSAGES[locale].bot.askInChat.line;
      const cast: Cast = [[me(locale), SOME], [MAYA, []], [DANA, EVENING]];
      const asked = { asked: new Set(['me', 'kid:maya', 'partner']) };
      const out = text(locale, answerOf(cast, DAY, [FRI, SAT], { ...gap, ...asked })) + text(locale, answerOf(cast, EVE, [FRI], { ...gap, ...asked })) + text(locale, answerOf(cast, AT20, [FRI], { ...gap, ...asked }));
      for (const free of [t.day.some.split('{ranges}')[1], t.window.some.split('{ranges}')[1], t.day.free.split('{name}')[1], t.window.free.split('{name}')[1], t.at.free.split('{name}')[1]]) {
        assert(!out.includes(free), `${locale}: a free claim "${free}" in ${show(out)}`);
      }
    }
  });

  check('review focus: a name holding braces is shown as written, never filled again', () => {
    same(text('en', answerOf([[person('kid:{ranges}', 'kid', '{ranges} {name}'), EVENING]], DAY)), 'Friday 13.11:\n{ranges} {name}: busy 19:00-21:00, free the rest of the day', 'braces');
  });

  check('the "which day?" and "up to 3 days" lines name the bot', () => {
    same(noDateText(words('en')), 'Which day? Reply to the message that names it, or write it after the mention, e.g. @famcal_test_bot Friday evening.', 'en noDate');
    same(tooManyDaysText(words('he')), 'אפשר לבדוק עד 3 ימים בכל פעם. כתבו יום אחד, למשל: @famcal_test_bot שישי', 'he tooManyDays');
    same(noDateText(words('ru')), `О${NB}каком дне речь? Ответьте на сообщение, где он назван, или напишите его после упоминания, например: @famcal_test_bot пятница вечером`, 'ru noDate');
  });

  check('no answer holds an event\'s title, and none has HTML', () => {
    for (const locale of ['en', 'he', 'ru'] as const) {
      for (const [events, range] of [[SOME, DAY], [EVENING, EVE], [EVENING, AT20], [NIGHTS, DAY]] as const) {
        const out = text(locale, answerOf([[me(locale), [...events]], [MAYA, [...events]]], range));
        assert(!out.includes('SECRET-TITLE') && !/[<>]/.test(out), `${locale}: ${show(out)}`);
      }
    }
  });

  const firstStrong = (s: string): 'rtl' | 'ltr' | 'none' => {
    let depth = 0;
    for (const ch of s) {
      if ('⁦⁧⁨'.includes(ch)) depth++;
      else if (ch === '⁩') depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        if (ch === RLM || /\p{Script=Hebrew}/u.test(ch)) return 'rtl';
        if (/[\p{Script=Latin}\p{Script=Cyrillic}]/u.test(ch) || ch === LRM) return 'ltr';
      }
    }
    return 'none';
  };

  check('every line of every Hebrew answer shape starts with a right-to-left letter (or U+200F): Telegram lays each paragraph out by its first strong character', () => {
    const gap = { googleGap: 'unavailable' as const };
    const t = he.bot.askInChat;
    const latin: Cast = [[me('he'), SOME], [MAYA, EVENING], [FAMILY, ALL_DAY]]; // "Maya" is Latin in a Hebrew answer
    const shapes: Record<string, string> = {
      day: text('he', solo('he', SOME, DAY)),
      window: text('he', solo('he', EVENING, EVE)),
      time: text('he', solo('he', EVENING, AT20)),
      range: text('he', solo('he', [], RANGE)),
      severalDays: text('he', solo('he', SOME, DAY, [FRI, SAT, SUN])),
      hebrewDate: text('he', { ...solo('he', [], DAY, ['2027-01-23']), hebrewAsked: true }),
      latinName: text('he', answerOf(latin, DAY)),
      partial: text('he', answerOf(latin, DAY, [FRI], gap)),
      unavailable: text('he', solo('he', [], DAY, [FRI], gap)),
      whichDay: noDateText(words('he')),
      tooManyDays: tooManyDaysText(words('he')),
      noAccount: leadRtl(t.noAccount, 'he'),
      rateLimited: leadRtl(t.rateLimited, 'he'),
      failure: leadRtl(t.unavailable, 'he'),
    };
    for (const [name, out] of Object.entries(shapes)) {
      for (const line of out.split('\n')) assert(firstStrong(line) === 'rtl', `${name}: ${show(line)}`);
    }
    same(text('he', answerOf(latin, DAY)).split('\n')[2], `${RLM}Maya: יש תוכניות ${L}19:00–21:00${P}, שאר היום פנוי`, 'the Latin name\'s line');
    assert(leadRtl('FamCal: busy', 'he').startsWith(RLM) && leadRtl('13.11 תפוס', 'he').startsWith(RLM), 'a Latin or digit start gets U+200F');
    assert(leadRtl('FamCal', 'en') === 'FamCal', 'other languages are untouched by leadRtl');
  });

  check('every line of an English or Russian answer starts left to right: a Hebrew name\'s line gets U+200E', () => {
    const hebrewName: Cast = [[me('en'), SOME], [person('kid:נועה', 'kid', 'נועה'), EVENING]];
    for (const locale of ['en', 'ru'] as const) {
      const out = text(locale, answerOf(hebrewName, DAY));
      for (const line of out.split('\n')) assert(firstStrong(line) === 'ltr', `${locale}: ${show(line)}`);
    }
    same(text('en', answerOf(hebrewName, DAY)).split('\n')[2], `${LRM}נועה: busy 19:00-21:00, free the rest of the day`, 'the Hebrew name\'s line');
    same(leadLtr('Raziel: free'), 'Raziel: free', 'a Latin start is untouched');
    same(leadLtr(`${L}20:00${P} נועה`), `${LRM}${L}20:00${P} נועה`, 'isolates are skipped');
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
