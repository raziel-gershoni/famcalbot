import { notFound } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getUserByTelegramId } from '@/src/services/user-service';
import DashboardClient from './DashboardClient';

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
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h1>Missing user_id parameter</h1>
      </div>
    );
  }

  const user = await getUserByTelegramId(userId);

  if (!user) {
    notFound();
  }

  // Check setup status
  const needsOAuth = !user.googleRefreshToken;
  const needsCalendars = user.calendars.length === 0;

  return (
    <DashboardClient
      user={{
        id: userId,
        name: user.name,
        location: user.location,
        calendarsCount: user.calendars.length,
      }}
      locale={locale}
      needsOAuth={needsOAuth}
      needsCalendars={needsCalendars}
    />
  );
}
