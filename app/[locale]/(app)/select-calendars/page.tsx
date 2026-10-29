import { getTranslations } from 'next-intl/server';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { MissingParameterCard, StateCard } from '@/components/app-ui/StateCard';
import PageGate from '../PageGate';
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

  // The notices are static and say what the user can do; the server's own error message stays in its logs.
  const noGoogle = await getTranslations({ locale, namespace: 'calendars.noGoogle' });
  const gate = await getTranslations({ locale, namespace: 'pageGate' });

  // No user data in the server HTML: PageGate loads it through /api/page-data
  // (src/lib/page-data.ts), which proves the user first.
  return (
    <PageGate
      page="select-calendars"
      userId={userId}
      locale={locale}
      links={gateLinks()}
      notices={{
        noGoogleToken: (
          <AppScreen>
            <StateCard tone="crash" title={noGoogle('title')} body={noGoogle('body')} />
          </AppScreen>
        ),
        // Generic error fallback
        error: (
          <AppScreen>
            <StateCard tone="crash" title={gate('errorTitle')} body={gate('errorBody')} action={{ label: gate('retry'), href: `/${locale}/select-calendars?user_id=${userId}` }} />
          </AppScreen>
        ),
      }}
    />
  );
}
