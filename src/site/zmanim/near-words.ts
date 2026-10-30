// What Near me needs from the server (spec 2026-10-30-public-zmanim §6.3): each city's point, zone, name and page, and
// its words, already in the page's language, as props, so the site's client namespaces stay ['site'] (src/site/
// messages.ts). The templates keep their {city} and {km}: the island fills them. A plain module, so the server page can
// call nearWords (a function exported from a 'use client' file can't be called on the server). Client-safe: types only.

import type { NearCity } from '@/src/site/near-city';

export type NearMeCity = NearCity & { name: string; href: string };

export interface NearMeWords {
  button: string;
  locating: string;
  privacy: string;
  /** With {city}. */
  opening: string;
  /** With {city} and {km}. */
  near: string;
  none: string;
  denied: string;
  unavailable: string;
  unsupported: string;
  toList: string;
}

const KEYS: readonly (keyof NearMeWords)[] = ['button', 'locating', 'privacy', 'opening', 'near', 'none', 'denied', 'unavailable', 'unsupported', 'toList'];

/** Near me's words from zmanimSite.near, raw (the templates' arguments stay for the island). */
export function nearWords(t: { raw: (key: string) => unknown }): NearMeWords {
  return Object.fromEntries(KEYS.map((key) => [key, String(t.raw(`zmanimSite.near.${key}`))])) as unknown as NearMeWords;
}
