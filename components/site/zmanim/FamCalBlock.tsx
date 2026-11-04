import { HonestLine, StartButtons, startWords } from '@/components/site/StartButtons';
import { cheapestPlanWith } from '@/src/site/plans';
import { browserStartHref } from '@/src/services/web-signin/signup-open';
import type { SiteT } from './words';

// FamCal on a city's page (spec §4.2.6): the landing's own sentence on reminders by zman with its two tags (On Telegram,
// and the cheapest plan that has reminders), then the site's start buttons (with Use in the browser while web sign-up
// is set up: browserStartHref, read on each request, as the city page is dynamic) and the honest line.
export function FamCalBlock({ t, locale }: { t: SiteT; locale: string }) {
  const plan = cheapestPlanWith('reminders');
  return (
    <aside className="site-cta" aria-labelledby="famcal-title">
      <h2 id="famcal-title" className="site-h3">
        {t('zmanimSite.famcal.title')}
      </h2>
      <p className="site-cta-text">
        {t('landing.features.jewish.zmanReminders')} <span className="site-tag">{t('landing.features.telegramTag')}</span>
        {plan && plan !== 'FREE' ? (
          <>
            {' '}
            <span className="site-tag">{t(`landing.plans.${plan.toLowerCase()}.name`)}</span>
          </>
        ) : null}
      </p>
      <StartButtons words={startWords(t)} browserHref={browserStartHref(locale)} />
      <HonestLine text={t('site.cta.honest')} />
    </aside>
  );
}
