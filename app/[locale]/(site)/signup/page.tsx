import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { SESSION_COOKIE_NAME, validateSessionToken } from '@/src/lib/session-auth';
import { siteMetadata } from '@/src/site/seo';
import { localeHref } from '@/src/site/zmanim/links';
import { SignUpClient } from './SignUpClient';

// /signup (web sign-up spec 2026-11-03 §2.2, §2.3, §3.4), in the site's chrome: where a Google sign-in or an email code
// that found no account ends. The proved identity waits on the server behind the famcal_signin cookie, whose path is
// /api/auth, so this page can't read it on the server: the client asks GET /api/auth/signup and shows the address, the
// second-account warning, the name field, the consent line and Create account (or the expired, exists and taken
// states). Rendered per request, as /signin is, and kept out of search (noindex, no alternates). No database read here.
// A browser already signed in (a bookmark, or Back after Create account) goes straight to its calendar, as on /signin:
// only the session cookie's signature and age are read, and it never sees the form.

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  const meta = siteMetadata({ locale, path: '/signup', title: t('site.signup.metaTitle'), description: t('site.signup.metaDescription'), imageAlt: t('landing.meta.ogImageAlt') });
  delete meta.alternates;
  return { ...meta, robots: { index: false, follow: false } };
}

export default async function SignUpPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = token ? validateSessionToken(token) : null;
  if (session) redirect(localeHref(locale, `/dashboard?user_id=${session.userId}`));
  return (
    <SitePage locale={locale} path="/signup">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-signin">
          <SignUpClient />
        </div>
      </main>
    </SitePage>
  );
}
