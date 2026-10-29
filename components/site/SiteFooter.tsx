import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { LanguageLinks } from './LanguageLinks';

// The footer of every public page (spec 2026-10-28-public-website §3.4): How it works, Plans, Blog, Privacy, Terms,
// Cancel a payment (the Terms' cancellation part, Consumer Protection Law s.14I) and Contact (the bot's feedback
// chat), the language switcher, "Made in Israel" and the years. The years stay left to right in Hebrew
// (<bdi dir="ltr">).

const CONTACT_URL = 'https://t.me/family_calendar_telegram_bot?start=feedback';

export async function SiteFooter({ locale, path }: { locale: string; path: string }) {
  const t = await getTranslations({ locale });
  const names = { en: t('site.language.names.en'), he: t('site.language.names.he'), ru: t('site.language.names.ru') };
  return (
    <footer className="site-footer">
      <div className="site-wrap">
        <nav aria-label={t('site.footer.navLabel')}>
          <ul className="site-footer-links">
            <li>
              <Link href={{ pathname: '/', hash: 'how' }}>{t('site.nav.howItWorks')}</Link>
            </li>
            <li>
              <Link href={{ pathname: '/', hash: 'plans' }}>{t('site.nav.plans')}</Link>
            </li>
            <li>
              <Link href="/blog">{t('site.nav.blog')}</Link>
            </li>
            <li>
              <Link href="/privacy">{t('site.footer.privacy')}</Link>
            </li>
            <li>
              <Link href="/terms">{t('site.footer.terms')}</Link>
            </li>
            <li>
              <Link href={{ pathname: '/terms', hash: 'cancel' }}>{t('site.footer.cancel')}</Link>
            </li>
            <li>
              <a href={CONTACT_URL}>{t('site.footer.contact')}</a>
            </li>
          </ul>
        </nav>
        <LanguageLinks locale={locale} path={path} names={names} label={t('site.language.choose')} />
        <div className="site-footer-meta">
          <p>{t('site.footer.madeIn')}</p>
          <p>
            <bdi dir="ltr">{t('site.footer.copyright', { year: String(new Date().getFullYear()) })}</bdi>
          </p>
        </div>
      </div>
    </footer>
  );
}
