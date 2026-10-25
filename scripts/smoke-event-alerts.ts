// Smoke test for the per-event alert (editor upgrades spec §2), the pure parts: the shared
// lead list and its helpers (src/lib/calendar-view/alert-leads.ts), the editor model's
// request bodies and scope plan (editor-model.ts), the server's body parsing (validate.ts),
// the copy in three languages, and the migration's SQL. The store, the pass and the routes
// are in smoke-calendar-editor-api.ts, smoke-reminders.ts and smoke-google-write.ts.
// No network, no DB.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';
import {
  ALERT_LEADS,
  MAX_LEAD_MINUTES,
  alertChoiceOf,
  alertColumns,
  defaultLeadOf,
  leadParts,
  nearestReminderLead,
  normalizeOverrides,
  parseAlertChoice,
} from '../src/lib/calendar-view/alert-leads';
import { createBody, editItemForm, isDirty, newItemForm, scopePlan, updateBody, type EditorForm } from '../src/lib/calendar-view/editor-model';
import type { ItemEditInfoResponse } from '../src/lib/calendar-view/editor-types';
import { parseCreate, parseUpdate } from '../src/services/calendar-write/validate';

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
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);
function same(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// ---- The shared list ----

check('the lead list: at start, 5, 10, 15, 30 min, 1 h, 2 h, 1 day; the longest is the pass\'s MAX_LEAD_MINUTES, defined once', () => {
  same([...ALERT_LEADS], [0, 5, 10, 15, 30, 60, 120, 1440], 'leads');
  assert(MAX_LEAD_MINUTES === 1440 && ALERT_LEADS[ALERT_LEADS.length - 1] === MAX_LEAD_MINUTES, 'the longest lead is the cap');
  const pass = read('src/services/reminders.ts');
  assert(/MAX_LEAD_MINUTES[^\n]*from '\.\.\/lib\/calendar-view\/alert-leads'/.test(pass) && !/const MAX_LEAD_MINUTES/.test(pass), 'reminders.ts takes the cap from alert-leads.ts');
});

check('parseAlertChoice: default, none and the listed leads only', () => {
  for (const ok of ['default', 'none', ...ALERT_LEADS]) assert(parseAlertChoice(ok) === ok, `${show(ok)} refused`);
  for (const bad of [7, 45, 2880, -5, 1.5, NaN, '30', 'Default', '', null, undefined, true, {}, []]) assert(parseAlertChoice(bad) === null, `${show(bad)} accepted`);
});

check('columns and back: default is (false, []), none (true, []), a lead (true, [lead]); an off-list stored lead reads as itself', () => {
  same(alertColumns('default'), { ownAlerts: false, alertMinutes: [] }, 'default');
  same(alertColumns('none'), { ownAlerts: true, alertMinutes: [] }, 'none');
  same(alertColumns(0), { ownAlerts: true, alertMinutes: [0] }, 'at start is an own lead, not none');
  for (const c of ['default', 'none', ...ALERT_LEADS] as const) same(alertChoiceOf(alertColumns(c)), c, `round trip ${c}`);
  assert(alertChoiceOf({ ownAlerts: true, alertMinutes: [45] }) === 45, 'migrated');
  assert(alertChoiceOf({ ownAlerts: false, alertMinutes: [30] }) === 'default', 'minutes without ownAlerts are ignored');
});

check('leadParts: days when divisible by 1440, hours by 60, else minutes; defaultLeadOf: the user\'s lead, else at start', () => {
  same([0, 5, 15, 60, 90, 120, 1440, 2880].map(leadParts), [
    { unit: 'minute', count: 0 }, { unit: 'minute', count: 5 }, { unit: 'minute', count: 15 }, { unit: 'hour', count: 1 }, { unit: 'minute', count: 90 },
    { unit: 'hour', count: 2 }, { unit: 'day', count: 1 }, { unit: 'day', count: 2 },
  ], 'parts');
  same([defaultLeadOf({ defaultReminderMinutes: 15 }), defaultLeadOf({ defaultReminderMinutes: 0 }), defaultLeadOf({ defaultReminderMinutes: null }), defaultLeadOf({})], [15, 0, 0, 0], 'default lead');
});

check('nearestReminderLead: the nearest popup, else the nearest email, else null (the pass and the item info share it)', () => {
  assert(nearestReminderLead([{ method: 'popup', minutes: 1440 }, { method: 'popup', minutes: 30 }]) === 30, 'popups');
  assert(nearestReminderLead([{ method: 'email', minutes: 60 }, { method: 'email', minutes: 10 }]) === 10, 'emails');
  assert(nearestReminderLead([{ method: 'email', minutes: 5 }, { method: 'popup', minutes: 120 }]) === 120, 'a popup beats a nearer email');
  assert(nearestReminderLead([]) === null && nearestReminderLead(undefined) === null, 'none');
  assert(nearestReminderLead(normalizeOverrides([{ method: 'email', minutes: 30 }, { minutes: 90 }])) === 90, 'a missing method is a popup (one normalisation for the fetch, the pass and the item info)');
  same(normalizeOverrides([{}, { method: 'email', minutes: null }]), [{ method: 'popup', minutes: 0 }, { method: 'email', minutes: 0 }], 'missing minutes are 0');
  assert(normalizeOverrides(undefined) === undefined, 'no overrides');
  assert(read('src/services/calendar.ts').includes('normalizeOverrides(') && read('src/services/calendar-write/google-item.ts').includes('normalizeOverrides('), 'both use it');
  const pass = read('src/services/reminders.ts');
  const info = read('src/services/calendar-write/google-item.ts');
  assert(pass.includes('nearestReminderLead(') && info.includes('nearestReminderLead('), 'both call the one function');
});

// ---- The editor model ----

const CALENDARS = [{ id: 'native:cal1', name: 'Family', color: null, main: true, mine: true }];
const blank = (over: Partial<EditorForm> = {}): EditorForm => ({
  ...newItemForm({ today: '2026-10-20', pickedDay: '2026-10-20', nowMs: Date.UTC(2026, 9, 20, 6), tz: 'Asia/Jerusalem', kinds: { event: true, reminder: true }, calendars: CALENDARS }),
  title: 'Dentist',
  ...over,
});

const info = (over: Partial<ItemEditInfoResponse> = {}): ItemEditInfoResponse => ({
  kind: 'event', canEdit: true, canDelete: true,
  occurrence: { start: '2026-10-27T10:00', end: '2026-10-27T11:00', allDay: false, title: 'Dentist', location: '', description: '' },
  series: { recurring: true, start: '2026-10-20T10:00', repeat: { freq: 'weekly', interval: 1, byDay: [], ends: false }, fixedDays: false, zone: 'Asia/Jerusalem', rule: { choice: 'weekly' }, first: false },
  tz: 'Asia/Jerusalem', calendar: { id: 'native:cal1', name: 'Family', color: null }, forName: null,
  scopes: ['single', 'following', 'all'], alert: 'default', source: 'famcal',
  ...over,
});

check('createBody: the default and an all-day event leave the alert out; a timed FamCal event sends it; a Google calendar and a reminder do not', () => {
  assert(!('alert' in createBody(blank())), 'default');
  same(createBody(blank({ alert: 15 })).alert, 15, 'a lead');
  same(createBody(blank({ alert: 'none' })).alert, 'none', 'none');
  same(createBody(blank({ alert: 0 })).alert, 0, 'at start');
  assert(!('alert' in createBody(blank({ alert: 15, allDay: true }))), 'all-day');
  assert(!('alert' in createBody(blank({ alert: 15, calendarId: 'avi@gmail.com' }))), 'a Google calendar');
  assert(!('alert' in createBody(blank({ alert: 15, kind: 'reminder' }))), 'a reminder');
});

check('updateBody: alert goes only when changed (and not for a reminder or while all-day)', () => {
  const initial = editItemForm(info({ alert: 15 }));
  assert(updateBody(initial, initial, 'k', 'all') === null, 'untouched');
  same(updateBody({ ...initial, alert: 'none' }, initial, 'k', 'all')?.changes, { alert: 'none' }, 'changed alone');
  same(updateBody({ ...initial, alert: 'default', title: 'x' }, initial, 'k', 'all')?.changes, { title: 'x', alert: 'default' }, 'with another change');
  assert(updateBody({ ...initial, alert: 30, allDay: true }, { ...initial }, 'k', 'all')?.changes.alert === undefined, 'all-day: no alert in the body');
  const reminder = editItemForm(info({ kind: 'reminder' }));
  assert(updateBody({ ...reminder, alert: 30 }, reminder, 'k', 'all') === null, 'a reminder');
  assert(editItemForm(info({ alert: 45 })).alert === 45, 'an off-list stored lead prefills as it is');
  assert(editItemForm(info({ alert: undefined })).alert === 'default', 'an older server');
  const kept = editItemForm(info({ alert: 45 }));
  assert(updateBody({ ...kept, title: 'x' }, kept, 'k', 'all')?.changes.alert === undefined, 'an off-list lead is kept unless another is picked');
});

check('isDirty: picking another alert is an edit (Cancel asks to discard)', () => {
  const initial = editItemForm(info({ alert: 15 }));
  assert(!isDirty(initial, initial) && isDirty({ ...initial, alert: 'none' }, initial), 'alert');
});

check('scopePlan: an alert change alone on a series asks "this one and after" or "all"; a one-off asks nothing; with a fixed-days day move it is refused', () => {
  const initial = editItemForm(info());
  same(scopePlan({ ...initial, alert: 10 }, initial, info()), { kind: 'sheet', choices: ['following', 'all'], note: 'series' }, 'a series');
  const oneOff = info({ series: { ...info().series, recurring: false, repeat: null, rule: { choice: 'none' } }, scopes: ['single'] });
  same(scopePlan({ ...initial, alert: 10 }, initial, oneOff).kind, 'none', 'a one-off');
  same(scopePlan({ ...initial, alert: 10, allDay: true }, { ...initial }, info()).kind === 'sheet', true, 'all-day is its own change (a time change)');
  const fixed = info({ series: { ...info().series, fixedDays: true } });
  same(scopePlan({ ...initial, alert: 10, startDay: '2026-10-28', endDay: '2026-10-28' }, initial, fixed), { kind: 'refuse', note: 'dayMoveAlone' }, 'a day move on fixed days');
  const google = { ...initial, calendarId: 'avi@gmail.com', alert: 10 };
  same(scopePlan(google, initial, info()), { kind: 'refuse', note: 'moveAlone' }, 'a cross-kind move with an alert change');
});

// ---- The server's body parsing ----

const create = (over: Record<string, unknown>) => parseCreate({ kind: 'event', title: 'x', allDay: false, start: '2026-10-20T10:00', ...over });

check('parseCreate: alert is default, none or a listed lead on an event; anything else, or any alert on a reminder, names the field', () => {
  for (const alert of ['default', 'none', ...ALERT_LEADS]) {
    const r = create({ alert });
    assert(r.ok && r.value.alert === alert, `${show(alert)}: ${show(r)}`);
  }
  assert(create({}).ok && !('alert' in (create({}) as { value: object }).value), 'omitted');
  for (const alert of [7, '30', null, true, 2880]) same(create({ alert }), { ok: false, field: 'alert' }, show(alert));
  same(parseCreate({ kind: 'reminder', title: 'x', allDay: false, start: '2026-10-20T10:00', alert: 'default' }), { ok: false, field: 'alert' }, 'reminder');
});

check('parseUpdate: changes.alert follows the same list and names the field', () => {
  const key = 'famcal|abc';
  for (const alert of ['default', 'none', 5, 1440]) {
    const r = parseUpdate({ key, scope: 'all', changes: { alert } });
    assert(r.ok && r.value.changes.alert === alert, show(r));
  }
  for (const alert of [7, '30', null, false, {}]) same(parseUpdate({ key, scope: 'all', changes: { alert } }), { ok: false, field: 'alert' }, show(alert));
});

// ---- Copy ----

check('copy: the Alert row\'s words in en, he and ru read by the lead (minutes, hours, days, plurals), and the three files have the same keys', () => {
  const want: Record<string, Record<number, string>> = {
    en: { 5: '5 min before', 15: '15 min before', 60: '1 hour before', 120: '2 hours before', 1440: '1 day before' },
    he: { 1: 'דקה אחת לפני', 5: '5 דקות לפני', 60: 'שעה לפני', 120: 'שעתיים לפני', 180: '3 שעות לפני', 1440: 'יום לפני', 2880: 'יומיים לפני' },
    ru: { 1: 'за 1 минуту', 5: 'за 5 минут', 22: 'за 22 минуты', 60: 'за 1 час', 120: 'за 2 часа', 300: 'за 5 часов', 1440: 'за 1 день', 2880: 'за 2 дня' },
  };
  const keys: string[][] = [];
  for (const lang of ['en', 'he', 'ru']) {
    const alert = JSON.parse(read(`messages/${lang}.json`)).calendarHome.editor.alert as Record<string, string>;
    keys.push(Object.keys(alert).sort());
    for (const [minutes, text] of Object.entries(want[lang])) {
      const parts = leadParts(Number(minutes));
      const got = new IntlMessageFormat(alert.before, lang).format(parts);
      assert(got === text, `${lang} ${minutes}: ${show(got)} (want ${show(text)})`);
    }
  }
  same(keys[1], keys[0], 'he keys');
  same(keys[2], keys[0], 'ru keys');
  same(keys[0], ['atStart', 'atStartInline', 'before', 'default', 'fromGoogle', 'label', 'none'], 'keys');
  const en = JSON.parse(read('messages/en.json')).calendarHome.editor.alert as Record<string, string>;
  assert(new IntlMessageFormat(en.default, 'en').format({ lead: '15 min before' }) === 'Default (15 min before)', 'default');
  assert(new IntlMessageFormat(en.default, 'en').format({ lead: en.atStartInline }) === 'Default (at start)', 'default at start');
  assert(new IntlMessageFormat(en.fromGoogle, 'en').format({ lead: '30 min before' }) === 'From Google Calendar: 30 min before', 'from Google');
});

check('copy: Hebrew names Google as the home does and None says what is off; a row\'s label keeps its word and a long value wraps to two lines', () => {
  const he = JSON.parse(read('messages/he.json')).calendarHome.editor.alert as Record<string, string>;
  assert(he.fromGoogle === 'לפי יומן Google: {lead}' && he.none === 'ללא התראה', `${he.fromGoogle} / ${he.none}`);
  for (const lang of ['en', 'he', 'ru']) {
    const note = JSON.parse(read(`messages/${lang}.json`)).calendarHome.scope.seriesNote as string;
    assert(lang === 'en' ? /alert/.test(note) : lang === 'he' ? /התראה/.test(note) : /уведомлен/.test(note), `${lang} seriesNote does not name the alert: ${note}`);
  }
  const kit = read('app/[locale]/dashboard/form-kit.tsx');
  assert(/\.ch-form-label \{[^}]*min-inline-size: min-content/.test(kit), 'label floor');
  assert(/\.ch-form-value-text \{[^}]*-webkit-line-clamp: 2/.test(kit), 'value wraps to two lines');
});

// ---- The migration ----

check('migration event_alerts: adds both columns if missing, copies a non-null reminderMinutes once, drops nothing', () => {
  const dir = path.join(ROOT, 'prisma/migrations');
  const name = readdirSync(dir).find((n) => n.endsWith('_event_alerts'));
  assert(!!name, 'no migration');
  const sql = read(`prisma/migrations/${name}/migration.sql`);
  const code = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n');
  assert(/ADD COLUMN IF NOT EXISTS "alertMinutes" INTEGER\[\] NOT NULL DEFAULT ARRAY\[\]::INTEGER\[\]/.test(code), 'alertMinutes');
  assert(/ADD COLUMN IF NOT EXISTS "ownAlerts" BOOLEAN NOT NULL DEFAULT false/.test(code), 'ownAlerts');
  assert(/SET "alertMinutes" = ARRAY\["reminderMinutes"\], "ownAlerts" = true/.test(code), 'the copy');
  assert(/WHERE "reminderMinutes" IS NOT NULL AND "ownAlerts" = false/.test(code), 'only rows not already copied');
  assert(!/DROP/i.test(code), 'the old column is dropped by a later migration');
  assert(/NOT dropped|not dropped/i.test(sql), 'the header explains the deferred drop');
  const schema = read('prisma/schema.prisma');
  assert(/ownAlerts\s+Boolean\s+@default\(false\)/.test(schema) && /alertMinutes\s+Int\[\]\s+@default\(\[\]\)/.test(schema), 'the schema has them');
  assert(/reminderMinutes Int\? \/\/ UNUSED/.test(schema), 'reminderMinutes stays, marked unused');
  const walk = (d: string): string[] =>
    readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) return walk(rel);
      return /\.(ts|tsx)$/.test(e.name) && /\.reminderMinutes\b|\breminderMinutes\??:/.test(read(rel)) ? [rel] : [];
    });
  const readers = [...walk('src'), ...walk('app')];
  // The only mention left is the mapper's default NativeEvent object, which fills the column's type.
  same(readers, ['src/services/calendar-move/mapper.ts'], 'nothing reads or writes the old column');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
