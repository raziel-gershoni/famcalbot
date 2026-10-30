import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { LanguageLinks } from './LanguageLinks';
import { SiteMenu } from './SiteMenu';
import { StartButtons, startWords } from './StartButtons';

// The header of every public page (spec 2026-10-28-public-website §3.1): the logo; How it works, Plans, Blog and Zmanim
// (spec 2026-10-30-public-zmanim §6.3); the language switcher; and the two start buttons, compact and equal. On a phone
// the links and the switcher sit behind the menu button (SiteMenu), and one Start button jumps to the landing's start
// section. Every tap target is 44 px. The end of the row has room for a later "Sign in" (spec §3.1, item 6b); nothing
// is built for it.

export async function SiteHeader({ locale, path }: { locale: string; path: string }) {
  const t = await getTranslations({ locale });
  const names = { en: t('site.language.names.en'), he: t('site.language.names.he'), ru: t('site.language.names.ru') };
  return (
    <header className="site-header">
      <div className="site-wrap site-header-row">
        <Link href="/" className="site-logo" aria-label={t('site.header.homeLabel')}>
          <Image src="/icon.png" alt="" width={36} height={36} priority />
          <span>FamCal</span>
        </Link>
        <nav className="site-nav site-wide-only" aria-label={t('site.nav.label')}>
          <Link href={{ pathname: '/', hash: 'how' }}>{t('site.nav.howItWorks')}</Link>
          <Link href={{ pathname: '/', hash: 'plans' }}>{t('site.nav.plans')}</Link>
          <Link href="/blog">{t('site.nav.blog')}</Link>
          <Link href="/zmanim">{t('site.nav.zmanim')}</Link>
        </nav>
        <div className="site-header-end">
          <div className="site-wide-only">
            <LanguageLinks locale={locale} path={path} names={names} label={t('site.language.choose')} />
          </div>
          <div className="site-wide-only">
            <StartButtons words={startWords(t)} compact />
          </div>
          <Link href={{ pathname: '/', hash: 'start' }} className="site-jump site-phone-only">
            {t('site.header.start')}
          </Link>
          <div className="site-phone-only">
            <SiteMenu path={path} />
          </div>
        </div>
      </div>
    </header>
  );
}
