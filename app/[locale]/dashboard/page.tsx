import { notFound } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getUserByTelegramId } from '@/src/services/user-service';
import DashboardClient from './DashboardClient';

interface PageProps {
  searchParams: { user_id?: string };
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const userId = searchParams.user_id
    ? parseInt(searchParams.user_id)
    : null;

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
      needsOAuth={needsOAuth}
      needsCalendars={needsCalendars}
    />
  );
}
