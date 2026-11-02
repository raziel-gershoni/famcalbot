import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MessageCircle } from 'lucide-react';
import { SitePage } from '@/components/site/SitePage';
import { StartButtons, startWords } from '@/components/site/StartButtons';
import { Link } from '@/i18n/navigation';
import { gateLinks } from '@/src/lib/gate-links';
import { SELLER } from '@/src/lib/seller';
import { SESSION_COOKIE_NAME, validateSessionToken } from '@/src/lib/session-auth';
import { emailConfigured } from '@/src/services/web-signin/email-send';
import { providerConfigured } from '@/src/services/web-signin/oidc';
import { SITE_URL } from '@/src/site/config';
import { siteMetadata } from '@/src/site/seo';
import { isOutcome, readSignInStatus, STATUS_KEY, type OutcomeStatus } from '@/src/site/signin';
import { localeHref } from '@/src/site/zmanim/links';
import { SignInClient, type SignInWays } from './SignInClient';

// /signin (spec 2026-11-02-web-sign-in §3, §2.11), in the site's chrome: Continue with Telegram, Continue with Google and
// Email me a code, each shown only when its keys are set (none set: sign-in isn't available yet, and the start
// buttons). Rendered per request:
//
// - A browser already signed in goes straight to its calendar. Only the cookie's signature and age are read here (no
//   database): a cookie the server has since refused (revoked, suspended, banned, no row) is cleared by that refusal
//   (page-data), so the card's Sign in lands here with no cookie and the ways show, with no loop.
// - ?status= is the outcome a sign-in reached (src/site/signin.ts): no account (the WhatsApp way to Settings and the
//   start buttons), several accounts on one Google account, suspended, blocked (the contact address), taken and has-one
//   (an Add Google that was refused) stand instead of the ways; restart, failed and unavailable are an alert above them.
//   A status page never redirects, even with a cookie.
// - Kept out of search (noindex, no alternates), as the share page is.
// - The Telegram app link the client uses inside Telegram is gateLinks().telegram, https://t.me/<bot>?start=dashboard: the
//   bot's chat, whose /start dashboard reply carries the Mini App button. The repo has no `startapp` (direct Mini App)
//   link builder (checked in src/lib/ and src/site/), and a direct link needs the bot's Main Mini App set in BotFather,
//   so this is the link that works today; one place to change if the owner sets a Main Mini App later.

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  const meta = siteMetadata({ locale, path: '/signin', title: t('site.signin.metaTitle'), description: t('site.signin.metaDescription'), imageAlt: t('landing.meta.ogImageAlt') });
  delete meta.alternates;
  return { ...meta, robots: { index: false, follow: false } };
}

/** An answer another try won't change, in place of the ways. */
async function Outcome({ status, locale, whatsappUrl }: { status: OutcomeStatus; locale: string; whatsappUrl: string }) {
  const t = await getTranslations({ locale });
  const key = `site.signin.status.${STATUS_KEY[status]}`;
  const mail = (chunks: ReactNode) => <a href={`mailto:${SELLER.email}`}>{chunks}</a>;
  return (
    <>
      <h1 className="site-h1 site-page-title">{t(`${key}.title`)}</h1>
      <p className="site-lead">{status === 'suspended' || status === 'blocked' ? t.rich(`${key}.body`, { email: SELLER.email, mail }) : t(`${key}.body`)}</p>
      {status === 'no-account' ? (
        <>
          <section className="site-signin-panel" aria-labelledby="signin-whatsapp">
            <p id="signin-whatsapp">{t('site.signin.status.noAccount.whatsapp')}</p>
            <div className="site-starts site-signin-starts">
              <a className="site-start" data-channel="whatsapp" href={whatsappUrl}>
                <MessageCircle aria-hidden="true" focusable="false" />
                {t('site.signin.status.noAccount.whatsappButton')}
              </a>
            </div>
          </section>
          <section className="site-signin-panel" aria-labelledby="signin-new">
            <p id="signin-new">{t('site.signin.status.noAccount.newHere')}</p>
            <div className="site-signin-starts">
              <StartButtons words={startWords(t)} />
            </div>
          </section>
        </>
      ) : null}
      <p className="site-back site-signin-again">
        <Link href="/signin" prefetch={false}>
          {t('site.signin.retry')}
        </Link>
      </p>
    </>
  );
}

export default async function SignInPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const status = readSignInStatus((await searchParams).status);
  if (!status) {
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    const session = token ? validateSessionToken(token) : null;
    if (session) redirect(`/${locale}/dashboard?user_id=${session.userId}`);
  }
  const t = await getTranslations({ locale });
  const ways: SignInWays = { telegram: providerConfigured('telegram'), google: providerConfigured('google'), email: emailConfigured() };
  const anyWay = ways.telegram || ways.google || ways.email;
  const links = gateLinks();
  return (
    <SitePage locale={locale} path="/signin">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-signin">
          {status && isOutcome(status) ? (
            <Outcome status={status} locale={locale} whatsappUrl={links.whatsapp} />
          ) : (
            <>
              <h1 className="site-h1 site-page-title">{t('site.signin.title')}</h1>
              <p className="site-lead">{t('site.signin.lead')}</p>
              {status ? (
                <p className="site-signin-notice" role="alert">
                  {t(`site.signin.status.${STATUS_KEY[status]}`)}
                </p>
              ) : null}
              {anyWay ? (
                <>
                  <SignInClient ways={ways} telegramAppUrl={links.telegram} pageAddress={`${new URL(SITE_URL).host}${localeHref(locale, '/signin')}`} />
                  <p className="site-honest">{t('site.signin.existingOnly')}</p>
                </>
              ) : (
                <>
                  <p className="site-signin-notice">{t('site.signin.none')}</p>
                  <div className="site-signin-starts">
                    <StartButtons words={startWords(t)} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </SitePage>
  );
}
