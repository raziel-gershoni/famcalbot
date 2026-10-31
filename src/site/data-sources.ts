// The credits the data's licences require in their own words (spec 2026-10-31-open-meteo-replacement, decision 3; the
// dust spike's ruling R8): Open-Meteo's credit for its open-data files (CC BY 4.0) and the Copernicus Atmosphere
// Monitoring Service's notice for modified CAMS information. Licence text, so it stays in English on every page, a
// constant and never a message; the words around it are site.footer.dataSources. Client-safe: no import.

/** Open-Meteo's required credit (https://open-meteo.com/en/licence), for the CAMS files FamCal reads. */
export const OPEN_METEO_CREDIT = 'Weather data by Open-Meteo.com';

/** Where each tag of site.footer.dataSources links: the sources and their licences. */
export const SOURCE_LINKS = {
  met: 'https://api.met.no/',
  nlod: 'https://data.norge.no/nlod/en/2.0',
  ccby: 'https://creativecommons.org/licenses/by/4.0/',
  cams: 'https://atmosphere.copernicus.eu/',
  om: 'https://open-meteo.com/',
  osm: 'https://www.openstreetmap.org/copyright',
  odbl: 'https://opendatacommons.org/licenses/odbl/1-0/',
} as const;

/**
 * The Copernicus notice for modified CAMS information, with the year of the information shown, and the disclaimer, both
 * as the Copernicus licence words them (https://apps.ecmwf.int/datasets/licences/copernicus/, section 5, checked
 * 2026-11-01).
 */
export function camsNotice(year: number): string {
  return `Contains modified Copernicus Atmosphere Monitoring Service information ${year}. Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.`;
}
