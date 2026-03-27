'use client';

import { useTranslations } from 'next-intl';
import { TelegramLayout, Header } from '@/components/Layout';
import { Section } from '@/components/UI';
import { LoadingButton } from '@/components/Feedback';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import CategoryIcon from '@/components/Forms/CategoryIcon';
import { CalendarAssignment, CalendarLabel } from '@/src/types';
import { KeyRound, Calendar, CloudSun, RefreshCw, PencilLine, ClipboardList, Loader2, Crown, Sparkles, MessageSquare, ChevronRight } from 'lucide-react';
import { HDate, Locale, gematriya } from '@hebcal/core';
import '@hebcal/locales';

interface User {
  id: number;
  name: string;
  location: string;
  calendarsCount: number;
  isAdmin: boolean;
}

interface SubscriptionInfo {
  plan: string;
  status: string;
  effectivePlan: string;
}

interface TrialInfo {
  isTrialing: boolean;
  daysRemaining: number;
  trialEndsAt: Date | null;
}

interface DashboardClientProps {
  user: User;
  calendarAssignments: CalendarAssignment[];
  locale: string;
  needsOAuth: boolean;
  needsCalendars: boolean;
  subscription: SubscriptionInfo | null;
  trial: TrialInfo;
  isEarlyAdopter: boolean;
}

export default function DashboardClient({
  user,
  calendarAssignments,
  locale,
  needsOAuth,
  needsCalendars,
  subscription,
  trial,
  isEarlyAdopter,
}: DashboardClientProps) {
  const t = useTranslations('dashboard');
  const tSub = useTranslations('subscription');
  const router = useRouter();

  // Map app locale to Intl locale
  const intlLocale = { he: 'he-IL', ru: 'ru-RU', en: 'en-US' }[locale] ?? 'en-US';

  // Format dates for today and tomorrow summary buttons
  const todaySummaryLabel = useMemo(() => {
    const now = new Date();
    const greg = now.toLocaleDateString(intlLocale, { month: 'short', day: 'numeric' });
    const dayOfWeek = now.toLocaleDateString(intlLocale, { weekday: 'short' });
    const hdate = new HDate(now);
    const hebDay = locale === 'he' ? gematriya(hdate.getDate()) : hdate.getDate();
    const hebMonth = Locale.lookupTranslation(hdate.getMonthName(), locale) || hdate.getMonthName();
    return {
      gregorian: `${dayOfWeek} ${greg}`,
      hebrew: `${hebDay} ${hebMonth}`
    };
  }, [locale, intlLocale]);

  const tomorrowSummaryLabel = useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const greg = tomorrow.toLocaleDateString(intlLocale, { month: 'short', day: 'numeric' });
    const dayOfWeek = tomorrow.toLocaleDateString(intlLocale, { weekday: 'short' });
    const hdate = new HDate(tomorrow);
    const hebDay = locale === 'he' ? gematriya(hdate.getDate()) : hdate.getDate();
    const hebMonth = Locale.lookupTranslation(hdate.getMonthName(), locale) || hdate.getMonthName();
    return {
      gregorian: `${dayOfWeek} ${greg}`,
      hebrew: `${hebDay} ${hebMonth}`
    };
  }, [locale, intlLocale]);

  // Track which button is loading
  const [loadingCommand, setLoadingCommand] = useState<string | null>(null);

  const executeCommand = async (command: string, args?: string) => {
    // Show loading spinner in button
    const commandKey = args ? `${command}-${args}` : command;
    setLoadingCommand(commandKey);

    try {
      // Get Telegram Web App initData for authentication
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;

      // Wait for API to send progress message to Telegram
      await fetch('/api/execute-command', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: user.id,
          command,
          args,
          language: locale,
          initData, // Include for authentication
        }),
      });
    } catch (error) {
      console.error('Command execution error:', error);
    } finally {
      // Close webapp (Telegram only) or reset spinner (browser)
      if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
        window.Telegram.WebApp.close();
      } else {
        setLoadingCommand(null);
      }
    }
  };

  const isLoading = (command: string, args?: string) => {
    const commandKey = args ? `${command}-${args}` : command;
    return loadingCommand === commandKey;
  };

  const handleOpenSettings = () => {
    router.push(`/${locale}/settings?user_id=${user.id}`);
  };

  const handleOpenAdminPanel = () => {
    router.push(`/${locale}/admin-panel?user_id=${user.id}`);
  };

  const handleConnectGoogle = () => {
    router.push(`/refresh-token?user_id=${user.id}`);
  };

  const handleSelectCalendars = () => {
    router.push(`/${locale}/select-calendars?user_id=${user.id}`);
  };

  const handleOpenSubscription = () => {
    router.push(`/${locale}/subscription?user_id=${user.id}`);
  };

  const handleOpenFeedback = () => {
    router.push(`/${locale}/feedback?user_id=${user.id}`);
  };

  return (
    <TelegramLayout>
      <div className="dashboard">
        <style jsx>{`
          .dashboard {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            min-height: 100vh;
          }

          .dashboard-content {
            padding: 20px;
          }

          .button-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
          }

          .action-button {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            font-size: 16px;
            font-weight: 500;
            color: #111827;
          }

          .summary-button {
            padding: 16px 20px;
            gap: 4px;
          }

          .summary-label {
            font-size: 18px;
            font-weight: 600;
            color: #667eea;
          }

          .summary-date {
            font-size: 13px;
            font-weight: 400;
            color: #6b7280;
          }

          .action-button:hover {
            border-color: #667eea;
            background: #f9fafb;
            transform: translateY(-2px);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }

          .action-button .icon {
            font-size: 32px;
          }

          .inline-icon {
            vertical-align: middle;
            display: inline-block;
            margin-right: 4px;
          }

          .setup-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .setup-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.3);
          }

          .setup-card h3 {
            font-size: 20px;
            margin-bottom: 8px;
          }

          .setup-card p {
            font-size: 14px;
            opacity: 0.9;
          }

          .settings-card {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .settings-card:hover {
            border-color: #667eea;
            background: #f9fafb;
            transform: translateY(-2px);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }

          .calendar-list-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
          }

          .calendar-list-header p {
            color: #6b7280;
            font-size: 14px;
          }

          .arrow {
            font-size: 20px;
            color: #9ca3af;
          }

          .calendar-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }

          .calendar-item-compact {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px;
            background: #f9fafb;
            border-radius: 8px;
            font-size: 13px;
          }

          .calendar-color-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            flex-shrink: 0;
          }

          .calendar-name-compact {
            flex: 1;
            color: #374151;
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .calendar-icons-compact {
            display: flex;
            gap: 4px;
            flex-shrink: 0;
          }

          .renew-token-button {
            width: 100%;
            margin-top: 12px;
            padding: 10px 16px;
            background: white;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            color: #6b7280;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
          }

          .renew-token-button:hover {
            background: #f9fafb;
            border-color: #667eea;
            color: #667eea;
          }

          .action-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
          }

          .action-button:disabled:hover {
            transform: none;
            box-shadow: none;
            border-color: #e5e7eb;
            background: white;
          }

          :global(.spinner) {
            animation: spin 1s linear infinite;
          }

          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }

          .subscription-card {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 16px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .subscription-card:hover {
            border-color: #667eea;
            background: #f9fafb;
            transform: translateY(-2px);
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }

          .subscription-card.trial {
            background: linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 100%);
            border-color: #667eea;
          }

          .subscription-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .subscription-plan {
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .subscription-plan-name {
            font-weight: 600;
            font-size: 16px;
            color: #111827;
          }

          .subscription-badge {
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 4px;
            font-weight: 600;
          }

          .subscription-badge.trial {
            background: #667eea;
            color: white;
          }

          .subscription-badge.active {
            background: #10b981;
            color: white;
          }

          .subscription-badge.free {
            background: #f3f4f6;
            color: #6b7280;
          }

          .subscription-badge.early-adopter {
            background: #10b981;
            color: white;
          }

          .subscription-card.early-adopter {
            background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%);
            border-color: #10b981;
          }

          .subscription-action {
            font-size: 13px;
            color: #667eea;
            font-weight: 500;
          }

          .trial-info {
            margin-top: 8px;
            font-size: 13px;
            color: #6b7280;
            display: flex;
            align-items: center;
            gap: 6px;
          }

          .trial-days {
            font-weight: 600;
            color: #667eea;
          }

          @media (max-width: 400px) {
            .button-group {
              grid-template-columns: 1fr;
            }
          }

          .feedback-card {
            background: linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 100%);
            border: 2px solid #667eea;
            border-radius: 12px;
            padding: 16px 20px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 20px;
          }

          .feedback-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.25);
          }

          .feedback-card-icon {
            color: #667eea;
            flex-shrink: 0;
          }

          .feedback-card-text {
            flex: 1;
            font-size: 15px;
            font-weight: 500;
            color: #374151;
          }

          .feedback-card-arrow {
            color: #667eea;
            flex-shrink: 0;
          }
        `}</style>

        <Header
          title={t('title')}
          userName={user.name}
          onSettingsClick={handleOpenSettings}
          onAdminClick={user.isAdmin ? handleOpenAdminPanel : undefined}
          isAdmin={user.isAdmin}
        />

        <div className="dashboard-content">
          {needsOAuth ? (
            <div className="setup-card" onClick={handleConnectGoogle}>
              <h3><KeyRound size={20} className="inline-icon" /> {t('setup.connectGoogle')}</h3>
              <p>{t('setup.connectGoogleDesc')}</p>
            </div>
          ) : needsCalendars ? (
            <div className="setup-card" onClick={handleSelectCalendars}>
              <h3><Calendar size={20} className="inline-icon" /> {t('setup.selectCalendars')}</h3>
              <p>{t('setup.selectCalendarsDesc')}</p>
            </div>
          ) : (
            <>
              {/* Feedback Card */}
              <div className="feedback-card" onClick={handleOpenFeedback}>
                <MessageSquare size={20} className="feedback-card-icon" />
                <span className="feedback-card-text">{t('feedback.cardText') || t('feedback.title')}</span>
                <ChevronRight size={18} className="feedback-card-arrow" />
              </div>

              {/* Summary Section */}
              <Section title={t('summary.title')} icon={<Calendar size={20} />}>
                <div className="button-group">
                  <button
                    className="action-button summary-button"
                    onClick={() => executeCommand('summary')}
                    disabled={loadingCommand !== null}
                  >
                    {isLoading('summary') ? (
                      <Loader2 size={24} className="spinner" />
                    ) : (
                      <>
                        <span className="summary-label">{t('summary.today')}</span>
                        <span className="summary-date">
                          {todaySummaryLabel.gregorian} • {todaySummaryLabel.hebrew}
                        </span>
                      </>
                    )}
                  </button>
                  <button
                    className="action-button summary-button"
                    onClick={() => executeCommand('summary', 'tmrw')}
                    disabled={loadingCommand !== null}
                  >
                    {isLoading('summary', 'tmrw') ? (
                      <Loader2 size={24} className="spinner" />
                    ) : (
                      <>
                        <span className="summary-label">{t('summary.tomorrow')}</span>
                        <span className="summary-date">
                          {tomorrowSummaryLabel.gregorian} • {tomorrowSummaryLabel.hebrew}
                        </span>
                      </>
                    )}
                  </button>
                </div>
                <div className="button-group" style={{ marginTop: '12px' }}>
                  <button
                    className="action-button summary-button"
                    onClick={() => executeCommand('lookahead')}
                    disabled={loadingCommand !== null}
                  >
                    {isLoading('lookahead') ? (
                      <Loader2 size={24} className="spinner" />
                    ) : (
                      <span className="summary-label">{t('summary.weekLookahead')}</span>
                    )}
                  </button>
                  <button
                    className="action-button summary-button"
                    onClick={() => executeCommand('nextweek')}
                    disabled={loadingCommand !== null}
                  >
                    {isLoading('nextweek') ? (
                      <Loader2 size={24} className="spinner" />
                    ) : (
                      <span className="summary-label">{t('summary.nextWeek')}</span>
                    )}
                  </button>
                </div>
              </Section>

              {/* Weather Section */}
              <Section
                title={t('weather.title')}
                subtitle={user.location}
                icon={<CloudSun size={20} />}
              >
                <div className="button-group">
                  <button
                    className="action-button"
                    onClick={() => executeCommand('weather')}
                    disabled={loadingCommand !== null}
                  >
                    {isLoading('weather') ? (
                      <Loader2 size={28} className="spinner" />
                    ) : (
                      <>
                        <span className="icon"><CloudSun size={32} /></span>
                        <span>{t('weather.forecast')}</span>
                      </>
                    )}
                  </button>
                </div>
              </Section>

              {/* Calendar Settings Card */}
              <Section title={t('settings.title')} icon={<ClipboardList size={20} />}>
                <div className="settings-card">
                  <div
                    onClick={() => handleSelectCalendars()}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="calendar-list-header">
                      <p>{t('settings.calendars', { count: user.calendarsCount })}</p>
                      <PencilLine size={16} className="inline-icon" style={{ opacity: 0.6 }} />
                    </div>
                    {calendarAssignments.length > 0 && (
                      <div className="calendar-list">
                        {calendarAssignments.map((cal) => (
                          <div key={cal.calendarId} className="calendar-item-compact">
                            <div
                              className="calendar-color-dot"
                              style={{ backgroundColor: cal.color }}
                            />
                            <span className="calendar-name-compact">{cal.name}</span>
                            <div className="calendar-icons-compact">
                              {cal.labels.map((label) => (
                                <CategoryIcon
                                  key={label}
                                  label={label as CalendarLabel}
                                  active={true}
                                  onClick={() => {}}
                                  disabled={true}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    className="renew-token-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConnectGoogle();
                    }}
                  >
                    <RefreshCw size={16} className="inline-icon" /> {t('settings.renewToken')}
                  </button>
                </div>
              </Section>

              {/* Subscription Card */}
              <Section title={tSub('title')} icon={<Crown size={20} />}>
                <div
                  className={`subscription-card ${isEarlyAdopter ? 'early-adopter' : trial.isTrialing ? 'trial' : ''}`}
                  onClick={handleOpenSubscription}
                >
                  <div className="subscription-header">
                    <div className="subscription-plan">
                      {isEarlyAdopter ? (
                        <Crown size={20} color="#10b981" />
                      ) : trial.isTrialing ? (
                        <Sparkles size={20} color="#667eea" />
                      ) : (
                        <Crown size={20} color={subscription?.plan === 'PRO' ? '#f59e0b' : subscription?.plan === 'BASIC' ? '#3b82f6' : '#6b7280'} />
                      )}
                      <span className="subscription-plan-name">
                        {subscription?.effectivePlan || 'FREE'}
                      </span>
                      {isEarlyAdopter ? (
                        <span className="subscription-badge early-adopter">{t('subscription.earlyAdopter')}</span>
                      ) : trial.isTrialing ? (
                        <span className="subscription-badge trial">{tSub('page.trialBadge')}</span>
                      ) : subscription?.status === 'ACTIVE' && subscription?.plan !== 'FREE' ? (
                        <span className="subscription-badge active">{tSub('page.currentPlanBadge')}</span>
                      ) : (
                        <span className="subscription-badge free">Free</span>
                      )}
                    </div>
                    {!isEarlyAdopter && (
                      <span className="subscription-action">
                        {trial.isTrialing || subscription?.plan === 'FREE' || !subscription ? tSub('upgradeButton') : tSub('managePlan')} →
                      </span>
                    )}
                  </div>
                  {!isEarlyAdopter && trial.isTrialing && trial.daysRemaining > 0 && (
                    <div className="trial-info">
                      <Sparkles size={14} />
                      <span className="trial-days">{trial.daysRemaining}</span> {t('subscription.daysRemaining') || 'days remaining in trial'}
                    </div>
                  )}
                </div>
              </Section>

            </>
          )}
        </div>
      </div>
    </TelegramLayout>
  );
}
