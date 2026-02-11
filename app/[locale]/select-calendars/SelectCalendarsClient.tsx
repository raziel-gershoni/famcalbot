'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
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

interface SpouseInfo {
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
    spouseInfo: SpouseInfo | null;
    calendarRules: Map<string, string>;
    globalRules: string[];
  };
  locale: string;
  calendarLimit: number; // -1 means unlimited
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
  locale,
  calendarLimit
}: SelectCalendarsClientProps) {
  const t = useTranslations('calendars');
  const router = useRouter();
  const [selectedCalendars, setSelectedCalendars] = useState<Set<string>>(
    currentSelections.selectedCalendars
  );
  const [calendarLabels, setCalendarLabels] = useState<Map<string, Set<CalendarLabel>>>(
    currentSelections.calendarLabels
  );
  // Single spouse info (applies to all spouse calendars)
  const [spouseInfo, setSpouseInfo] = useState<SpouseInfo | null>(
    currentSelections.spouseInfo
  );
  const [calendarRules, setCalendarRules] = useState<Map<string, string>>(
    currentSelections.calendarRules
  );
  // Global rules (up to 3)
  const [globalRules, setGlobalRules] = useState<string[]>(
    currentSelections.globalRules.length > 0
      ? [...currentSelections.globalRules, '', '', ''].slice(0, 3)
      : ['', '', '']
  );
  const [feedbackMessages, setFeedbackMessages] = useState<FeedbackMessage[]>([]);
  const [messageIdCounter, setMessageIdCounter] = useState(0);
  // Track which panels are expanded (collapsed by default if data exists)
  const [expandedGlobalRules, setExpandedGlobalRules] = useState(false);
  const [expandedSpousePanels, setExpandedSpousePanels] = useState<Set<string>>(new Set());
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());

  // Debounce timer ref for spouse info and rules
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const DEBOUNCE_DELAY = 500; // ms

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

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Debounced save for spouse info, rules, and global rules
  const debouncedSave = useCallback((
    newSpouseInfo?: SpouseInfo | null,
    newRules?: Map<string, string>,
    newGlobalRules?: string[],
    feedbackKey?: string
  ) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(async () => {
      const success = await saveToServer(
        selectedCalendars,
        calendarLabels,
        newSpouseInfo !== undefined ? newSpouseInfo : spouseInfo,
        newRules !== undefined ? newRules : calendarRules,
        newGlobalRules !== undefined ? newGlobalRules : globalRules
      );
      if (success && feedbackKey) {
        showFeedback(t(feedbackKey) || feedbackKey);
      }
    }, DEBOUNCE_DELAY);
  }, [selectedCalendars, calendarLabels, spouseInfo, calendarRules, globalRules]);

  // Immediate save (for panel collapse)
  const immediateSave = useCallback(async (feedbackKey?: string) => {
    // Cancel any pending debounced save
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const success = await saveToServer(selectedCalendars, calendarLabels, spouseInfo, calendarRules, globalRules);
    if (success && feedbackKey) {
      showFeedback(t(feedbackKey) || feedbackKey);
    }
    return success;
  }, [selectedCalendars, calendarLabels, spouseInfo, calendarRules, globalRules]);

  // Save current state to server
  const saveToServer = async (
    newSelectedCalendars: Set<string>,
    newCalendarLabels: Map<string, Set<CalendarLabel>>,
    newSpouseInfo?: SpouseInfo | null,
    newCalendarRules?: Map<string, string>,
    newGlobalRules?: string[]
  ) => {
    const spouseInfoToUse = newSpouseInfo !== undefined ? newSpouseInfo : spouseInfo;
    const rulesToUse = newCalendarRules || calendarRules;
    const globalRulesToUse = newGlobalRules || globalRules;
    try {
      const calendarAssignments: CalendarAssignment[] = Array.from(newSelectedCalendars).map(calId => {
        const calendar = availableCalendars.find(c => c.id === calId);
        const labels = Array.from(newCalendarLabels.get(calId) || []);
        const rule = rulesToUse.get(calId);
        const isSpouse = labels.includes('spouse');

        return {
          calendarId: calId,
          labels: labels,
          name: calendar?.name || calId,
          color: calendar?.backgroundColor || '#4285f4',
          // Apply spouseInfo to ALL spouse calendars (single source of truth)
          ...(isSpouse && spouseInfoToUse ? {
            personName: spouseInfoToUse.personName,
            personEnglishName: spouseInfoToUse.personEnglishName,
            personGender: spouseInfoToUse.personGender,
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
        body: JSON.stringify({
          calendarAssignments,
          globalRules: globalRulesToUse.filter(r => r.trim() !== ''),
          initData
        })
      });

      if (!response.ok) {
        const data = await response.json();
        if (data.error === 'calendar_limit_reached') {
          showFeedback(
            t('validation.calendarLimitReached', { limit: String(data.limit) }),
            'error'
          );
          return false;
        }
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

  // Check if calendar limit is reached
  const isAtCalendarLimit = calendarLimit > 0 && selectedCalendars.size >= calendarLimit;

  // Toggle calendar checkbox
  const handleCalendarToggle = async (calendarId: string) => {
    const isCurrentlySelected = selectedCalendars.has(calendarId);
    const calendarName = getCalendarName(calendarId);

    // Block adding new calendars if at limit
    if (!isCurrentlySelected && isAtCalendarLimit) {
      showFeedback(
        t('validation.calendarLimitReached', { limit: String(calendarLimit) }),
        'error'
      );
      return;
    }

    let newSelectedCalendars: Set<string>;
    let newCalendarLabels: Map<string, Set<CalendarLabel>>;

    if (isCurrentlySelected) {
      // Unchecking: Remove from selected AND remove all labels
      newSelectedCalendars = new Set(selectedCalendars);
      newSelectedCalendars.delete(calendarId);

      newCalendarLabels = new Map(calendarLabels);
      newCalendarLabels.delete(calendarId);

      // Also remove rules if unchecking
      const newCalendarRules = new Map(calendarRules);
      newCalendarRules.delete(calendarId);

      setSelectedCalendars(newSelectedCalendars);
      setCalendarLabels(newCalendarLabels);
      setCalendarRules(newCalendarRules);

      // Save and show feedback
      const success = await saveToServer(newSelectedCalendars, newCalendarLabels, undefined, newCalendarRules);
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

  // Update spouse info field with debounced save
  const handleSpouseInfoChange = (field: keyof SpouseInfo, value: string) => {
    const newSpouseInfo = {
      ...spouseInfo,
      [field]: value || undefined
    };
    setSpouseInfo(newSpouseInfo);
    debouncedSave(newSpouseInfo, undefined, undefined, 'feedback.spouseInfoSaved');
  };

  // Toggle spouse panel for a calendar, save on collapse
  const toggleSpousePanel = (calendarId: string) => {
    const isCurrentlyExpanded = expandedSpousePanels.has(calendarId);

    if (isCurrentlyExpanded) {
      // Collapsing - save in background (don't block UI)
      immediateSave('feedback.spouseInfoSaved');
    }

    setExpandedSpousePanels(prev => {
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
  const getSpouseInfoSummary = (): string | null => {
    if (!spouseInfo?.personName) return null;
    const parts: string[] = [spouseInfo.personName];
    if (spouseInfo.personEnglishName) {
      parts.push(`(${spouseInfo.personEnglishName})`);
    }
    if (spouseInfo.personGender) {
      parts.push(`- ${t(`spouseInfo.${spouseInfo.personGender}`)}`);
    }
    return parts.join(' ');
  };

  // Check if spouse has any data
  const hasSpouseInfoData = !!(spouseInfo?.personName || spouseInfo?.personEnglishName || spouseInfo?.personGender);

  // Update calendar rule with debounced save
  const handleRuleChange = (calendarId: string, value: string) => {
    const newRules = new Map(calendarRules);
    if (value.trim()) {
      newRules.set(calendarId, value);
    } else {
      newRules.delete(calendarId);
    }
    setCalendarRules(newRules);
    debouncedSave(undefined, newRules, undefined, 'feedback.ruleSaved');
  };

  // Toggle expanded state for rule panel, save on collapse
  const toggleRuleExpanded = (calendarId: string) => {
    const isCurrentlyExpanded = expandedRules.has(calendarId);

    if (isCurrentlyExpanded) {
      // Collapsing - save in background (don't block UI)
      immediateSave('feedback.ruleSaved');
    }

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

  // Update global rule with debounced save
  const handleGlobalRuleChange = (index: number, value: string) => {
    const newRules = [...globalRules];
    newRules[index] = value;
    setGlobalRules(newRules);
    debouncedSave(undefined, undefined, newRules, 'feedback.globalRulesSaved');
  };

  // Toggle global rules panel, save on collapse
  const toggleGlobalRulesPanel = () => {
    if (expandedGlobalRules) {
      // Collapsing - save in background (don't block UI)
      immediateSave('feedback.globalRulesSaved');
    }
    setExpandedGlobalRules(!expandedGlobalRules);
  };

  // Check if any global rules have data
  const hasGlobalRulesData = globalRules.some(r => r.trim() !== '');

  // Get global rules summary text
  const getGlobalRulesSummary = (): string => {
    const filledRules = globalRules.filter(r => r.trim() !== '');
    if (filledRules.length === 0) return '';
    if (filledRules.length === 1) return filledRules[0];
    return `${filledRules.length} rules`;
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
        .collapsible-panel.global-rules {
          background: #faf5ff;
          border: 1px solid #e9d5ff;
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
        .collapsible-panel.global-rules .panel-title {
          color: #7c3aed;
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

          {calendarLimit > 0 && (
            <p style={{ fontSize: '13px', color: isAtCalendarLimit ? '#ef4444' : '#6b7280', marginBottom: '12px' }}>
              <span dir="ltr">{selectedCalendars.size} / {calendarLimit}</span>{' '}
              {t('calendarLimitInfoSuffix')}
            </p>
          )}

          <div className="help-text">
            {t('categoryHelp')}
          </div>

          {/* Global Rules Panel - collapsed by default */}
          <div className="collapsible-panel global-rules" style={{ marginBottom: '20px' }}>
            <div
              className="panel-header"
              onClick={toggleGlobalRulesPanel}
            >
              {hasGlobalRulesData ? (
                <>
                  <span className="panel-summary">{getGlobalRulesSummary()}</span>
                  <div className="panel-actions">
                    <Pencil size={14} />
                    {expandedGlobalRules ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </div>
                </>
              ) : (
                <>
                  <div className="panel-title">
                    <span>{t('globalRules.title')}</span>
                  </div>
                  <div className="panel-actions">
                    <Pencil size={14} />
                    {expandedGlobalRules ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </div>
                </>
              )}
            </div>
            {expandedGlobalRules && (
              <div className="panel-content">
                <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '10px' }}>
                  {t('globalRules.help')}
                </p>
                <div className="spouse-input-group">
                  {[0, 1, 2].map((index) => (
                    <input
                      key={index}
                      type="text"
                      className="spouse-input"
                      value={globalRules[index] || ''}
                      onChange={(e) => handleGlobalRuleChange(index, e.target.value)}
                      placeholder={t('globalRules.placeholder', { number: index + 1 })}
                    />
                  ))}
                </div>
              </div>
            )}
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
                              />
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Spouse info panel - synced across all spouse calendars */}
                    {isSelected && labels.has('spouse') && (() => {
                      const isExpanded = expandedSpousePanels.has(calendar.id);

                      return (
                        <div className="collapsible-panel spouse">
                          <div
                            className="panel-header"
                            onClick={() => toggleSpousePanel(calendar.id)}
                          >
                            {hasSpouseInfoData ? (
                              <>
                                <span className="panel-summary">{getSpouseInfoSummary()}</span>
                                <div className="panel-actions">
                                  <Pencil size={14} />
                                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="panel-title">
                                  <span>{t('spouseInfo.title')}</span>
                                </div>
                                <div className="panel-actions">
                                  <Pencil size={14} />
                                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
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
                                    value={spouseInfo?.personName || ''}
                                    onChange={(e) => handleSpouseInfoChange('personName', e.target.value)}
                                  />
                                </div>
                                <div>
                                  <div className="input-label">{t('spouseInfo.englishName')} ({t('spouseInfo.optional')})</div>
                                  <input
                                    type="text"
                                    className="spouse-input"
                                    placeholder={t('spouseInfo.englishNamePlaceholder')}
                                    value={spouseInfo?.personEnglishName || ''}
                                    onChange={(e) => handleSpouseInfoChange('personEnglishName', e.target.value)}
                                  />
                                </div>
                                <div>
                                  <div className="input-label">{t('spouseInfo.gender')}</div>
                                  <select
                                    className="spouse-select"
                                    value={spouseInfo?.personGender || ''}
                                    onChange={(e) => handleSpouseInfoChange('personGender', e.target.value as 'male' | 'female')}
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
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </TelegramLayout>
    );
  }
