// The zmanim index's list (spec 2026-10-30-public-zmanim §4.1.3): the cities by country, Israel first, then the other
// countries by name, each country's cities by name, in the page's language (Intl.Collator; names from messages, never
// Intl.DisplayNames). Pure.

import type { City } from '@/src/site/cities';

const ISRAEL = 'IL';

export type CityGroup = { country: string; name: string; cities: { slug: string; name: string }[] };

export function cityGroups(cities: readonly City[], cityName: (slug: string) => string, countryName: (code: string) => string, collator: Intl.Collator): CityGroup[] {
  const byCountry = new Map<string, CityGroup>();
  for (const city of cities) {
    const group = byCountry.get(city.country) ?? { country: city.country, name: countryName(city.country), cities: [] };
    group.cities.push({ slug: city.slug, name: cityName(city.slug) });
    byCountry.set(city.country, group);
  }
  const groups = [...byCountry.values()];
  for (const group of groups) group.cities.sort((a, b) => collator.compare(a.name, b.name));
  return groups.sort((a, b) => (a.country === ISRAEL ? -1 : b.country === ISRAEL ? 1 : collator.compare(a.name, b.name)));
}
