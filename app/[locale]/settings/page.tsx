import { notFound } from 'next/navigation';
import { getUserByTelegramId } from '@/src/services/user-service';
import { normalizeLocale } from '@/src/utils/locale';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { AlertTriangle } from 'lucide-react';
import SettingsClient from './SettingsClient';
import { getSubscriptionWithUsage } from '@/src/services/subscription-service';
import { getPlanLimits } from '@/src/config/plans';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function SettingsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  if (!userId) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          textAlign: 'center',
          maxWidth: '400px'
        }}>
          <div style={{ marginBottom: '20px' }}><AlertTriangle size={64} color="#f59e0b" /></div>
          <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Missing Parameter</h1>
          <p style={{ color: '#666' }}>user_id parameter is required</p>
        </div>
      </div>
    );
  }

  const user = await getUserByTelegramId(userId);

  if (!user) {
    notFound();
  }

  // Check if URL locale matches user's language preference
  // normalizeLocale handles legacy values like 'Hebrew' -> 'he'
  const userLocale = normalizeLocale(user.language);
  if (locale !== userLocale) {
    const { redirect } = await import('next/navigation');
    redirect(`/${userLocale}/settings?user_id=${userId}`);
  }

  // Fetch admin settings and subscription data in parallel
  const [adminSettings, subWithUsage] = await Promise.all([
    withDbRetry(
      () => prisma.adminSettings.findUnique({
        where: { id: 'global' }
      }),
      'settings.adminSettings'
    ).catch(() => null),
    getSubscriptionWithUsage(user.id).catch(() => null),
  ]);

  // Build subscription info for the client
  const effectivePlan = subWithUsage?.effectivePlan || 'FREE';
  const limits = getPlanLimits(effectivePlan);
  const isTrialing = subWithUsage?.subscription.status === 'TRIALING'
    && new Date() < subWithUsage.subscription.trialEndsAt;

  const subscriptionInfo = {
    effectivePlan,
    textSummariesUsed: subWithUsage?.usage.textSummariesUsed ?? 0,
    textSummariesLimit: limits.textSummaries === Infinity ? -1 : limits.textSummaries,
    voiceSummariesUsed: subWithUsage?.usage.voiceSummariesUsed ?? 0,
    voiceSummariesLimit: limits.voiceSummaries === Infinity ? -1 : limits.voiceSummaries,
    remindersAllowed: limits.reminders,
    isTrialing,
  };

  return (
    <SettingsClient
      userId={userId}
      currentSettings={{
        language: userLocale,  // Pass normalized locale
        location: user.location,
        messagingPlatform: user.messagingPlatform,
        culture: user.culture || 'default',
        textSummaryEnabled: user.textSummaryEnabled,
        voiceSummaryEnabled: user.voiceSummaryEnabled,
        weatherEnabled: user.weatherEnabled,
        includeLookaheadInTomorrow: user.includeLookaheadInTomorrow,
        lookaheadAlways7Days: user.lookaheadAlways7Days,
        preferredMorningHour: user.preferredMorningHour,
        preferredEveningHour: user.preferredEveningHour,
        remindersEnabled: user.remindersEnabled,
        defaultReminderMinutes: user.defaultReminderMinutes ?? null,
        pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
        voiceInputEnabled: user.voiceInputEnabled,
        voicePreference: user.voicePreference || 'default'
      }}
      remindersGloballyEnabled={adminSettings?.remindersEnabled ?? false}
      subscriptionInfo={subscriptionInfo}
    />
  );
}
