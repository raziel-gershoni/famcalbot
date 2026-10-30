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
//   the server adds them on the days they fall (the rest-day blocks, WINDOW_ROW_KEYS; the pause itself begins at the
//   eve's sunset, the plain sunset row, 20 minutes after the candle lighting), among them the candle lighting
//   "not before" the day's own end on a rest day inside a longer window and "Shabbat and Yom Tov end" on a Saturday that
//   is also a Yom Tov;
// - the halachic hour at the bottom, as minutes and seconds under each opinion the set counts by.
//
// The server counts and sends instants; every word and format is here, and the rows and the hour line are ZmanimRows
// (components/app-ui/ZmanimRows.tsx, shared with the public city pages). Client component: it never imports the zmanim
// service (the list's shapes are src/lib/calendar-view/zmanim-list.ts). Its CSS lives in
// src/lib/calendar-view/zmanim-sheet-css.ts and is re-exported here.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { formatDayLong } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import { zoneLabel } from '@/src/lib/calendar-view/home-client';
import { addDaysToKey } from '@/src/lib/calendar-view/store';
import type { DayKey } from '@/src/lib/calendar-view/types';
import type { ZmanimApi, ZmanimListResponse } from '@/src/lib/calendar-view/zmanim-list';
import { ZMANIM_SHEET_CSS } from '@/src/lib/calendar-view/zmanim-sheet-css';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { Notice } from '@/components/app-ui/Notice';
import { StateCard } from '@/components/app-ui/StateCard';
import { ZmanimRows } from '@/components/app-ui/ZmanimRows';

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

export { ZMANIM_SHEET_CSS };

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
            <ChevronLeft className="ch-flip" aria-hidden="true" />
          </button>
          <div className="ch-zl-date" aria-live="polite">
            <p className="ch-zl-day">{formatDayLong(day, locale)}</p>
            {hebrew ? <p className="ch-zl-hebrew">{hebrew}</p> : null}
          </div>
          <button type="button" className="ch-icon-btn" aria-label={t('zmanimList.nextDay')} onClick={() => setDay(addDaysToKey(day, 1))}>
            <ChevronRight className="ch-flip" aria-hidden="true" />
          </button>
        </div>
        {last && (place === null || place.source === 'zone') ? (
          <div className="ch-zl-note">
            <Notice action={settings}>{t(place === null ? 'editor.zmanNoPlace' : 'editor.zmanZoneOnly')}</Notice>
          </div>
        ) : null}
        {current.status === 'loading' ? (
          <div className="ch-zl-loading" role="status">
            <Loader2 size={28} className="ch-spin" aria-hidden="true" />
            <span className="ch-visually-hidden">{t('zmanimList.loading')}</span>
          </div>
        ) : null}
        {current.status === 'failed' ? (
          <StateCard title={t('zmanimList.failedTitle')} body={t('zmanimList.failedBody')} action={{ label: t('actions.retry'), onClick: retry }} />
        ) : null}
        {current.status === 'ok' ? <ZmanimRows list={current.list} locale={locale} t={t} /> : null}
      </div>
    </BottomSheet>
  );
}
