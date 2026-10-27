import { AppScreen } from '@/components/app-ui/AppScreen';
import { MissingParameterCard, StateCard } from '@/components/app-ui/StateCard';
import PageGate, { NoticeDetail } from '../PageGate';
import { gateLinks } from '@/src/lib/gate-links';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function SelectCalendarsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  if (!userId) {
    return <MissingParameterCard />;
  }

  // No user data in the server HTML: PageGate loads it through /api/page-data
  // (src/lib/page-data.ts), which proves the user first. The notices are static.
  return (
    <PageGate
      page="select-calendars"
      userId={userId}
      locale={locale}
      links={gateLinks()}
      notices={{
        noGoogleToken: (
          <AppScreen>
            <StateCard tone="crash" title="No Google Token" body="Please refresh your token first." />
          </AppScreen>
        ),
        // Generic error fallback; the message comes from the server
        error: (
          <AppScreen>
            <StateCard tone="crash" title="Error" body={<NoticeDetail fallback="Unknown error" />} action={{ label: 'Try Again', href: `/select-calendars?user_id=${userId}` }} />
          </AppScreen>
        ),
      }}
    />
  );
}
