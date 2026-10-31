// The credits the data's licences require in their own words (spec 2026-10-31-open-meteo-replacement, decision 3; the
// dust spike's ruling R8; the lawyer's opinion of 2026-11-01): the links of site.footer.dataSources, whose words are in
// messages (Open-Meteo's credit is the linked words "Open-Meteo.com" in them), and the Copernicus Atmosphere Monitoring
// Service's notice for modified CAMS information. Licence text, so the notice stays in English on every page, a constant
// and never a message. Client-safe: no import.

/** Where each tag of site.footer.dataSources links: the sources and their licences. */
export const SOURCE_LINKS = {
  met: 'https://api.met.no/',
  nlod: 'https://data.norge.no/nlod/en/2.0',
  ccby: 'https://creativecommons.org/licenses/by/4.0/',
  cams: 'https://doi.org/10.24381/04a0b097',
  om: 'https://open-meteo.com/',
  osm: 'https://www.openstreetmap.org/copyright',
  odbl: 'https://opendatacommons.org/licenses/odbl/1-0/',
} as const;

/**
 * The Copernicus notice for modified CAMS information, with the year of the information shown, and the disclaimer. The
 * data is "CAMS global atmospheric composition forecasts", CC BY 4.0 since 2 July 2025 (it was under the 2019 "Licence to
 * Use Copernicus Products"); the notice is the wording of the Atmosphere Data Store entry's "Citation and attribution"
 * (https://doi.org/10.24381/04a0b097, read by the lawyer 2026-11-01).
 */
export function camsNotice(year: number): string {
  return `Contains modified Copernicus Atmosphere Monitoring Service information ${year}. Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.`;
}
