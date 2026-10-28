'use client';

// The sun sheet: today's zmanim at the person's place, opened from the sun button in the home's header (only for the
// Jewish calendar). A bottom sheet of the kit, with no new visual language:
//
// - the title, "Today's zmanim" on today and "Zmanim" on another day (the date under it always says which day), and
//   under it the place and the community's set ("Harish · Sephardi"). Without a saved place the zone stands in, with
//   the editor's note and its link to Settings;
// - the day, in the Gregorian and the Hebrew date, between two arrows: the previous day and the next. The sheet opens
//   on the home's today (the person's zone) and each arrow asks the server for that day (GET /api/zmanim) and shows a
//   loading state meanwhile, or a card that says it failed with Retry. A newer tap drops the older request's answer;
// - the rows, a plain list (no tap creates anything): the set's zmanim in the order of the day, each named with its
//   opinion (the editor's words), its time in 24 hours in the person's zone and left to right inside Hebrew. A zman the
//   sun does not make that day shows a dash. The candle lighting and the end of Shabbat or Yom Tov are in the accent:
//   the server adds them on the days they fall (the pause's windows);
// - the halachic hour at the bottom, as minutes and seconds under each opinion the set counts by.
//
// The server counts and sends instants; every word and format is here. Client component: it never imports the zmanim
// service (the list's shapes are src/lib/calendar-view/zmanim-list.ts).

import { Fragment, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDayLong, formatTime } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import { zoneLabel } from '@/src/lib/calendar-view/home-client';
import { addDaysToKey } from '@/src/lib/calendar-view/store';
import type { DayKey } from '@/src/lib/calendar-view/types';
import { formatHalachicHour, type ZmanimApi, type ZmanimListResponse, type ZmanimListRow } from '@/src/lib/calendar-view/zmanim-list';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { Notice } from '@/components/app-ui/Notice';
import { StateCard } from '@/components/app-ui/StateCard';
import { zmanName } from './zman-words';

export interface ZmanimSheetProps {
  /** The page's own user_id, as CalendarHomeProps carries it (never swapped). */
  userId: number;
  locale: string;
  /** The home's today in the person's zone: the day the sheet opens on. */
  today: DayKey;
  /** The request for a day's list: the real one, or a smoke's. */
  load: ZmanimApi['list'];
  /** The way to Settings, for the note about a place that is not saved. */
  onOpenSettings: () => void;
  onClose: () => void;
}

type Load = { status: 'loading' } | { status: 'failed' } | { status: 'ok'; list: ZmanimListResponse };

export const ZMANIM_SHEET_CSS = `
.ch-zl-place {
  margin: 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-block: 12px 4px;
}
.ch-zl-date {
  flex: 1;
  min-inline-size: 0;
  text-align: center;
}
.ch-zl-day {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
}
.ch-zl-day::first-letter {
  text-transform: uppercase;
}
.ch-zl-hebrew {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-note {
  margin-block: 8px 4px;
}
.ch-zl-note .ch-notice {
  background: var(--ch-surface);
}
.ch-zl-rows {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.ch-zl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-block-size: 44px;
  padding-block: 6px;
  border-block-end: 1px solid var(--ch-separator);
}
.ch-zl-row:last-child {
  border-block-end: 0;
}
.ch-zl-name {
  flex: 1;
  min-inline-size: 0;
  font-size: 15px;
  line-height: 1.3;
}
.ch-zl-time {
  flex: none;
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ch-zl-row.is-key .ch-zl-name,
.ch-zl-row.is-key .ch-zl-time {
  color: var(--ch-accent);
  font-weight: 600;
}
.ch-zl-row.is-none .ch-zl-time {
  color: var(--ch-muted);
  font-weight: 400;
}
.ch-zl-hours {
  margin: 12px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 280px;
  color: var(--ch-accent);
}
.ch-zl-loading svg {
  inline-size: 28px;
  block-size: 28px;
}
.ch-zl .ch-home-card {
  margin: 8px 0 0;
}
`;

/** An arrow: back (the previous day) or forward. Flipped in RTL by .ch-flip. */
function Arrow({ back }: { back: boolean }) {
  return (
    <svg className="ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={back ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="ch-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M12 3a9 9 0 1 1-9 9" />
    </svg>
  );
}

export function ZmanimSheet({ userId, locale, today, load, onOpenSettings, onClose }: ZmanimSheetProps) {
  const t = useTranslations('calendarHome');
  const [day, setDay] = useState<DayKey>(today);
  /** The day the answer in `result` is for: a newer tap leaves the older answer unread. */
  const [result, setResult] = useState<{ day: DayKey; load: Load }>({ day: today, load: { status: 'loading' } });
  /** The latest list that arrived: the place and the set stay on the sheet while the next day loads. */
  const [last, setLast] = useState<ZmanimListResponse | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The day shown is `day` at once: an answer for another day reads as loading (`current`), so nothing sets state here until one arrives.
  useEffect(() => {
    let live = true;
    load(userId, day)
      .then((out) => {
        if (!live) return;
        if (out.kind === 'ok') {
          setLast(out.list);
          setResult({ day, load: { status: 'ok', list: out.list } });
        } else setResult({ day, load: { status: 'failed' } });
      })
      .catch((error: unknown) => {
        console.error(`[zmanim-sheet] the list for ${day} could not be read:`, error);
        if (live) setResult({ day, load: { status: 'failed' } });
      });
    return () => {
      live = false;
    };
  }, [day, attempt, userId, load]);

  const retry = () => {
    setResult({ day, load: { status: 'loading' } });
    setAttempt((n) => n + 1);
  };
  const current: Load = result.day === day ? result.load : { status: 'loading' };
  const title = day === today ? t('zmanimList.title') : t('zmanimList.titleOther');
  const genitive = locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const hebrew = hebrewFullDate(day, locale, genitive);

  const rowText = (row: ZmanimListRow): string => {
    if (row.key === 'SHABBAT_ENDS') return t('zmanimList.shabbatEnds');
    if (row.key === 'YOM_TOV_ENDS') return t('zmanimList.yomTovEnds');
    return zmanName(t, row.key, row.opinion);
  };
  const isKey = (row: ZmanimListRow) => row.key === 'CANDLE_LIGHTING' || row.key === 'SHABBAT_ENDS' || row.key === 'YOM_TOV_ENDS';

  // The place and the set, from the latest list (they do not change from day to day).
  const place = last?.place ?? null;
  const placeName = place?.source === 'saved' && place.name !== '' ? place.name : last ? zoneLabel(last.tz, locale) : '';
  const settings = { label: t('editor.zmanOpenSettings'), onClick: onOpenSettings };

  return (
    <BottomSheet label={title} closeLabel={t('actions.close')} onClose={onClose}>
      <style>{ZMANIM_SHEET_CSS}</style>
      <div className="ch-zl">
        <h2 className="ch-sheet-heading">{title}</h2>
        {last && place ? (
          <p className="ch-zl-place">
            <bdi>{placeName}</bdi>
            {' · '}
            {t(`zmanimList.community.${last.community}`)}
          </p>
        ) : null}
        <div className="ch-zl-nav">
          <button type="button" className="ch-icon-btn" aria-label={t('zmanimList.previousDay')} onClick={() => setDay(addDaysToKey(day, -1))}>
            <Arrow back />
          </button>
          <div className="ch-zl-date" aria-live="polite">
            <p className="ch-zl-day">{formatDayLong(day, locale)}</p>
            {hebrew ? <p className="ch-zl-hebrew">{hebrew}</p> : null}
          </div>
          <button type="button" className="ch-icon-btn" aria-label={t('zmanimList.nextDay')} onClick={() => setDay(addDaysToKey(day, 1))}>
            <Arrow back={false} />
          </button>
        </div>
        {last && (place === null || place.source === 'zone') ? (
          <div className="ch-zl-note">
            <Notice action={settings}>{t(place === null ? 'editor.zmanNoPlace' : 'editor.zmanZoneOnly')}</Notice>
          </div>
        ) : null}
        {current.status === 'loading' ? (
          <div className="ch-zl-loading" role="status">
            <Spinner />
            <span className="ch-visually-hidden">{t('zmanimList.loading')}</span>
          </div>
        ) : null}
        {current.status === 'failed' ? (
          <StateCard title={t('zmanimList.failedTitle')} body={t('zmanimList.failedBody')} action={{ label: t('actions.retry'), onClick: retry }} />
        ) : null}
        {current.status === 'ok' ? (
          <>
            <ul className="ch-zl-rows" role="list">
              {current.list.rows.map((row) => (
                <li key={row.key} className={`ch-zl-row${isKey(row) ? ' is-key' : ''}${row.at === null ? ' is-none' : ''}`} data-zman={row.key}>
                  <span className="ch-zl-name">{rowText(row)}</span>
                  <span className="ch-zl-time">
                    {row.at === null ? (
                      <>
                        <span aria-hidden="true">—</span>
                        <span className="ch-visually-hidden">{t('zmanimList.noTime')}</span>
                      </>
                    ) : (
                      <bdi dir="ltr">{formatTime(row.at, current.list.tz, locale)}</bdi>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {current.list.hours.length > 0 ? (
              <p className="ch-zl-hours">
                {t('zmanimList.hourLabel')}{' '}
                {current.list.hours.map((hour, i) => (
                  <Fragment key={hour.opinion}>
                    {i > 0 ? ' · ' : null}
                    <bdi dir="ltr">{formatHalachicHour(hour.ms)}</bdi> ({t(`zmanim.opinions.${hour.opinion}`)})
                  </Fragment>
                ))}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </BottomSheet>
  );
}
