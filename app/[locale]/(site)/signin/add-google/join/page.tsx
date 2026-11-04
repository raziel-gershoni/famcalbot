import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { captureError } from '@/src/lib/error-capture';
import { joinDateText, joinLines, type JoinSummary } from '@/src/lib/join-summary';
import { SESSION_COOKIE_NAME, validateSessionToken } from '@/src/lib/session-auth';
import { peekJoin } from '@/src/services/web-signin/join';
import { siteMetadata } from '@/src/site/seo';
import { JoinClient } from './JoinClient';

// /signin/add-google/join?token= (web sign-up spec 2026-11-03 §2.9, §3.6): where Add Google lands when the Google
// account belongs to an account made on famcal.bot with no chat. Google's callback has signed this browser in as the
// account that made the Add Google link (finishAddGoogle), so the question is shown only to that session: peekJoin
// reads the question for the session's account and never uses it up. The question and what moves are
// settings.signIn.join's words (the Settings sheet asks the same), the buttons are JoinClient's. A late, used or bad id,
// or another browser, says to start again. Rendered per request, kept out of search. The id is never logged.

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  const meta = siteMetadata({ locale, path: '/signin/add-google/join', title: t('site.signin.addGoogle.join.metaTitle'), description: t('site.signin.metaDescription'), imageAlt: t('landing.meta.ogImageAlt') });
  delete meta.alternates;
  return { ...meta, robots: { index: false, follow: false } };
}

type Question = { kind: 'ok'; userId: number; summary: JoinSummary } | { kind: 'gone' } | { kind: 'failed' };

/** The question this browser's session may answer: one cookie check and one Redis read, only when a person opens it. */
async function readQuestion(token: string | null): Promise<Question> {
  if (!token) return { kind: 'gone' };
  try {
    const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    const session = cookie ? validateSessionToken(cookie) : null;
    if (!session) return { kind: 'gone' };
    const summary = await peekJoin(session.userId, token);
    return summary ? { kind: 'ok', userId: session.userId, summary } : { kind: 'gone' };
  } catch (error) {
    captureError(error, 'join-page', { service: 'web-signin' });
    return { kind: 'failed' };
  }
}

export default async function JoinPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : null;
  const question = await readQuestion(token);
  const t = await getTranslations({ locale });
  return (
    <SitePage locale={locale} path="/signin">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-signin">
          {question.kind === 'gone' ? (
            <>
              <h1 className="site-h1 site-page-title">{t('site.signin.addGoogle.join.expiredTitle')}</h1>
              <p className="site-lead">{t('site.signin.addGoogle.join.expired')}</p>
            </>
          ) : question.kind === 'failed' ? (
            <>
              <h1 className="site-h1 site-page-title">{t('settings.signIn.join.title')}</h1>
              <p className="site-signin-notice" role="alert">
                {t('site.signin.addGoogle.loadFailed')}
              </p>
            </>
          ) : (
            <>
              <h1 className="site-h1 site-page-title">{t('settings.signIn.join.title')}</h1>
              <div className="site-signin-panel">
                <p>{t('settings.signIn.join.question', { kind: 'google', name: question.summary.name, date: joinDateText(question.summary.createdAt, locale) })}</p>
                <p className="site-signin-moves-title">{t('settings.signIn.join.movesTitle')}</p>
                <ul className="site-signin-moves">
                  {joinLines(question.summary.plan).map((line) => (
                    <li key={line.key}>{t(`settings.signIn.join.${line.key}`, line.values)}</li>
                  ))}
                </ul>
                <p>{t('settings.signIn.join.closes')}</p>
              </div>
              {token ? <JoinClient userId={question.userId} token={token} /> : null}
            </>
          )}
        </div>
      </main>
    </SitePage>
  );
}
