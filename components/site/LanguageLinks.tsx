import { Check, Globe } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

// The language switcher (spec 2026-10-28-public-website §2.2): the same page in each language, each name written in its
// own language and marked with its lang. The current language is marked aria-current and links to the page as it is; the
// others are next-intl Links with a locale, which carry the prefix (English's too) so the proxy stores the choice before
// it lands on the page. Used by the header and the footer (server) and the phone menu (client): no server-only import.

export interface LanguageLinksProps {
  locale: string;
  /** The page's path without a locale: "/", "/blog", "/privacy". */
  path: string;
  names: Record<string, string>;
  /** The list's accessible name. */
  label: string;
  /** 'inline' (the header and the footer) or 'list' (the phone menu's rows, with a check by the current one). */
  variant?: 'inline' | 'list';
  className?: string;
  onNavigate?: () => void;
}

export function LanguageLinks({ locale, path, names, label, variant = 'inline', className, onNavigate }: LanguageLinksProps) {
  const items = routing.locales.map((l) => {
    const current = l === locale;
    const name = (
      <span lang={l} dir={l === 'he' ? 'rtl' : 'ltr'}>
        {names[l]}
      </span>
    );
    return (
      <li key={l}>
        {current ? (
          <Link href={path} aria-current="true" onClick={onNavigate}>
            {name}
            {variant === 'list' ? <Check className="site-icon" aria-hidden="true" focusable="false" /> : null}
          </Link>
        ) : (
          <Link href={path} locale={l} onClick={onNavigate}>
            {name}
          </Link>
        )}
      </li>
    );
  });
  if (variant === 'list') {
    return (
      <ul className={className ?? 'site-menu-list'} aria-label={label}>
        {items}
      </ul>
    );
  }
  return (
    <ul className={className ?? 'site-langs'} aria-label={label}>
      <li aria-hidden="true" className="site-langs-icon">
        <Globe className="site-icon" focusable="false" />
      </li>
      {items}
    </ul>
  );
}
