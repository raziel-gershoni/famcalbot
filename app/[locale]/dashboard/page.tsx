import TelegramDashboardRedirect from './TelegramDashboardRedirect';
import PageGate from '../PageGate';
import { gateLinks } from '@/src/lib/gate-links';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function DashboardPage({ params, searchParams }: PageProps) {
  // Await params and searchParams (Next.js 15+ requirement)
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  // If no user_id, show Telegram redirect component that reads from initData
  if (!userId) {
    return <TelegramDashboardRedirect locale={locale} links={gateLinks()} />;
  }

  // No user data in the server HTML: PageGate loads it through /api/page-data
  // (src/lib/page-data.ts), which proves the user first.
  return <PageGate page="dashboard" userId={userId} locale={locale} links={gateLinks()} />;
}
