import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { captureError } from '@/src/lib/error-capture';
import { getUserById } from '@/src/services/user-service';
import { peekAddGoogleToken } from '@/src/services/web-signin/add-google';
import { providerConfigured } from '@/src/services/web-signin/oidc';
import { siteMetadata } from '@/src/site/seo';
import { AddGoogleClient } from './AddGoogleClient';

// /signin/add-google?token= (spec 2026-11-02-web-sign-in §2.9): the page a one-time "Add Google" link opens in the browser,
// from Settings → Sign in on the web. It names the account ("Add Google sign-in to Dana's FamCal") and offers one
// Continue; opening the page never uses the link up (a link preview or a second look costs nothing), only Continue does.
// A used, late or malformed link says to start again from Settings; a token that isn't one is never looked up
// (peekAddGoogleToken checks the shape before it reads Redis, so the shape is checked in one place). Reading the link is
// one Redis read and one user row (getUserById), only when a person opens it. Rendered per request, kept out of search.
// The token is never logged.

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  const meta = siteMetadata({ locale, path: '/signin/add-google', title: t('site.signin.addGoogle.metaTitle'), description: t('site.signin.metaDescription'), imageAlt: t('landing.meta.ogImageAlt') });
  delete meta.alternates;
  return { ...meta, robots: { index: false, follow: false } };
}

type Owner = { kind: 'ok'; name: string } | { kind: 'gone' } | { kind: 'failed' };

/** Whose FamCal the link is for, by name, without using the link up. */
async function linkOwner(token: string): Promise<Owner> {
  try {
    const link = await peekAddGoogleToken(token);
    if (!link) return { kind: 'gone' };
    const user = await getUserById(link.userId);
    return user ? { kind: 'ok', name: user.name } : { kind: 'gone' };
  } catch (error) {
    captureError(error, 'add-google-page', { service: 'web-signin' });
    return { kind: 'failed' };
  }
}

export default async function AddGooglePage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : null;
  const owner: Owner = token ? await linkOwner(token) : { kind: 'gone' };
  const t = await getTranslations({ locale });
  return (
    <SitePage locale={locale} path="/signin">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-signin">
          {owner.kind === 'gone' ? (
            <>
              <h1 className="site-h1 site-page-title">{t('site.signin.addGoogle.expiredTitle')}</h1>
              <p className="site-lead">{t('site.signin.addGoogle.expired')}</p>
            </>
          ) : owner.kind === 'failed' ? (
            <>
              <h1 className="site-h1 site-page-title">{t('site.signin.addGoogle.titleNoName')}</h1>
              <p className="site-signin-notice" role="alert">
                {t('site.signin.addGoogle.loadFailed')}
              </p>
            </>
          ) : (
            <>
              <h1 className="site-h1 site-page-title">{owner.name ? t('site.signin.addGoogle.title', { name: owner.name }) : t('site.signin.addGoogle.titleNoName')}</h1>
              {providerConfigured('google') && token ? (
                <AddGoogleClient token={token} />
              ) : (
                <p className="site-signin-notice" role="alert">
                  {t('site.signin.addGoogle.unavailable')}
                </p>
              )}
            </>
          )}
        </div>
      </main>
    </SitePage>
  );
}
