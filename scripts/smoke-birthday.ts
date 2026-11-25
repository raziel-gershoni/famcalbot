// Smoke test for the Birthday switch (docs/superpowers/specs/2026-11-25-birthday-switch-design.md): the rule of what can
// be a birthday and the year a civil birthday counts from (src/lib/birthday.ts). The store, the readers, the editor and
// the screen are pinned where they are tested (smoke-calendar-editor-api, smoke-hebrew-anniversary). Pure: no DB, no network.
//   TZ=UTC npx tsx scripts/smoke-birthday.ts

import fs from 'fs';
import path from 'path';
import { createElement, type ComponentProps, type MutableRefObject } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { NativeEvent } from '@prisma/client';
import { EditorSheet } from '../app/[locale]/(app)/dashboard/EditorSheet';
import { ItemRow } from '../app/[locale]/(app)/dashboard/ItemRow';
import { ItemSheet } from '../app/[locale]/(app)/dashboard/ItemSheet';
import { AGENDA_CSS } from '../app/[locale]/(app)/dashboard/AgendaView';
import { toUnifiedEvent } from '../src/services/calendar-provider/native-provider';
import { toItemDto } from '../src/services/calendar-read/dto';
import type { ReadItem } from '../src/services/calendar-read/types';
import type { ItemDTO } from '../src/lib/calendar-view/types';
import { birthYearOf, canBeBirthday, isEveryYearRule } from '../src/lib/birthday';
import { toGoogleEvent, toGoogleHebrewSingles } from '../src/services/calendar-move/mapper';
import { createBody, editItemForm, newItemForm, scopePlan, showsBirthday, updateBody, type EditorForm } from '../src/lib/calendar-view/editor-model';
import type { ItemEditInfoResponse } from '../src/lib/calendar-view/editor-types';

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
function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

const messages = Object.fromEntries((['en', 'he', 'ru'] as const).map((l) => [l, JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${l}.json`), 'utf8'))]));
const inHome = (locale: 'en' | 'he' | 'ru', el: ReturnType<typeof createElement>) => {
  const provider = { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, createElement('div', { className: 'ch-home', 'data-theme': 'light' }, el));
};

async function main() {
  await check('isEveryYearRule: FREQ=YEARLY with no interval or interval 1, an end allowed; any other rule, or none, is not', () => {
    const cases: [string | null, boolean][] = [
      ['FREQ=YEARLY', true],
      ['FREQ=YEARLY;INTERVAL=1', true],
      ['RRULE:FREQ=YEARLY', true],
      ['FREQ=YEARLY;UNTIL=20300101T000000Z', true],
      ['FREQ=YEARLY;COUNT=5', true],
      ['FREQ=YEARLY;INTERVAL=2', false],
      ['FREQ=WEEKLY', false],
      ['FREQ=MONTHLY;INTERVAL=12', false],
      ['', false],
      [null, false],
    ];
    assertSame(cases.map(([rule]) => isEveryYearRule(rule)), cases.map(([, want]) => want), 'rules');
  });

  await check('canBeBirthday: an all-day EVENT repeating every year; not a reminder, a timed event, a one-off or another repeat', () => {
    const base = { kind: 'EVENT', allDay: true, rrule: 'FREQ=YEARLY' };
    assertSame(
      [
        canBeBirthday(base),
        canBeBirthday({ ...base, kind: 'REMINDER' }),
        canBeBirthday({ ...base, allDay: false }),
        canBeBirthday({ ...base, rrule: null }),
        canBeBirthday({ ...base, rrule: 'FREQ=DAILY' }),
        canBeBirthday({ ...base, rrule: 'FREQ=YEARLY;INTERVAL=3' }),
      ],
      [true, false, false, false, false, false],
      'shapes'
    );
  });

  await check('birthYearOf: the stored year when there is one, else the start\'s civil year in the series\' own zone (not the server\'s)', () => {
    // 3 March 1985 00:00 in Jerusalem is 2 March 22:00 UTC: the year is read where the series lives.
    const startsAt = new Date('1985-03-02T22:00:00Z');
    assertSame(birthYearOf({ birthYear: null, startsAt, timeZone: 'Asia/Jerusalem' }), 1985, 'from the start');
    // 1 January 2000 00:00 in Jerusalem is still 1999 in UTC.
    assertSame(birthYearOf({ birthYear: null, startsAt: new Date('1999-12-31T22:00:00Z'), timeZone: 'Asia/Jerusalem' }), 2000, 'a new year in the zone');
    assertSame(birthYearOf({ birthYear: 1972, startsAt, timeZone: 'Asia/Jerusalem' }), 1972, 'the stored year wins');
  });

  await check('the Google copy is unchanged by the switch: a civil birthday maps as the same series without it, and a Hebrew one\'s yearly singles too', () => {
    const base = {
      id: 's1', calendarId: 'c1', creatorUserId: 1, title: 'Dana', description: null, location: null,
      startsAt: new Date('1985-03-02T22:00:00Z'), endsAt: new Date('1985-03-03T21:59:00Z'), allDay: true, timeZone: 'Asia/Jerusalem',
      rrule: 'FREQ=YEARLY', hebrewRule: null, hebrewAnchor: null, exdates: [], ownAlerts: false, alertMinutes: [], kind: 'EVENT',
      forUserId: null, forBoth: false, eachMarksDone: false, zmanSpec: null, armedAt: null, isDeleted: false,
      createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), birthday: false, birthYear: null,
    } as NativeEvent;
    assertSame(toGoogleEvent({ ...base, birthday: true, birthYear: 1985 }, [], { exceptions: 'whole' }), toGoogleEvent(base, [], { exceptions: 'whole' }), 'civil');
    const heb = { ...base, hebrewRule: 'anniversary', hebrewAnchor: '1985-03-03' };
    const slots = [new Date('2026-03-02T22:00:00Z')];
    assertSame(toGoogleHebrewSingles({ ...heb, birthday: true }, [], slots), toGoogleHebrewSingles(heb, [], slots), 'hebrew');
  });

  // ---- The editor model (src/lib/calendar-view/editor-model.ts) ----

  const CALENDARS = [{ id: 'native:cal1', name: 'Family', color: null, main: true, mine: true }];
  const YEARLY = { freq: 'yearly' as const, interval: 1 };
  const blank = (over: Partial<EditorForm> = {}): EditorForm => ({
    ...newItemForm({ today: '2026-03-03', pickedDay: '2026-03-03', nowMs: Date.UTC(2026, 2, 3, 6), tz: 'Asia/Jerusalem', kinds: { event: true, reminder: true }, calendars: CALENDARS }),
    title: 'Dana', allDay: true, repeat: YEARLY,
    ...over,
  });
  const info = (over: Partial<ItemEditInfoResponse> = {}): ItemEditInfoResponse => ({
    kind: 'event', canEdit: true, canDelete: true,
    occurrence: { start: '2026-03-03', end: '2026-03-03', allDay: true, title: 'Dana', location: '', description: '' },
    series: { recurring: true, start: '1985-03-03', repeat: { freq: 'yearly', interval: 1, ends: false }, spec: YEARLY, fixedDays: false, zone: 'Asia/Jerusalem', rule: { choice: 'yearly' }, first: false },
    tz: 'Asia/Jerusalem', calendar: { id: 'native:cal1', name: 'Family', color: null }, forName: null,
    scopes: ['single', 'following', 'all'], alert: 'default', birthday: false, source: 'famcal',
    ...over,
  } as ItemEditInfoResponse);

  await check('showsBirthday: an all-day FamCal event repeating every year, civil or Hebrew; not timed, weekly, every two years, a one-off, a reminder or a Google calendar', () => {
    assertSame(
      [
        showsBirthday(blank()),
        showsBirthday(blank({ repeat: { freq: 'hebrew', interval: 1 } })),
        showsBirthday(blank({ allDay: false })),
        showsBirthday(blank({ repeat: { freq: 'weekly', interval: 1, byDay: ['TU'] } })),
        showsBirthday(blank({ repeat: { freq: 'yearly', interval: 2 } })),
        showsBirthday(blank({ repeat: 'none' })),
        showsBirthday(blank({ kind: 'reminder' })),
        showsBirthday(blank({ calendarId: 'avi@gmail.com' })),
      ],
      [true, true, false, false, false, false, false, false],
      'shows'
    );
  });

  await check('createBody: birthday: true only when the switch is on and shown; never false, never for a hidden switch', () => {
    assert(!('birthday' in createBody(blank())), 'off');
    assertSame(createBody(blank({ birthday: true })).birthday, true, 'on');
    assert(!('birthday' in createBody(blank({ birthday: true, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'] } }))), 'hidden under another repeat');
    assert(!('birthday' in createBody(blank({ birthday: true, allDay: false }))), 'hidden on a timed event');
  });

  await check('edit: the form reads the switch; updateBody sends it only when changed and shown; a series asks "this one and after" or "all", as the alert does', () => {
    const initial = editItemForm(info());
    assertSame([initial.birthday, editItemForm(info({ birthday: true })).birthday, editItemForm(info({ birthday: undefined })).birthday], [false, true, false], 'prefill');
    assert(updateBody(initial, initial, 'k', 'all', info()) === null, 'untouched');
    assertSame(updateBody({ ...initial, birthday: true }, initial, 'k', 'all', info())?.changes, { birthday: true }, 'on');
    const on = editItemForm(info({ birthday: true }));
    assertSame(updateBody({ ...on, birthday: false }, on, 'k', 'all', info({ birthday: true }))?.changes, { birthday: false }, 'off');
    const weekly = updateBody({ ...on, repeat: { freq: 'weekly', interval: 1, byDay: ['TU'] } }, on, 'k', 'following', info({ birthday: true }))?.changes;
    assert(weekly !== undefined && !('birthday' in weekly), `another repeat sends no switch (the server turns it off): ${show(weekly)}`);
    assertSame(scopePlan({ ...initial, birthday: true }, initial, info()), { kind: 'sheet', choices: ['following', 'all'], note: 'series' }, 'a series');
  });

  await check('editor: the Birthday switch shows under Repeat for an all-day yearly FamCal event, in en/he/ru; not for a weekly one; on a civil birthday the count hint sits under it (the Hebrew one keeps it under Repeat, once)', () => {
    const cancelRef = { current: null } as MutableRefObject<(() => void) | null>;
    const render = (locale: 'en' | 'he' | 'ru', over: Partial<EditorForm>) =>
      renderToString(inHome(locale, createElement(EditorSheet, { mode: 'create', initial: blank(over), kinds: { event: true, reminder: true }, calendars: CALENDARS, hebrewDates: true, onSave: async () => ({ ok: true }) as never, onClose: () => undefined, cancelRef })));
    const times = (html: string, text: string) => html.split(text.replace(/'/g, '&#x27;')).length - 1;
    for (const locale of ['en', 'he', 'ru'] as const) {
      const label = messages[locale].calendarHome.row.birthday as string;
      const hint = messages[locale].calendarHome.editor.repeat.hebrewCountHint as string;
      const off = render(locale, {});
      assert(times(off, `>${label}<`) === 1, `${locale}: the switch is not shown`);
      assert(times(off, hint) === 0, `${locale}: a hint with the switch off`);
      assert(times(render(locale, { birthday: true }), hint) === 1, `${locale}: no hint on a civil birthday`);
      assert(times(render(locale, { birthday: true, repeat: { freq: 'hebrew', interval: 1 } }), hint) === 1, `${locale}: the Hebrew hint twice or not at all`);
      assert(times(render(locale, { repeat: { freq: 'weekly', interval: 1, byDay: ['TU'] } }), `>${label}<`) === 0, `${locale}: shown for a weekly event`);
    }
  });

  // ---- The calendar screen: a cake before the title (ItemRow, ItemSheet) ----

  const cal = { id: 'native:c1', source: 'famcal' as const, name: 'Family', color: null, mine: true, inLegend: true };
  const occurrence = { title: 'Dana', startsAt: new Date('2026-03-02T22:00:00Z'), endsAt: new Date('2026-03-03T21:59:00Z'), allDay: true, timeZone: 'Asia/Jerusalem', seriesEventId: 's1', instanceStartsAt: new Date('2026-03-02T22:00:00Z'), isRecurringInstance: true };
  const series = { kind: 'EVENT' as const, rrule: 'FREQ=YEARLY', hebrewRule: null, hebrewAnchor: null, startsAt: new Date('1985-03-02T22:00:00Z'), timeZone: 'Asia/Jerusalem', birthYear: null };
  const dtoOf = (birthday: boolean, source: 'famcal' | 'google' = 'famcal'): ItemDTO => {
    const event = toUnifiedEvent({ id: 'c1', name: 'Family' }, occurrence, { ...series, birthday: source === 'famcal' && birthday });
    const item: ReadItem = {
      source, key: source === 'famcal' ? 'famcal|s1' : 'google|g@gmail.com|e1', event: source === 'google' && birthday ? { ...event, eventType: 'birthday' } : event, calendar: { ...cal, source },
      title: 'Dana', kind: 'event', seriesId: 's1', originalStart: event.start, recurring: true, rrule: 'FREQ=YEARLY', hebrewRule: null, hebrewAnchor: null,
      ...(source === 'google' ? { google: { birthday, htmlLink: null } } : {}),
    };
    return toItemDto(item, null, { now: new Date('2026-03-03T08:00:00Z'), open: false, openSince: null });
  };
  const rowOf = (item: ItemDTO) => ({ item, whose: { mine: true, person: null, relation: null }, mark: null });
  const renderRow = (locale: 'en' | 'he' | 'ru', item: ItemDTO) => renderToString(inHome(locale, createElement(ItemRow, { row: rowOf(item), day: '2026-03-03', tz: 'Asia/Jerusalem', onOpen: () => undefined }))).replace(/<!-- -->/g, '');
  const cakes = (html: string) => (html.match(/lucide-cake/g) ?? []).length;

  await check('row: a FamCal birthday and a Google one have the cake before the title and "Birthday" only for screen readers (no word in the meta line), in en/he/ru; a plain event has none', () => {
    for (const locale of ['en', 'he', 'ru'] as const) {
      const label = messages[locale].calendarHome.row.birthday as string;
      for (const source of ['famcal', 'google'] as const) {
        const html = renderRow(locale, dtoOf(true, source));
        assert(cakes(html) === 1, `${locale} ${source}: cakes ${cakes(html)}`);
        assert(html.indexOf('lucide-cake') < html.indexOf('>Dana'), `${locale} ${source}: the cake is not before the title`);
        assert(new RegExp(`ch-visually-hidden[^>]*>${label} <`).test(html), `${locale} ${source}: no hidden label`);
        assert(html.split(label).length - 1 === 1, `${locale} ${source}: the word shows outside the hidden label`);
      }
      const plain = renderRow(locale, dtoOf(false));
      assert(cakes(plain) === 0 && !plain.includes(label), `${locale}: a plain event`);
    }
  });

  await check('sheet: the cake before the title, and the "Birthday" tag stays', () => {
    for (const locale of ['en', 'he', 'ru'] as const) {
      const label = messages[locale].calendarHome.row.birthday as string;
      const html = renderToString(inHome(locale, createElement(ItemSheet, { row: rowOf(dtoOf(true)), today: '2026-03-03', tz: 'Asia/Jerusalem', onClose: () => undefined }))).replace(/<!-- -->/g, '');
      assert(cakes(html) === 1 && html.indexOf('lucide-cake') < html.indexOf('ch-sheet-title'), `${locale}: cake`);
      assert(/<p class="ch-sheet-tags"><span>([^<]*)<\/span>/.exec(html)?.[1].split(' · ').includes(label), `${locale}: tag`);
      const plain = renderToString(inHome(locale, createElement(ItemSheet, { row: rowOf(dtoOf(false)), today: '2026-03-03', tz: 'Asia/Jerusalem', onClose: () => undefined })));
      assert(cakes(plain) === 0, `${locale}: a plain event`);
    }
  });

  await check('CSS: the cake is muted, sized as the row\'s other icons, uses the home tokens and no physical left/right', () => {
    const block = /\.ch-icon-birthday\s*\{[^}]*\}/.exec(AGENDA_CSS)?.[0] ?? '';
    assert(/var\(--ch-muted\)/.test(block), `block ${block}`);
    assert(!/\b(left|right|margin-left|margin-right|padding-left|padding-right)\b/.test(block), 'physical sides');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
