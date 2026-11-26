'use client';

// The Month's day panel (spec 2026-11-19 §2, plan Task 5): the selected day's list, moved out of
// release 1's tapped-day screen into the one Month screen (the wide panel and the split's list). From top to bottom inside one scroller: `top` (the
// banners and the unavailable row, spec §1), the day's header ("Today · Thursday, 15 October" or the
// weekday and date, the Hebrew date, the holiday line), the Daf Yomi line, a state row per source
// that failed on the day (`notices`, picked's words: "Couldn't load this month" with Retry, busy,
// calendars gone with Choose again; the month's pill may be off screen), the rows (LiftableRow: an
// item lifted from the list to move it), "Nothing planned" once the day is answered and empty, and
// placeholders while it loads.
//
// `peek` (the month grown): the scroller cannot scroll and is inert (its rows under the button take
// no focus, so tabbing never scrolls it), and one transparent button over the whole panel, named
// "Show the month smaller", calls onPeek on a tap anywhere on it.
// Renders AGENDA_CSS once: the Agenda is not mounted on the Month tab.

import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { AgendaRow } from '@/src/lib/calendar-view/agenda';
import { noticeCopy, type MonthNotice } from '@/src/lib/calendar-view/month';
import { formatDayLong } from '@/src/lib/calendar-view/format';
import { hebrewDayLabel } from '@/src/lib/calendar-view/hebrew-date';
import { hasChag, holidayTitles, useHolidays } from '@/src/lib/calendar-view/holidays-client';
import type { DayStatus } from '@/src/lib/calendar-view/store';
import type { DayKey, SourceName } from '@/src/lib/calendar-view/types';
import { AGENDA_CSS, StateRow } from './AgendaView';
import { DafYomiLine } from './DafYomiLine';
import { PlaceholderRows } from './DayList';
import { ItemRow, useItemTitle, type ItemRowProps } from './ItemRow';
import { useItemDrag } from './DragSurface';

export interface DayPanelProps {
  day: DayKey;
  today: DayKey;
  tz: string;
  hebrewDates: boolean;
  /** Show the day's Daf Yomi page under the header. */
  dafYomi?: boolean;
  rows: AgendaRow[];
  status: DayStatus;
  /** Rendered first inside the scroller: banners and the unavailable row. */
  top?: ReactNode;
  /** The sources that failed on the day (dayNotices), each a state row with its action. */
  notices?: readonly MonthNotice[];
  /** Retry on a failed row: the container asks the day's month again for that source. */
  onRetry?: (source: SourceName) => void;
  /** Choose again on a calendars-gone row. */
  onChooseCalendars?: () => void;
  /** The month is grown: the list is a peek that cannot scroll, and a tap on it calls onPeek. */
  peek?: boolean;
  onPeek?: () => void;
  onOpenItem: (row: AgendaRow) => void;
}

/** A row of the day's list, lifted from that day (drag to move; the Agenda's rows never are, so the library stays in the Month's chunk). */
function LiftableRow(props: ItemRowProps) {
  const { item } = props.row;
  const title = useItemTitle(item);
  const lift = useItemDrag({ key: item.key, title, canEdit: item.canEdit, repeatsEveryDay: item.repeatsEveryDay }, props.day);
  return <ItemRow {...props} lift={lift} />;
}

const NO_NOTICES: readonly MonthNotice[] = [];

export function DayPanel({ day, today, tz, hebrewDates, dafYomi, rows, status, top, notices = NO_NOTICES, onRetry, onChooseCalendars, peek, onPeek, onOpenItem }: DayPanelProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const genitive = hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const date = formatDayLong(day, locale);
  const dayTitle = day === today ? t('month.dayToday', { date }) : date;
  const dayHebrew = hebrewDates ? hebrewDayLabel(day, locale, genitive) : '';
  const dayHolidays = useHolidays([day.slice(0, 7)], locale, hebrewDates)[day];
  const loading = status === 'loading';

  return (
    <section className="ch-dp" dir={locale === 'he' ? 'rtl' : 'ltr'} aria-labelledby="ch-dp-day" aria-busy={loading || undefined}>
      <style>{AGENDA_CSS}</style>
      <style>{DAY_PANEL_CSS}</style>
      <div className={peek ? 'ch-dp-scroller is-peek' : 'ch-dp-scroller'} inert={peek || undefined}>
        {top}
        <h3 className="ch-dp-day" id="ch-dp-day">
          <span className="ch-dp-day-label">{dayTitle}</span>
          {dayHebrew ? (
            <>
              {' '}
              <span className="ch-dp-day-hebrew">{dayHebrew}</span>
            </>
          ) : null}
          {dayHolidays && dayHolidays.length > 0 ? (
            <>
              {' '}
              <span className={hasChag(dayHolidays) ? 'ch-day-holiday is-chag' : 'ch-day-holiday'}>
                <bdi>{holidayTitles(dayHolidays)}</bdi>
              </span>
            </>
          ) : null}
        </h3>
        {dafYomi ? <DafYomiLine day={day} /> : null}
        {notices.length > 0 ? (
          <div className="ch-states">
            {notices.map((notice) => {
              const copy = noticeCopy(notice);
              return (
                <StateRow
                  key={`${notice.kind}-${notice.source}`}
                  text={t(copy.text)}
                  action={t(copy.action)}
                  onAction={() => (copy.chooseAgain ? onChooseCalendars?.() : onRetry?.(notice.source))}
                />
              );
            })}
          </div>
        ) : null}
        {rows.length > 0 ? (
          <ul className="ch-list" role="list">
            {rows.map((row) => (
              <LiftableRow key={row.item.key} row={row} day={day} tz={tz} onOpen={onOpenItem} />
            ))}
          </ul>
        ) : null}
        {rows.length === 0 && status === 'answered' ? <p className="ch-dp-nothing">{t('agenda.nothingPlanned')}</p> : null}
        {loading ? <PlaceholderRows count={rows.length > 0 ? 1 : 2} /> : null}
      </div>
      {peek ? <button type="button" className="ch-dp-peek" aria-label={t('month.showSmaller')} onClick={onPeek} /> : null}
    </section>
  );
}

/** The panel's styles (picked's day header and nothing-planned rows, renamed); AGENDA_CSS supplies the rows and the placeholders. */
export const DAY_PANEL_CSS = `
.ch-dp {
  position: relative;
  display: flex;
  flex-direction: column;
  min-block-size: 0;
  block-size: 100%;
}
.ch-dp-scroller {
  flex: 1;
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-block-end: calc(24px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
}
.ch-dp-scroller.is-peek {
  overflow: hidden;
}
.ch-dp-peek {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.ch-dp-day {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  margin-block: 16px 2px;
  margin-inline: 16px;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.35;
}
.ch-dp-day-label {
  font-weight: 600;
}
.ch-dp-day-label::first-letter {
  text-transform: uppercase;
}
.ch-dp-day-hebrew {
  color: var(--ch-muted);
}
.ch-dp-nothing {
  margin-block: 8px 0;
  margin-inline: 16px;
  padding: 14px;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-muted);
  font-size: 14px;
}
`;
