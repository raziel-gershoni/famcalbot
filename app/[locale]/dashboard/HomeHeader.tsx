'use client';

// The calendar home's header (spec §7.2, the approved layout A): the day and, when the
// route says so, its Hebrew date ("Thursday, 15 October" over "4 Cheshvan 5787"), both
// from the server's today, never the device's clock; "Times in <zone>" when the device
// is in another zone (§7.1); and 44 px buttons: "+" (add an event or a reminder, only
// when the user can add one, home editing spec §2), Send to chat, and the ⋯ menu.
// Until the first answer the day is a placeholder bar.

import { useLocale, useTranslations } from 'next-intl';
import { daysBetween, formatDayLong } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import { hasChag, holidayTitles, monthLanded, useHolidays, useNextHoliday } from '@/src/lib/calendar-view/holidays-client';
import { zoneLabel } from '@/src/lib/calendar-view/home-client';
import type { DayKey } from '@/src/lib/calendar-view/types';

export interface HomeHeaderProps {
  /** The server's today; null until the first answer. */
  today: DayKey | null;
  hebrewDates: boolean;
  /** The zone the times are in, only when the device's zone differs; else null. */
  zone: string | null;
  sendOpen: boolean;
  menuOpen: boolean;
  onSend: () => void;
  onMenu: () => void;
  /** Opens the editor for a new item; absent when the user can add neither kind, and there is no "+". */
  onAdd?: () => void;
  addOpen?: boolean;
}

export function SendIcon() {
  return (
    <svg className="ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function HomeHeader({ today, hebrewDates, zone, sendOpen, menuOpen, onSend, onMenu, onAdd, addOpen }: HomeHeaderProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // calendarHome.hebrewMonthGenitive: only Russian reads it (Ruling R9).
  const genitive = locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const title = today ? formatDayLong(today, locale) : '';
  const hebrew = today && hebrewDates ? hebrewFullDate(today, locale, genitive) : '';
  const holidays = useHolidays(today ? [today.slice(0, 7)] : [], locale, hebrewDates)[today ?? ''];
  // On a day with no holiday line (known once the month has landed), a muted countdown to the next
  // holiday worth naming, counted in whole days from the server's today.
  const quiet = !!today && monthLanded(today.slice(0, 7), locale) && !(holidays && holidays.length > 0);
  const next = useNextHoliday(today, locale, hebrewDates && quiet);
  const away = today && next ? daysBetween(today, next.day) : Number.NaN;

  return (
    <header className="ch-head">
      <div className="ch-head-text">
        {title ? (
          <h1 className="ch-head-title">{title}</h1>
        ) : (
          <div className="ch-head-ghost" aria-hidden="true">
            <span className="ch-head-ghost-title" />
            <span className="ch-head-ghost-sub" />
          </div>
        )}
        {hebrew ? <p className="ch-head-sub">{hebrew}</p> : null}
        {holidays && holidays.length > 0 ? (
          <p className={hasChag(holidays) ? 'ch-head-sub ch-day-holiday is-chag' : 'ch-head-sub ch-day-holiday'}>
            <bdi>{holidayTitles(holidays, locale)}</bdi>
          </p>
        ) : null}
        {!holidays?.length && away >= 1 && next ? (
          <p className="ch-head-sub">
            <bdi>{away === 1 ? t('header.nextHolidayTomorrow', { name: next.name }) : t('header.nextHoliday', { name: next.name, count: away })}</bdi>
          </p>
        ) : null}
        {zone ? <p className="ch-head-zone">{t('shell.timesIn', { zone: zoneLabel(zone, locale) })}</p> : null}
      </div>
      <div className="ch-head-buttons">
        {onAdd ? (
          <button type="button" className="ch-icon-btn ch-icon-btn-accent" aria-label={t('header.add')} aria-haspopup="dialog" aria-expanded={addOpen ?? false} onClick={onAdd}>
            <PlusIcon />
          </button>
        ) : null}
        <button
          type="button"
          className="ch-icon-btn ch-icon-btn-accent"
          aria-label={t('header.send')}
          aria-haspopup="dialog"
          aria-expanded={sendOpen}
          onClick={onSend}
        >
          <SendIcon />
        </button>
        <button
          type="button"
          className="ch-icon-btn"
          aria-label={t('header.menu')}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          <MoreIcon />
        </button>
      </div>
    </header>
  );
}
