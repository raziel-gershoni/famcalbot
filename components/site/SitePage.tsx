import type { ReactNode } from 'react';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

// A public page's frame: the site's scope (.site: the font, the colours, the page's paint), the header, the page's own
// <main>, and the footer. `path` is the page's path without a locale, for the language switcher.
export function SitePage({ locale, path, children }: { locale: string; path: string; children: ReactNode }) {
  return (
    <div className="site">
      <SiteHeader locale={locale} path={path} />
      {children}
      <SiteFooter locale={locale} path={path} />
    </div>
  );
}
