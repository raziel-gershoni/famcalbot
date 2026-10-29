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
//  - spec §9's fix on the old screens: the dashboard loader's "Loading Dashboard..." (the old Header, whose
//    aria-labels and admin badge it also checked, went with the Select calendars redesign);
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
  // The next-holiday countdown under the Hebrew date (count is 2 or more; tomorrow has its own line)
  'header.nextHoliday': ['name', 'count'],
  'header.nextHolidayTomorrow': ['name'],
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
  'menu.connectGoogle': [],
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
  'row.anniversary': ['n'],
  'row.googleCalendar': ['calendar'],
  // The partner's status chip on a reminder where each marks their own Done (replaces "For both of you")
  'row.partnerDone': ['name'],
  'row.partnerNotYet': ['name'],
  // Whose an item is (D5: rows, the still-open card, the item sheet), spec §7.3
  'person.from': ['name'],
  'person.for': ['name'],
  'person.both': [],
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
  'sheet.partnerDone': ['name'],
  'sheet.partnerNotDone': ['name'],
  'sheet.stateLater': [],
  'sheet.openInGoogle': [],
  // The reminder actions in the sheet (done, undo, snooze) and the notes after a tap that could not apply
  'sheet.actions.done': [],
  'sheet.actions.undo': [],
  'sheet.actions.snoozeLabel': [],
  'sheet.actions.snooze15': [],
  'sheet.actions.snooze60': [],
  'sheet.actions.snoozeTomorrow': [],
  'sheet.actionNotes.changed': [],
  'sheet.actionNotes.alreadyDone': [],
  'sheet.actionNotes.notYours': [],
  'sheet.actionNotes.failed': [],
  'sheet.actionNotes.movedLeft': ['calendar'],
  // Editing (home editing spec §2): the header's +, the sheet's pencil and Delete, the editor and the scope sheet
  'header.add': [],
  'header.zmanim': [],
  'sheet.edit': [],
  'sheet.googleOnly': [],
  'sheet.deleteEvent': [],
  'sheet.deleteReminder': [],
  'editor.titleNew': [],
  'editor.titleEdit': [],
  'editor.cancel': [],
  'editor.save': [],
  'editor.kind.label': [],
  'editor.kind.event': [],
  'editor.kind.reminder': [],
  'editor.fields.title': [],
  'editor.fields.location': [],
  'editor.fields.notes': [],
  'editor.allDay': [],
  'editor.starts': [],
  'editor.ends': [],
  'editor.startsDate': [],
  'editor.startsTime': [],
  'editor.endsDate': [],
  'editor.endsTime': [],
  'editor.when': [],
  'editor.whenDate': [],
  'editor.whenTime': [],
  'editor.atTime': [],
  'editor.atTimeHint': ['time'],
  'editor.repeat.label': [],
  'editor.repeat.none': [],
  'editor.repeat.weeklyPlain': [],
  'editor.repeat.monthlyPlain': [],
  'editor.repeat.yearlyPlain': [],
  'editor.repeat.hebrewPlain': [],
  'editor.repeat.hebrewCountHint': [],
  'editor.repeat.hebrewEvery': ['count', 'date'],
  'editor.repeat.current': ['words'],
  'editor.repeat.currentPlain': [],
  'editor.repeat.until': ['date', 'rule'],
  'editor.repeat.times': ['count', 'rule'],
  'editor.repeat.fromHere': ['date'],
  'editor.repeat.every.daily': ['count'],
  'editor.repeat.every.weekly': ['count'],
  'editor.repeat.every.monthly': ['count'],
  'editor.repeat.every.yearly': ['count'],
  'editor.repeat.done': [],
  'editor.repeat.freq.none': [],
  'editor.repeat.freq.daily': [],
  'editor.repeat.freq.weekly': [],
  'editor.repeat.freq.monthly': [],
  'editor.repeat.freq.yearly': [],
  'editor.repeat.freq.hebrew': [],
  'editor.repeat.frequencyLabel': [],
  'editor.repeat.everyLabel': [],
  'editor.repeat.unit.daily': ['count'],
  'editor.repeat.unit.weekly': ['count'],
  'editor.repeat.unit.monthly': ['count'],
  'editor.repeat.unit.yearly': ['count'],
  'editor.repeat.fewer': [],
  'editor.repeat.more': [],
  'editor.repeat.daysLabel': [],
  'editor.repeat.startDayKept': [],
  'editor.repeat.monthlyLabel': [],
  'editor.repeat.monthOnDay': ['day'],
  'editor.repeat.monthOnNth': ['day', 'ord', 'ordinal'],
  'editor.repeat.dayShort': ['weekday'],
  'editor.repeat.dayLong': ['weekday'],
  'editor.repeat.dayOn': ['weekday'],
  'editor.repeat.dayNth': ['weekday'],
  'editor.repeat.gender': ['weekday'],
  'editor.repeat.ordinal': ['g', 'ord'],
  'editor.repeat.weeklyOn': ['count', 'days', 'n'],
  'editor.repeat.monthlyDay': ['count', 'day'],
  'editor.repeat.monthlyNth': ['count', 'day', 'g', 'ord', 'ordinal'],
  'editor.repeat.yearlyOn': ['count', 'date'],
  'editor.repeat.endsLabel': [],
  'editor.repeat.endsNever': [],
  'editor.repeat.endsOn': [],
  'editor.repeat.endsAfter': [],
  'editor.repeat.endsOnRow': [],
  'editor.repeat.endsDate': [],
  'editor.repeat.afterLabel': [],
  'editor.repeat.timesUnit': ['count'],
  'editor.alert.label': [],
  'editor.alert.default': ['lead'],
  'editor.alert.none': [],
  'editor.alert.atStart': [],
  'editor.alert.atStartInline': [],
  'editor.alert.before': ['unit', 'count'],
  'editor.alert.fromGoogle': ['lead'],
  'editor.dayMoveAlone': [],
  'editor.moveAlone': [],
  'editor.move.alertsFollow': [],
  'editor.move.partnerSees': [],
  'editor.move.reasons.meet': [],
  'editor.move.reasons.hebrew': [],
  'editor.move.reasons.repeat': [],
  'editor.calendar': [],
  'editor.partnerCalendar': ['calendar', 'name'],
  'editor.forLabel': [],
  'editor.forMe': [],
  'editor.forBoth': [],
  'editor.eachMarksDone': [],
  'editor.eachMarksDoneHint': [],
  // Reminders by zman (zmanim reminders plan, Task 3): the editor's rows and the zmanim names, opinions and rule phrases.
  'editor.byZman': [],
  'editor.byZmanHint': [],
  'editor.zmanLabel': [],
  'editor.zmanHoursLabel': [],
  'editor.zmanHoursUnit': ['count'],
  'editor.zmanHoursLess': [],
  'editor.zmanHoursMore': [],
  'editor.zmanOffsetLabel': [],
  'editor.zmanOffsetUnit': ['count'],
  'editor.zmanOffsetLess': [],
  'editor.zmanOffsetMore': [],
  'editor.zmanDirection': [],
  'editor.zmanBefore': [],
  'editor.zmanAfter': [],
  'editor.zmanToday': [],
  'editor.zmanNoneToday': [],
  'editor.zmanNoPlace': [],
  'editor.zmanZoneOnly': [],
  'editor.zmanOpenSettings': [],
  'zmanim.names.ALOT': [],
  'zmanim.names.MISHEYAKIR': [],
  'zmanim.names.NETZ': [],
  'zmanim.names.SOF_SHMA_MGA': [],
  'zmanim.names.SOF_SHMA_GRA': [],
  'zmanim.names.SOF_TFILA': [],
  'zmanim.names.CHATZOT': [],
  'zmanim.names.MINCHA_GEDOLA': [],
  'zmanim.names.MINCHA_KETANA': [],
  'zmanim.names.PLAG_HALACHA_BERURA': [],
  'zmanim.names.PLAG_YALKUT_YOSEF': [],
  'zmanim.names.PLAG_GRA': [],
  'zmanim.names.CANDLE_LIGHTING': [],
  'zmanim.names.SHKIA': [],
  'zmanim.names.TZEIT': [],
  'zmanim.names.TZEIT_LECHUMRA': [],
  'zmanim.names.CHATZOT_HALAYLA': [],
  'zmanim.namesAfter.ALOT': [],
  'zmanim.namesAfter.MISHEYAKIR': [],
  'zmanim.namesAfter.NETZ': [],
  'zmanim.namesAfter.SOF_SHMA_MGA': [],
  'zmanim.namesAfter.SOF_SHMA_GRA': [],
  'zmanim.namesAfter.SOF_TFILA': [],
  'zmanim.namesAfter.CHATZOT': [],
  'zmanim.namesAfter.MINCHA_GEDOLA': [],
  'zmanim.namesAfter.MINCHA_KETANA': [],
  'zmanim.namesAfter.PLAG_HALACHA_BERURA': [],
  'zmanim.namesAfter.PLAG_YALKUT_YOSEF': [],
  'zmanim.namesAfter.PLAG_GRA': [],
  'zmanim.namesAfter.CANDLE_LIGHTING': [],
  'zmanim.namesAfter.SHKIA': [],
  'zmanim.namesAfter.TZEIT': [],
  'zmanim.namesAfter.TZEIT_LECHUMRA': [],
  'zmanim.namesAfter.CHATZOT_HALAYLA': [],
  'zmanim.opinions.gra': [],
  'zmanim.opinions.mga': [],
  'zmanim.opinions.halachaBerura': [],
  'zmanim.opinions.yalkutYosef': [],
  'zmanim.opinions.baalHatanya': [],
  'zmanim.withOpinion': ['name', 'opinion'],
  'zmanim.hoursName': [],
  'zmanim.hours': ['count'],
  'zmanim.hoursAfter': ['count'],
  'zmanim.before': ['minutes', 'name'],
  'zmanim.after': ['minutes', 'name'],
  'zmanimList.title': [],
  'zmanimList.titleOther': [],
  'zmanimList.previousDay': [],
  'zmanimList.nextDay': [],
  'zmanimList.community.sephardi': [],
  'zmanimList.community.ashkenazi': [],
  'zmanimList.community.chabad': [],
  'zmanimList.shabbatEnds': [],
  'zmanimList.yomTovEnds': [],
  'zmanimList.shabbatYomTovEnds': [],
  'zmanimList.candlesNotBefore': [],
  'zmanimList.noTime': [],
  'zmanimList.hourLabel': [],
  'zmanimList.loading': [],
  'zmanimList.failedTitle': [],
  'zmanimList.failedBody': [],
  'editor.forName': ['name'],
  'editor.errors.errTitle': [],
  'editor.errors.errTitleLong': ['max'],
  'editor.errors.errTooLong': [],
  'editor.errors.errDate': [],
  'editor.errors.errEnd': [],
  'editor.errors.errField': [],
  'editor.errors.errYear': [],
  'editor.errors.errSeriesYear': [],
  'editor.errors.errRepeat': [],
  'editor.errors.errRepeatEnd': [],
  // The date and time sheets (editor upgrades spec §1).
  'picker.gregorian': [],
  'picker.hebrew': [],
  'picker.today': [],
  'picker.done': [],
  'picker.chooseMonth': [],
  'picker.year': [],
  'picker.prevMonth': [],
  'picker.nextMonth': [],
  'picker.hour': [],
  'picker.minute': [],
  'editor.submitErrors.notAllowed': [],
  'editor.submitErrors.changed': [],
  'editor.submitErrors.failed': [],
  'editor.submitErrors.busy': [],
  'editor.submitErrors.reconnect': [],
  'editor.submitErrors.moveFailed': [],
  'editor.discard.title': [],
  'editor.discard.confirm': [],
  'editor.discard.keep': [],
  'scope.save.event': [],
  'scope.save.reminder': [],
  'scope.save.ask': [],
  'scope.delete.event': [],
  'scope.delete.reminder': [],
  'scope.delete.ask': [],
  'scope.single': ['date'],
  'scope.following': [],
  'scope.all': [],
  'scope.everyDay': [],
  'scope.everyWeekday': ['weekday'],
  'scope.cancel': [],
  'scope.confirmDelete': ['title'],
  'scope.deleteConfirm': [],
  'scope.dayMoveNote': [],
  'scope.seriesNote': [],
  'scope.crossKindNote': [],
  // Drag to move (editor upgrades spec §4)
  'drag.moved': ['date'],
  'drag.undo': [],
  'drag.undone': [],
  'drag.cantMove': [],
  'drag.cantMoveDaily': [],
  'drag.failed': [],
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
  n: 5,
  opinion: 'GRA',
  minutes: 10,
  weekday: 'tue',
  ordinal: 'second',
  days: 'Sun and Tue',
  g: 'm',
  ord: '2',
  lead: '15 min before',
  unit: 'minute',
  words: 'Every day',
  rule: 'Every week',
  day: 20,
  max: 200,
  title: 'Swimming',
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
  await check('#1 calendarHome is its own top-level object in en/he/ru, right after feedback (the place the dashboard namespace had before W1b moved its feedback keys to a top-level feedback) and before admin (away from bot.errors)', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const messages = messagesOf(locale);
      const top = Object.keys(messages);
      const at = top.indexOf('calendarHome');
      if (at < 0) problems.push(`${locale}: no top-level calendarHome`);
      else if (top[at - 1] !== 'feedback' || top[at + 1] !== 'admin') problems.push(`${locale}: calendarHome sits between ${top[at - 1]} and ${top[at + 1]}`);
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
          if (arg === 'weekday' || arg === 'unit') continue; // #4 runs every weekday; a unit only picks the wording (smoke-event-alerts.ts)
          // The Repeat sheet's selectors only pick a word (a gender, an ordinal, how many days), and a unit's number is the stepper's own.
          if (arg === 'g' || arg === 'ord' || (arg === 'n' && key === 'editor.repeat.weeklyOn') || (arg === 'count' && /\.unit\.|timesUnit|zman(Hours|Offset)Unit/.test(key))) continue;
          if (!out.includes(String(SAMPLES[arg]))) problems.push(`${locale} ${key} never shows {${arg}}: "${out}"`);
        }
      }
    }
    assert(problems.length === 0, problems.slice(0, 8).join('; '));
  });

  await check('#4 plurals, the weekday select and the person chips read naturally (exact text in en/he/ru)', () => {
    const cases: [Locale, string, Row, string][] = [
      ['en', 'row.anniversary', { n: 1 }, '1 year'],
      ['en', 'row.anniversary', { n: 36 }, '36 years'],
      ['he', 'row.anniversary', { n: 1 }, 'שנה'],
      ['he', 'row.anniversary', { n: 2 }, 'שנתיים'],
      ['he', 'row.anniversary', { n: 36 }, '36 שנים'],
      ['ru', 'row.anniversary', { n: 1 }, '1 год'],
      ['ru', 'row.anniversary', { n: 22 }, '22 года'],
      ['ru', 'row.anniversary', { n: 35 }, '35 лет'],
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

  await check('#6 no slash or bracket gender forms in the Hebrew or Russian copy (calendarHome)', () => {
    const problems: string[] = [];
    const rules: [Locale, RegExp][] = [
      ['he', /[א-ת]\s?\/\s?[א-ת]/],
      ['ru', /[а-яё]\/[а-яё]|\((а|ла|ась|ен|на|ы)\)/i],
    ];
    for (const [locale, gendered] of rules) {
      const messages = messagesOf(locale);
      if (!messages.calendarHome) problems.push(`${locale}: no calendarHome`);
      const strings = [...leavesOf(messages.calendarHome ?? {}).entries()];
      for (const [key, value] of strings) {
        for (const s of Array.isArray(value) ? value : [value]) {
          if (typeof s === 'string' && gendered.test(s)) problems.push(`${locale} ${key}: "${s}"`);
        }
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#8 the dashboard loader (TelegramDashboardRedirect) says pageGate.loading in each language, not "Loading Dashboard..."', async () => {
    const React = nodeRequire('react');
    const Redirect = (await load('app/[locale]/(app)/dashboard/TelegramDashboardRedirect.tsx')).default;
    const links = { whatsapp: 'https://wa.me/972500000000?text=settings', telegram: 'https://t.me/test_bot?start=dashboard' };
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const html = renderHtml(React.createElement(Redirect, { locale, links }), locale);
      const want = messagesOf(locale).pageGate.loading;
      // The app loader (PageGate's, the dashboard's own) says it to a screen reader in its status
      if (!html.includes(`<div class="ch-loader" role="status">`) || !html.includes(`<span class="ch-visually-hidden">${asHtml(want)}</span>`)) problems.push(`${locale}: no "${want}" in the loader's status in ${html.slice(0, 120)}…`);
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

  await check('#19 the editor and scope copy reads naturally (exact text in en/he/ru): the repeat choices (weekday select, ordinal day), the repeat text with its plurals, the scope choices and the delete question', () => {
    const cases: [Locale, string, Row, string][] = [
      // The Repeat sheet's words (editor upgrades spec §3): a weekly list, the day of the month, the n-th weekday with its gender, every N.
      ['en', 'editor.repeat.weeklyOn', { count: 1, n: 1, days: 'Tuesday' }, 'Every week on Tuesday'],
      ['en', 'editor.repeat.weeklyOn', { count: 2, n: 2, days: 'Sun and Tue' }, 'Every 2 weeks on Sun and Tue'],
      ['he', 'editor.repeat.weeklyOn', { count: 1, n: 1, days: 'יום שלישי' }, 'כל שבוע ביום שלישי'],
      ['he', 'editor.repeat.weeklyOn', { count: 2, n: 2, days: 'א׳ וג׳' }, 'כל שבועיים בימים א׳ וג׳'],
      ['ru', 'editor.repeat.weeklyOn', { count: 1, n: 1, days: 'во вторник' }, 'Каждую неделю, во вторник'],
      ['ru', 'editor.repeat.weeklyOn', { count: 2, n: 2, days: 'вс и вт' }, 'Каждые 2 недели, по вс и вт'],
      ['en', 'editor.repeat.monthlyDay', { count: 1, day: 1 }, 'Every month on the 1st'],
      ['en', 'editor.repeat.monthlyDay', { count: 3, day: 22 }, 'Every 3 months on the 22nd'],
      ['en', 'editor.repeat.monthlyDay', { count: 1, day: 3 }, 'Every month on the 3rd'],
      ['en', 'editor.repeat.monthlyDay', { count: 1, day: 11 }, 'Every month on the 11th'],
      ['he', 'editor.repeat.monthlyDay', { count: 1, day: 20 }, 'כל חודש ב-20'],
      ['ru', 'editor.repeat.monthlyDay', { count: 1, day: 20 }, 'Каждый месяц, 20-го числа'],
      ['ru', 'editor.repeat.monthlyDay', { count: 2, day: 20 }, 'Каждые 2 месяца, 20-го числа'],
      ['en', 'editor.repeat.monthOnNth', { ord: '2', ordinal: 'second', day: 'Tuesday' }, 'On the second Tuesday'],
      ['he', 'editor.repeat.monthOnNth', { ord: '2', ordinal: 'השני', day: 'יום שלישי' }, 'ביום שלישי השני בכל חודש'],
      ['ru', 'editor.repeat.monthOnNth', { ord: '2', ordinal: 'вторую', day: 'среду' }, 'Во вторую среду'],
      ['ru', 'editor.repeat.monthOnNth', { ord: 'last', ordinal: 'последнюю', day: 'среду' }, 'В последнюю среду'],
      ['ru', 'editor.repeat.monthOnNth', { ord: '5', ordinal: 'пятый', day: 'четверг' }, 'В пятый четверг'],
      ['he', 'editor.repeat.endsOnRow', {}, 'תאריך סיום'],
      ['en', 'editor.repeat.monthOnDay', { day: 14 }, 'On day 14'],
      ['he', 'editor.repeat.monthOnDay', { day: 14 }, 'ב-14 בחודש'],
      ['ru', 'editor.repeat.monthOnDay', { day: 14 }, '14-го числа'],
      ['en', 'editor.repeat.times', { rule: 'Every day', count: 1 }, 'Every day, once'],
      ['en', 'editor.repeat.times', { rule: 'Every day', count: 5 }, 'Every day, 5 times'],
      ['he', 'editor.repeat.times', { rule: 'כל יום', count: 1 }, 'כל יום, פעם אחת'],
      ['he', 'editor.repeat.times', { rule: 'כל יום', count: 2 }, 'כל יום, פעמיים'],
      ['he', 'editor.repeat.times', { rule: 'כל יום', count: 5 }, 'כל יום, 5 פעמים'],
      ['ru', 'editor.repeat.times', { rule: 'Каждый день', count: 1 }, 'Каждый день, 1 раз'],
      ['ru', 'editor.repeat.times', { rule: 'Каждый день', count: 3 }, 'Каждый день, 3 раза'],
      ['ru', 'editor.repeat.times', { rule: 'Каждый день', count: 5 }, 'Каждый день, 5 раз'],
      ['ru', 'editor.repeat.times', { rule: 'Каждый день', count: 21 }, 'Каждый день, 21 раз'],
      ['en', 'editor.repeat.unit.weekly', { count: 1 }, 'week'],
      ['en', 'editor.repeat.unit.weekly', { count: 3 }, 'weeks'],
      ['ru', 'editor.repeat.unit.weekly', { count: 1 }, 'неделю'],
      ['ru', 'editor.repeat.unit.weekly', { count: 2 }, 'недели'],
      ['ru', 'editor.repeat.unit.weekly', { count: 5 }, 'недель'],
      ['ru', 'editor.repeat.unit.daily', { count: 21 }, 'день'],
      ['ru', 'editor.repeat.timesUnit', { count: 1 }, 'раз'],
      ['ru', 'editor.repeat.timesUnit', { count: 2 }, 'раза'],
      ['ru', 'editor.repeat.timesUnit', { count: 5 }, 'раз'],
      ['en', 'editor.repeat.yearlyOn', { count: 1, date: '20 Oct' }, 'Every year on 20 Oct'],
      ['en', 'editor.repeat.yearlyOn', { count: 2, date: '20 Oct' }, 'Every 2 years on 20 Oct'],
      ['he', 'editor.repeat.yearlyOn', { count: 1, date: '20 באוק׳' }, 'כל שנה ב-20 באוק׳'],
      ['ru', 'editor.repeat.yearlyOn', { count: 2, date: '20 окт.' }, 'Каждые 2 года, 20 окт.'],
      // Hebrew-date repeats (hebrew-repeats spec §4): the date is hebrewDayLabel's, in gematriya in Hebrew.
      ['en', 'editor.repeat.hebrewEvery', { count: 1, date: '15 Sh\'vat' }, 'Every year on 15 Sh\'vat'],
      ['he', 'editor.repeat.hebrewEvery', { count: 1, date: 'ט״ו בשבט' }, 'כל שנה בט״ו בשבט'],
      ['ru', 'editor.repeat.hebrewEvery', { count: 1, date: '15 швата' }, 'Каждый год 15 швата'],
      ['en', 'editor.repeat.hebrewPlain', {}, 'Every year on the Hebrew date'],
      ['he', 'editor.repeat.hebrewPlain', {}, 'כל שנה לפי התאריך העברי'],
      ['ru', 'editor.repeat.hebrewPlain', {}, 'Каждый год по еврейской дате'],
      ['en', 'editor.repeat.hebrewEvery', { count: 2, date: '15 Sh\'vat' }, 'Every 2 years on 15 Sh\'vat'],
      ['he', 'editor.repeat.hebrewEvery', { count: 2, date: 'ט״ו בשבט' }, 'כל שנתיים בט״ו בשבט'],
      ['he', 'editor.repeat.hebrewEvery', { count: 3, date: 'ט״ו בשבט' }, 'כל 3 שנים בט״ו בשבט'],
      ['ru', 'editor.repeat.hebrewEvery', { count: 2, date: '15 швата' }, 'Каждые 2 года 15 швата'],
      ['ru', 'editor.repeat.hebrewEvery', { count: 21, date: '15 швата' }, 'Каждые 21 год 15 швата'],
      ['en', 'editor.repeat.current', { words: 'Every Tuesday' }, 'Current: Every Tuesday'],
      ['he', 'editor.repeat.current', { words: 'כל יום שלישי' }, 'החזרה הנוכחית: כל יום שלישי'],
      ['ru', 'editor.repeat.current', { words: 'Каждый вторник' }, 'Сейчас: Каждый вторник'],
      // The date and time sheets (editor upgrades spec §1): Hebrew nouns and infinitives, Russian formal.
      ['en', 'picker.done', {}, 'Done'],
      ['he', 'picker.done', {}, 'אישור'],
      ['ru', 'picker.done', {}, 'Готово'],
      ['he', 'picker.today', {}, 'היום'],
      ['he', 'picker.hour', {}, 'שעה'],
      ['he', 'picker.minute', {}, 'דקות'],
      ['ru', 'picker.chooseMonth', {}, 'Выберите месяц'],
      ['he', 'picker.chooseMonth', {}, 'בחירת חודש'],
      ['en', 'editor.errors.errYear', {}, 'Only one-time and yearly items can start before the year 2000'],
      ['he', 'editor.errors.errYear', {}, 'רק פריט חד-פעמי או שנתי יכול להתחיל לפני שנת 2000'],
      ['ru', 'editor.errors.errYear', {}, 'Раньше 2000 года могут начинаться только разовые и ежегодные записи'],
      // An "All" move that would start the series outside its years (editor upgrades spec §1): no addressee in Hebrew.
      ['en', 'editor.errors.errSeriesYear', {}, 'Moving all of them would make the series start too early'],
      ['he', 'editor.errors.errSeriesYear', {}, 'העברת כל המופעים תגרום לסדרה להתחיל מוקדם מדי'],
      ['ru', 'editor.errors.errSeriesYear', {}, 'Если перенести все, серия начнётся слишком рано'],
      ['en', 'editor.repeat.until', { rule: 'Every day', date: '27 Oct' }, 'Every day, until 27 Oct'],
      ['he', 'editor.repeat.until', { rule: 'כל יום', date: '27 באוק׳' }, 'כל יום, עד 27 באוק׳'],
      ['ru', 'editor.repeat.until', { rule: 'Каждый день', date: '27 окт.' }, 'Каждый день, до 27 окт.'],
      ['en', 'editor.repeat.fromHere', { date: '20 Oct' }, 'From 20 Oct on. Earlier ones stay as they were.'],
      ['he', 'editor.repeat.fromHere', { date: '20 באוק׳' }, 'החל מ-20 באוק׳. המופעים הקודמים נשארים כפי שהיו.'],
      ['ru', 'editor.repeat.fromHere', { date: '20 окт.' }, 'С 20 окт. и дальше. Предыдущие остаются как были.'],
      ['en', 'editor.repeat.every.weekly', { count: 2 }, 'Every 2 weeks'],
      ['he', 'editor.repeat.every.weekly', { count: 2 }, 'כל שבועיים'],
      ['he', 'editor.repeat.every.daily', { count: 3 }, 'כל 3 ימים'],
      ['ru', 'editor.repeat.every.daily', { count: 2 }, 'Каждые 2 дня'],
      ['ru', 'editor.repeat.every.monthly', { count: 5 }, 'Каждые 5 месяцев'],
      ['ru', 'editor.repeat.every.yearly', { count: 3 }, 'Каждые 3 года'],
      ['ru', 'editor.repeat.every.weekly', { count: 1 }, 'Каждую неделю'],
      // Russian `one` also matches 21, 31, 101: only a count of exactly 1 reads as the singular.
      ['ru', 'editor.repeat.every.daily', { count: 21 }, 'Каждые 21 день'],
      ['ru', 'editor.repeat.every.weekly', { count: 21 }, 'Каждые 21 неделю'],
      ['ru', 'editor.repeat.every.monthly', { count: 31 }, 'Каждые 31 месяц'],
      ['ru', 'editor.repeat.every.yearly', { count: 21 }, 'Каждые 21 год'],
      ['ru', 'editor.repeat.every.daily', { count: 1 }, 'Каждый день'],
      ['en', 'scope.single', { date: 'Tue 20 Oct' }, 'Only this one (Tue 20 Oct)'],
      ['en', 'drag.moved', { date: 'Thu, 15 Oct' }, 'Moved to Thu, 15 Oct'],
      ['he', 'drag.moved', { date: 'חמישי 15 באוק׳' }, 'הועבר ליום חמישי 15 באוק׳'],
      ['ru', 'drag.moved', { date: 'чт, 15 окт.' }, 'Перенесено на чт, 15 окт.'],
      ['en', 'scope.everyWeekday', { weekday: 'tue' }, 'Every Tuesday'],
      ['he', 'scope.everyWeekday', { weekday: 'tue' }, 'כל יום שלישי'],
      ['ru', 'scope.everyWeekday', { weekday: 'tue' }, 'Каждый вторник'],
      ['ru', 'scope.everyWeekday', { weekday: 'sun' }, 'Каждое воскресенье'],
      ['en', 'scope.confirmDelete', { title: 'Swimming' }, 'Delete “Swimming”?'],
      ['he', 'scope.confirmDelete', { title: 'שחייה' }, 'למחוק את ״שחייה״?'],
      ['ru', 'scope.confirmDelete', { title: 'Плавание' }, 'Удалить «Плавание»?'],
      ['en', 'editor.atTimeHint', { time: '09:00' }, 'Without a time, the reminder arrives at 09:00'],
    ];
    const problems: string[] = [];
    for (const [locale, key, values, want] of cases) {
      const errors: string[] = [];
      const got = translator(locale, errors)(key, values);
      if (errors.length || got !== want) problems.push(`${locale} ${key} ${show(values)}: ${show(got)} (want ${show(want)})`);
    }
    assert(problems.length === 0, problems.slice(0, 6).join('; '));
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
