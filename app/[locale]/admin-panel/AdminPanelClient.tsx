'use client';

import { useEffect, useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2 } from 'lucide-react';
import { HDate } from 'hebcal';

// @ts-ignore - Hebcal doesn't export gematriya in types
import Hebcal from 'hebcal';

interface AdminPanelClientProps {
  userId: number;
  locale: string;
  stats: {
    totalUsers: number;
    usersWithOAuth: number;
    usersWithCalendars: number;
    needSetup: number;
  };
  recentUsers: Array<{
    name: string;
    createdAt: string;
    language: string;
    messagingPlatform: string;
  }>;
}

type ButtonState = 'idle' | 'loading' | 'success' | 'error';

export default function AdminPanelClient({ userId, locale, stats, recentUsers }: AdminPanelClientProps) {
  const t = useTranslations('admin');
  const [todayState, setTodayState] = useState<ButtonState>('idle');
  const [tomorrowState, setTomorrowState] = useState<ButtonState>('idle');

  // Format dates for today and tomorrow buttons
  const todayLabel = useMemo(() => {
    const now = new Date();
    const userLocale = locale === 'he' ? 'he-IL' : 'en-US';
    const greg = now.toLocaleDateString(userLocale, { month: 'short', day: 'numeric' });
    const dayOfWeek = now.toLocaleDateString(userLocale, { weekday: 'short' });
    const hdate = new HDate(now);
    const hebDay = locale === 'he' ? Hebcal.gematriya(hdate.getDate()) : hdate.getDate();
    const hebMonth = hdate.getMonthName('h');
    return `${dayOfWeek} ${greg} • ${hebDay} ${hebMonth}`;
  }, [locale]);

  const tomorrowLabel = useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const userLocale = locale === 'he' ? 'he-IL' : 'en-US';
    const greg = tomorrow.toLocaleDateString(userLocale, { month: 'short', day: 'numeric' });
    const dayOfWeek = tomorrow.toLocaleDateString(userLocale, { weekday: 'short' });
    const hdate = new HDate(tomorrow);
    const hebDay = locale === 'he' ? Hebcal.gematriya(hdate.getDate()) : hdate.getDate();
    const hebMonth = hdate.getMonthName('h');
    return `${dayOfWeek} ${greg} • ${hebDay} ${hebMonth}`;
  }, [locale]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();
      tg.ready();
      tg.setHeaderColor('#667eea');
      tg.setBackgroundColor('#ffffff');
    }
  }, []);

  const testModel = async (timeframe: 'today' | 'tmrw') => {
    const setState = timeframe === 'today' ? setTodayState : setTomorrowState;
    setState('loading');

    try {
      const response = await fetch('/api/execute-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          command: 'testai',
          args: timeframe === 'tmrw' ? 'tmrw' : undefined,
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to execute command');
      }

      setState('success');

      // Auto-close after 1 second
      setTimeout(() => {
        if (window.Telegram?.WebApp) {
          window.Telegram.WebApp.close();
        }
      }, 1000);

    } catch (error) {
      setState('error');
      console.error('Command failed:', error);

      // Reset after 2 seconds
      setTimeout(() => {
        setState('idle');
      }, 2000);
    }
  };

  const openUserDashboard = () => {
    window.location.href = `/dashboard?user_id=${userId}`;
  };

  const getButtonContent = (state: ButtonState, label: string) => {
    switch (state) {
      case 'loading':
        return t('testing.sending');
      case 'success':
        return t('testing.sent');
      case 'error':
        return t('testing.error');
      default:
        return label;
    }
  };

  const getButtonStyle = (state: ButtonState) => {
    switch (state) {
      case 'success':
        return { background: '#22c55e' };
      case 'error':
        return { background: '#ef4444' };
      case 'loading':
        return { opacity: 0.6 };
      default:
        return {};
    }
  };

  return (
    <>
      <style jsx>{`
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        .admin-panel {
          max-width: 600px;
          margin: 0 auto;
          background: white;
          min-height: 100vh;
          font-family: 'Rubik', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
        }

        header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        header h1 {
          font-size: 24px;
          font-weight: 600;
        }

        .admin-badge {
          background: rgba(255, 255, 255, 0.3);
          padding: 6px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 1px;
        }

        .admin-content {
          padding: 20px;
        }

        .section {
          margin-bottom: 30px;
        }

        .section-title {
          font-size: 18px;
          font-weight: 600;
          color: #111827;
          margin-bottom: 12px;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 16px;
        }

        .stat-card {
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          padding: 20px;
          text-align: center;
        }

        .stat-value {
          font-size: 32px;
          font-weight: 700;
          color: #667eea;
          margin-bottom: 4px;
        }

        .stat-label {
          font-size: 13px;
          color: #6b7280;
          font-weight: 500;
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
          padding: 16px;
          cursor: pointer;
          transition: all 0.2s;
          font-size: 15px;
          font-weight: 500;
          color: #111827;
        }

        .action-button:hover:not(:disabled) {
          border-color: #667eea;
          background: #f9fafb;
          transform: translateY(-2px);
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .action-button:disabled {
          cursor: not-allowed;
        }

        .health-list {
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          overflow: hidden;
        }

        .health-item {
          padding: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #e5e7eb;
        }

        .health-item:last-child {
          border-bottom: none;
        }

        .health-label {
          font-size: 14px;
          color: #374151;
          font-weight: 500;
        }

        .status-icon {
          font-size: 20px;
        }

        .user-list {
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          overflow: hidden;
        }

        .user-item {
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
        }

        .user-item:last-child {
          border-bottom: none;
        }

        .user-name {
          font-size: 14px;
          font-weight: 600;
          color: #111827;
          margin-bottom: 4px;
        }

        .user-meta {
          font-size: 12px;
          color: #6b7280;
        }

        .dashboard-btn {
          width: 100%;
          padding: 15px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
          margin-top: 16px;
        }

        .dashboard-btn:hover {
          background: #5a67d8;
        }

        .subsection-title {
          font-size: 14px;
          font-weight: 600;
          color: #6b7280;
          margin-bottom: 8px;
        }

        @media (max-width: 400px) {
          .stats-grid,
          .button-group {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="admin-panel">
        <header>
          <h1>{t('title')}</h1>
          <div className="admin-badge">{t('badge')}</div>
        </header>

        <div className="admin-content">
          {/* AI Model Testing Section */}
          <div className="section">
            <h2 className="section-title">{t('testing.title')}</h2>
            <div className="button-group">
              <button
                className="action-button"
                onClick={() => testModel('today')}
                disabled={todayState !== 'idle'}
                style={getButtonStyle(todayState)}
              >
                {getButtonContent(todayState, todayLabel)}
              </button>
              <button
                className="action-button"
                onClick={() => testModel('tmrw')}
                disabled={tomorrowState !== 'idle'}
                style={getButtonStyle(tomorrowState)}
              >
                {getButtonContent(tomorrowState, tomorrowLabel)}
              </button>
            </div>
          </div>

          {/* User Statistics Section */}
          <div className="section">
            <h2 className="section-title">{t('statistics.title')}</h2>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{stats.totalUsers}</div>
                <div className="stat-label">{t('statistics.totalUsers')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.usersWithOAuth}</div>
                <div className="stat-label">{t('statistics.withOAuth')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.usersWithCalendars}</div>
                <div className="stat-label">{t('statistics.withCalendars')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.needSetup}</div>
                <div className="stat-label">{t('statistics.needSetup')}</div>
              </div>
            </div>

            <h3 className="subsection-title">{t('statistics.recentUsers')}</h3>
            <div className="user-list">
              {recentUsers.map((user, index) => (
                <div key={index} className="user-item">
                  <div className="user-name">{user.name}</div>
                  <div className="user-meta">
                    {new Date(user.createdAt).toLocaleDateString()} •{' '}
                    {user.language} •{' '}
                    {user.messagingPlatform}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* System Health Section */}
          <div className="section">
            <h2 className="section-title">{t('health.title')}</h2>
            <div className="health-list">
              <div className="health-item">
                <span className="health-label">{t('health.database')}</span>
                <span className="status-icon"><CheckCircle2 size={20} color="#22c55e" /></span>
              </div>
              <div className="health-item">
                <span className="health-label">{t('health.totalUsers')}</span>
                <span className="health-label">{stats.totalUsers}</span>
              </div>
              <div className="health-item">
                <span className="health-label">{t('health.setupCompletion')}</span>
                <span className="health-label">
                  {Math.round((stats.usersWithCalendars / stats.totalUsers) * 100)}%
                </span>
              </div>
            </div>
          </div>

          {/* User Dashboard Link */}
          <button className="dashboard-btn" onClick={openUserDashboard}>
            {t('openDashboard')}
          </button>
        </div>
      </div>
    </>
  );
}
