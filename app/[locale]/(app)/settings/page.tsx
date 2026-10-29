import { MissingParameterCard } from '@/components/app-ui/StateCard';
import PageGate from '../PageGate';
import { gateLinks } from '@/src/lib/gate-links';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function SettingsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  if (!userId) {
    return <MissingParameterCard />;
  }

  // No user data in the server HTML: PageGate loads it through /api/page-data
  // (src/lib/page-data.ts), which proves the user first.
  return <PageGate page="settings" userId={userId} locale={locale} links={gateLinks()} />;
}
