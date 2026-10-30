// The rows of a day's zmanim (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.1): the one drawing the
// sun sheet (app/[locale]/(app)/dashboard/ZmanimSheet.tsx) and the public city pages share, so both show the same words,
// accent and dash.
//
// - each row is the set's zman named with its opinion (zman-words.ts, the editor's words), or a window row (WINDOW_ROW_KEYS:
//   the candle lighting, the candle lighting "not before", the end of Shabbat, of Yom Tov or of both) in the accent
//   (is-key); its time in 24 hours in the list's zone, left to right inside Hebrew;
// - a zman the sun does not make that day shows a dash, with "No time this day" for a reader (is-none);
// - under the rows, the halachic hour under each opinion the set counts by, when the list has any.
//
// A plain component: no 'use client', no hooks and no next-intl import. The caller gives it calendarHome's translator
// (useTranslations in the sheet, getTranslations on a server page) and a list in the shape both the Mini App's answer
// (ZmanimListResponse) and the engine's day list have. Its CSS is ZMANIM_SHEET_CSS (src/lib/calendar-view/zmanim-sheet-css.ts).

import type { ReactElement } from 'react';
import { formatTime } from '@/src/lib/calendar-view/format';
import { zmanName, type ZmanWordsT } from '@/src/lib/calendar-view/zman-words';
import { WINDOW_ROW_KEYS, formatHalachicHour, type ZmanimListResponse, type ZmanimListRow } from '@/src/lib/calendar-view/zmanim-list';

/** What the rows read of a day's list: the zone, the rows and the hours (ZmanimListResponse and the engine's ZmanDayList both fit). */
export type ZmanimRowsList = Pick<ZmanimListResponse, 'tz' | 'rows' | 'hours'>;

export interface ZmanimRowsProps {
  list: ZmanimRowsList;
  locale: string;
  /** calendarHome's translator. */
  t: ZmanWordsT;
}

/** A row's name: a window row by its own message, any other zman by its name and opinion. */
function rowText(t: ZmanWordsT, row: ZmanimListRow): string {
  switch (row.key) {
    case 'SHABBAT_ENDS':
      return t('zmanimList.shabbatEnds');
    case 'YOM_TOV_ENDS':
      return t('zmanimList.yomTovEnds');
    case 'SHABBAT_YOM_TOV_ENDS':
      return t('zmanimList.shabbatYomTovEnds');
    case 'CANDLE_LIGHTING_NOT_BEFORE':
      return t('zmanimList.candlesNotBefore');
    default:
      return zmanName(t, row.key, row.opinion);
  }
}

export function ZmanimRows({ list, locale, t }: ZmanimRowsProps): ReactElement {
  return (
    <>
      <ul className="ch-zl-rows" role="list">
        {list.rows.map((row) => (
          <li key={row.key} className={`ch-zl-row${WINDOW_ROW_KEYS.includes(row.key) ? ' is-key' : ''}${row.at === null ? ' is-none' : ''}`} data-zman={row.key}>
            <span className="ch-zl-name">{rowText(t, row)}</span>
            <span className="ch-zl-time">
              {row.at === null ? (
                <>
                  <span aria-hidden="true">—</span>
                  <span className="ch-visually-hidden">{t('zmanimList.noTime')}</span>
                </>
              ) : (
                <bdi dir="ltr">{formatTime(row.at, list.tz, locale)}</bdi>
              )}
            </span>
          </li>
        ))}
      </ul>
      {list.hours.length > 0 ? (
        <p className="ch-zl-hours">
          {t('zmanimList.hourLabel')}{' '}
          {list.hours.map((hour) => t('zmanim.withOpinion', { name: formatHalachicHour(hour.ms), opinion: t(`zmanim.opinions.${hour.opinion}`) })).join(' · ')}
        </p>
      ) : null}
    </>
  );
}
