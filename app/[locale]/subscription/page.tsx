import { notFound } from 'next/navigation';
import { getUserByTelegramId } from '@/src/services/user-service';
import { getSubscriptionWithUsage, getTrialStatus } from '@/src/services/subscription-service';
import { normalizeLocale } from '@/src/utils/locale';
import SubscriptionClient from './SubscriptionClient';

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

  const user = await getUserByTelegramId(userId);

  if (!user) {
    notFound();
  }

  // Check if URL locale matches user's language preference
  const userLocale = normalizeLocale(user.language);
  if (locale !== userLocale) {
    const { redirect } = await import('next/navigation');
    redirect(`/${userLocale}/subscription?user_id=${userId}`);
  }

  // Get subscription data (use internal DB user.id, not Telegram userId)
  const subWithUsage = await getSubscriptionWithUsage(user.id);
  const trialStatus = await getTrialStatus(user.id);

  if (!subWithUsage) {
    notFound();
  }

  return (
    <SubscriptionClient
      userId={userId}
      locale={locale}
      subscription={{
        plan: subWithUsage.subscription.plan,
        status: subWithUsage.subscription.status,
        effectivePlan: subWithUsage.effectivePlan,
        currentPeriodEnd: subWithUsage.subscription.currentPeriodEnd?.toISOString() || null,
        cancelAtPeriodEnd: subWithUsage.subscription.cancelAtPeriodEnd,
      }}
      usage={{
        textSummaries: subWithUsage.usage.textSummariesUsed,
        voiceSummaries: subWithUsage.usage.voiceSummariesUsed,
        voiceEvents: subWithUsage.usage.voiceEventsCreated,
        reminders: subWithUsage.usage.remindersTriggered,
        cycleStartDate: subWithUsage.usage.cycleStartDate.toISOString(),
      }}
      trial={{
        isTrialing: trialStatus.isTrialing,
        daysRemaining: trialStatus.daysRemaining,
        trialEndsAt: trialStatus.trialEndsAt?.toISOString() || null,
      }}
    />
  );
}
