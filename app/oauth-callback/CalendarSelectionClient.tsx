'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Calendar {
  id: string;
  name: string;
  description?: string;
  backgroundColor: string;
  primary?: boolean;
  accessRole?: string;
}

interface CalendarSelectionClientProps {
  userId: number;
  stateToken: string;
  availableCalendars: Calendar[];
  currentSelections: {
    primary: string;
    own: string[];
    spouse: string[];
  };
}

export default function CalendarSelectionClient({
  userId,
  stateToken,
  availableCalendars,
  currentSelections
}: CalendarSelectionClientProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // Initialize Telegram WebApp
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();
      tg.ready();
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const primarySelected = formData.get('primary');
    const ownSelected = formData.getAll('own_calendars');

    if (!primarySelected) {
      alert('Please select a primary calendar');
      return;
    }

    if (ownSelected.length === 0) {
      alert('Please select at least one of your calendars');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/refresh-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          state_token: stateToken,
          primary: formData.get('primary'),
          own_calendars: formData.getAll('own_calendars'),
          spouse_calendars: formData.getAll('spouse_calendars')
        })
      });

      if (response.ok) {
        // Redirect to success page
        router.push(`/oauth-success?user_id=${userId}`);
      } else {
        const error = await response.text();
        alert(`Error: ${error}`);
        setIsSubmitting(false);
      }
    } catch (error) {
      alert(`Error submitting form: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsSubmitting(false);
    }
  };

  const selectPrimary = (calendarId: string) => {
    // Auto-check in "Own Calendars" when selected as primary
    const checkbox = document.querySelector<HTMLInputElement>(
      `input[name="own_calendars"][value="${calendarId}"]`
    );
    if (checkbox) {
      checkbox.checked = true;
    }
  };

  return (
    <html>
      <head>
        <title>Select Calendars</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>{`
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            margin: 0;
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
          .btn:hover {
            background: #5a67d8;
          }
          .btn:disabled {
            background: #9ca3af;
            cursor: not-allowed;
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
      </head>
      <body>
        <div className="container">
          <h1>📅 Select Your Calendars</h1>
          <p className="subtitle">Choose which calendars to sync with your bot</p>

          <form onSubmit={handleSubmit}>
            {/* Primary Calendar Selection */}
            <div className="section">
              <div className="section-title">Primary Calendar</div>
              <p className="help-text">Your main personal calendar (used as default)</p>

              {availableCalendars.map((cal) => (
                <label
                  key={`primary-${cal.id}`}
                  className="calendar-item"
                  onClick={() => selectPrimary(cal.id)}
                >
                  <input
                    type="radio"
                    name="primary"
                    value={cal.id}
                    defaultChecked={
                      cal.id === currentSelections.primary ||
                      (cal.primary && !currentSelections.primary)
                    }
                  />
                  <div
                    className="calendar-color"
                    style={{ backgroundColor: cal.backgroundColor }}
                  ></div>
                  <div className="calendar-info">
                    <div className="calendar-name">
                      {cal.name}
                      {cal.primary && <span className="badge">PRIMARY</span>}
                    </div>
                    {cal.description && (
                      <div className="calendar-desc">{cal.description}</div>
                    )}
                  </div>
                </label>
              ))}
            </div>

            {/* Own Calendars */}
            <div className="section">
              <div className="section-title">Your Calendars</div>
              <p className="help-text">Select your personal and work calendars</p>

              {availableCalendars.map((cal) => (
                <label key={`own-${cal.id}`} className="calendar-item">
                  <input
                    type="checkbox"
                    name="own_calendars"
                    value={cal.id}
                    defaultChecked={
                      currentSelections.own.includes(cal.id) ||
                      (!currentSelections.own.length &&
                        (cal.accessRole === 'owner' || cal.accessRole === 'writer'))
                    }
                  />
                  <div
                    className="calendar-color"
                    style={{ backgroundColor: cal.backgroundColor }}
                  ></div>
                  <div className="calendar-info">
                    <div className="calendar-name">{cal.name}</div>
                    {cal.description && (
                      <div className="calendar-desc">{cal.description}</div>
                    )}
                  </div>
                </label>
              ))}
            </div>

            {/* Spouse Calendars (optional) */}
            <div className="section">
              <div className="section-title">Spouse&apos;s Calendars (Optional)</div>
              <p className="help-text">Select calendars belonging to your spouse</p>

              {availableCalendars.map((cal) => (
                <label key={`spouse-${cal.id}`} className="calendar-item">
                  <input
                    type="checkbox"
                    name="spouse_calendars"
                    value={cal.id}
                    defaultChecked={currentSelections.spouse.includes(cal.id)}
                  />
                  <div
                    className="calendar-color"
                    style={{ backgroundColor: cal.backgroundColor }}
                  ></div>
                  <div className="calendar-info">
                    <div className="calendar-name">{cal.name}</div>
                    {cal.description && (
                      <div className="calendar-desc">{cal.description}</div>
                    )}
                  </div>
                </label>
              ))}
            </div>

            <button type="submit" className="btn" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save Calendar Selection'}
            </button>
          </form>
        </div>
      </body>
    </html>
  );
}
