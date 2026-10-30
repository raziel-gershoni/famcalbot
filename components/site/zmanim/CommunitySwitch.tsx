import { COMMUNITIES } from '@/src/services/zmanim/sets';
import { defaultCommunity } from '@/src/site/zmanim/city-view';
import { cityHref } from '@/src/site/zmanim/links';
import type { CityViewProps } from './words';

// The community switch (spec §4.2.2): the three sets as plain links that keep the day shown, the current one marked. The
// city's default is written without ?community, so its link is the clean address on today.
export function CommunitySwitch({ view, locale, t, tc }: CityViewProps) {
  const date = view.isToday ? undefined : view.day;
  const fallback = defaultCommunity(view.city);
  return (
    <nav aria-label={t('zmanimSite.day.communityLabel')}>
      <ul className="site-zm-switch">
        {COMMUNITIES.map((community) => (
          <li key={community}>
            <a href={cityHref(locale, view.city.slug, { date, community: community === fallback ? undefined : community })} rel="nofollow" aria-current={community === view.community ? 'true' : undefined}>
              {tc(`zmanimList.community.${community}`)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
