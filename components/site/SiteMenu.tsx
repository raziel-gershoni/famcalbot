'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Menu } from 'lucide-react';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { Link } from '@/i18n/navigation';
import { LanguageLinks } from './LanguageLinks';

// The phone's menu (spec 2026-10-28-public-website §3.1): a 44 px button that opens the app's own bottom sheet with the
// site's links and the language switcher. The sheet is the kit's BottomSheet, so it behaves as every sheet in the app
// does: focus moves into it and back to this button, Tab stays inside, and Escape, a tap on the scrim and its Close
// button close it. A link closes it too (a link to a section of the same page would leave it open over the page).

export function SiteMenu({ path }: { path: string }) {
  const t = useTranslations('site');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const names = { en: t('language.names.en'), he: t('language.names.he'), ru: t('language.names.ru') };
  return (
    <>
      <button type="button" className="site-menu-button" aria-label={t('menu.open')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <Menu aria-hidden="true" focusable="false" />
      </button>
      {open ? (
        <BottomSheet label={t('menu.button')} closeLabel={t('menu.close')} onClose={close}>
          <nav className="site-menu-section" aria-label={t('nav.label')}>
            <ul className="site-menu-list">
              <li>
                <Link href={{ pathname: '/', hash: 'how' }} onClick={close}>
                  {t('nav.howItWorks')}
                </Link>
              </li>
              <li>
                <Link href={{ pathname: '/', hash: 'plans' }} onClick={close}>
                  {t('nav.plans')}
                </Link>
              </li>
              <li>
                <Link href="/blog" onClick={close}>
                  {t('nav.blog')}
                </Link>
              </li>
            </ul>
          </nav>
          <div className="site-menu-section">
            <span className="site-menu-label" aria-hidden="true">
              {t('language.label')}
            </span>
            <LanguageLinks locale={locale} path={path} names={names} label={t('language.choose')} variant="list" onNavigate={close} />
          </div>
        </BottomSheet>
      ) : null}
    </>
  );
}
