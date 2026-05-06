import { notFound } from 'next/navigation';
import { getUserByTelegramId, getUserById } from '@/src/services/user-service';
import { getSubscriptionWithUsage, getTrialStatus, checkEarlyAdopterAccess } from '@/src/services/subscription-service';
import { normalizeLocale } from '@/src/utils/locale';
import DashboardClient from './DashboardClient';
import TelegramDashboardRedirect from './TelegramDashboardRedirect';

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
    return <TelegramDashboardRedirect locale={locale} />;
  }

  // Try Telegram ID first (existing path), fall back to DB primary key (magic link path)
  const user = await getUserByTelegramId(userId) ?? await getUserById(userId);

  if (!user) {
    notFound();
  }

  // Check if URL locale matches user's language preference
  // normalizeLocale handles legacy values like 'Hebrew' -> 'he'
  const userLocale = normalizeLocale(user.language);
  if (locale !== userLocale) {
    // User's language was updated but they're using an old URL - redirect to correct locale
    const { redirect } = await import('next/navigation');
    redirect(`/${userLocale}/dashboard?user_id=${userId}`);
  }

  // Check setup status. OAuth and calendar selection are GOOGLE-only — for
  // NATIVE users the calendar is auto-bootstrapped at signup, so the only
  // setup gap is location (handled in SettingsClient, not here).
  const isNative = user.calendarSource === 'NATIVE';
  const needsOAuth = !isNative && !user.googleRefreshToken;
  const needsCalendars = !isNative && (!user.calendarAssignments || user.calendarAssignments.length === 0);

  // Fetch subscription data
  const [subWithUsage, trialStatus, isEarlyAdopter] = await Promise.all([
    getSubscriptionWithUsage(user.id),
    getTrialStatus(user.id),
    checkEarlyAdopterAccess(user.id),
  ]);

  const subscription = subWithUsage ? {
    plan: subWithUsage.subscription.plan,
    status: subWithUsage.subscription.status,
    effectivePlan: subWithUsage.effectivePlan,
  } : null;

  return (
    <DashboardClient
      user={{
        id: userId,
        name: user.name,
        location: user.location,
        calendarsCount: user.calendarAssignments?.length || 0,
        isAdmin: user.isAdmin || false,
      }}
      calendarAssignments={user.calendarAssignments || []}
      locale={locale}
      calendarSource={user.calendarSource}
      needsOAuth={needsOAuth}
      needsCalendars={needsCalendars}
      subscription={subscription}
      trial={trialStatus}
      isEarlyAdopter={isEarlyAdopter}
    />
  );
}
