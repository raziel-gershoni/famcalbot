import { ZmanimRows } from '@/components/app-ui/ZmanimRows';
import { formatDayShort } from '@/src/lib/calendar-view/format';
import { hebrewDayLabel } from '@/src/lib/calendar-view/hebrew-date';
import { joinTitles } from '@/src/lib/join-titles';
import { windowList } from '@/src/site/zmanim/city-view';
import { genitiveOf, type CityViewProps } from './words';

// The month's list, under the grid (spec §4.2.4): every holiday, fast and Rosh Chodesh, and every Shabbat with its
// parasha, candle lighting and end, at this city in this community (the day lists' own rows).
export function MonthList({ view, locale, t, tc }: CityViewProps) {
  const entries = view.month.entries;
  if (!entries || entries.length === 0) return null;
  const genitive = genitiveOf(tc, locale);
  const dashed = entries.some((e) => e.shabbat?.rows.some((r) => r.at === null));
  return (
    <section className="site-zm-sub" aria-labelledby="month-list-title">
      <h3 id="month-list-title" className="site-h3">
        {t('zmanimSite.month.listTitle')}
      </h3>
      <ul className="site-zm-mlist">
        {entries.map((entry) => {
          const names = joinTitles([...(entry.shabbat?.parasha ? [entry.shabbat.parasha.title] : []), ...entry.holidays.map((h) => h.title)]);
          return (
            <li key={entry.day} className="site-zm-entry">
              <p className="site-zm-entry-date">
                {formatDayShort(entry.day, locale)}
                <span className="site-zm-entry-hebrew">{hebrewDayLabel(entry.day, locale, genitive)}</span>
              </p>
              {names ? <p className="site-zm-entry-names">{names}</p> : null}
              {entry.shabbat && entry.shabbat.rows.length > 0 ? <ZmanimRows list={windowList(view, entry.day, entry.shabbat.rows)} locale={locale} t={tc} /> : null}
            </li>
          );
        })}
      </ul>
      {dashed ? <p className="site-zm-dash">{t('zmanimSite.day.dashNote')}</p> : null}
    </section>
  );
}
