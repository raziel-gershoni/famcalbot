import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import TelegramDashboardRedirect from './TelegramDashboardRedirect';
import PageGate from '../PageGate';
import { gateLinks } from '@/src/lib/gate-links';
import { SESSION_COOKIE_NAME, validateSessionToken } from '@/src/lib/session-auth';
import { localeHref } from '@/src/site/zmanim/links';
import { normalizeLocale } from '@/src/utils/locale';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function DashboardPage({ params, searchParams }: PageProps) {
  // Await params and searchParams (Next.js 15+ requirement)
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  if (!userId) {
    // A browser with a session (signed in on famcal.bot, or by a WhatsApp link) opens its own calendar: the cookie
    // names the DB id. Only its signature is checked here. page-data checks it against the row and clears a refused
    // cookie with its answer, so a revoked one lands on the gate's card once and does not come back here signed in.
    const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    const session = cookie ? validateSessionToken(cookie) : null;
    if (session) redirect(localeHref(normalizeLocale(locale), `/dashboard?user_id=${session.userId}`));

    // No session: the Telegram redirect reads initData, else shows the no-credential card
    return <TelegramDashboardRedirect locale={locale} links={gateLinks()} />;
  }

  // No user data in the server HTML: PageGate loads it through /api/page-data
  // (src/lib/page-data.ts), which proves the user first.
  return <PageGate page="dashboard" userId={userId} locale={locale} links={gateLinks()} />;
}
