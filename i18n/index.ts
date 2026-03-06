import { routing } from './routing';

export const locales = routing.locales;
export type Locale = (typeof locales)[number];
