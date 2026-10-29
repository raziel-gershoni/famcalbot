'use client';

// The calendar home's header (spec §7.2, the approved layout A): the day and, when the
// route says so, its Hebrew date ("Thursday, 15 October" over "4 Cheshvan 5787"), both
// from the server's today, never the device's clock; "Times in <zone>" when the device
// is in another zone (§7.1); and 44 px buttons: "+" (add an event or a reminder, only
// when the user can add one, home editing spec §2), Send to chat, the sun (today's zmanim, only for the Jewish
// calendar) and the ⋯ menu. Until the first answer the day is a placeholder bar.

import { useLocale, useTranslations } from 'next-intl';
import { daysBetween, formatDayLong, shabbatOf } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import { hasChag, holidayTitles, isPortion, monthLanded, useHolidays, useNextHoliday } from '@/src/lib/calendar-view/holidays-client';
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
  /** Opens the zmanim sheet; absent for anyone but the Jewish calendar (and before the first answer), and there is no sun. */
  onZmanim?: () => void;
  zmanimOpen?: boolean;
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

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
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

export function HomeHeader({ today, hebrewDates, zone, sendOpen, menuOpen, onSend, onMenu, onAdd, addOpen, onZmanim, zmanimOpen }: HomeHeaderProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // calendarHome.hebrewMonthGenitive: only Russian reads it (Ruling R9).
  const genitive = locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const title = today ? formatDayLong(today, locale) : '';
  const hebrew = today && hebrewDates ? hebrewFullDate(today, locale, genitive) : '';
  // This week's parasha (and its special Shabbat) on the Hebrew date's line, all week: the portions of
  // the first Saturday on or after today, which may fall in next month. They are no holiday: they
  // never make the holiday line and never hide the countdown.
  const shabbat = today ? shabbatOf(today) : null;
  const months = today ? [...new Set([today.slice(0, 7), (shabbat ?? today).slice(0, 7)])] : [];
  const loaded = useHolidays(months, locale, hebrewDates);
  const todays = loaded[today ?? ''];
  const holidays = todays?.filter((h) => !isPortion(h));
  const portions = (shabbat ? loaded[shabbat] : undefined)?.filter(isPortion) ?? [];
  // On a day with no holiday line (known once the month has landed), a muted countdown to the next
  // holiday worth naming, counted in whole days from the server's today, on the Hebrew date's line.
  const quiet = !!today && monthLanded(today.slice(0, 7), locale) && !(holidays && holidays.length > 0);
  const next = useNextHoliday(today, locale, hebrewDates && quiet);
  const away = today && next ? daysBetween(today, next.day) : Number.NaN;
  const countdown = !holidays?.length && away >= 1 && next
    ? (away === 1 ? t('header.nextHolidayTomorrow', { name: next.name }) : t('header.nextHoliday', { name: next.name, count: away }))
    : '';

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
        {hebrew ? (
          <p className="ch-head-sub ch-head-line">
            {hebrew}
            {portions.map((portion) => <span key={portion.kind} className="ch-head-next"><bdi>{portion.title}</bdi></span>)}
            {countdown ? <span className="ch-head-next"><bdi>{countdown}</bdi></span> : null}
          </p>
        ) : null}
        {holidays && holidays.length > 0 ? (
          <p className={hasChag(holidays) ? 'ch-head-sub ch-day-holiday is-chag' : 'ch-head-sub ch-day-holiday'}>
            <bdi>{holidayTitles(holidays)}</bdi>
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
        {onZmanim ? (
          <button type="button" className="ch-icon-btn" aria-label={t('header.zmanim')} aria-haspopup="dialog" aria-expanded={zmanimOpen ?? false} onClick={onZmanim}>
            <SunIcon />
          </button>
        ) : null}
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
