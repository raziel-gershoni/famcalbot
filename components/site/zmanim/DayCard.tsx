import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ZmanimRows } from '@/components/app-ui/ZmanimRows';
import { formatDayFull } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import { cityHref } from '@/src/site/zmanim/links';
import { CommunitySwitch } from './CommunitySwitch';
import { genitiveOf, keptQuery, type CityViewProps } from './words';

// The day (spec §4.2.2): the app's sun sheet set on the page as a card. The day between the previous and next day's
// arrows (the sheet's own nav and icons, flipped in RTL by .ch-flip; links here), Today when another day is shown, the community switch and the line saying how
// that set counts, then the sheet's rows (ZmanimRows: the same words, opinions, order, accent and dash) and the halachic
// hour. A row with no time gets one note under the rows. A day that could not be computed says so.
export function DayCard({ view, locale, t, tc }: CityViewProps) {
  const hebrew = hebrewFullDate(view.day, locale, genitiveOf(tc, locale));
  const kept = keptQuery(view);
  const method = view.community === 'sephardi' && !view.il ? 'sephardiAbroad' : view.community;
  return (
    <section className="site-zm-card" aria-labelledby="day-title">
      <h2 id="day-title" className="ch-visually-hidden">
        {t('zmanimSite.day.title')}
      </h2>
      <nav className="ch-zl-nav" aria-label={t('zmanimSite.day.navLabel')}>
        {view.prevDay ? (
          <a className="site-zm-arrow" href={cityHref(locale, view.city.slug, { ...kept, date: view.prevDay })} rel="nofollow" aria-label={t('zmanimSite.day.previous')}>
            <ChevronLeft className="ch-flip" aria-hidden="true" focusable="false" />
          </a>
        ) : (
          <span className="site-zm-arrow" aria-hidden="true" />
        )}
        <div className="ch-zl-date">
          <p className="ch-zl-day">{formatDayFull(view.day, locale)}</p>
          {hebrew ? <p className="ch-zl-hebrew">{hebrew}</p> : null}
        </div>
        {view.nextDay ? (
          <a className="site-zm-arrow" href={cityHref(locale, view.city.slug, { ...kept, date: view.nextDay })} rel="nofollow" aria-label={t('zmanimSite.day.next')}>
            <ChevronRight className="ch-flip" aria-hidden="true" focusable="false" />
          </a>
        ) : (
          <span className="site-zm-arrow" aria-hidden="true" />
        )}
      </nav>
      {view.isToday ? null : (
        <p className="site-zm-today">
          <a href={cityHref(locale, view.city.slug, kept)} rel="nofollow">
            {t('zmanimSite.day.today')}
          </a>
        </p>
      )}
      <CommunitySwitch view={view} locale={locale} t={t} tc={tc} />
      <p className="site-zm-method">{t(`zmanimSite.day.method.${method}`)}</p>
      {view.list ? (
        <>
          <ZmanimRows list={view.list} locale={locale} t={tc} />
          {view.hasDash ? <p className="site-zm-dash">{t('zmanimSite.day.dashNote')}</p> : null}
        </>
      ) : (
        <p className="site-zm-failed" role="status">
          {t('zmanimSite.day.failed')}
        </p>
      )}
    </section>
  );
}
