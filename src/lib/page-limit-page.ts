// The page a visitor sees when the zmanim city pages' request limit (page-limit.ts) refuses them: a tiny static HTML
// page with one line in their language, not a blank screen. The words are messages' zmanimSite.limit in en, he and ru;
// the language comes from the path prefix (/he/..., /ru/..., else English), read as the routes read it.
// No external CSS or JS, no image, no emoji; it takes the device's light or dark scheme (color-scheme) with no colour of
// its own. Server only (the proxy); no network, no DB.

import enMessages from '../../messages/en.json';
import heMessages from '../../messages/he.json';
import ruMessages from '../../messages/ru.json';
import { routedPath } from './page-limit';

type LimitLocale = 'en' | 'he' | 'ru';

const WORDS: Record<LimitLocale, { title: string; body: string }> = {
  en: enMessages.zmanimSite.limit,
  he: heMessages.zmanimSite.limit,
  ru: ruMessages.zmanimSite.limit,
};

/** The page's language by the path's prefix: he and ru when it says so, else English. */
export function limitLocale(path: string): LimitLocale {
  const prefix = /^\/(he|ru)\//i.exec(routedPath(path));
  return prefix ? (prefix[1].toLowerCase() as LimitLocale) : 'en';
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The refusal page for the request at `path`: its language, direction and HTML. */
export function limitPage(path: string): { locale: LimitLocale; html: string } {
  const locale = limitLocale(path);
  const { title, body } = WORDS[locale];
  const dir = locale === 'he' ? 'rtl' : 'ltr';
  const html =
    `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">' +
    '<meta name="robots" content="noindex">' +
    `<title>${escapeHtml(title)}</title>` +
    '<style>body{margin:0;padding:48px 16px;font:18px/1.6 system-ui,sans-serif}main{max-inline-size:480px;margin-inline:auto}p{margin:0 0 12px}</style>' +
    `</head><body><main><p>${escapeHtml(title)}</p><p>${escapeHtml(body)}</p></main></body></html>`;
  return { locale, html };
}
