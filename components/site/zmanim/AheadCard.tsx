import { ZmanimRows } from '@/components/app-ui/ZmanimRows';
import { formatDayShort } from '@/src/lib/calendar-view/format';
import { windowList } from '@/src/site/zmanim/city-view';
import { windowName, type CityViewProps } from './words';

// Shabbat and Yom Tov ahead (spec §4.2.3): the window under way and every one that begins within 8 days, each named by
// its parasha or holidays, with one line per day: the eve's candle lighting, "not before" on a middle night, and the end
// (the day lists' own rows, in the accent). A window whose end the sun doesn't make keeps its candles; its end is a dash,
// with its own line. Windows that could not be computed say so.
export function AheadCard({ view, locale, t, tc }: CityViewProps) {
  return (
    <section className="site-zm-section" aria-labelledby="ahead-title">
      <h2 id="ahead-title" className="site-h2">
        {t('zmanimSite.ahead.title')}
      </h2>
      {view.ahead === null ? (
        <p className="site-zm-failed" role="status">
          {t('zmanimSite.ahead.failed')}
        </p>
      ) : (
        view.ahead.map((window) => {
          const dashed = window.days.some((d) => d.rows.some((r) => r.at === null));
          return (
            <section key={window.eve} className="site-zm-window" aria-labelledby={`window-${window.eve}`}>
              <h3 id={`window-${window.eve}`} className="site-h3">
                {windowName(window, t)}
              </h3>
              {window.days.map((d) =>
                d.rows.length > 0 ? (
                  <div key={d.day} className="site-zm-wday">
                    <p className="site-zm-wdate">{formatDayShort(d.day, locale)}</p>
                    <ZmanimRows list={windowList(view, d.day, d.rows)} locale={locale} t={tc} />
                  </div>
                ) : null,
              )}
              {window.endMissing ? <p className="site-zm-dash">{t('zmanimSite.ahead.noEnd')}</p> : dashed ? <p className="site-zm-dash">{t('zmanimSite.day.dashNote')}</p> : null}
            </section>
          );
        })
      )}
    </section>
  );
}
