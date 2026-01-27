'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, Crown, Bot, Users, LayoutDashboard, Bell, UserCog, Search, X, Check, Loader2, Clock, RefreshCw, ChevronDown } from 'lucide-react';
import { HDate, Locale, gematriya } from '@hebcal/core';
import '@hebcal/locales';

interface AdminPanelClientProps {
  userId: number;
  locale: string;
  stats: {
    totalUsers: number;
    usersWithOAuth: number;
    usersWithCalendars: number;
    needSetup: number;
  };
  remindersEnabled: boolean;
}

type ButtonState = 'idle' | 'loading' | 'success' | 'error';

interface UserListItem {
  id: number;
  telegramId: number | null;
  name: string;
  subscription: {
    plan: string;
    status: string;
    trialEndsAt: string | null;
    trialDaysRemaining: number | null;
    currentPeriodEnd: string | null;
  } | null;
  usage: {
    textSummariesUsed: number;
    voiceSummariesUsed: number;
    voiceEventsCreated: number;
  } | null;
  calendarsCount: number;
  hasOverride: boolean;
}

type FilterType = 'all' | 'trial' | 'paid' | 'free' | 'override';

interface UserOverrideDetails {
  id: number;
  telegramId: number | null;
  name: string;
  subscription: {
    plan: string;
    status: string;
    trialEndsAt: string | null;
    trialDaysRemaining: number | null;
    currentPeriodEnd: string | null;
  } | null;
  usage: {
    textSummariesUsed: number;
    voiceSummariesUsed: number;
    voiceEventsCreated: number;
  };
  limits: {
    textSummaries: number;
    voiceSummaries: number;
    calendars: number;
  };
  calendarsCount: number;
  override: {
    unlimitedSummaries: boolean | null;
    remindersEnabled: boolean | null;
    voiceEventsEnabled: boolean | null;
    unlimitedCalendars: boolean | null;
    reason: string | null;
    grantedAt: string | null;
    grantedBy: number | null;
  } | null;
  paidFeatures: {
    unlimitedSummaries: boolean;
    remindersEnabled: boolean;
    voiceEventsEnabled: boolean;
    unlimitedCalendars: boolean;
  };
  registrationStatus: {
    hasOAuth: boolean;
    hasCalendars: boolean;
    hasLocation: boolean;
    applicableReminder: 'oauth' | 'calendars' | 'location' | null;
  };
}

interface ActivityItem {
  id: string;
  userId: number;
  userName: string;
  userTelegramId: number | null;
  action: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface ActivityStats {
  action: string;
  count: number;
}

export default function AdminPanelClient({ userId, locale, stats, remindersEnabled: initialRemindersEnabled }: AdminPanelClientProps) {
  const t = useTranslations('admin');
  const [todayState, setTodayState] = useState<ButtonState>('idle');
  const [tomorrowState, setTomorrowState] = useState<ButtonState>('idle');
  const [remindersEnabled, setRemindersEnabled] = useState(initialRemindersEnabled);
  const [remindersSaving, setRemindersSaving] = useState(false);

  // User overrides state
  const [userList, setUserList] = useState<UserListItem[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [nameFilter, setNameFilter] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserOverrideDetails | null>(null);
  const [isLoadingUser, setIsLoadingUser] = useState(false);
  const [isSavingOverride, setIsSavingOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [pendingOverrides, setPendingOverrides] = useState({
    unlimitedSummaries: false,
    remindersEnabled: false,
    voiceEventsEnabled: false,
    unlimitedCalendars: false,
  });

  // Reminder sending state
  const [isSendingReminder, setIsSendingReminder] = useState(false);
  const [reminderFeedback, setReminderFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // User activity state
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [activityStats, setActivityStats] = useState<ActivityStats[]>([]);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);
  const [activityFilter, setActivityFilter] = useState<string>('');
  const [activityUserFilter, setActivityUserFilter] = useState<string>('');
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityOffset, setActivityOffset] = useState(0);

  // Collapsible sections state
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const toggleSection = (sectionId: string) => {
    setCollapsedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  // Infinite scroll for activity list
  const activitySentinelRef = useRef<HTMLDivElement>(null);

  // Map app locale to Intl locale
  const intlLocale = { he: 'he-IL', ru: 'ru-RU', en: 'en-US' }[locale] ?? 'en-US';

  // Format dates for today and tomorrow buttons
  const todayLabel = useMemo(() => {
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

  const tomorrowLabel = useMemo(() => {
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
      // Get Telegram Web App initData for authentication
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;

      const response = await fetch('/api/execute-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          command: 'testai',
          args: timeframe === 'tmrw' ? 'tmrw' : undefined,
          initData,
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

  const toggleReminders = async () => {
    setRemindersSaving(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remindersEnabled: !remindersEnabled, initData })
      });
      if (response.ok) {
        setRemindersEnabled(!remindersEnabled);
      }
    } finally {
      setRemindersSaving(false);
    }
  };

  // Fetch all users
  const fetchUserList = useCallback(async () => {
    setIsLoadingUsers(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch(`/api/admin/user-overrides?initData=${encodeURIComponent(initData || '')}&list=all`);
      const data = await response.json();
      if (data.success) {
        setUserList(data.users || []);
      }
    } catch (error) {
      console.error('Failed to fetch users:', error);
    } finally {
      setIsLoadingUsers(false);
    }
  }, []);

  // Fetch user activity
  const fetchActivity = useCallback(async (reset: boolean = false) => {
    setIsLoadingActivity(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const newOffset = reset ? 0 : activityOffset;
      const params = new URLSearchParams({
        initData: initData || '',
        limit: '20',
        offset: String(newOffset),
      });
      if (activityFilter) params.append('action', activityFilter);
      if (activityUserFilter) params.append('user_id', activityUserFilter);

      const response = await fetch(`/api/admin/user-activity?${params}`);
      const data = await response.json();
      if (data.success) {
        if (reset) {
          setActivities(data.activities || []);
          setActivityOffset(20);
        } else {
          setActivities(prev => [...prev, ...(data.activities || [])]);
          setActivityOffset(newOffset + 20);
        }
        setActivityStats(data.actionStats || []);
        setActivityHasMore(data.pagination?.hasMore || false);
      }
    } catch (error) {
      console.error('Failed to fetch activity:', error);
    } finally {
      setIsLoadingActivity(false);
    }
  }, [activityFilter, activityUserFilter, activityOffset]);

  // Refresh all data
  const refreshAll = useCallback(() => {
    fetchUserList();
    fetchActivity(true);
  }, [fetchUserList, fetchActivity]);

  // Load user list and activity on mount
  useEffect(() => {
    fetchUserList();
    fetchActivity(true);
  }, [fetchUserList]);

  // Reload activity when filter changes
  useEffect(() => {
    fetchActivity(true);
  }, [activityFilter]);

  // Infinite scroll for activity list
  useEffect(() => {
    const sentinel = activitySentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && activityHasMore && !isLoadingActivity) {
          fetchActivity(false);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activityHasMore, isLoadingActivity, fetchActivity]);

  // Format relative time
  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('activity.justNow');
    if (diffMins < 60) return `${diffMins}${t('activity.minutes')} ${t('activity.ago')}`;
    if (diffHours < 24) return `${diffHours}${t('activity.hours')} ${t('activity.ago')}`;
    return `${diffDays}${t('activity.days')} ${t('activity.ago')}`;
  };

  // Filter users based on active filter and name filter
  const filteredUsers = useMemo(() => {
    return userList.filter(user => {
      // Apply name filter first
      if (nameFilter.trim()) {
        const search = nameFilter.toLowerCase();
        const matchesName = user.name?.toLowerCase().includes(search);
        const matchesId = user.telegramId?.toString().includes(search);
        if (!matchesName && !matchesId) return false;
      }

      // Apply category filter
      switch (activeFilter) {
        case 'trial':
          return user.subscription?.status === 'TRIALING';
        case 'paid':
          return user.subscription?.status === 'ACTIVE' && user.subscription?.plan !== 'FREE';
        case 'free':
          return !user.subscription || user.subscription.plan === 'FREE' && user.subscription.status !== 'TRIALING';
        case 'override':
          return user.hasOverride;
        default:
          return true;
      }
    });
  }, [userList, activeFilter, nameFilter]);

  // Load user details
  const loadUserDetails = async (userId: number) => {
    setIsLoadingUser(true);
    setSelectedUser(null);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch(
        `/api/admin/user-overrides?initData=${encodeURIComponent(initData || '')}&user_id=${userId}`
      );
      const data = await response.json();
      if (data.success && data.user) {
        setSelectedUser(data.user);
        // Initialize pending overrides with current values
        setPendingOverrides({
          unlimitedSummaries: data.user.override?.unlimitedSummaries === true,
          remindersEnabled: data.user.override?.remindersEnabled === true,
          voiceEventsEnabled: data.user.override?.voiceEventsEnabled === true,
          unlimitedCalendars: data.user.override?.unlimitedCalendars === true,
        });
        setOverrideReason(data.user.override?.reason || '');
      }
    } catch (error) {
      console.error('Failed to load user:', error);
    } finally {
      setIsLoadingUser(false);
    }
  };

  // Save override
  const saveOverride = async () => {
    if (!selectedUser) return;
    setIsSavingOverride(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/user-overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData,
          user_id: selectedUser.id,
          unlimitedSummaries: pendingOverrides.unlimitedSummaries || null,
          remindersEnabled: pendingOverrides.remindersEnabled || null,
          voiceEventsEnabled: pendingOverrides.voiceEventsEnabled || null,
          unlimitedCalendars: pendingOverrides.unlimitedCalendars || null,
          reason: overrideReason || null,
        }),
      });
      const data = await response.json();
      if (data.success) {
        // Refresh the user and user list
        await loadUserDetails(selectedUser.id);
        await fetchUserList();
      }
    } catch (error) {
      console.error('Failed to save override:', error);
    } finally {
      setIsSavingOverride(false);
    }
  };

  const clearSelectedUser = () => {
    setSelectedUser(null);
    setReminderFeedback(null);
  };

  // Send registration reminder
  const sendReminder = async (reminderType: 'oauth' | 'calendars' | 'location') => {
    if (!selectedUser) return;
    setIsSendingReminder(true);
    setReminderFeedback(null);

    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/send-reminder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData,
          user_id: selectedUser.id,
          reminder_type: reminderType,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setReminderFeedback({ type: 'success', message: t('overrides.reminderSent') });
        // Auto-dismiss after 3s
        setTimeout(() => setReminderFeedback(null), 3000);
      } else {
        setReminderFeedback({ type: 'error', message: data.error || t('overrides.reminderFailed') });
      }
    } catch (error) {
      console.error('Failed to send reminder:', error);
      setReminderFeedback({ type: 'error', message: t('overrides.reminderFailed') });
    } finally {
      setIsSendingReminder(false);
    }
  };

  const getButtonContent = (state: ButtonState, label: { gregorian: string; hebrew: string }) => {
    switch (state) {
      case 'loading':
        return t('testing.sending');
      case 'success':
        return t('testing.sent');
      case 'error':
        return t('testing.error');
      default:
        return (
          <>
            {label.gregorian}
            <br />
            {label.hebrew}
          </>
        );
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

        .header-right {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .admin-badge {
          background: rgba(255, 255, 255, 0.3);
          padding: 6px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 1px;
        }

        .header-icon-btn {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: white;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }

        .header-icon-btn:hover {
          background: rgba(255, 255, 255, 0.3);
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .admin-content {
          padding: 20px;
        }

        .section {
          margin-bottom: 30px;
        }

        .section-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        .section-title {
          font-size: 18px;
          font-weight: 600;
          color: #111827;
          margin: 0;
        }

        .section-icon {
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .refresh-btn {
          margin-left: auto;
          background: none;
          border: none;
          color: #6b7280;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          display: flex;
          align-items: center;
        }

        .refresh-btn:hover:not(:disabled) {
          color: #667eea;
          background: #f3f4f6;
        }

        .refresh-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .section-header-clickable {
          cursor: pointer;
          user-select: none;
        }

        .section-header-clickable:hover .section-title {
          color: #667eea;
        }

        .section-chevron {
          margin-left: auto;
          color: #9ca3af;
          transition: transform 0.2s ease;
          display: flex;
          align-items: center;
        }

        .section-chevron.collapsed {
          transform: rotate(-90deg);
        }

        .section-content {
          overflow: hidden;
          transition: max-height 0.3s ease, opacity 0.2s ease;
          max-height: 2000px;
          opacity: 1;
        }

        .section-content.collapsed {
          max-height: 0;
          opacity: 0;
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

        .subsection-title {
          font-size: 14px;
          font-weight: 600;
          color: #6b7280;
          margin-bottom: 8px;
        }

        .toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px;
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
        }

        .toggle-info {
          flex: 1;
        }

        .toggle-label {
          font-weight: 600;
          color: #374151;
          font-size: 14px;
          margin: 0 0 4px 0;
        }

        .toggle-description {
          font-size: 13px;
          color: #6b7280;
          margin: 0;
        }

        .toggle-switch {
          position: relative;
          width: 50px;
          height: 26px;
          background: #d1d5db;
          border-radius: 13px;
          cursor: pointer;
          transition: background 0.2s;
          flex-shrink: 0;
          margin-left: 16px;
        }

        .toggle-switch.checked {
          background: #667eea;
        }

        .toggle-switch.disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .toggle-slider {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 20px;
          height: 20px;
          background: white;
          border-radius: 50%;
          transition: transform 0.2s;
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }

        .toggle-switch.checked .toggle-slider {
          transform: translateX(24px);
        }

        .search-container {
          position: relative;
          margin-bottom: 16px;
        }

        .search-input {
          width: 100%;
          padding: 12px 40px 12px 16px;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          font-size: 14px;
          outline: none;
          transition: border-color 0.2s;
        }

        .search-input:focus {
          border-color: #667eea;
        }

        .search-icon {
          position: absolute;
          right: 12px;
          top: 50%;
          transform: translateY(-50%);
          color: #9ca3af;
        }

        .search-results {
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          margin-top: 8px;
          overflow: hidden;
        }

        .search-result-item {
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
          cursor: pointer;
          transition: background 0.2s;
        }

        .search-result-item:hover {
          background: #f9fafb;
        }

        .search-result-item:last-child {
          border-bottom: none;
        }

        .search-result-name {
          font-weight: 600;
          color: #111827;
          font-size: 14px;
        }

        .search-result-meta {
          font-size: 12px;
          color: #6b7280;
          margin-top: 2px;
        }

        .user-card {
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          padding: 16px;
          margin-bottom: 16px;
        }

        .user-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 16px;
        }

        .user-card-info h3 {
          font-size: 16px;
          font-weight: 600;
          color: #111827;
          margin: 0 0 4px 0;
        }

        .user-card-info p {
          font-size: 13px;
          color: #6b7280;
          margin: 0;
        }

        .close-btn {
          background: none;
          border: none;
          color: #9ca3af;
          cursor: pointer;
          padding: 4px;
        }

        .close-btn:hover {
          color: #6b7280;
        }

        .plan-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
        }

        .plan-badge.free {
          background: #f3f4f6;
          color: #6b7280;
        }

        .plan-badge.basic {
          background: #dbeafe;
          color: #1d4ed8;
        }

        .plan-badge.pro {
          background: #fef3c7;
          color: #b45309;
        }

        .plan-badge.trialing {
          background: #d1fae5;
          color: #047857;
        }

        .override-toggles {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 16px;
        }

        .override-toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px;
          background: #f9fafb;
          border-radius: 8px;
        }

        .override-toggle-row.paid {
          background: #f0fdf4;
        }

        .override-toggle-info {
          flex: 1;
        }

        .override-toggle-label {
          font-weight: 500;
          color: #374151;
          font-size: 14px;
          margin: 0;
        }

        .override-toggle-desc {
          font-size: 12px;
          color: #6b7280;
          margin: 0;
        }

        .paid-badge {
          font-size: 11px;
          color: #059669;
          background: #d1fae5;
          padding: 2px 6px;
          border-radius: 4px;
          margin-left: 8px;
        }

        .reason-input {
          width: 100%;
          padding: 10px 12px;
          border: 2px solid #e5e7eb;
          border-radius: 8px;
          font-size: 14px;
          margin-bottom: 16px;
          outline: none;
        }

        .reason-input:focus {
          border-color: #667eea;
        }

        .save-override-btn {
          width: 100%;
          padding: 12px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 12px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .save-override-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .override-list-item {
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .override-list-item:last-child {
          border-bottom: none;
        }

        .override-list-info {
          flex: 1;
        }

        .override-list-name {
          font-weight: 600;
          font-size: 14px;
          color: #111827;
        }

        .override-list-features {
          font-size: 12px;
          color: #6b7280;
          margin-top: 2px;
        }

        .override-list-actions {
          display: flex;
          gap: 8px;
        }

        .override-action-btn {
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border: none;
        }

        .override-action-btn.edit {
          background: #f3f4f6;
          color: #374151;
        }

        .override-action-btn.remove {
          background: #fef2f2;
          color: #dc2626;
        }

        .override-action-btn:hover {
          opacity: 0.8;
        }

        .empty-state {
          text-align: center;
          padding: 24px;
          color: #6b7280;
          font-size: 14px;
        }

        .mini-toggle {
          position: relative;
          width: 44px;
          height: 24px;
          background: #d1d5db;
          border-radius: 12px;
          cursor: pointer;
          transition: background 0.2s;
          flex-shrink: 0;
        }

        .mini-toggle.checked {
          background: #667eea;
        }

        .mini-toggle.disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .mini-toggle-slider {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 20px;
          height: 20px;
          background: white;
          border-radius: 50%;
          transition: transform 0.2s;
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }

        .mini-toggle.checked .mini-toggle-slider {
          transform: translateX(20px);
        }

        .filter-chips {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }

        .filter-chip {
          padding: 6px 12px;
          border-radius: 16px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          border: none;
          transition: all 0.2s;
          background: #f3f4f6;
          color: #6b7280;
        }

        .filter-chip:hover {
          background: #e5e7eb;
        }

        .filter-chip.active {
          background: #667eea;
          color: white;
        }

        .user-list-scroll {
          max-height: 300px;
          overflow-y: auto;
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
        }

        .user-list-item {
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          align-items: center;
          transition: background 0.2s;
        }

        .user-list-item:hover {
          background: #f9fafb;
        }

        .user-list-item:last-child {
          border-bottom: none;
        }

        .user-list-item.selected {
          background: #f0f4ff;
        }

        .user-list-name {
          font-weight: 600;
          font-size: 14px;
          color: #111827;
        }

        .user-list-right {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .status-badge {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          font-weight: 600;
        }

        .status-badge.trial {
          background: #d1fae5;
          color: #047857;
        }

        .status-badge.active {
          background: #dbeafe;
          color: #1d4ed8;
        }

        .status-badge.expired {
          background: #fee2e2;
          color: #dc2626;
        }

        .status-badge.free {
          background: #f3f4f6;
          color: #6b7280;
        }

        .status-badge.override {
          background: #fef3c7;
          color: #b45309;
        }

        .user-card-section {
          padding: 12px 0;
          border-bottom: 1px solid #e5e7eb;
        }

        .user-card-section:last-child {
          border-bottom: none;
        }

        .user-card-section-title {
          font-size: 11px;
          font-weight: 700;
          color: #9ca3af;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }

        .subscription-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .subscription-item {
          font-size: 13px;
        }

        .subscription-label {
          color: #6b7280;
        }

        .subscription-value {
          font-weight: 600;
          color: #111827;
        }

        .usage-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .usage-item {
          font-size: 13px;
          display: flex;
          flex-direction: column;
        }

        .usage-label {
          color: #6b7280;
          font-size: 12px;
        }

        .usage-value {
          font-weight: 600;
          color: #111827;
        }

        .activity-list {
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          overflow: hidden;
          max-height: 400px;
          overflow-y: auto;
        }

        .activity-item {
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }

        .activity-item:last-child {
          border-bottom: none;
        }

        .activity-info {
          flex: 1;
        }

        .activity-user {
          font-weight: 600;
          font-size: 14px;
          color: #111827;
        }

        .activity-action {
          font-size: 13px;
          color: #6b7280;
          margin-top: 2px;
        }

        .activity-action-badge {
          display: inline-block;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 500;
          background: #f3f4f6;
          color: #374151;
          margin-right: 4px;
        }

        .activity-time {
          font-size: 12px;
          color: #9ca3af;
          white-space: nowrap;
        }

        .activity-filter-row {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }

        .activity-filter-select {
          flex: 1;
          min-width: 150px;
          padding: 10px 12px;
          border: 2px solid #e5e7eb;
          border-radius: 8px;
          font-size: 14px;
          background: white;
          cursor: pointer;
        }

        .activity-filter-select:focus {
          outline: none;
          border-color: #667eea;
        }

        .load-more-btn {
          width: 100%;
          padding: 12px;
          background: #f3f4f6;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          color: #374151;
          cursor: pointer;
          margin-top: 12px;
        }

        .load-more-btn:hover {
          background: #e5e7eb;
        }

        .load-more-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .activity-sentinel {
          padding: 16px;
          display: flex;
          justify-content: center;
          align-items: center;
        }

        .registration-status-grid {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 12px;
        }

        .registration-status-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          padding: 8px 12px;
          border-radius: 8px;
        }

        .registration-status-item.complete {
          background: #d1fae5;
          color: #047857;
        }

        .registration-status-item.incomplete {
          background: #fee2e2;
          color: #dc2626;
        }

        .send-reminder-btn {
          width: 100%;
          padding: 10px 16px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: background 0.2s;
        }

        .send-reminder-btn:hover:not(:disabled) {
          background: #5a6fd6;
        }

        .send-reminder-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .fully-registered-message {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 10px 16px;
          background: #d1fae5;
          color: #047857;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
        }

        .reminder-feedback {
          margin-top: 8px;
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 13px;
          text-align: center;
        }

        .reminder-feedback.success {
          background: #d1fae5;
          color: #047857;
        }

        .reminder-feedback.error {
          background: #fee2e2;
          color: #dc2626;
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
          <div className="header-left">
            <Crown size={24} />
            <h1>{t('title')}</h1>
          </div>
          <div className="header-right">
            <div className="admin-badge">{t('badge')}</div>
            <button className="header-icon-btn" onClick={openUserDashboard} aria-label="User Dashboard">
              <LayoutDashboard size={20} />
            </button>
          </div>
        </header>

        <div className="admin-content">
          {/* AI Model Testing Section */}
          <div className="section">
            <div className="section-header section-header-clickable" onClick={() => toggleSection('testing')}>
              <span className="section-icon"><Bot size={20} /></span>
              <h2 className="section-title">{t('testing.title')}</h2>
              <span className={`section-chevron ${collapsedSections['testing'] ? 'collapsed' : ''}`}>
                <ChevronDown size={20} />
              </span>
            </div>
            <div className={`section-content ${collapsedSections['testing'] ? 'collapsed' : ''}`}>
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
          </div>

          {/* Feature Toggles Section */}
          <div className="section">
            <div className="section-header section-header-clickable" onClick={() => toggleSection('features')}>
              <span className="section-icon"><Bell size={20} /></span>
              <h2 className="section-title">{t('features.title')}</h2>
              <span className={`section-chevron ${collapsedSections['features'] ? 'collapsed' : ''}`}>
                <ChevronDown size={20} />
              </span>
            </div>
            <div className={`section-content ${collapsedSections['features'] ? 'collapsed' : ''}`}>
            <div className="toggle-row">
              <div className="toggle-info">
                <p className="toggle-label">{t('features.reminders')}</p>
                <p className="toggle-description">{t('features.remindersDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${remindersEnabled ? 'checked' : ''} ${remindersSaving ? 'disabled' : ''}`}
                onClick={() => !remindersSaving && toggleReminders()}
                role="switch"
                aria-checked={remindersEnabled}
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !remindersSaving) {
                    e.preventDefault();
                    toggleReminders();
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>
            </div>
          </div>

          {/* User Feature Overrides Section */}
          <div className="section">
            <div className="section-header">
              <span className="section-icon section-header-clickable" onClick={() => toggleSection('overrides')}><UserCog size={20} /></span>
              <h2 className="section-title section-header-clickable" onClick={() => toggleSection('overrides')}>{t('overrides.title')}</h2>
              <button
                className="refresh-btn"
                onClick={refreshAll}
                disabled={isLoadingUsers || isLoadingActivity}
                aria-label="Refresh data"
              >
                <RefreshCw size={18} className={isLoadingUsers || isLoadingActivity ? 'animate-spin' : ''} />
              </button>
              <span className={`section-chevron section-header-clickable ${collapsedSections['overrides'] ? 'collapsed' : ''}`} onClick={() => toggleSection('overrides')}>
                <ChevronDown size={20} />
              </span>
            </div>
            <div className={`section-content ${collapsedSections['overrides'] ? 'collapsed' : ''}`}>

            {/* Filter Chips */}
            <div className="filter-chips">
              <button
                className={`filter-chip ${activeFilter === 'all' ? 'active' : ''}`}
                onClick={() => setActiveFilter('all')}
              >
                {t('overrides.filterAll')}
              </button>
              <button
                className={`filter-chip ${activeFilter === 'trial' ? 'active' : ''}`}
                onClick={() => setActiveFilter('trial')}
              >
                {t('overrides.filterTrial')}
              </button>
              <button
                className={`filter-chip ${activeFilter === 'paid' ? 'active' : ''}`}
                onClick={() => setActiveFilter('paid')}
              >
                {t('overrides.filterPaid')}
              </button>
              <button
                className={`filter-chip ${activeFilter === 'free' ? 'active' : ''}`}
                onClick={() => setActiveFilter('free')}
              >
                {t('overrides.filterFree')}
              </button>
              <button
                className={`filter-chip ${activeFilter === 'override' ? 'active' : ''}`}
                onClick={() => setActiveFilter('override')}
              >
                {t('overrides.filterOverride')}
              </button>
            </div>

            {/* Name Filter */}
            <div className="search-container">
              <input
                type="text"
                className="search-input"
                placeholder={t('overrides.filterByName')}
                value={nameFilter}
                onChange={(e) => setNameFilter(e.target.value)}
              />
              <span className="search-icon">
                <Search size={18} />
              </span>
            </div>

            {/* User List */}
            {!selectedUser && (
              <div className="user-list-scroll">
                {isLoadingUsers ? (
                  <div className="empty-state">
                    <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto' }} />
                  </div>
                ) : filteredUsers.length === 0 ? (
                  <div className="empty-state">{t('overrides.noUsers')}</div>
                ) : (
                  filteredUsers.map((user) => (
                    <div
                      key={user.id}
                      className="user-list-item"
                      onClick={() => loadUserDetails(user.id)}
                    >
                      <span className="user-list-name">{user.name}</span>
                      <div className="user-list-right">
                        <span className={`plan-badge ${user.subscription?.plan?.toLowerCase() || 'free'}`}>
                          {user.subscription?.plan || 'FREE'}
                        </span>
                        {user.subscription?.status === 'TRIALING' && user.subscription?.trialDaysRemaining && (
                          <span className="status-badge trial">
                            {user.subscription.trialDaysRemaining}d
                          </span>
                        )}
                        {user.subscription?.status === 'ACTIVE' && (
                          <span className="status-badge active">
                            {t('overrides.statusActive')}
                          </span>
                        )}
                        {user.subscription?.status === 'EXPIRED' && (
                          <span className="status-badge expired">
                            {t('overrides.statusExpired')}
                          </span>
                        )}
                        {user.hasOverride && (
                          <span className="status-badge override">
                            {t('overrides.statusOverride')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Loading User */}
            {isLoadingUser && (
              <div className="user-card">
                <div className="empty-state">
                  <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto' }} />
                </div>
              </div>
            )}

            {/* Selected User Card */}
            {selectedUser && !isLoadingUser && (
              <div className="user-card">
                <div className="user-card-header">
                  <div className="user-card-info">
                    <h3>{selectedUser.name}</h3>
                    <p>Telegram ID: {selectedUser.telegramId || 'N/A'}</p>
                  </div>
                  <button className="close-btn" onClick={clearSelectedUser}>
                    <X size={20} />
                  </button>
                </div>

                {/* Subscription Section */}
                <div className="user-card-section">
                  <div className="user-card-section-title">{t('overrides.subscriptionTitle')}</div>
                  <div className="subscription-grid">
                    <div className="subscription-item">
                      <span className="subscription-label">{t('overrides.plan')}: </span>
                      <span className={`plan-badge ${selectedUser.subscription?.plan?.toLowerCase() || 'free'}`}>
                        {selectedUser.subscription?.plan || 'FREE'}
                      </span>
                    </div>
                    <div className="subscription-item">
                      <span className="subscription-label">{t('overrides.status')}: </span>
                      <span className="subscription-value">
                        {selectedUser.subscription?.status === 'TRIALING' ? t('overrides.statusTrialing') :
                         selectedUser.subscription?.status === 'ACTIVE' ? t('overrides.statusActive') :
                         selectedUser.subscription?.status === 'EXPIRED' ? t('overrides.statusExpired') :
                         selectedUser.subscription?.status === 'CANCELED' ? t('overrides.statusCanceled') :
                         t('overrides.statusFree')}
                      </span>
                    </div>
                    {selectedUser.subscription?.status === 'TRIALING' && selectedUser.subscription?.trialDaysRemaining && (
                      <div className="subscription-item">
                        <span className="subscription-label">{t('overrides.trialRemaining')}: </span>
                        <span className="subscription-value">{selectedUser.subscription.trialDaysRemaining} {t('overrides.days')}</span>
                      </div>
                    )}
                    {selectedUser.subscription?.status === 'ACTIVE' && selectedUser.subscription?.currentPeriodEnd && (
                      <div className="subscription-item">
                        <span className="subscription-label">{t('overrides.periodEnd')}: </span>
                        <span className="subscription-value">
                          {new Date(selectedUser.subscription.currentPeriodEnd).toLocaleDateString(intlLocale, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Usage Section */}
                <div className="user-card-section">
                  <div className="user-card-section-title">{t('overrides.usageTitle')}</div>
                  <div className="usage-grid">
                    <div className="usage-item">
                      <span className="usage-label">{t('overrides.textSummaries')}</span>
                      <span className="usage-value">
                        {selectedUser.usage.textSummariesUsed} / {selectedUser.limits.textSummaries === Infinity ? '∞' : selectedUser.limits.textSummaries}
                      </span>
                    </div>
                    <div className="usage-item">
                      <span className="usage-label">{t('overrides.voiceSummaries')}</span>
                      <span className="usage-value">
                        {selectedUser.usage.voiceSummariesUsed} / {selectedUser.limits.voiceSummaries === Infinity ? '∞' : selectedUser.limits.voiceSummaries}
                      </span>
                    </div>
                    <div className="usage-item">
                      <span className="usage-label">{t('overrides.voiceEventsUsage')}</span>
                      <span className="usage-value">{selectedUser.usage.voiceEventsCreated}</span>
                    </div>
                    <div className="usage-item">
                      <span className="usage-label">{t('overrides.calendarsUsage')}</span>
                      <span className="usage-value">
                        {selectedUser.calendarsCount} / {selectedUser.limits.calendars === Infinity ? '∞' : selectedUser.limits.calendars}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Registration Status Section */}
                <div className="user-card-section">
                  <div className="user-card-section-title">{t('overrides.registrationTitle')}</div>
                  <div className="registration-status-grid">
                    <div className={`registration-status-item ${selectedUser.registrationStatus.hasOAuth ? 'complete' : 'incomplete'}`}>
                      {selectedUser.registrationStatus.hasOAuth ? <Check size={16} /> : <X size={16} />}
                      <span>{t('overrides.hasOAuth')}</span>
                    </div>
                    <div className={`registration-status-item ${selectedUser.registrationStatus.hasCalendars ? 'complete' : 'incomplete'}`}>
                      {selectedUser.registrationStatus.hasCalendars ? <Check size={16} /> : <X size={16} />}
                      <span>{t('overrides.hasCalendars')}</span>
                    </div>
                    <div className={`registration-status-item ${selectedUser.registrationStatus.hasLocation ? 'complete' : 'incomplete'}`}>
                      {selectedUser.registrationStatus.hasLocation ? <Check size={16} /> : <X size={16} />}
                      <span>{t('overrides.hasLocation')}</span>
                    </div>
                  </div>

                  {/* Reminder Button or Fully Registered Message */}
                  {selectedUser.registrationStatus.applicableReminder ? (
                    <button
                      className="send-reminder-btn"
                      onClick={() => sendReminder(selectedUser.registrationStatus.applicableReminder!)}
                      disabled={isSendingReminder}
                    >
                      {isSendingReminder ? (
                        <>
                          <Loader2 size={16} className="animate-spin" />
                          {t('overrides.sendingReminder')}
                        </>
                      ) : (
                        t(`overrides.sendReminder_${selectedUser.registrationStatus.applicableReminder}`)
                      )}
                    </button>
                  ) : (
                    <div className="fully-registered-message">
                      <Check size={16} />
                      {t('overrides.fullyRegistered')}
                    </div>
                  )}

                  {/* Reminder Feedback */}
                  {reminderFeedback && (
                    <div className={`reminder-feedback ${reminderFeedback.type}`}>
                      {reminderFeedback.message}
                    </div>
                  )}
                </div>

                {/* Feature Overrides Section */}
                <div className="user-card-section">
                  <div className="user-card-section-title">{t('overrides.featureOverridesTitle')}</div>

                {/* Override Toggles */}
                <div className="override-toggles">
                  {/* Unlimited Summaries */}
                  <div className={`override-toggle-row ${selectedUser.paidFeatures.unlimitedSummaries ? 'paid' : ''}`}>
                    <div className="override-toggle-info">
                      <p className="override-toggle-label">
                        {t('overrides.unlimitedSummaries')}
                        {selectedUser.paidFeatures.unlimitedSummaries && (
                          <span className="paid-badge">{t('overrides.paidBadge')}</span>
                        )}
                      </p>
                      <p className="override-toggle-desc">{t('overrides.unlimitedSummariesDesc')}</p>
                    </div>
                    <div
                      className={`mini-toggle ${pendingOverrides.unlimitedSummaries || selectedUser.paidFeatures.unlimitedSummaries ? 'checked' : ''} ${selectedUser.paidFeatures.unlimitedSummaries ? 'disabled' : ''}`}
                      onClick={() => {
                        if (!selectedUser.paidFeatures.unlimitedSummaries) {
                          setPendingOverrides(prev => ({ ...prev, unlimitedSummaries: !prev.unlimitedSummaries }));
                        }
                      }}
                    >
                      <div className="mini-toggle-slider" />
                    </div>
                  </div>

                  {/* Reminders */}
                  <div className={`override-toggle-row ${selectedUser.paidFeatures.remindersEnabled ? 'paid' : ''}`}>
                    <div className="override-toggle-info">
                      <p className="override-toggle-label">
                        {t('overrides.reminders')}
                        {selectedUser.paidFeatures.remindersEnabled && (
                          <span className="paid-badge">{t('overrides.paidBadge')}</span>
                        )}
                      </p>
                      <p className="override-toggle-desc">{t('overrides.remindersDesc')}</p>
                    </div>
                    <div
                      className={`mini-toggle ${pendingOverrides.remindersEnabled || selectedUser.paidFeatures.remindersEnabled ? 'checked' : ''} ${selectedUser.paidFeatures.remindersEnabled ? 'disabled' : ''}`}
                      onClick={() => {
                        if (!selectedUser.paidFeatures.remindersEnabled) {
                          setPendingOverrides(prev => ({ ...prev, remindersEnabled: !prev.remindersEnabled }));
                        }
                      }}
                    >
                      <div className="mini-toggle-slider" />
                    </div>
                  </div>

                  {/* Voice Events */}
                  <div className={`override-toggle-row ${selectedUser.paidFeatures.voiceEventsEnabled ? 'paid' : ''}`}>
                    <div className="override-toggle-info">
                      <p className="override-toggle-label">
                        {t('overrides.voiceEvents')}
                        {selectedUser.paidFeatures.voiceEventsEnabled && (
                          <span className="paid-badge">{t('overrides.paidBadge')}</span>
                        )}
                      </p>
                      <p className="override-toggle-desc">{t('overrides.voiceEventsDesc')}</p>
                    </div>
                    <div
                      className={`mini-toggle ${pendingOverrides.voiceEventsEnabled || selectedUser.paidFeatures.voiceEventsEnabled ? 'checked' : ''} ${selectedUser.paidFeatures.voiceEventsEnabled ? 'disabled' : ''}`}
                      onClick={() => {
                        if (!selectedUser.paidFeatures.voiceEventsEnabled) {
                          setPendingOverrides(prev => ({ ...prev, voiceEventsEnabled: !prev.voiceEventsEnabled }));
                        }
                      }}
                    >
                      <div className="mini-toggle-slider" />
                    </div>
                  </div>

                  {/* Unlimited Calendars */}
                  <div className={`override-toggle-row ${selectedUser.paidFeatures.unlimitedCalendars ? 'paid' : ''}`}>
                    <div className="override-toggle-info">
                      <p className="override-toggle-label">
                        {t('overrides.unlimitedCalendars')}
                        {selectedUser.paidFeatures.unlimitedCalendars && (
                          <span className="paid-badge">{t('overrides.paidBadge')}</span>
                        )}
                      </p>
                      <p className="override-toggle-desc">{t('overrides.unlimitedCalendarsDesc')}</p>
                    </div>
                    <div
                      className={`mini-toggle ${pendingOverrides.unlimitedCalendars || selectedUser.paidFeatures.unlimitedCalendars ? 'checked' : ''} ${selectedUser.paidFeatures.unlimitedCalendars ? 'disabled' : ''}`}
                      onClick={() => {
                        if (!selectedUser.paidFeatures.unlimitedCalendars) {
                          setPendingOverrides(prev => ({ ...prev, unlimitedCalendars: !prev.unlimitedCalendars }));
                        }
                      }}
                    >
                      <div className="mini-toggle-slider" />
                    </div>
                  </div>
                </div>

                {/* Reason Input */}
                <input
                  type="text"
                  className="reason-input"
                  placeholder={t('overrides.reasonPlaceholder')}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />

                {/* Save Button */}
                <button
                  className="save-override-btn"
                  onClick={saveOverride}
                  disabled={isSavingOverride}
                >
                  {isSavingOverride ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      {t('overrides.saving')}
                    </>
                  ) : (
                    <>
                      <Check size={16} />
                      {t('overrides.save')}
                    </>
                  )}
                </button>
                </div>
              </div>
            )}

            </div>
          </div>

          {/* User Activity Section */}
          <div className="section">
            <div className="section-header">
              <span className="section-icon section-header-clickable" onClick={() => toggleSection('activity')}><Clock size={20} /></span>
              <h2 className="section-title section-header-clickable" onClick={() => toggleSection('activity')}>{t('activity.title')}</h2>
              <button
                className="refresh-btn"
                onClick={() => fetchActivity(true)}
                disabled={isLoadingActivity}
                aria-label="Refresh activity"
              >
                <RefreshCw size={18} className={isLoadingActivity ? 'animate-spin' : ''} />
              </button>
              <span className={`section-chevron section-header-clickable ${collapsedSections['activity'] ? 'collapsed' : ''}`} onClick={() => toggleSection('activity')}>
                <ChevronDown size={20} />
              </span>
            </div>
            <div className={`section-content ${collapsedSections['activity'] ? 'collapsed' : ''}`}>

            {/* Activity Filter */}
            <div className="activity-filter-row">
              <select
                className="activity-filter-select"
                value={activityFilter}
                onChange={(e) => setActivityFilter(e.target.value)}
              >
                <option value="">{t('activity.allActions')}</option>
                {activityStats.map(stat => (
                  <option key={stat.action} value={stat.action}>
                    {stat.action} ({stat.count})
                  </option>
                ))}
              </select>
            </div>

            {/* Activity List */}
            <div className="activity-list">
              {isLoadingActivity && activities.length === 0 ? (
                <div className="empty-state">
                  <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto' }} />
                  <p>{t('activity.loading')}</p>
                </div>
              ) : activities.length === 0 ? (
                <div className="empty-state">{t('activity.noActivity')}</div>
              ) : (
                activities.map((activity) => (
                  <div key={activity.id} className="activity-item">
                    <div className="activity-info">
                      <div className="activity-user">{activity.userName}</div>
                      <div className="activity-action">
                        <span className="activity-action-badge">{activity.action}</span>
                        {activity.metadata && Object.keys(activity.metadata).length > 0 && (
                          <span style={{ fontSize: '11px', color: '#9ca3af' }}>
                            {JSON.stringify(activity.metadata).substring(0, 50)}
                            {JSON.stringify(activity.metadata).length > 50 && '...'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="activity-time">
                      {formatRelativeTime(activity.createdAt)}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Infinite scroll sentinel */}
            {activityHasMore && (
              <div ref={activitySentinelRef} className="activity-sentinel">
                {isLoadingActivity && (
                  <Loader2 size={20} className="animate-spin" style={{ margin: '0 auto' }} />
                )}
              </div>
            )}
            </div>
          </div>

          {/* User Statistics Section */}
          <div className="section">
            <div className="section-header section-header-clickable" onClick={() => toggleSection('statistics')}>
              <span className="section-icon"><Users size={20} /></span>
              <h2 className="section-title">{t('statistics.title')}</h2>
              <span className={`section-chevron ${collapsedSections['statistics'] ? 'collapsed' : ''}`}>
                <ChevronDown size={20} />
              </span>
            </div>
            <div className={`section-content ${collapsedSections['statistics'] ? 'collapsed' : ''}`}>
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
            </div>
          </div>

          {/* System Health Section */}
          <div className="section">
            <div className="section-header section-header-clickable" onClick={() => toggleSection('health')}>
              <span className="section-icon"><Activity size={20} /></span>
              <h2 className="section-title">{t('health.title')}</h2>
              <span className={`section-chevron ${collapsedSections['health'] ? 'collapsed' : ''}`}>
                <ChevronDown size={20} />
              </span>
            </div>
            <div className={`section-content ${collapsedSections['health'] ? 'collapsed' : ''}`}>
            <div className="health-list">
              <div className="health-item">
                <span className="health-label">{t('health.database')}</span>
                <span className="status-icon"><Activity size={20} color="#22c55e" /></span>
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
          </div>
        </div>
      </div>
    </>
  );
}
