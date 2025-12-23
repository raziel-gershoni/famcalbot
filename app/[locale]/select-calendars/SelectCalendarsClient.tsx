'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TelegramLayout } from '@/components/Layout';
import CategoryIcon from '@/components/Forms/CategoryIcon';
import { CalendarLabel, CalendarAssignment } from '@/src/types';
import { validateCalendarAssignments } from '@/src/utils/calendar-helpers';

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
    selectedCalendars: Set<string>;
    calendarLabels: Map<string, Set<CalendarLabel>>;
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
  const [selectedCalendars, setSelectedCalendars] = useState<Set<string>>(
    currentSelections.selectedCalendars
  );
  const [calendarLabels, setCalendarLabels] = useState<Map<string, Set<CalendarLabel>>>(
    currentSelections.calendarLabels
  );

  // Toggle calendar checkbox
  const handleCalendarToggle = (calendarId: string) => {
    setSelectedCalendars(prev => {
      const newSet = new Set(prev);
      if (newSet.has(calendarId)) {
        // Unchecking: Remove from selected AND remove all labels
        newSet.delete(calendarId);
        setCalendarLabels(prevLabels => {
          const newLabels = new Map(prevLabels);
          newLabels.delete(calendarId);
          return newLabels;
        });
      } else {
        // Checking: Add to selected (no labels yet)
        newSet.add(calendarId);
      }
      return newSet;
    });
  };

  // Toggle category label
  const handleLabelToggle = (calendarId: string, label: CalendarLabel) => {
    setCalendarLabels(prev => {
      const newLabels = new Map(prev);
      const labels = new Set(newLabels.get(calendarId) || []);

      if (label === 'primary') {
        // Radio behavior: Remove primary from all others
        for (const [otherCalId, otherLabels] of newLabels) {
          if (otherCalId !== calendarId) {
            otherLabels.delete('primary');
          }
        }
        // Add to this calendar
        labels.add('primary');
        // Force-add 'yours' as well (primary must be in yours)
        labels.add('yours');
      } else {
        // Toggle behavior
        if (labels.has(label)) {
          // Removing: Check if primary+yours edge case
          if (label === 'yours' && labels.has('primary')) {
            alert(t('validation.primaryMustBeYours'));
            return prev; // Don't remove
          }
          labels.delete(label);
        } else {
          // Adding: Check mutual exclusivity
          const mutuallyExclusive: CalendarLabel[] = ['yours', 'spouse', 'kids', 'birthdays'];
          for (const other of mutuallyExclusive) {
            if (other !== label && labels.has(other)) {
              labels.delete(other); // Auto-remove conflicting label
            }
          }
          labels.add(label);
        }
      }

      newLabels.set(calendarId, labels);
      return newLabels;
    });
  };

  // Validation before submit
  const validateSelection = (): { valid: boolean; error?: string } => {
    // At least one calendar must be selected
    if (selectedCalendars.size === 0) {
      return { valid: false, error: t('validation.noneSelected') };
    }

    // At least one calendar must have 'yours' label
    const hasYours = Array.from(calendarLabels.values())
      .some(labels => labels.has('yours'));
    if (!hasYours) {
      return { valid: false, error: t('validation.yours') };
    }

    // Must have exactly one primary
    const primaryCount = Array.from(calendarLabels.values())
      .filter(labels => labels.has('primary')).length;
    if (primaryCount === 0) {
      return { valid: false, error: t('validation.primary') };
    }

    return { valid: true };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    const validation = validateSelection();
    if (!validation.valid) {
      alert(validation.error);
      return;
    }

    setFormState('submitting');

    try {
      // Build calendarAssignments array
      const calendarAssignments: CalendarAssignment[] = Array.from(selectedCalendars).map(calId => {
        const calendar = availableCalendars.find(c => c.id === calId);
        const labels = Array.from(calendarLabels.get(calId) || []);

        return {
          calendarId: calId,
          labels: labels,
          name: calendar?.name || calId,
          color: calendar?.backgroundColor || '#4285f4'
        };
      });

      // Server-side validation
      const serverValidation = validateCalendarAssignments(calendarAssignments);
      if (!serverValidation.valid) {
        alert(serverValidation.errors[0]);
        setFormState('idle');
        return;
      }

      const response = await fetch(`/api/select-calendars?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarAssignments
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save calendars');
      }

      setFormState('success');

      // Auto-close after 2 seconds
      setTimeout(() => {
        if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
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
          .success-box {
            background: white;
            padding: 40px;
            border-radius: 15px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 500px;
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
          <div className="success-box">
            <div className="icon">✅</div>
            <h1>{t('actions.saved')}</h1>
            <div className="user-info">
              <strong>{userName}</strong><br />
              {t('successMessage')}
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
          margin-bottom: 20px;
          font-size: 14px;
        }
        .help-text {
          color: #6b7280;
          font-size: 13px;
          margin-bottom: 20px;
          padding: 12px;
          background: #f9fafb;
          border-radius: 8px;
          border-left: 3px solid #667eea;
        }
        .calendar-list {
          margin-bottom: 30px;
        }
        .calendar-item {
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          padding: 16px;
          margin-bottom: 12px;
          transition: all 0.2s;
        }
        .calendar-item.selected {
          border-color: #667eea;
          background: #f9fafb;
        }
        .calendar-header {
          display: flex;
          align-items: center;
          gap: 12px;
          cursor: pointer;
        }
        .checkbox {
          width: 20px;
          height: 20px;
          cursor: pointer;
        }
        .calendar-color {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .calendar-info {
          flex: 1;
        }
        .calendar-name {
          font-weight: 600;
          color: #111827;
          font-size: 15px;
        }
        .calendar-desc {
          font-size: 13px;
          color: #6b7280;
          margin-top: 2px;
        }
        .label-icons {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #e5e7eb;
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
          opacity: 0.6;
          cursor: not-allowed;
        }
        .btn-error {
          background: #ef4444;
        }
      `}</style>

      <div className="page-container">
        <div className="container">
          <h1>{t('title')}</h1>
          <p className="subtitle">{t('subtitle')}</p>

          <div className="help-text">
            {t('categoryHelp')}
          </div>

          <form onSubmit={handleSubmit}>
            <div className="calendar-list">
              {availableCalendars.map(calendar => {
                const isSelected = selectedCalendars.has(calendar.id);
                const labels = calendarLabels.get(calendar.id) || new Set();

                return (
                  <div
                    key={calendar.id}
                    className={`calendar-item ${isSelected ? 'selected' : ''}`}
                  >
                    <div
                      className="calendar-header"
                      onClick={() => handleCalendarToggle(calendar.id)}
                    >
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={isSelected}
                        onChange={() => {}} // Handled by parent div click
                      />
                      <div
                        className="calendar-color"
                        style={{ background: calendar.backgroundColor }}
                      />
                      <div className="calendar-info">
                        <div className="calendar-name">{calendar.name}</div>
                        {calendar.description && (
                          <div className="calendar-desc">{calendar.description}</div>
                        )}
                      </div>
                    </div>

                    {isSelected && (
                      <div className="label-icons">
                        <CategoryIcon
                          label="primary"
                          active={labels.has('primary')}
                          onClick={() => handleLabelToggle(calendar.id, 'primary')}
                        />
                        <CategoryIcon
                          label="yours"
                          active={labels.has('yours')}
                          onClick={() => handleLabelToggle(calendar.id, 'yours')}
                        />
                        <CategoryIcon
                          label="spouse"
                          active={labels.has('spouse')}
                          onClick={() => handleLabelToggle(calendar.id, 'spouse')}
                        />
                        <CategoryIcon
                          label="kids"
                          active={labels.has('kids')}
                          onClick={() => handleLabelToggle(calendar.id, 'kids')}
                        />
                        <CategoryIcon
                          label="birthdays"
                          active={labels.has('birthdays')}
                          onClick={() => handleLabelToggle(calendar.id, 'birthdays')}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
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
