'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { TelegramLayout, Header } from '@/components/Layout';
import { Calendar, Pencil, ChevronDown, ChevronUp } from 'lucide-react';
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

interface SpouseMetadata {
  personName?: string;
  personEnglishName?: string;
  personGender?: 'male' | 'female';
}

interface CalendarRules {
  [calendarId: string]: string;
}

interface SelectCalendarsClientProps {
  userId: number;
  userName: string;
  availableCalendars: Calendar[];
  currentSelections: {
    selectedCalendars: Set<string>;
    calendarLabels: Map<string, Set<CalendarLabel>>;
    spouseMetadata: Map<string, SpouseMetadata>;
    calendarRules: Map<string, string>;
  };
  locale: string;
}

interface FeedbackMessage {
  text: string;
  type: 'success' | 'error';
  id: number;
}

export default function SelectCalendarsClient({
  userId,
  userName,
  availableCalendars,
  currentSelections,
  locale
}: SelectCalendarsClientProps) {
  const t = useTranslations('calendars');
  const router = useRouter();
  const [selectedCalendars, setSelectedCalendars] = useState<Set<string>>(
    currentSelections.selectedCalendars
  );
  const [calendarLabels, setCalendarLabels] = useState<Map<string, Set<CalendarLabel>>>(
    currentSelections.calendarLabels
  );
  const [spouseMetadata, setSpouseMetadata] = useState<Map<string, SpouseMetadata>>(
    currentSelections.spouseMetadata
  );
  const [calendarRules, setCalendarRules] = useState<Map<string, string>>(
    currentSelections.calendarRules
  );
  const [feedbackMessages, setFeedbackMessages] = useState<FeedbackMessage[]>([]);
  const [messageIdCounter, setMessageIdCounter] = useState(0);
  // Track which panels are expanded (collapsed by default if data exists)
  const [expandedSpouse, setExpandedSpouse] = useState<Set<string>>(new Set());
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());

  const handleBack = () => {
    router.push(`/${locale}/dashboard?user_id=${userId}`);
  };

  // Show feedback message
  const showFeedback = (text: string, type: 'success' | 'error' = 'success') => {
    const id = messageIdCounter;
    setMessageIdCounter(prev => prev + 1);

    const message: FeedbackMessage = { text, type, id };
    setFeedbackMessages(prev => [...prev, message]);

    // Auto-dismiss after 3 seconds
    setTimeout(() => {
      setFeedbackMessages(prev => prev.filter(m => m.id !== id));
    }, 3000);
  };

  // Save current state to server
  const saveToServer = async (
    newSelectedCalendars: Set<string>,
    newCalendarLabels: Map<string, Set<CalendarLabel>>,
    newSpouseMetadata?: Map<string, SpouseMetadata>,
    newCalendarRules?: Map<string, string>
  ) => {
    const metadataToUse = newSpouseMetadata || spouseMetadata;
    const rulesToUse = newCalendarRules || calendarRules;
    try {
      const calendarAssignments: CalendarAssignment[] = Array.from(newSelectedCalendars).map(calId => {
        const calendar = availableCalendars.find(c => c.id === calId);
        const labels = Array.from(newCalendarLabels.get(calId) || []);
        const metadata = metadataToUse.get(calId);
        const rule = rulesToUse.get(calId);

        return {
          calendarId: calId,
          labels: labels,
          name: calendar?.name || calId,
          color: calendar?.backgroundColor || '#4285f4',
          // Include spouse metadata if this is a spouse calendar
          ...(labels.includes('spouse') && metadata ? {
            personName: metadata.personName,
            personEnglishName: metadata.personEnglishName,
            personGender: metadata.personGender,
          } : {}),
          // Include rule if present
          ...(rule ? { rules: [rule] } : {})
        };
      });

      // Get Telegram Web App initData for authentication
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;

      const response = await fetch(`/api/select-calendars?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarAssignments, initData })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save');
      }

      return true;
    } catch (error) {
      console.error('Error saving:', error);
      showFeedback(t('actions.error'), 'error');
      return false;
    }
  };

  // Get calendar name by ID
  const getCalendarName = (calendarId: string) => {
    return availableCalendars.find(c => c.id === calendarId)?.name || calendarId;
  };

  // Get label display name
  const getLabelName = (label: CalendarLabel) => {
    return t(`categories.${label}`);
  };

  // Toggle calendar checkbox
  const handleCalendarToggle = async (calendarId: string) => {
    const isCurrentlySelected = selectedCalendars.has(calendarId);
    const calendarName = getCalendarName(calendarId);

    let newSelectedCalendars: Set<string>;
    let newCalendarLabels: Map<string, Set<CalendarLabel>>;

    if (isCurrentlySelected) {
      // Unchecking: Remove from selected AND remove all labels
      newSelectedCalendars = new Set(selectedCalendars);
      newSelectedCalendars.delete(calendarId);

      newCalendarLabels = new Map(calendarLabels);
      newCalendarLabels.delete(calendarId);

      // Also remove spouse metadata and rules if unchecking
      const newSpouseMetadata = new Map(spouseMetadata);
      newSpouseMetadata.delete(calendarId);
      const newCalendarRules = new Map(calendarRules);
      newCalendarRules.delete(calendarId);

      setSelectedCalendars(newSelectedCalendars);
      setCalendarLabels(newCalendarLabels);
      setSpouseMetadata(newSpouseMetadata);
      setCalendarRules(newCalendarRules);

      // Save and show feedback
      const success = await saveToServer(newSelectedCalendars, newCalendarLabels, newSpouseMetadata, newCalendarRules);
      if (success) {
        showFeedback(`${calendarName} ${t('feedback.removed')}`);
      }
    } else {
      // Checking: Add to selected (no labels yet)
      newSelectedCalendars = new Set(selectedCalendars);
      newSelectedCalendars.add(calendarId);

      newCalendarLabels = new Map(calendarLabels);

      setSelectedCalendars(newSelectedCalendars);

      // Save and show feedback
      const success = await saveToServer(newSelectedCalendars, newCalendarLabels);
      if (success) {
        showFeedback(`${calendarName} ${t('feedback.added')}`);
      }
    }
  };

  // Update spouse metadata for a calendar
  const handleSpouseMetadataChange = async (calendarId: string, field: keyof SpouseMetadata, value: string) => {
    const newMetadata = new Map(spouseMetadata);
    const current = newMetadata.get(calendarId) || {};
    newMetadata.set(calendarId, { ...current, [field]: value || undefined });
    setSpouseMetadata(newMetadata);

    // Debounce save (save after user stops typing)
    // For now, we'll save on blur instead
  };

  // Save spouse metadata on blur
  const handleSpouseMetadataBlur = async (calendarId: string) => {
    const success = await saveToServer(selectedCalendars, calendarLabels, spouseMetadata, calendarRules);
    if (success) {
      showFeedback(t('feedback.spouseInfoSaved') || 'Spouse info saved');
    }
  };

  // Update calendar rule
  const handleRuleChange = (calendarId: string, value: string) => {
    const newRules = new Map(calendarRules);
    if (value.trim()) {
      newRules.set(calendarId, value);
    } else {
      newRules.delete(calendarId);
    }
    setCalendarRules(newRules);
  };

  // Save rule on blur
  const handleRuleBlur = async (calendarId: string) => {
    const success = await saveToServer(selectedCalendars, calendarLabels, spouseMetadata, calendarRules);
    if (success) {
      showFeedback(t('feedback.ruleSaved') || 'Rule saved');
    }
  };

  // Toggle expanded state for spouse panel
  const toggleSpouseExpanded = (calendarId: string) => {
    setExpandedSpouse(prev => {
      const next = new Set(prev);
      if (next.has(calendarId)) {
        next.delete(calendarId);
      } else {
        next.add(calendarId);
      }
      return next;
    });
  };

  // Toggle expanded state for rule panel
  const toggleRuleExpanded = (calendarId: string) => {
    setExpandedRules(prev => {
      const next = new Set(prev);
      if (next.has(calendarId)) {
        next.delete(calendarId);
      } else {
        next.add(calendarId);
      }
      return next;
    });
  };

  // Get spouse summary text
  const getSpouseSummary = (calendarId: string): string | null => {
    const metadata = spouseMetadata.get(calendarId);
    if (!metadata?.personName) return null;

    const parts: string[] = [metadata.personName];
    if (metadata.personEnglishName) {
      parts.push(`(${metadata.personEnglishName})`);
    }
    if (metadata.personGender) {
      parts.push(`- ${t(`spouseInfo.${metadata.personGender}`)}`);
    }
    return parts.join(' ');
  };

  // Check if spouse has any data
  const hasSpouseData = (calendarId: string): boolean => {
    const metadata = spouseMetadata.get(calendarId);
    return !!(metadata?.personName || metadata?.personEnglishName || metadata?.personGender);
  };

  // Toggle category label
  const handleLabelToggle = async (calendarId: string, label: CalendarLabel) => {
    const calendarName = getCalendarName(calendarId);
    const labelName = getLabelName(label);

    const newLabels = new Map(calendarLabels);
    const labels = new Set(newLabels.get(calendarId) || []);
    const hadLabel = labels.has(label);

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
          showFeedback(t('validation.primaryMustBeYours'), 'error');
          return; // Don't remove
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
    setCalendarLabels(newLabels);

    // Save and show feedback
    const success = await saveToServer(selectedCalendars, newLabels);
    if (success) {
      if (label === 'primary') {
        showFeedback(`${calendarName} ${t('feedback.setPrimary')}`);
      } else if (hadLabel) {
        showFeedback(`${calendarName} ${t('feedback.removedFrom')} ${labelName}`);
      } else {
        showFeedback(`${calendarName} ${t('feedback.addedTo')} ${labelName}`);
      }
    }
  };

  return (
    <TelegramLayout>
      <Header
        title={t('title')}
        userName={userName}
        onBackClick={handleBack}
      />
      <style jsx>{`
        .page-container {
          min-height: 100vh;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: white;
          padding: 20px;
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
          padding: 12px;
          margin-bottom: 8px;
          transition: all 0.2s;
        }
        .calendar-item.selected {
          border-color: #667eea;
          background: #f9fafb;
        }
        .collapsible-panel {
          margin-top: 10px;
          border-radius: 8px;
          overflow: hidden;
        }
        .collapsible-panel.spouse {
          background: #fef3f2;
          border: 1px solid #fecaca;
        }
        .collapsible-panel.rule {
          background: #f0f9ff;
          border: 1px solid #bae6fd;
        }
        .panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          cursor: pointer;
          user-select: none;
        }
        .panel-header:hover {
          opacity: 0.8;
        }
        .panel-title {
          font-size: 13px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .collapsible-panel.spouse .panel-title {
          color: #b91c1c;
        }
        .collapsible-panel.rule .panel-title {
          color: #0369a1;
        }
        .panel-summary {
          font-size: 13px;
          color: #374151;
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .panel-actions {
          display: flex;
          align-items: center;
          gap: 4px;
          color: #667eea;
          flex-shrink: 0;
          margin-left: 8px;
        }
        .panel-content {
          padding: 0 12px 12px 12px;
        }
        .spouse-input-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .spouse-input {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          font-size: 14px;
          background: white;
        }
        .spouse-input:focus {
          outline: none;
          border-color: #667eea;
        }
        .spouse-select {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          font-size: 14px;
          background: white;
        }
        .spouse-select:focus {
          outline: none;
          border-color: #667eea;
        }
        .input-label {
          font-size: 11px;
          color: #6b7280;
          margin-bottom: 2px;
        }
        .rule-input {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          font-size: 14px;
          background: white;
        }
        .rule-input:focus {
          outline: none;
          border-color: #667eea;
        }
        .rule-input::placeholder {
          color: #9ca3af;
        }
        .calendar-header-wrapper {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 12px;
        }
        .calendar-info {
          display: flex;
          align-items: center;
          gap: 12px;
          /* Grow to fill space, but allow natural wrapping */
          flex: 1 1 auto;
          min-width: 0;
          cursor: pointer;
        }
        .checkbox {
          width: 20px;
          height: 20px;
          cursor: pointer;
          flex-shrink: 0;
        }
        .calendar-color {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .name-container {
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
          min-width: 0;
        }
        .calendar-name {
          font-weight: 600;
          color: #111827;
          font-size: 15px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .calendar-desc {
          font-size: 13px;
          color: #6b7280;
        }
        .label-icons {
          display: flex;
          gap: 6px;
          /* Fixed width - 5 icons (24px) + 4 gaps (6px) = 144px */
          flex: 0 0 auto;
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

        .feedback-container {
          position: fixed;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 1000;
          display: flex;
          flex-direction: column;
          gap: 10px;
          max-width: 90%;
          width: 400px;
        }

        .feedback-message {
          background: white;
          border-radius: 8px;
          padding: 12px 16px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          animation: slideIn 0.3s ease-out;
        }

        .feedback-message.success {
          border-left: 4px solid #22c55e;
          color: #166534;
        }

        .feedback-message.error {
          border-left: 4px solid #ef4444;
          color: #991b1b;
        }

        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>

      {/* Feedback Messages */}
      <div className="feedback-container">
        {feedbackMessages.map(msg => (
          <div key={msg.id} className={`feedback-message ${msg.type}`}>
            <span>{msg.type === 'success' ? '✓' : '✗'}</span>
            <span>{msg.text}</span>
          </div>
        ))}
      </div>

      <div className="page-container">
        <div className="container">
          <h1><Calendar size={24} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 8 }} />{t('title')}</h1>
          <p className="subtitle">{t('subtitle')}</p>

          <div className="help-text">
            {t('categoryHelp')}
          </div>

          <div className="calendar-list">
              {availableCalendars.map(calendar => {
                const isSelected = selectedCalendars.has(calendar.id);
                const labels = calendarLabels.get(calendar.id) || new Set();

                return (
                  <div
                    key={calendar.id}
                    className={`calendar-item ${isSelected ? 'selected' : ''}`}
                  >
                    <div className="calendar-header-wrapper">
                      <div
                        className="calendar-info"
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
                        <div className="name-container">
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

                    {/* Spouse metadata - collapsible panel */}
                    {isSelected && labels.has('spouse') && (() => {
                      const spouseSummary = getSpouseSummary(calendar.id);
                      const hasData = hasSpouseData(calendar.id);
                      const isExpanded = expandedSpouse.has(calendar.id);

                      return (
                        <div className="collapsible-panel spouse">
                          <div
                            className="panel-header"
                            onClick={() => toggleSpouseExpanded(calendar.id)}
                          >
                            {hasData ? (
                              <>
                                <span className="panel-summary">{spouseSummary}</span>
                                <div className="panel-actions">
                                  <Pencil size={14} />
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="panel-title">
                                  <span>{t('spouseInfo.title')}</span>
                                </div>
                                <div className="panel-actions">
                                  <Pencil size={14} />
                                </div>
                              </>
                            )}
                          </div>
                          {isExpanded && (
                            <div className="panel-content">
                              <div className="spouse-input-group">
                                <div>
                                  <div className="input-label">{t('spouseInfo.name')}</div>
                                  <input
                                    type="text"
                                    className="spouse-input"
                                    placeholder={t('spouseInfo.namePlaceholder')}
                                    value={spouseMetadata.get(calendar.id)?.personName || ''}
                                    onChange={(e) => handleSpouseMetadataChange(calendar.id, 'personName', e.target.value)}
                                    onBlur={() => handleSpouseMetadataBlur(calendar.id)}
                                  />
                                </div>
                                <div>
                                  <div className="input-label">{t('spouseInfo.englishName')} ({t('spouseInfo.optional')})</div>
                                  <input
                                    type="text"
                                    className="spouse-input"
                                    placeholder={t('spouseInfo.englishNamePlaceholder')}
                                    value={spouseMetadata.get(calendar.id)?.personEnglishName || ''}
                                    onChange={(e) => handleSpouseMetadataChange(calendar.id, 'personEnglishName', e.target.value)}
                                    onBlur={() => handleSpouseMetadataBlur(calendar.id)}
                                  />
                                </div>
                                <div>
                                  <div className="input-label">{t('spouseInfo.gender')}</div>
                                  <select
                                    className="spouse-select"
                                    value={spouseMetadata.get(calendar.id)?.personGender || ''}
                                    onChange={(e) => {
                                      handleSpouseMetadataChange(calendar.id, 'personGender', e.target.value as 'male' | 'female');
                                      setTimeout(() => handleSpouseMetadataBlur(calendar.id), 100);
                                    }}
                                  >
                                    <option value="">{t('spouseInfo.selectGender')}</option>
                                    <option value="male">{t('spouseInfo.male')}</option>
                                    <option value="female">{t('spouseInfo.female')}</option>
                                  </select>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Calendar rule - collapsible panel */}
                    {isSelected && (() => {
                      const rule = calendarRules.get(calendar.id);
                      const hasRule = !!rule;
                      const isExpanded = expandedRules.has(calendar.id);

                      return (
                        <div className="collapsible-panel rule">
                          <div
                            className="panel-header"
                            onClick={() => toggleRuleExpanded(calendar.id)}
                          >
                            {hasRule ? (
                              <>
                                <span className="panel-summary">{rule}</span>
                                <div className="panel-actions">
                                  <Pencil size={14} />
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="panel-title">
                                  <span>{t('calendarRule.label')}</span>
                                </div>
                                <div className="panel-actions">
                                  <Pencil size={14} />
                                </div>
                              </>
                            )}
                          </div>
                          {isExpanded && (
                            <div className="panel-content">
                              <input
                                type="text"
                                className="rule-input"
                                placeholder={t('calendarRule.placeholder')}
                                value={calendarRules.get(calendar.id) || ''}
                                onChange={(e) => handleRuleChange(calendar.id, e.target.value)}
                                onBlur={() => handleRuleBlur(calendar.id)}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </TelegramLayout>
    );
  }
