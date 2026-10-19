// Smoke test for the calendar home's copy (calendar-home spec §9, §7.8 and Ruling R9;
// Plan D, Task D1; the tabs and the Month, Plan E, Task E1).
//
// The calendarHome namespace in messages/{en,he,ru}.json holds every string the new home
// shows. Its key names are a contract: Tasks D2-D7 and E2-E8 use them verbatim. So this
// smoke lists them (KEYS, the tasks' Keys tables) and checks that the three files carry
// exactly those keys, each formatting through next-intl with exactly its arguments. It
// also pins:
//  - the plurals (Russian one/few/many, Hebrew one/two/other) and the weekday select;
//  - the 14 Hebrew month names in Task D2's order (from Tishrei), genitive in Russian (R9),
//    and their short forms for the Month's cells (hebrewMonthShort);
//  - no slash or bracket gender forms in the Hebrew or Russian copy;
//  - calendarHome as its own top-level object between dashboard and admin, away from the
//    bot.errors keys Plan C adds;
//  - spec §9's fixes on the old screens: the Header's aria-labels and admin badge (also
//    on Subscription and Select calendars) and the dashboard loader's "Loading Dashboard...";
//  - scripts/check-i18n-parity.ts's ICU check, run on fixture files in a temp directory,
//    with E1's three fixes: bot.* read as getBotMessage fills it, '' inside a quoted
//    literal, and =N forms standing in for a category that holds N alone.
//
// Nothing is faked: no DB, Redis or network.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-calendar-home-copy.ts

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const messagesOf = (locale: Locale): Row => JSON.parse(readSource(`messages/${locale}.json`));

// ---- The Keys table ----

/** Every calendarHome key, with the ICU arguments it takes (the task's Keys table). */
const KEYS: Record<string, readonly string[]> = {
  // HomeHeader (D6)
  'header.send': [],
  'header.menu': [],
  // SendSheet (D6), with the send results of Ruling R5 (D4's outcomes)
  'send.title': [],
  'send.subtitle': [],
  'send.today': [],
  'send.todayHint': [],
  'send.tomorrow': [],
  'send.tomorrowHint': [],
  'send.thisWeek': [],
  'send.thisWeekHint': [],
  'send.nextWeek': [],
  'send.nextWeekHint': [],
  'send.weather': [],
  'send.weatherHint': [],
  'send.sending': [],
  'send.sent': [],
  'send.sentWhatsApp': [],
  'send.busy': [],
  'send.failed': [],
  'send.signedOut': [],
  'send.offline': [],
  // MenuSheet (D6), Ruling R6
  'menu.settings': [],
  'menu.calendars': [],
  'menu.partner': [],
  'menu.chooseCalendars': [],
  'menu.reconnectGoogle': [],
  'menu.subscription': [],
  'menu.refresh': [],
  'menu.feedback': [],
  'menu.admin': [],
  // HomeBanners (D6), spec §7.2 and §5's Reconnect banner
  'banner.trial': ['count'],
  'banner.trialAction': [],
  'banner.location': [],
  'banner.locationAction': [],
  'banner.connectGoogle': [],
  'banner.connectGoogleBody': [],
  'banner.chooseCalendars': [],
  'banner.chooseCalendarsBody': [],
  'banner.reconnect': [],
  'banner.reconnectBody': [],
  'banner.reconnectScopes': [],
  'banner.reconnectScopesBody': [],
  'banner.reconnectAction': [],
  'banner.openInTelegram': [],
  'banner.openInTelegramBody': [],
  // §5's state rows and the retry card (D5 and D6)
  'state.partial': [],
  'state.unavailable': ['count'],
  'state.googleError': [],
  'state.calendarsGone': [],
  'state.famcalError': [],
  'state.busy': [],
  'state.errorTitle': [],
  'state.errorBody': [],
  // Buttons shared by the rows, cards, sheets and the error boundary
  'actions.retry': [],
  'actions.chooseAgain': [],
  'actions.close': [],
  'actions.reload': [],
  // HomeErrorBoundary (D6)
  'errorBoundary.title': [],
  'errorBoundary.body': [],
  // CalendarHome shell (D6)
  'shell.loading': [],
  'shell.timesIn': ['zone'],
  // AgendaView and DayList (D5)
  'agenda.today': [],
  'agenda.tomorrow': [],
  'agenda.nothingPlanned': [],
  'agenda.nothingPlannedRange': ['range'],
  'agenda.showNextWeek': [],
  // The still-open card (D5)
  'stillOpen.title': [],
  'stillOpen.count': ['count'],
  'stillOpen.more': ['count'],
  'stillOpen.sinceTime': ['time'],
  'stillOpen.sinceYesterday': [],
  'stillOpen.sinceWeekday': ['weekday'],
  'stillOpen.sinceDate': ['date'],
  // ItemRow (D5)
  'row.allDay': [],
  'row.until': ['when'],
  'row.continues': [],
  'row.noTitle': [],
  'row.reminder': [],
  'row.open': [],
  'row.done': [],
  'row.everyDay': [],
  'row.repeats': [],
  'row.snoozedUntil': ['time'],
  'row.snoozedLabel': ['time'],
  'row.birthday': [],
  'row.googleCalendar': ['calendar'],
  // Whose an item is (D5: rows, the still-open card, the item sheet), spec §7.3
  'person.from': ['name'],
  'person.for': ['name'],
  // ItemSheet (D5), spec §7.5
  'sheet.label': [],
  'sheet.calendar': [],
  'sheet.partnerCalendar': ['name'],
  'sheet.privateCalendar': [],
  'sheet.location': [],
  'sheet.notes': [],
  'sheet.repeats': [],
  'sheet.everyDay': [],
  'sheet.stateOpen': [],
  'sheet.stateDone': [],
  'sheet.stateDoneAt': ['time'],
  'sheet.stateSnoozed': ['time'],
  'sheet.stateLater': [],
  'sheet.openInGoogle': [],
  // The empty state (D5), Ruling R10
  'empty.title': [],
  'empty.hintEvents': [],
  'empty.hintReminders': [],
  // The tab bar (E4), spec §7.1 and §7.7
  'tabs.label': [],
  'tabs.agenda': [],
  'tabs.month': [],
  // The Month (E6 browse, E7 picked), spec §7.4 and §7.7
  'month.today': [],
  'month.allMonths': [],
  'month.previous': [],
  'month.next': [],
  'month.dayToday': ['date'],
  'month.more': ['count'],
  'month.moreShort': ['count'],
  'month.cellItems': ['count'],
  'month.cellFromPartner': ['count', 'name'],
  'month.cellNothing': [],
  'month.cellLoading': [],
  'month.cellFailed': [],
  'month.failed': [],
};
/** Keys whose value is an array (read with t.raw). */
const ARRAY_KEYS = ['hebrewMonthGenitive', 'hebrewMonthShort'];

/** A sample value per argument. count and weekday also run over several values. */
const SAMPLES: Record<string, string | number> = {
  name: 'Noa',
  calendar: 'Family',
  when: '02:00',
  time: '13:45',
  date: '12 Oct',
  range: 'Sat 17 – Sun 18 Oct',
  zone: 'Asia/Jerusalem',
  count: 5,
  weekday: 'tue',
};
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * hebcal's month names (HDate#getMonthName()) in the order of Task D2's HEBREW_MONTHS: the
 * year from Tishrei, a common year's Adar before a leap year's Adar I and Adar II. D2's
 * hebrew-date.ts looks a month up in that order; D1 lands first, so this is a copy.
 */
const HEBREW_MONTHS = ['Tishrei', 'Cheshvan', 'Kislev', 'Tevet', "Sh'vat", 'Adar', 'Adar I', 'Adar II', 'Nisan', 'Iyyar', 'Sivan', 'Tamuz', 'Av', 'Elul'];
/** Ruling R9: "4 хешвана". The genitive of @hebcal/locales' ru names (Тишрей, Хешван, …), in that order. */
const RU_GENITIVE = ['тишрея', 'хешвана', 'кислева', 'тевета', 'швата', 'адара', 'адара I', 'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула'];
/**
 * calendarHome.hebrewMonthShort, the Month cell's month after the Hebrew day ("1 Chesh.",
 * "א׳ חשון", "1 хешв."), in HEBREW_MONTHS order. English and Russian cut the four long
 * names the approved mockup cuts (Tish., Chesh., Kis., Tev.) and keep the rest whole;
 * Russian is the genitive, to read after a number. Hebrew is the plain name, the one the
 * Agenda's day labels use.
 */
const EN_SHORT = ['Tish.', 'Chesh.', 'Kis.', 'Tev.', "Sh'vat", 'Adar', 'Adar I', 'Adar II', 'Nisan', 'Iyyar', 'Sivan', 'Tamuz', 'Av', 'Elul'];
const HE_SHORT = ['תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר', 'אדר א׳', 'אדר ב׳', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];
const RU_SHORT = ['тишр.', 'хешв.', 'кисл.', 'тев.', 'швата', 'адара', 'адара I', 'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула'];

/** Every leaf under a node, by its dot path; an array is one leaf. */
function leavesOf(node: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) leavesOf(value, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

/** The part of next-intl's translator the checks call. */
type Translate = ((key: string, values?: Row) => string) & { raw: (key: string) => unknown };

/** next-intl's translator for calendarHome, as the home's useTranslations('calendarHome') gets it. */
function translator(locale: Locale, errors: string[]): Translate {
  const { createTranslator } = nodeRequire('next-intl');
  return createTranslator({
    locale,
    messages: messagesOf(locale),
    namespace: 'calendarHome',
    onError: (err: Error) => errors.push(err.message),
    getMessageFallback: ({ key }: { key: string }) => `[missing ${key}]`,
  });
}

/** The sample values for a key's arguments. */
const valuesFor = (args: readonly string[]): Row => Object.fromEntries(args.map(a => [a, SAMPLES[a]]));

// ---- Rendering (the providers the [locale] layout gives a client page) ----

/** Text as React writes it into HTML. */
const asHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function renderHtml(el: unknown, locale: Locale): string {
  const React = nodeRequire('react');
  const { renderToString } = nodeRequire('react-dom/server');
  const { NextIntlClientProvider } = nodeRequire('next-intl');
  const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
  const noop = () => undefined;
  const router = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop };
  // <style jsx> is styled-jsx's; without its compiler React warns about the jsx attribute.
  const error = console.error;
  console.error = (...args: unknown[]) => {
    if (!args.some(a => typeof a === 'string' && a.includes('non-boolean attribute'))) error(...args);
  };
  try {
    return renderToString(
      React.createElement(AppRouterContext.Provider, { value: router },
        React.createElement(NextIntlClientProvider, { locale, messages: messagesOf(locale), timeZone: 'Asia/Jerusalem' }, el)),
    );
  } finally {
    console.error = error;
  }
}

// ---- check-i18n-parity on fixtures ----

const tempDirs: string[] = [];

/** Writes en.json, he.json and ru.json into a fresh temp directory. */
function fixture(files: Record<Locale, Row>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-parity-'));
  tempDirs.push(dir);
  for (const locale of LOCALES) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(files[locale]));
  return dir;
}

/** Runs scripts/check-i18n-parity.ts (on messages/, or on `dir`) and returns its exit code and stdout. */
function runParity(dir?: string): { code: number | null; out: string } {
  const script = path.join(ROOT, 'scripts', 'check-i18n-parity.ts');
  const res = spawnSync(process.execPath, [nodeRequire.resolve('tsx/cli'), script, ...(dir ? [dir] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  // stdout carries the problems and the verdict; stderr only tsx's own warnings.
  return { code: res.status, out: res.stdout ?? '' };
}

const GOOD_PLURALS: Record<Locale, string> = {
  en: '{count, plural, one {# item} other {# items}}',
  he: '{count, plural, one {פריט אחד} two {שני פריטים} other {# פריטים}}',
  ru: '{count, plural, one {# пункт} few {# пункта} many {# пунктов} other {# пункта}}',
};

async function main() {
  await check('#1 calendarHome is its own top-level object in en/he/ru, right after dashboard and before admin (away from bot.errors)', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const messages = messagesOf(locale);
      const top = Object.keys(messages);
      const at = top.indexOf('calendarHome');
      if (at < 0) problems.push(`${locale}: no top-level calendarHome`);
      else if (top[at - 1] !== 'dashboard' || top[at + 1] !== 'admin') problems.push(`${locale}: calendarHome sits between ${top[at - 1]} and ${top[at + 1]}`);
      if (messages.bot && 'calendarHome' in messages.bot) problems.push(`${locale}: a calendarHome inside bot`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#2 each language holds exactly the Keys table under calendarHome: none missing, none extra', () => {
    const want = [...Object.keys(KEYS), ...ARRAY_KEYS].sort();
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const have = [...leavesOf(messagesOf(locale).calendarHome ?? {}).keys()].sort();
      const missing = want.filter(k => !have.includes(k));
      const extra = have.filter(k => !want.includes(k));
      if (missing.length) problems.push(`${locale} lacks ${missing.length}: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}`);
      if (extra.length) problems.push(`${locale} has extra: ${extra.join(', ')}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#3 every key formats through next-intl in each language with exactly its arguments: no error, nothing left unfilled, each argument shown', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, args] of Object.entries(KEYS)) {
        const errors: string[] = [];
        const t = translator(locale, errors);
        const out = t(key, valuesFor(args));
        if (errors.length) { problems.push(`${locale} ${key}: ${errors[0]}`); continue; }
        if (typeof out !== 'string' || !out.trim()) { problems.push(`${locale} ${key}: empty`); continue; }
        if (/[{}]/.test(out) || out.includes('calendarHome') || out.includes('[missing')) problems.push(`${locale} ${key}: "${out}"`);
        for (const arg of args) {
          if (arg === 'weekday') continue; // #4 runs every weekday
          if (!out.includes(String(SAMPLES[arg]))) problems.push(`${locale} ${key} never shows {${arg}}: "${out}"`);
        }
      }
    }
    assert(problems.length === 0, problems.slice(0, 8).join('; '));
  });

  await check('#4 plurals, the weekday select and the person chips read naturally (exact text in en/he/ru)', () => {
    const cases: [Locale, string, Row, string][] = [
      ['en', 'stillOpen.count', { count: 1 }, '1 reminder'],
      ['en', 'stillOpen.count', { count: 2 }, '2 reminders'],
      ['he', 'stillOpen.count', { count: 1 }, 'תזכורת אחת'],
      ['he', 'stillOpen.count', { count: 2 }, 'שתי תזכורות'],
      ['he', 'stillOpen.count', { count: 5 }, '5 תזכורות'],
      ['ru', 'stillOpen.count', { count: 1 }, '1 напоминание'],
      ['ru', 'stillOpen.count', { count: 3 }, '3 напоминания'],
      ['ru', 'stillOpen.count', { count: 5 }, '5 напоминаний'],
      ['ru', 'stillOpen.count', { count: 21 }, '21 напоминание'],
      ['en', 'stillOpen.more', { count: 3 }, '3 more'],
      ['he', 'stillOpen.more', { count: 1 }, 'ועוד אחת'],
      ['he', 'stillOpen.more', { count: 2 }, 'ועוד שתיים'],
      ['he', 'stillOpen.more', { count: 7 }, 'ועוד 7'],
      ['ru', 'stillOpen.more', { count: 7 }, 'Ещё 7'],
      ['en', 'banner.trial', { count: 1 }, '1 day left in your trial'],
      ['he', 'banner.trial', { count: 2 }, 'נשארו יומיים לתקופת הניסיון'],
      ['he', 'banner.trial', { count: 9 }, 'נשארו 9 ימים לתקופת הניסיון'],
      ['ru', 'banner.trial', { count: 1 }, 'До конца пробного периода 1 день'],
      ['ru', 'banner.trial', { count: 4 }, 'До конца пробного периода 4 дня'],
      ['ru', 'banner.trial', { count: 11 }, 'До конца пробного периода 11 дней'],
      ['en', 'state.unavailable', { count: 2 }, '2 calendars aren’t available'],
      ['he', 'state.unavailable', { count: 1 }, 'יומן אחד לא זמין'],
      ['ru', 'state.unavailable', { count: 1 }, '1 календарь недоступен'],
      ['ru', 'state.unavailable', { count: 2 }, '2 календаря недоступны'],
      ['ru', 'state.unavailable', { count: 12 }, '12 календарей недоступны'],
      ['en', 'stillOpen.sinceWeekday', { weekday: 'tue' }, 'Since Tuesday'],
      ['he', 'stillOpen.sinceWeekday', { weekday: 'sat' }, 'משבת'],
      ['ru', 'stillOpen.sinceWeekday', { weekday: 'mon' }, 'С понедельника'],
      ['ru', 'stillOpen.sinceWeekday', { weekday: 'tue' }, 'Со вторника'],
      ['ru', 'stillOpen.sinceWeekday', { weekday: 'wed' }, 'Со среды'],
      ['en', 'person.from', { name: 'Noa' }, 'From Noa'],
      ['he', 'person.for', { name: 'נועה' }, 'בשביל נועה'],
      ['ru', 'person.from', { name: 'Маша' }, 'От: Маша'],
      ['ru', 'person.for', { name: 'Маша' }, 'Кому: Маша'],
      ['he', 'agenda.nothingPlannedRange', { range: 'שבת, 17 באוק׳' }, 'אין אירועים בשבת, 17 באוק׳'],
      // The Month (E1): a cell's label parts, its "+N" and the picked day's header
      ['en', 'month.cellItems', { count: 1 }, '1 item'],
      ['en', 'month.cellItems', { count: 3 }, '3 items'],
      ['he', 'month.cellItems', { count: 1 }, 'אירוע אחד'],
      ['he', 'month.cellItems', { count: 2 }, 'שני אירועים'],
      ['he', 'month.cellItems', { count: 3 }, '3 אירועים'],
      ['ru', 'month.cellItems', { count: 1 }, '1 событие'],
      ['ru', 'month.cellItems', { count: 3 }, '3 события'],
      ['ru', 'month.cellItems', { count: 5 }, '5 событий'],
      ['ru', 'month.cellItems', { count: 21 }, '21 событие'],
      ['en', 'month.cellFromPartner', { count: 1, name: 'Noa' }, '1 from Noa'],
      ['he', 'month.cellFromPartner', { count: 1, name: 'נועה' }, '1 של נועה'],
      ['ru', 'month.cellFromPartner', { count: 1, name: 'Маша' }, 'Маша: 1'],
      ['en', 'month.more', { count: 2 }, '+2 more'],
      ['he', 'month.more', { count: 2 }, 'עוד 2'],
      ['ru', 'month.more', { count: 2 }, 'Ещё 2'],
      ['en', 'month.moreShort', { count: 4 }, '+4'],
      ['he', 'month.moreShort', { count: 4 }, '+4'],
      ['ru', 'month.moreShort', { count: 4 }, '+4'],
      ['en', 'month.dayToday', { date: 'Thursday, 15 October' }, 'Today · Thursday, 15 October'],
      ['he', 'month.dayToday', { date: 'יום חמישי, 15 באוקטובר' }, 'היום · יום חמישי, 15 באוקטובר'],
      ['ru', 'month.dayToday', { date: 'четверг, 15 октября' }, 'Сегодня · четверг, 15 октября'],
    ];
    const problems: string[] = [];
    for (const [locale, key, values, want] of cases) {
      const errors: string[] = [];
      const got = translator(locale, errors)(key, values);
      if (errors.length || got !== want) problems.push(`${locale} ${key} ${show(values)}: ${show(got)}${errors.length ? ` (${errors[0]})` : ''}, want ${show(want)}`);
    }
    for (const locale of LOCALES) {
      const errors: string[] = [];
      const t = translator(locale, errors);
      const all = WEEKDAYS.map(weekday => t('stillOpen.sinceWeekday', { weekday }));
      if (errors.length || new Set(all).size !== 7 || all.some(s => !s.trim())) problems.push(`${locale} weekdays: ${show(all)} ${errors[0] ?? ''}`);
    }
    assert(problems.length === 0, problems.slice(0, 6).join('; '));
  });

  await check('#5 hebrewMonthGenitive: 14 names in each language in D2\'s HEBREW_MONTHS order (from Tishrei), genitive in Russian (R9), read whole by t.raw', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const errors: string[] = [];
      const list = translator(locale, errors).raw('hebrewMonthGenitive');
      if (errors.length || !Array.isArray(list) || list.length !== 14 || list.some((s: unknown) => typeof s !== 'string' || !s.trim())) {
        problems.push(`${locale}: ${show(list)} ${errors[0] ?? ''}`);
      }
    }
    const en = messagesOf('en').calendarHome?.hebrewMonthGenitive;
    if (show(en) !== show(HEBREW_MONTHS)) problems.push(`en is not hebcal's names in HEBREW_MONTHS order: ${show(en)}`);
    const ru = messagesOf('ru').calendarHome?.hebrewMonthGenitive;
    if (show(ru) !== show(RU_GENITIVE)) problems.push(`ru: ${show(ru)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#6 no slash or bracket gender forms in the Hebrew or Russian copy (calendarHome and common.header)', () => {
    const problems: string[] = [];
    const rules: [Locale, RegExp][] = [
      ['he', /[א-ת]\s?\/\s?[א-ת]/],
      ['ru', /[а-яё]\/[а-яё]|\((а|ла|ась|ен|на|ы)\)/i],
    ];
    for (const [locale, gendered] of rules) {
      const messages = messagesOf(locale);
      if (!messages.calendarHome) problems.push(`${locale}: no calendarHome`);
      if (!messages.common?.header) problems.push(`${locale}: no common.header`);
      const strings = [...leavesOf(messages.calendarHome ?? {}).entries(), ...leavesOf(messages.common?.header ?? {}).entries()];
      for (const [key, value] of strings) {
        for (const s of Array.isArray(value) ? value : [value]) {
          if (typeof s === 'string' && gendered.test(s)) problems.push(`${locale} ${key}: "${s}"`);
        }
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#7 Header (Subscription, Select calendars): translated aria-labels and admin badge in en/he/ru, no English left in he/ru', async () => {
    const React = nodeRequire('react');
    const Header = (await load('components/Layout/Header.tsx')).default;
    const noop = () => undefined;
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const labels = messagesOf(locale).common?.header;
      if (!labels) { problems.push(`${locale}: no common.header`); continue; }
      const html = renderHtml(React.createElement(Header, {
        title: 'FamCal', userName: 'Dana', isAdmin: true, onBackClick: noop, onAdminClick: noop, onSettingsClick: noop,
      }), locale);
      for (const key of ['back', 'adminPanel', 'settings']) {
        if (!html.includes(`aria-label="${asHtml(labels[key])}"`)) problems.push(`${locale}: no aria-label for ${key}`);
      }
      if (!html.includes(`>${asHtml(labels.adminBadge)}</div>`)) problems.push(`${locale}: no ${labels.adminBadge} badge`);
      if (locale !== 'en') {
        for (const english of ['Go Back', 'Admin Panel', '"Settings"', '>ADMIN<']) {
          if (html.includes(english)) problems.push(`${locale}: still ${english}`);
        }
      }
      if (!html.includes('text-transform: uppercase')) problems.push(`${locale}: the badge is no longer upper-case`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#8 the dashboard loader (TelegramDashboardRedirect) says pageGate.loading in each language, not "Loading Dashboard..."', async () => {
    const React = nodeRequire('react');
    const Redirect = (await load('app/[locale]/dashboard/TelegramDashboardRedirect.tsx')).default;
    const links = { whatsapp: 'https://wa.me/972500000000?text=settings', telegram: 'https://t.me/test_bot?start=dashboard' };
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const html = renderHtml(React.createElement(Redirect, { locale, links }), locale);
      const want = messagesOf(locale).pageGate.loading;
      if (!html.includes(`>${asHtml(want)}</h2>`)) problems.push(`${locale}: no "${want}" heading in ${html.slice(0, 120)}…`);
      if (html.includes('Loading Dashboard')) problems.push(`${locale}: still "Loading Dashboard..."`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#10 check-i18n-parity passes messages/ and a fixture with well-formed plurals in each language', () => {
    const real = runParity();
    assert(real.code === 0 && /i18n parity OK \(\d+ keys\)/.test(real.out), `messages/: exit ${real.code}: ${real.out.trim().slice(-300)}`);
    const good = runParity(fixture({
      en: { x: { n: GOOD_PLURALS.en, who: 'Hi {name}' } },
      he: { x: { n: GOOD_PLURALS.he, who: 'שלום {name}' } },
      ru: { x: { n: GOOD_PLURALS.ru, who: 'Привет, {name}' } },
    }));
    assert(good.code === 0 && good.out.includes('i18n parity OK (2 keys)'), `fixture: exit ${good.code}: ${good.out.trim().slice(-300)}`);
  });

  await check('#11 check-i18n-parity fails an ICU argument renamed in one language ({n, plural} in ru where en has {count, plural})', () => {
    const res = runParity(fixture({
      en: { x: { n: GOOD_PLURALS.en } },
      he: { x: { n: GOOD_PLURALS.he } },
      ru: { x: { n: GOOD_PLURALS.ru.replace('{count,', '{n,') } },
    }));
    assert(res.code === 1 && res.out.includes('ru: x.n has arguments [n], en has [count]'), `exit ${res.code}: ${res.out.trim().slice(-300)}`);
  });

  await check('#12 check-i18n-parity fails an argument missing inside one language\'s plural forms ({name} in en, not in he)', () => {
    const res = runParity(fixture({
      en: { x: { n: '{count, plural, one {# from {name}} other {# from {name}}}' } },
      he: { x: { n: GOOD_PLURALS.he } },
      ru: { x: { n: '{count, plural, one {# от: {name}} few {# от: {name}} many {# от: {name}} other {# от: {name}}}' } },
    }));
    assert(res.code === 1 && res.out.includes('he: x.n has arguments [count], en has [count name]'), `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    assert(!res.out.includes('ru: x.n'), `ru was flagged: ${res.out.trim()}`);
  });

  await check('#13 check-i18n-parity fails a plural missing a form its language uses (ru few) or giving one it never uses (he few)', () => {
    const res = runParity(fixture({
      en: { x: { n: GOOD_PLURALS.en } },
      he: { x: { n: '{count, plural, one {פריט אחד} two {שני פריטים} few {כמה} other {# פריטים}}' } },
      ru: { x: { n: '{count, plural, one {# пункт} many {# пунктов} other {# пункта}}' } },
    }));
    assert(res.code === 1, `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    for (const line of ['ru: x.n {count, plural} lacks the "few" form', 'he: x.n {count, plural} has a "few" form, which he never uses']) {
      assert(res.out.includes(line), `no "${line}" in: ${res.out.trim().slice(-300)}`);
    }
  });

  await check('#14 check-i18n-parity fails a message ICU can\'t parse (an unclosed brace) and a select with no "other" form', () => {
    const res = runParity(fixture({
      en: { x: { n: GOOD_PLURALS.en, s: '{w, select, a {A} b {B}}' } },
      he: { x: { n: GOOD_PLURALS.he.slice(0, -1), s: '{w, select, a {א} other {ב}}' } },
      ru: { x: { n: GOOD_PLURALS.ru, s: '{w, select, a {А} other {Б}}' } },
    }));
    assert(res.code === 1, `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    for (const line of ['he: x.n is not valid ICU:', 'en: x.s {w, select} has no "other" form']) {
      assert(res.out.includes(line), `no "${line}" in: ${res.out.trim().slice(-300)}`);
    }
    assert(!/he: x\.n has arguments/.test(res.out), `an unparsable message was also compared: ${res.out.trim()}`);
  });

  await check('#15 hebrewMonthShort: 14 short names in each language in HEBREW_MONTHS order, read whole by t.raw; en and ru each the whole name or its start with a period, ru genitive, he hebcal\'s plain name', () => {
    const want: Record<Locale, readonly string[]> = { en: EN_SHORT, he: HE_SHORT, ru: RU_SHORT };
    const problems: string[] = [];
    const lists = {} as Record<Locale, unknown>;
    for (const locale of LOCALES) {
      const errors: string[] = [];
      lists[locale] = translator(locale, errors).raw('hebrewMonthShort');
      if (errors.length || show(lists[locale]) !== show(want[locale])) problems.push(`${locale}: ${show(lists[locale])} ${errors[0] ?? ''}`);
    }
    // "Chesh." cuts "Cheshvan", "хешв." cuts "хешвана"; a name short enough stays whole.
    const cutOf = (short: unknown, full: string) =>
      typeof short === 'string' && (short === full || (short.length > 1 && short.endsWith('.') && full.startsWith(short.slice(0, -1))));
    const fullNames: [Locale, readonly string[]][] = [['en', HEBREW_MONTHS], ['ru', RU_GENITIVE]];
    for (const [locale, full] of fullNames) {
      const list = lists[locale];
      if (!Array.isArray(list) || list.length !== 14) continue;
      list.forEach((short: unknown, i: number) => {
        if (!cutOf(short, full[i])) problems.push(`${locale}: ${show(short)} is neither ${full[i]} nor a cut of it`);
      });
    }
    // Hebrew: the name the Agenda's day labels use (D2's monthLabel), without nikud.
    const { Locale: HebcalLocale } = nodeRequire('@hebcal/hdate');
    const plain = HEBREW_MONTHS.map(name => HebcalLocale.lookupTranslation(name, 'he-x-NoNikud'));
    if (show(lists.he) !== show(plain)) problems.push(`he is not hebcal's plain names ${show(plain)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#16 check-i18n-parity reads bot.* the way getBotMessage fills it: each {word} is an argument, with no ICU quoting or syntax; elsewhere ICU stands', () => {
    // getBotMessage fills both {word} and {name} in "Reply '{word}' to {name}"; ICU would
    // quote {word} away. "{a, b}" isn't ICU, but getBotMessage just leaves it as it is.
    const bot = runParity(fixture({
      en: { bot: { q: "Reply '{word}' to {name}", j: 'Send {name} a list like {a, b}' } },
      he: { bot: { q: 'אפשר לענות {word} ל{name}', j: 'אפשר לשלוח ל{name} רשימה כמו {a, b}' } },
      ru: { bot: { q: 'Ответьте {word}, {name}', j: 'Отправьте {name} список вроде {a, b}' } },
    }));
    assert(bot.code === 0 && bot.out.includes('i18n parity OK (2 keys)'), `bot.*: exit ${bot.code}: ${bot.out.trim().slice(-300)}`);
    // A bot argument renamed in one language is still caught, and outside bot.* the quote holds.
    const res = runParity(fixture({
      en: { bot: { s: 'Hi {name}' }, x: { q: "Reply '{word}' to {name}" } },
      he: { bot: { s: 'היי {name}' }, x: { q: 'אפשר לענות {word} ל{name}' } },
      ru: { bot: { s: 'Привет, {nmae}' }, x: { q: 'Ответьте {word}, {name}' } },
    }));
    assert(res.code === 1, `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    for (const line of ['ru: bot.s has arguments [nmae], en has [name]', 'he: x.q has arguments [name word], en has [name]']) {
      assert(res.out.includes(line), `no "${line}" in: ${res.out.trim().slice(-300)}`);
    }
  });

  await check("#17 check-i18n-parity reads '' inside a quoted literal as one apostrophe that leaves the quote open, as next-intl does", () => {
    const quoted = "Say '{it''s}' to {name}";
    const inForm = "{count, plural, one {# note: '{it''s}'} other {# notes: '{it''s}'}}";
    const errors: string[] = [];
    const { createTranslator } = nodeRequire('next-intl');
    const t = createTranslator({ locale: 'en', messages: { q: quoted, p: inForm }, onError: (err: Error) => errors.push(err.message) });
    const shown = [t('q', { name: 'Noa' }), t('p', { count: 2 })];
    assert(!errors.length && show(shown) === show(["Say {it's} to Noa", "2 notes: {it's}"]), `next-intl: ${show(shown)} ${errors[0] ?? ''}`);
    const good = runParity(fixture({
      en: { x: { q: quoted, p: inForm } },
      he: { x: { q: 'אפשר להגיד ל{name}', p: GOOD_PLURALS.he } },
      ru: { x: { q: 'Скажите {name}', p: GOOD_PLURALS.ru } },
    }));
    assert(good.code === 0 && good.out.includes('i18n parity OK (2 keys)'), `fixture: exit ${good.code}: ${good.out.trim().slice(-300)}`);
    // A quote that never closes still fails, '' or not.
    const open = runParity(fixture({
      en: { x: { q: "Say '{it''s} to {name}" } },
      he: { x: { q: 'אפשר להגיד ל{name}' } },
      ru: { x: { q: 'Скажите {name}' } },
    }));
    assert(open.code === 1 && open.out.includes('en: x.q is not valid ICU: a quote that never closes'), `unclosed: exit ${open.code}: ${open.out.trim().slice(-300)}`);
  });

  await check('#18 check-i18n-parity lets an =N form stand in for a category that holds N alone (=1 for en and he one, =2 for he two), never for ru one', () => {
    const good = runParity(fixture({
      en: { x: { n: '{count, plural, =1 {One item} other {# items}}', d: '{count, plural, =1 {Tomorrow} other {In # days}}' } },
      he: { x: { n: '{count, plural, =1 {פריט אחד} =2 {שני פריטים} other {# פריטים}}', d: '{count, plural, =1 {מחר} =2 {מחרתיים} other {בעוד # ימים}}' } },
      ru: { x: {
        n: '{count, plural, =1 {Один пункт} one {# пункт} few {# пункта} many {# пунктов} other {# пункта}}',
        d: '{count, plural, =1 {Завтра} one {Через # день} few {Через # дня} many {Через # дней} other {Через # дня}}',
      } },
    }));
    assert(good.code === 0 && good.out.includes('i18n parity OK (2 keys)'), `fixture: exit ${good.code}: ${good.out.trim().slice(-300)}`);
    // =2 is not en one; =1 alone leaves he two; ru one also holds 21, 31, …
    const res = runParity(fixture({
      en: { x: { n: '{count, plural, =2 {Two items} other {# items}}' } },
      he: { x: { n: '{count, plural, =1 {פריט אחד} other {# פריטים}}' } },
      ru: { x: { n: '{count, plural, =1 {Один пункт} few {# пункта} many {# пунктов} other {# пункта}}' } },
    }));
    assert(res.code === 1, `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    for (const line of ['en: x.n {count, plural} lacks the "one" form', 'he: x.n {count, plural} lacks the "two" form', 'ru: x.n {count, plural} lacks the "one" form']) {
      assert(res.out.includes(line), `no "${line}" in: ${res.out.trim().slice(-300)}`);
    }
    assert(!res.out.includes('he: x.n {count, plural} lacks the "one" form'), `=1 did not stand in for he one: ${res.out.trim()}`);
  });

  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
