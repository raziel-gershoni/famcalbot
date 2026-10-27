import { MissingParameterCard } from '@/components/app-ui/StateCard';
import PageGate from '../PageGate';
import { gateLinks } from '@/src/lib/gate-links';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function PairPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const sp = await searchParams;
  const userId = sp.user_id ? parseInt(sp.user_id) : null;

  if (!userId) {
    return <MissingParameterCard />;
  }

  // No user data in the server HTML (the invite token grants editor access): PageGate
  // loads it through /api/page-data (src/lib/page-data.ts), which proves the user first.
  return (
    <PageGate
      page="pair"
      userId={userId}
      locale={locale}
      links={gateLinks()}
    />
  );
}
