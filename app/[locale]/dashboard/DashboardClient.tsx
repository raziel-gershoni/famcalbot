'use client';

import { useTranslations } from 'next-intl';
import { TelegramLayout, Header } from '@/components/Layout';
import { Section } from '@/components/UI';
import { LoadingButton } from '@/components/Feedback';
import { useRouter } from 'next/navigation';

interface User {
  id: number;
  name: string;
  location: string;
  calendarsCount: number;
}

interface DashboardClientProps {
  user: User;
  needsOAuth: boolean;
  needsCalendars: boolean;
}

export default function DashboardClient({
  user,
  needsOAuth,
  needsCalendars,
}: DashboardClientProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();

  const executeCommand = async (command: string, args?: string) => {
    const response = await fetch('/api/execute-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: user.id,
        command,
        args,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to execute command');
    }

    // Close webapp after successful execution
    setTimeout(() => {
      if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
        window.Telegram.WebApp.close();
      }
    }, 1500);
  };

  const handleOpenSettings = () => {
    router.push(`/settings?user_id=${user.id}`);
  };

  const handleConnectGoogle = () => {
    router.push(`/refresh-token?user_id=${user.id}`);
  };

  const handleSelectCalendars = () => {
    router.push(`/select-calendars?user_id=${user.id}`);
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

          .card-content {
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .card-content p {
            color: #6b7280;
            font-size: 14px;
          }

          .arrow {
            font-size: 20px;
            color: #9ca3af;
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
        />

        <div className="dashboard-content">
          {needsOAuth ? (
            <div className="setup-card" onClick={handleConnectGoogle}>
              <h3>🔐 {t('setup.connectGoogle')}</h3>
              <p>{t('setup.connectGoogleDesc')}</p>
            </div>
          ) : needsCalendars ? (
            <div className="setup-card" onClick={handleSelectCalendars}>
              <h3>📅 {t('setup.selectCalendars')}</h3>
              <p>{t('setup.selectCalendarsDesc')}</p>
            </div>
          ) : (
            <>
              {/* Summary Section */}
              <Section title={t('summary.title')} icon="📅">
                <div className="button-group">
                  <button
                    className="action-button"
                    onClick={() => executeCommand('summary')}
                  >
                    <span className="icon">☀️</span>
                    <span>{t('summary.today')}</span>
                  </button>
                  <button
                    className="action-button"
                    onClick={() => executeCommand('summary', 'tmrw')}
                  >
                    <span className="icon">🌙</span>
                    <span>{t('summary.tomorrow')}</span>
                  </button>
                </div>
              </Section>

              {/* Weather Section */}
              <Section
                title={t('weather.title')}
                subtitle={user.location}
                icon="🌤️"
              >
                <div className="button-group">
                  <button
                    className="action-button"
                    onClick={() => executeCommand('weather', 'std')}
                  >
                    <span className="icon">📊</span>
                    <span>{t('weather.standard')}</span>
                  </button>
                  <button
                    className="action-button"
                    onClick={() => executeCommand('weather', 'dtl')}
                  >
                    <span className="icon">📋</span>
                    <span>{t('weather.detailed')}</span>
                  </button>
                </div>
              </Section>

              {/* Calendar Settings Card */}
              <Section title={t('settings.title')} icon="📋">
                <div
                  className="settings-card"
                  onClick={() => handleSelectCalendars()}
                >
                  <div className="card-content">
                    <p>
                      {t('settings.calendars', { count: user.calendarsCount })}
                    </p>
                    <span className="arrow">→</span>
                  </div>
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </TelegramLayout>
  );
}
