'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TelegramLayout } from '@/components/Layout';

interface Calendar {
  id: string;
  name: string;
  description?: string;
  backgroundColor: string;
  primary?: boolean;
  accessRole?: string;
}

interface SelectCalendarsClientProps {
  userId: number;
  userName: string;
  availableCalendars: Calendar[];
  currentSelections: {
    primary: string;
    own: string[];
    spouse: string[];
  };
}

type FormState = 'idle' | 'submitting' | 'success' | 'error';

export default function SelectCalendarsClient({
  userId,
  userName,
  availableCalendars,
  currentSelections
}: SelectCalendarsClientProps) {
  const t = useTranslations('calendars');
  const [formState, setFormState] = useState<FormState>('idle');
  const [primary, setPrimary] = useState(
    currentSelections.primary ||
    availableCalendars.find(cal => cal.primary)?.id ||
    ''
  );
  const [ownCalendars, setOwnCalendars] = useState<string[]>(
    currentSelections.own.length > 0
      ? currentSelections.own
      : availableCalendars
          .filter(cal => cal.accessRole === 'owner' || cal.accessRole === 'writer')
          .map(cal => cal.id)
  );
  const [spouseCalendars, setSpouseCalendars] = useState<string[]>(currentSelections.spouse);

  const handlePrimaryChange = (calendarId: string) => {
    setPrimary(calendarId);
    // Auto-check in "Own Calendars" when selected as primary
    if (!ownCalendars.includes(calendarId)) {
      setOwnCalendars([...ownCalendars, calendarId]);
    }
  };

  const handleOwnCalendarToggle = (calendarId: string) => {
    setOwnCalendars(prev =>
      prev.includes(calendarId)
        ? prev.filter(id => id !== calendarId)
        : [...prev, calendarId]
    );
  };

  const handleSpouseCalendarToggle = (calendarId: string) => {
    setSpouseCalendars(prev =>
      prev.includes(calendarId)
        ? prev.filter(id => id !== calendarId)
        : [...prev, calendarId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!primary) {
      alert(t('validation.primary'));
      return;
    }

    if (ownCalendars.length === 0) {
      alert(t('validation.own'));
      return;
    }

    setFormState('submitting');

    try {
      const response = await fetch(`/api/select-calendars?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primary,
          own_calendars: ownCalendars,
          spouse_calendars: spouseCalendars
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save calendars');
      }

      setFormState('success');

      // Auto-close after 2 seconds
      setTimeout(() => {
        if (window.Telegram?.WebApp) {
          window.Telegram.WebApp.close();
        }
      }, 2000);

    } catch (error) {
      console.error('Error saving calendars:', error);
      setFormState('error');

      // Reset after 3 seconds
      setTimeout(() => {
        setFormState('idle');
      }, 3000);
    }
  };

  if (formState === 'success') {
    return (
      <TelegramLayout>
        <style jsx>{`
          .success-container {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container { max-width: 500px; width: 100%; }
          .success-box {
            background: white;
            padding: 40px;
            border-radius: 15px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
          }
          .icon {
            font-size: 64px;
            margin-bottom: 20px;
            animation: bounce 1s;
          }
          @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
          }
          h1 { color: #22c55e; margin: 0 0 10px 0; }
          p { color: #666; line-height: 1.6; }
          .user-info {
            background: #f9fafb;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
          }
        `}</style>
        <div className="success-container">
          <div className="container">
            <div className="success-box">
              <div className="icon">✅</div>
              <h1>{t('actions.saved')}</h1>
              <div className="user-info">
                <strong>{userName}</strong><br />
                {t('successMessage')}
              </div>
            </div>
          </div>
        </div>
      </TelegramLayout>
    );
  }

  return (
    <TelegramLayout>
      <style jsx>{`
        .page-container {
          min-height: 100vh;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: white;
          padding: 30px;
          border-radius: 15px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        h1 {
          color: #667eea;
          margin: 0 0 10px 0;
          font-size: 24px;
        }
        .subtitle {
          color: #6b7280;
          margin-bottom: 30px;
        }
        .section {
          margin-bottom: 30px;
        }
        .section-title {
          font-weight: 600;
          color: #374151;
          margin-bottom: 15px;
          font-size: 16px;
        }
        .calendar-item {
          display: flex;
          align-items: center;
          padding: 12px;
          border: 2px solid #e5e7eb;
          border-radius: 8px;
          margin-bottom: 10px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .calendar-item:hover {
          border-color: #667eea;
          background: #f9fafb;
        }
        .calendar-item.selected {
          border-color: #667eea;
          background: #ede9fe;
        }
        .calendar-color {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          margin-right: 12px;
          flex-shrink: 0;
        }
        .calendar-info {
          flex: 1;
        }
        .calendar-name {
          font-weight: 500;
          color: #111827;
        }
        .calendar-desc {
          font-size: 13px;
          color: #6b7280;
        }
        input[type="checkbox"],
        input[type="radio"] {
          margin-right: 12px;
          width: 18px;
          height: 18px;
          cursor: pointer;
        }
        .btn {
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
        }
        .btn:hover:not(:disabled) {
          background: #5a67d8;
        }
        .btn:disabled {
          background: #9ca3af;
          cursor: not-allowed;
          opacity: 0.6;
        }
        .btn-error {
          background: #ef4444;
        }
        .help-text {
          font-size: 13px;
          color: #6b7280;
          margin-top: 8px;
        }
        .badge {
          display: inline-block;
          padding: 2px 8px;
          background: #dbeafe;
          color: #1e40af;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          margin-left: 8px;
        }
      `}</style>

      <div className="page-container">
        <div className="container">
        <h1>{t('title')}</h1>
        <p className="subtitle">{t('subtitle')}</p>

        <form onSubmit={handleSubmit}>
          {/* Primary Calendar Selection */}
          <div className="section">
            <div className="section-title">{t('ownership.primaryLabel')}</div>
            <p className="help-text">{t('ownership.primaryHelp')}</p>

            {availableCalendars.map(cal => (
              <label
                key={`primary-${cal.id}`}
                className={`calendar-item ${primary === cal.id ? 'selected' : ''}`}
                onClick={() => handlePrimaryChange(cal.id)}
              >
                <input
                  type="radio"
                  name="primary"
                  value={cal.id}
                  checked={primary === cal.id}
                  onChange={() => {}}
                  disabled={formState !== 'idle'}
                />
                <div className="calendar-color" style={{ backgroundColor: cal.backgroundColor }} />
                <div className="calendar-info">
                  <div className="calendar-name">
                    {cal.name}
                    {cal.primary && <span className="badge">PRIMARY</span>}
                  </div>
                  {cal.description && <div className="calendar-desc">{cal.description}</div>}
                </div>
              </label>
            ))}
          </div>

          {/* Own Calendars */}
          <div className="section">
            <div className="section-title">{t('ownership.ownLabel')}</div>
            <p className="help-text">{t('ownership.ownHelp')}</p>

            {availableCalendars.map(cal => (
              <label
                key={`own-${cal.id}`}
                className={`calendar-item ${ownCalendars.includes(cal.id) ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  name="own_calendars"
                  value={cal.id}
                  checked={ownCalendars.includes(cal.id)}
                  onChange={() => handleOwnCalendarToggle(cal.id)}
                  disabled={formState !== 'idle'}
                />
                <div className="calendar-color" style={{ backgroundColor: cal.backgroundColor }} />
                <div className="calendar-info">
                  <div className="calendar-name">{cal.name}</div>
                  {cal.description && <div className="calendar-desc">{cal.description}</div>}
                </div>
              </label>
            ))}
          </div>

          {/* Spouse Calendars (optional) */}
          <div className="section">
            <div className="section-title">{t('ownership.spouseLabel')}</div>
            <p className="help-text">{t('ownership.spouseHelp')}</p>

            {availableCalendars.map(cal => (
              <label
                key={`spouse-${cal.id}`}
                className={`calendar-item ${spouseCalendars.includes(cal.id) ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  name="spouse_calendars"
                  value={cal.id}
                  checked={spouseCalendars.includes(cal.id)}
                  onChange={() => handleSpouseCalendarToggle(cal.id)}
                  disabled={formState !== 'idle'}
                />
                <div className="calendar-color" style={{ backgroundColor: cal.backgroundColor }} />
                <div className="calendar-info">
                  <div className="calendar-name">{cal.name}</div>
                  {cal.description && <div className="calendar-desc">{cal.description}</div>}
                </div>
              </label>
            ))}
          </div>

          <button
            type="submit"
            className={`btn ${formState === 'error' ? 'btn-error' : ''}`}
            disabled={formState !== 'idle'}
          >
            {formState === 'submitting' && t('actions.saving')}
            {formState === 'error' && t('actions.error')}
            {formState === 'idle' && t('actions.save')}
          </button>
        </form>
        </div>
      </div>
    </TelegramLayout>
  );
}
