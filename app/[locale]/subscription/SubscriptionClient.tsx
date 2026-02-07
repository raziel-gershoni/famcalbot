'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { TelegramLayout, Header } from '@/components/Layout';
import { Section } from '@/components/UI';
import { useState } from 'react';
import { Star, Check, X, Crown, Sparkles, Clock } from 'lucide-react';
import { PLAN_CONFIGS, PlanId, PlanConfig } from '@/src/config/plans';

interface SubscriptionProps {
  plan: string;
  status: string;
  effectivePlan: PlanId;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface UsageProps {
  textSummaries: number;
  voiceSummaries: number;
  voiceEvents: number;
  reminders: number;
  cycleStartDate: string;
}

interface TrialProps {
  isTrialing: boolean;
  daysRemaining: number;
  trialEndsAt: string | null;
}

interface SubscriptionClientProps {
  userId: number;
  locale: string;
  subscription: SubscriptionProps;
  usage: UsageProps;
  trial: TrialProps;
}

export default function SubscriptionClient({
  userId,
  locale,
  subscription,
  usage,
  trial,
}: SubscriptionClientProps) {
  const t = useTranslations('subscription');
  const router = useRouter();
  const [upgrading, setUpgrading] = useState<PlanId | null>(null);

  const handleBack = () => {
    router.push(`/${locale}/dashboard?user_id=${userId}`);
  };

  const currentPlan = subscription.effectivePlan;
  const planConfig = PLAN_CONFIGS[currentPlan];
  const limits = planConfig.limits;
  const isRtl = locale === 'he';

  const handleUpgrade = async (planId: PlanId) => {
    await processUpgrade(planId);
  };

  const processUpgrade = async (planId: PlanId) => {
    setUpgrading(planId);
    try {
      // Get Telegram Web App initData for authentication
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;

      // Parse user_id from URL (passed as telegramId)
      const urlParams = new URLSearchParams(window.location.search);
      const telegramUserId = urlParams.get('user_id');

      if (!telegramUserId) {
        if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
          window.Telegram.WebApp.showAlert('Unable to identify user. Please try again from Telegram.');
        }
        return;
      }

      // Call API to send invoice
      const response = await fetch('/api/subscription/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: parseInt(telegramUserId),
          plan: planId,
          initData,
          recurring: false,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Close the web app - user will see the invoice in Telegram
        if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
          window.Telegram.WebApp.showAlert(
            t('page.invoiceSent') || 'Invoice sent! Check your Telegram chat to complete payment.',
            () => {
              window.Telegram?.WebApp?.close();
            }
          );
        }
      } else {
        if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
          window.Telegram.WebApp.showAlert(data.error || 'Failed to send invoice. Please try again.');
        }
      }
    } catch (error) {
      console.error('Upgrade error:', error);
      if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
        window.Telegram.WebApp.showAlert('An error occurred. Please try again.');
      }
    } finally {
      setUpgrading(null);
    }
  };

  return (
    <TelegramLayout>
      <div className={`subscription-page ${isRtl ? 'rtl' : ''}`}>
        <style jsx global>{`
          .subscription-page {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            min-height: 100vh;
          }

          .subscription-content {
            padding: 20px;
          }

          .trial-banner {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 16px;
            border-radius: 12px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 12px;
          }

          .trial-banner-icon {
            background: rgba(255,255,255,0.2);
            padding: 8px;
            border-radius: 50%;
          }

          .trial-banner-text h3 {
            margin: 0 0 4px 0;
            font-size: 16px;
            font-weight: 600;
          }

          .trial-banner-text p {
            margin: 0;
            font-size: 14px;
            opacity: 0.9;
          }

          .current-plan-card {
            background: linear-gradient(135deg, #f5f7fa 0%, #e4e8eb 100%);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
          }

          .current-plan-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
          }

          .current-plan-name {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 20px;
            font-weight: 600;
            color: #1a1a1a;
          }

          .current-plan-badge {
            background: #10b981;
            color: white;
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 4px;
            font-weight: 500;
          }

          .trial-badge {
            background: #667eea;
          }

          .usage-section {
            margin-top: 16px;
          }

          .usage-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 0;
            border-bottom: 1px solid #e5e7eb;
          }

          .usage-item:last-child {
            border-bottom: none;
          }

          .usage-label {
            color: #6b7280;
            font-size: 14px;
          }

          .usage-value {
            font-weight: 600;
            color: #1a1a1a;
          }

          .usage-bar {
            flex: 1;
            height: 6px;
            background: #e5e7eb;
            border-radius: 3px;
            margin: 0 12px;
            overflow: hidden;
          }

          .usage-bar-fill {
            height: 100%;
            background: #10b981;
            border-radius: 3px;
            transition: width 0.3s;
          }

          .usage-bar-fill.warning {
            background: #f59e0b;
          }

          .usage-bar-fill.danger {
            background: #ef4444;
          }

          .plans-grid {
            display: grid;
            gap: 16px;
          }

          .plan-card {
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 20px;
            position: relative;
            transition: all 0.2s;
            background: white;
          }

          .plan-card.current {
            border-color: #10b981;
            background: #f0fdf4;
          }

          .plan-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid #e5e7eb;
          }

          .rtl .plan-card-header {
            flex-direction: row-reverse;
          }

          .plan-name {
            font-size: 20px;
            font-weight: 700;
            color: #1a1a1a;
          }

          .plan-price {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 18px;
            font-weight: 700;
            color: #667eea;
            background: #f0f0ff;
            padding: 6px 12px;
            border-radius: 8px;
          }

          .rtl .plan-price {
            flex-direction: row-reverse;
          }

          .plan-features {
            list-style: none;
            padding: 0;
            margin: 0 0 16px 0;
          }

          .plan-features li {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 0;
            font-size: 14px;
            color: #4b5563;
            border-bottom: 1px solid #f3f4f6;
          }

          .plan-features li:last-child {
            border-bottom: none;
          }

          .rtl .plan-features li {
            flex-direction: row-reverse;
            text-align: right;
          }

          .feature-icon {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
          }

          .feature-icon.included {
            color: #10b981;
          }

          .feature-icon.excluded {
            color: #d1d5db;
          }

          .upgrade-button {
            width: 100%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: opacity 0.2s;
          }

          .upgrade-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }

          .current-badge {
            position: absolute;
            top: -1px;
            right: -1px;
            background: #10b981;
            color: white;
            font-size: 11px;
            padding: 4px 12px;
            border-radius: 0 10px 0 8px;
            font-weight: 500;
          }

          .rtl .current-badge {
            right: auto;
            left: -1px;
            border-radius: 10px 0 8px 0;
          }
        `}</style>

        <Header title={t('page.title')} onBackClick={handleBack} />

        <div className="subscription-content">
          {/* Trial Banner */}
          {trial.isTrialing && (
            <div className="trial-banner">
              <div className="trial-banner-icon">
                <Sparkles size={24} />
              </div>
              <div className="trial-banner-text">
                <h3>{t('trialBanner', { days: trial.daysRemaining })}</h3>
                <p>{t('trialEndsIn', { days: trial.daysRemaining })}</p>
              </div>
            </div>
          )}

          {/* Current Plan Card */}
          <Section title={t('currentPlan')}>
            <div className="current-plan-card">
              <div className="current-plan-header">
                <div className="current-plan-name">
                  <Crown size={24} />
                  {planConfig.name}
                </div>
                <span className={`current-plan-badge ${trial.isTrialing ? 'trial-badge' : ''}`}>
                  {trial.isTrialing ? t('page.trialBadge') : t('page.currentPlanBadge')}
                </span>
              </div>

              {/* Usage Stats */}
              <div className="usage-section">
                <UsageItem
                  label={t('textSummaries')}
                  used={usage.textSummaries}
                  limit={limits.textSummaries}
                  unlimited={t('unlimited')}
                />
                <UsageItem
                  label={t('voiceSummaries')}
                  used={usage.voiceSummaries}
                  limit={limits.voiceSummaries}
                  unlimited={t('unlimited')}
                />
                {limits.voiceEvents && (
                  <UsageItem
                    label={t('voiceEvents')}
                    used={usage.voiceEvents}
                    limit={Infinity}
                    unlimited={t('unlimited')}
                  />
                )}
                {limits.reminders && (
                  <UsageItem
                    label={t('reminders')}
                    used={usage.reminders}
                    limit={Infinity}
                    unlimited={t('unlimited')}
                  />
                )}
              </div>
            </div>
          </Section>

          {/* Plan Comparison */}
          <Section title={t('page.comparePlans')}>
            <div className="plans-grid">
              {(['FREE', 'BASIC', 'PRO'] as PlanId[]).map((planId) => {
                const plan = PLAN_CONFIGS[planId];
                const isCurrent = planId === subscription.plan ||
                  (trial.isTrialing && planId === 'FREE');
                const canUpgrade = !isCurrent &&
                  ['FREE', 'BASIC'].indexOf(subscription.plan) < ['FREE', 'BASIC', 'PRO'].indexOf(planId);

                return (
                  <PlanCard
                    key={planId}
                    plan={plan}
                    isCurrent={isCurrent}
                    canUpgrade={canUpgrade}
                    isTrialing={trial.isTrialing}
                    upgrading={upgrading === planId}
                    onUpgrade={() => handleUpgrade(planId)}
                    t={t}
                  />
                );
              })}
            </div>
          </Section>
        </div>
      </div>
    </TelegramLayout>
  );
}

function UsageItem({
  label,
  used,
  limit,
  unlimited,
}: {
  label: string;
  used: number;
  limit: number;
  unlimited: string;
}) {
  const isUnlimited = limit === Infinity;
  const percentage = isUnlimited ? 0 : Math.min((used / limit) * 100, 100);
  const barClass = percentage >= 90 ? 'danger' : percentage >= 70 ? 'warning' : '';

  return (
    <div className="usage-item">
      <span className="usage-label">{label}</span>
      {!isUnlimited && (
        <div className="usage-bar">
          <div
            className={`usage-bar-fill ${barClass}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
      <span className="usage-value">
        {isUnlimited ? unlimited : `${used}/${limit}`}
      </span>
    </div>
  );
}

function PlanCard({
  plan,
  isCurrent,
  canUpgrade,
  isTrialing,
  upgrading,
  onUpgrade,
  t,
}: {
  plan: PlanConfig;
  isCurrent: boolean;
  canUpgrade: boolean;
  isTrialing: boolean;
  upgrading: boolean;
  onUpgrade: () => void;
  t: ReturnType<typeof useTranslations<'subscription'>>;
}) {
  const limits = plan.limits;

  return (
    <div className={`plan-card ${isCurrent ? 'current' : ''}`}>
      {isCurrent && !isTrialing && (
        <span className="current-badge">{t('page.currentPlanBadge')}</span>
      )}

      <div className="plan-card-header">
        <span className="plan-name">{plan.name}</span>
        {plan.priceStars > 0 && (
          <span className="plan-price">
            <Star size={16} fill="currentColor" />
            {plan.priceStars}/mo
          </span>
        )}
      </div>

      <ul className="plan-features">
        <FeatureItem
          included={true}
          text={limits.textSummaries === Infinity
            ? t('planFeatures.textSummariesUnlimited')
            : t('planFeatures.textSummariesLimit', { count: limits.textSummaries })}
        />
        <FeatureItem
          included={true}
          text={limits.voiceSummaries === Infinity
            ? t('planFeatures.voiceSummariesUnlimited')
            : t('planFeatures.voiceSummariesLimit', { count: limits.voiceSummaries })}
        />
        <FeatureItem
          included={true}
          text={limits.calendars === Infinity
            ? t('planFeatures.calendarsUnlimited')
            : t('planFeatures.calendarsLimit', { count: limits.calendars })}
        />
        <FeatureItem
          included={limits.reminders}
          text={limits.reminders ? t('planFeatures.remindersIncluded') : t('planFeatures.remindersExcluded')}
        />
        <FeatureItem
          included={limits.voiceEvents}
          text={limits.voiceEvents ? t('planFeatures.voiceEventsIncluded') : t('planFeatures.voiceEventsExcluded')}
        />
      </ul>

      {canUpgrade && (
        <button
          className="upgrade-button"
          onClick={onUpgrade}
          disabled={upgrading}
        >
          <Star size={16} fill="currentColor" />
          {upgrading ? '...' : t('page.upgradeNow')}
        </button>
      )}
    </div>
  );
}

function FeatureItem({ included, text }: { included: boolean; text: string }) {
  return (
    <li>
      {included ? (
        <Check className="feature-icon included" size={16} />
      ) : (
        <X className="feature-icon excluded" size={16} />
      )}
      <span style={{ opacity: included ? 1 : 0.5 }}>{text}</span>
    </li>
  );
}
