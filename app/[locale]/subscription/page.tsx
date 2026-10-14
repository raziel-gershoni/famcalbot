import { notFound } from 'next/navigation';
import PageGate from '../PageGate';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function SubscriptionPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  if (!userId) {
    notFound();
  }

  // No user data in the server HTML: PageGate loads it through /api/page-data
  // (src/lib/page-data.ts), which proves the user first.
  return <PageGate page="subscription" userId={userId} locale={locale} />;
}
