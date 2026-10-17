'use client';

// One Agenda row (spec §7.3): the time or "All day", the title, and a meta line (the
// span, the reminder's kind and state, the location or note, the person chip, and
// "Google · <calendar>" for Google items). A tap opens the item sheet.
//
// - Times are in the route's tz, 24-hour, and set dir="ltr"; titles and names are
//   isolated (dir="auto" / <bdi>), so Hebrew and English mix cleanly.
// - Reminder state is an icon plus text, never colour alone: an open circle and "Open";
//   a check, the title struck through and "done"; an open circle and an "until <time>"
//   badge while snoozed; a bell for later ones.
// - The person chip carries the partner's name (Ruling R7): "From Noa", "For Noa", or
//   the bare name on a partner's event. Calendar ids never reach the markup.

import { Fragment } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AgendaRow, ReminderMark, Whose } from '@/src/lib/calendar-view/agenda';
import type { DayKey, ItemDTO } from '@/src/lib/calendar-view/types';
import { allDayLastDay, formatDayShort, formatTime, formatWeekdayTime, instantDay } from '@/src/lib/calendar-view/format';

export interface ItemRowProps {
  row: AgendaRow;
  /** The day the row is listed on (its span and times are read for this day). */
  day: DayKey;
  tz: string;
  onOpen: (row: AgendaRow) => void;
}

/** The reminder's icon (decorative: the state is also in text beside it). */
export function ReminderIcon({ mark }: { mark: ReminderMark }) {
  if (mark === 'done') {
    return (
      <svg className="ch-icon ch-icon-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.5 2.5L16 9.5" />
      </svg>
    );
  }
  if (mark === 'later') {
    return (
      <svg className="ch-icon ch-icon-later" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </svg>
    );
  }
  // open and snoozed: an open circle (a snoozed one adds its "until" badge in the meta line)
  return (
    <svg className="ch-icon ch-icon-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

/** The person chip's text, or null for the viewer's own item. */
export function usePersonText(whose: Whose): string | null {
  const t = useTranslations('calendarHome');
  if (!whose.person) return null;
  if (whose.relation === 'from') return t('person.from', { name: whose.person });
  if (whose.relation === 'for') return t('person.for', { name: whose.person });
  return whose.person;
}

export function PersonChip({ whose }: { whose: Whose }) {
  const text = usePersonText(whose);
  if (!text) return null;
  return (
    <span className="ch-chip" dir="auto">
      {text}
    </span>
  );
}

/** The item's title, or "(No title)". */
export function useItemTitle(item: ItemDTO): string {
  const t = useTranslations('calendarHome');
  return item.title && item.title.trim() !== '' ? item.title : t('row.noTitle');
}

/** The first non-empty line of a plain-text description. */
function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line ? line.trim() : null;
}

/** A snooze or an end shown on `day`: its time, or its weekday and time when it falls on another day. */
function timeOn(value: string | null, day: DayKey, tz: string, locale: string): string {
  return instantDay(value, tz) === day ? formatTime(value, tz, locale) : formatWeekdayTime(value, tz, locale);
}

export function ItemRow({ row, day, tz, onOpen }: ItemRowProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const { item, whose, mark } = row;
  const title = useItemTitle(item);

  // The time column: what happens on this day.
  let main: string;
  let mainIsTime = false;
  let sub: string | null = null;
  if (item.allDay || item.span === 'spansDay') {
    main = t('row.allDay');
  } else if (item.span === 'continues') {
    main = t('row.until', { when: formatTime(item.end, tz, locale) });
  } else {
    main = formatTime(item.start, tz, locale);
    mainIsTime = true;
    if (item.span !== 'endsLater' && Date.parse(item.end) > Date.parse(item.start)) sub = formatTime(item.end, tz, locale);
  }

  // The meta line's text, joined with " · ".
  const segments: { text: string; user?: boolean }[] = [];
  if (item.span === 'endsLater') {
    const when = item.allDay ? formatDayShort(allDayLastDay(item), locale) : timeOn(item.end, day, tz, locale);
    segments.push({ text: t('row.until', { when }) });
  } else if (item.span === 'spansDay') {
    segments.push({ text: t('row.continues') });
  }
  if (item.kind === 'reminder') {
    segments.push({ text: t('row.reminder') });
    if (mark === 'done') segments.push({ text: t('row.done') });
    if (item.repeatsDaily) segments.push({ text: t('row.everyDay') });
    else if (item.recurring) segments.push({ text: t('row.repeats') });
  }
  if (item.birthday) segments.push({ text: t('row.birthday') });
  const note = item.location && item.location.trim() !== '' ? item.location.trim() : firstLine(item.description);
  if (note) segments.push({ text: note, user: true });

  const snoozeTime = mark === 'snoozed' ? timeOn(item.reminder?.snoozedUntil ?? null, day, tz, locale) : '';
  const hasMeta = mark === 'open' || segments.length > 0 || !!snoozeTime || !!whose.person || item.source === 'google';

  return (
    <li className="ch-row-li">
      <button type="button" className={`ch-row ch-tap${mark === 'done' ? ' is-done' : ''}`} onClick={() => onOpen(row)}>
        <span className="ch-time">
          <span className="ch-time-main" dir={mainIsTime ? 'ltr' : undefined}>
            {main}
          </span>
          {sub ? (
            <span className="ch-time-sub" dir="ltr">
              {sub}
            </span>
          ) : null}
        </span>
        <span className="ch-body">
          <span className="ch-title-line">
            {mark ? <ReminderIcon mark={mark} /> : null}
            <span className="ch-title" dir="auto">
              {title}
            </span>
          </span>
          {hasMeta ? (
            <span className={`ch-meta${mark ? ' ch-indent' : ''}`}>
              {mark === 'open' ? <span className="ch-open">{t('row.open')}</span> : null}
              {segments.length > 0 ? (
                <span className="ch-meta-text">
                  {segments.map((s, i) => (
                    <Fragment key={i}>
                      {i > 0 ? ' · ' : null}
                      {s.user ? <bdi>{s.text}</bdi> : s.text}
                    </Fragment>
                  ))}
                </span>
              ) : null}
              {snoozeTime ? (
                <>
                  <span className="ch-badge" aria-hidden="true">
                    {t('row.snoozedUntil', { time: snoozeTime })}
                  </span>
                  <span className="ch-visually-hidden">{t('row.snoozedLabel', { time: snoozeTime })}</span>
                </>
              ) : null}
              <PersonChip whose={whose} />
              {item.source === 'google' ? (
                <span className="ch-chip ch-chip-outline" dir="auto">
                  {t('row.googleCalendar', { calendar: item.calendar.name })}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
