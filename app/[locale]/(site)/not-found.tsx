import { getLocale, getTranslations } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { Link } from '@/i18n/navigation';

// The public site's 404 (a notFound() under the (site) root layout: a blog post that doesn't exist): the site's chrome,
// "Page not found" in the page's language (the layout set the request's locale), and the way to the home page. The
// Mini App's pages keep the app's own card (../(app)/not-found.tsx).
export default async function SiteNotFound() {
  const locale = await getLocale();
  const t = await getTranslations({ locale });
  return (
    <SitePage locale={locale} path="/">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-narrow">
          <h1 className="site-h1 site-page-title">{t('ui.notFound.title')}</h1>
          <p className="site-lead">{t('ui.notFound.body')}</p>
          <p className="site-more">
            <Link href="/">{t('site.notFound.home')}</Link>
          </p>
        </div>
      </main>
    </SitePage>
  );
}
