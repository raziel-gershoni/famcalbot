import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDayFull, formatMonthTitle, formatWeekdayHeader } from '@/src/lib/calendar-view/format';
import { weekdayOrder } from '@/src/lib/calendar-view/grid';
import { hebrewCellLabel, hebrewCellMonth, hebrewFullDate, hebrewMonthHeader, isHebrewMonthStart } from '@/src/lib/calendar-view/hebrew-date';
import { joinTitles } from '@/src/lib/join-titles';
import type { MonthCell } from '@/src/site/zmanim/city-view';
import { cityHref } from '@/src/site/zmanim/links';
import { genitiveOf, keptQuery, weekdayName, type CityViewProps } from './words';

// The month (spec §4.2.4): the Gregorian month and the Hebrew months it spans, with the previous and next month's links
// (left out at the range's ends), then a <table> from Sunday with its weekday headers. Each cell shows the day, the Hebrew
// day (and the Hebrew month's short name on its first day and on the 1st) and a dot for a holiday; Yom Tov is in the
// accent, today is outlined and carries aria-current="date", the day shown is filled. Each cell links to its day, named by
// the full Gregorian date, the Hebrew date and the holiday; a day outside the range is not a link.
export function MonthGrid({ view, locale, t, tc }: CityViewProps) {
  const { month } = view;
  const title = formatMonthTitle(month.key, locale, true);
  const kept = keptQuery(view);
  const shortMonths = tc.raw('hebrewMonthShort') as string[];
  const genitive = genitiveOf(tc, locale);

  const cell = (c: MonthCell) => {
    const monthName = isHebrewMonthStart(c.day) || c.day.endsWith('-01') ? hebrewCellMonth(c.day, locale, shortMonths) : '';
    const names = joinTitles(c.holidays.map((h) => h.title));
    const className = ['site-zm-cell', c.yomTov ? 'is-yomtov' : '', c.isToday ? 'is-today' : '', c.isShown ? 'is-shown' : '', c.inRange ? '' : 'is-out'].filter(Boolean).join(' ');
    const inner = (
      <>
        <span className="site-zm-gday">{Number(c.day.slice(8))}</span>
        <span className="site-zm-hday">{hebrewCellLabel(c.day, locale, false)}</span>
        {monthName ? <span className="site-zm-hmonth">{monthName}</span> : null}
        {c.holidays.length > 0 ? <span className="site-zm-mark" /> : null}
      </>
    );
    if (!c.inRange) return <span className={className}>{inner}</span>;
    const label = t(names ? 'zmanimSite.month.cellHoliday' : 'zmanimSite.month.cell', { date: formatDayFull(c.day, locale), hebrew: hebrewFullDate(c.day, locale, genitive), holidays: names });
    return (
      <a className={className} href={cityHref(locale, view.city.slug, { ...kept, date: c.day })} rel="nofollow" aria-label={label} aria-current={c.isToday ? 'date' : undefined}>
        {inner}
      </a>
    );
  };

  return (
    <>
      <div className="site-zm-month-head">
        <h2 id="month-title" className="site-h2">
          {title}
        </h2>
        <nav className="site-zm-month-nav" aria-label={t('zmanimSite.month.navLabel')}>
          {month.prevMonthDay ? (
            <a className="site-zm-arrow" href={cityHref(locale, view.city.slug, { ...kept, date: month.prevMonthDay })} rel="nofollow" aria-label={t('zmanimSite.month.previous')}>
              <ChevronLeft className="ch-flip" aria-hidden="true" focusable="false" />
            </a>
          ) : null}
          {month.nextMonthDay ? (
            <a className="site-zm-arrow" href={cityHref(locale, view.city.slug, { ...kept, date: month.nextMonthDay })} rel="nofollow" aria-label={t('zmanimSite.month.next')}>
              <ChevronRight className="ch-flip" aria-hidden="true" focusable="false" />
            </a>
          ) : null}
        </nav>
      </div>
      <p className="site-zm-hmonths">{hebrewMonthHeader(month.key, locale)}</p>
      {month.weeks ? (
        <table className="site-zm-grid" aria-labelledby="month-title">
          <thead>
            <tr>
              {weekdayOrder(month.weekStart).map((weekday) => (
                <th key={weekday} scope="col">
                  <span aria-hidden="true">{formatWeekdayHeader(weekday, locale)}</span>
                  <span className="ch-visually-hidden">{weekdayName(weekday, locale)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {month.weeks.map((week) => (
              <tr key={week[0].day}>
                {week.map((c) => (
                  <td key={c.day}>{c.inMonth ? cell(c) : null}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="site-zm-failed" role="status">
          {t('zmanimSite.month.failed')}
        </p>
      )}
    </>
  );
}
