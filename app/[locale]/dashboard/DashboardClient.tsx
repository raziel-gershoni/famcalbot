'use client';

import { useTranslations } from 'next-intl';
import { TelegramLayout, Header } from '@/components/Layout';
import { Section } from '@/components/UI';
import { LoadingButton } from '@/components/Feedback';
import { useRouter } from 'next/navigation';
import CategoryIcon from '@/components/Forms/CategoryIcon';
import { CalendarAssignment, CalendarLabel } from '@/src/types';
import { KeyRound, Calendar, Sun, Moon, CloudSun, Gauge, FileText, RefreshCw, PencilLine } from 'lucide-react';

interface User {
  id: number;
  name: string;
  location: string;
  calendarsCount: number;
  isAdmin: boolean;
}

interface DashboardClientProps {
  user: User;
  calendarAssignments: CalendarAssignment[];
  locale: string;
  needsOAuth: boolean;
  needsCalendars: boolean;
}

export default function DashboardClient({
  user,
  calendarAssignments,
  locale,
  needsOAuth,
  needsCalendars,
}: DashboardClientProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();

  const executeCommand = async (command: string, args?: string) => {
    // Close webapp immediately for better UX
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      window.Telegram.WebApp.close();
    }

    // Execute command in background (non-blocking)
    fetch('/api/execute-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: user.id,
        command,
        args,
      }),
    }).catch((error) => {
      console.error('Command execution error:', error);
    });
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

          @media (max-width: 400px) {
            .button-group {
              grid-template-columns: 1fr;
            }
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
              {/* Summary Section */}
              <Section title={t('summary.title')} icon={<Calendar size={20} />}>
                <div className="button-group">
                  <button
                    className="action-button"
                    onClick={() => executeCommand('summary')}
                  >
                    <span className="icon"><Sun size={32} /></span>
                    <span>{t('summary.today')}</span>
                  </button>
                  <button
                    className="action-button"
                    onClick={() => executeCommand('summary', 'tmrw')}
                  >
                    <span className="icon"><Moon size={32} /></span>
                    <span>{t('summary.tomorrow')}</span>
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
                    onClick={() => executeCommand('weather', 'std')}
                  >
                    <span className="icon"><Gauge size={32} /></span>
                    <span>{t('weather.standard')}</span>
                  </button>
                  <button
                    className="action-button"
                    onClick={() => executeCommand('weather', 'dtl')}
                  >
                    <span className="icon"><FileText size={32} /></span>
                    <span>{t('weather.detailed')}</span>
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
            </>
          )}
        </div>
      </div>
    </TelegramLayout>
  );
}
