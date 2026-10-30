// The zmanim pages' translators and small shared words (spec 2026-10-30-public-zmanim §4.2): the site's whole catalogue
// (t) and calendarHome (tc, the words of the app's sun sheet, which ZmanimRows reads), the Russian month genitives, a
// weekday's full name for a column header, a window's name, and the community a link keeps. Server only by import
// discipline (the city view reads src/services).

import type { ReactNode } from 'react';
import type { ZmanWordsT } from '@/src/lib/calendar-view/zman-words';
import { intlLocale } from '@/src/lib/calendar-view/format';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import { joinTitles } from '@/src/lib/join-titles';
import type { AheadWindow, CityView } from '@/src/site/zmanim/city-view';
import type { CityQuery } from '@/src/site/zmanim/links';

export type SiteT = ((key: string, values?: Record<string, string | number>) => string) & {
  raw: (key: string) => unknown;
  rich: (key: string, values: Record<string, (chunks: ReactNode) => ReactNode>) => ReactNode;
};
export type CalendarT = ZmanWordsT & { raw: (key: string) => unknown };

export interface CityViewProps {
  view: CityView;
  locale: string;
  t: SiteT;
  tc: CalendarT;
}

/** calendarHome.hebrewMonthGenitive for Russian ("4 хешвана"); the other languages need none. */
export function genitiveOf(tc: CalendarT, locale: string): string[] | undefined {
  return locale === 'ru' ? (tc.raw('hebrewMonthGenitive') as string[]) : undefined;
}

/** The full name of a weekday (0 = Sunday), for a column header's spoken name. */
export function weekdayName(weekday: WeekStart, locale: string): string {
  // 18 October 2026 is a Sunday
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 18 + weekday, 12)));
}

/** A window's name: its parasha, then its holidays ("Parashat Tetzave, Shabbat Zachor", "Pesach I, Pesach II"), else Shabbat. */
export function windowName(window: AheadWindow, t: SiteT): string {
  const names = [...(window.parasha ? [window.parasha.title] : []), ...window.holidays.map((h) => h.title)];
  return names.length > 0 ? joinTitles(names) : t('zmanimSite.ahead.shabbat');
}

/** The query every day, month and Today link keeps: the community, when it is not the city's default. */
export function keptQuery(view: CityView): CityQuery {
  return { community: view.isDefaultCommunity ? undefined : view.community };
}
