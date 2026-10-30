// The zmanim pages' addresses (spec 2026-10-30-public-zmanim §4.3): a city's path with the day and the community in the
// query, and a path in a language (English unprefixed, as i18n/routing.ts's 'as-needed' prefix writes it). The pages draw
// their day, month and community links as plain <a href> with these (never prefetched: the request limit counts city
// pages), and the city list and Near me link the clean address. Client-safe: it imports the routing table and a type.

import { routing } from '@/i18n/routing';
import type { ZmanimListResponse } from '@/src/lib/calendar-view/zmanim-list';

export type CityQuery = { date?: string; community?: ZmanimListResponse['community'] };

/** '/zmanim/<slug>', then ?date= and community= when given. A caller passes the community only when it is not the city's default. */
export function cityPath(slug: string, q: CityQuery = {}): string {
  const query = new URLSearchParams();
  if (q.date) query.set('date', q.date);
  if (q.community) query.set('community', q.community);
  const search = query.toString();
  return `/zmanim/${slug}${search ? `?${search}` : ''}`;
}

/** A path in a language: English as it is, Hebrew and Russian under their prefix. */
export function localeHref(locale: string, path: string): string {
  return locale === routing.defaultLocale ? path : `/${locale}${path}`;
}

/** A city's page in a language, with its query. */
export function cityHref(locale: string, slug: string, q: CityQuery = {}): string {
  return localeHref(locale, cityPath(slug, q));
}
