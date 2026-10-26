'use client';

// The Agenda's days (spec §7.3, §5 "Empty means answered"; Ruling R8), in the order
// buildAgenda gives them:
// - a day: its header ("Today" / "Tomorrow" / the weekday and date, plus the Hebrew
//   date when it's on), then its rows. With no rows: "Nothing planned" once every
//   source answered; placeholders while one is still loading; nothing when it failed
//   (the state row above the days says why). A loading day with rows adds a placeholder.
// - a fold: later empty days, answered, in one line ("Nothing planned Sat 17 – Sun 18 Oct").

import { useLocale, useTranslations } from 'next-intl';
import type { AgendaDay, AgendaEntry, AgendaRow } from '@/src/lib/calendar-view/agenda';
import { formatDayRange, formatDayShort } from '@/src/lib/calendar-view/format';
import { hebrewDayLabel } from '@/src/lib/calendar-view/hebrew-date';
import { hasChag, holidayTitles, useHolidays, type HolidayDays } from '@/src/lib/calendar-view/holidays-client';
import { ItemRow } from './ItemRow';

export interface DayListProps {
  entries: AgendaEntry[];
  tz: string;
  hebrewDates: boolean;
  onOpen: (row: AgendaRow) => void;
}

/** Grey rows that stand in for a day's items until its sources answer. */
export function PlaceholderRows({ count }: { count: number }) {
  return (
    <div className="ch-ghosts" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ch-ghost" />
      ))}
    </div>
  );
}

/** The Hebrew-date settings a day header reads: on or off, and Russian's genitive month names (Ruling R9). */
type HebrewDates = { on: boolean; genitive?: readonly string[]; holidays: HolidayDays };

function DayHeader({ day, hebrew }: { day: AgendaDay; hebrew: HebrewDates }) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const date = formatDayShort(day.date, locale);
  const hebrewLabel = hebrew.on ? hebrewDayLabel(day.date, locale, hebrew.genitive) : '';
  const holidays = hebrew.on ? hebrew.holidays[day.date] : undefined;
  const relative = day.relative === 'today' ? t('agenda.today') : day.relative === 'tomorrow' ? t('agenda.tomorrow') : null;
  return (
    <h2 className="ch-day-head" id={`ch-day-${day.date}`}>
      <span className="ch-day-label">{relative ?? date}</span>
      {relative ? (
        <>
          {' '}
          <span className="ch-day-date">{date}</span>
        </>
      ) : null}
      {hebrewLabel ? (
        <>
          {' '}
          <span className="ch-day-hebrew">{hebrewLabel}</span>
        </>
      ) : null}
      {holidays && holidays.length > 0 ? (
        <>
          {' '}
          <span className={hasChag(holidays) ? 'ch-day-holiday is-chag' : 'ch-day-holiday'}>
            <bdi>{holidayTitles(holidays)}</bdi>
          </span>
        </>
      ) : null}
    </h2>
  );
}

function Day({ day, tz, hebrew, onOpen }: { day: AgendaDay; tz: string; hebrew: HebrewDates; onOpen: DayListProps['onOpen'] }) {
  const t = useTranslations('calendarHome');
  const loading = day.status === 'loading';
  return (
    <section className="ch-day" aria-labelledby={`ch-day-${day.date}`} aria-busy={loading || undefined}>
      <DayHeader day={day} hebrew={hebrew} />
      {day.rows.length > 0 ? (
        <ul className="ch-list" role="list">
          {day.rows.map((row) => (
            <ItemRow key={row.item.key} row={row} day={day.date} tz={tz} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
      {day.rows.length === 0 && day.status === 'answered' ? <p className="ch-nothing">{t('agenda.nothingPlanned')}</p> : null}
      {loading ? <PlaceholderRows count={day.rows.length > 0 ? 1 : 2} /> : null}
    </section>
  );
}

export function DayList({ entries, tz, hebrewDates, onOpen }: DayListProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // calendarHome.hebrewMonthGenitive: 14 names in D2's HEBREW_MONTHS order; only Russian reads them.
  // The holidays of the months the listed days fall in (folds name no day).
  const months = [...new Set(entries.flatMap((entry) => (entry.type === 'fold' ? [] : [entry.date.slice(0, 7)])))];
  const holidays = useHolidays(months, locale, hebrewDates);
  const hebrew: HebrewDates = {
    on: hebrewDates,
    genitive: hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined,
    holidays,
  };
  return (
    <div className="ch-days">
      {entries.map((entry) =>
        entry.type === 'fold' ? (
          <p key={`fold-${entry.first}`} className="ch-fold">
            {t('agenda.nothingPlannedRange', { range: formatDayRange(entry.first, entry.last, locale) })}
          </p>
        ) : (
          <Day key={entry.date} day={entry} tz={tz} hebrew={hebrew} onOpen={onOpen} />
        ),
      )}
    </div>
  );
}
