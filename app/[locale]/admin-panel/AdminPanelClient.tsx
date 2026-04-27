'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, Crown, Users, LayoutDashboard, Bell, UserCog, Search, X, Check, Loader2, Clock, RefreshCw, ChevronDown, MessageSquare } from 'lucide-react';
import { AI_MODELS } from '@/src/config/ai-models';

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
  earlyAdoptionMode: boolean;
  defaultAiModel: string | null;
  geminiThinkingLevel: string | null;
}


interface UserListItem {
  id: number;
  telegramId: number | null;
  name: string;
  suspendedAt: string | null;
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
  earlyAdopter?: boolean;
}

type FilterType = 'all' | 'trial' | 'paid' | 'free' | 'override';

interface UserOverrideDetails {
  id: number;
  telegramId: number | null;
  whatsappPhone: string | null;
  messagingPlatform: string;
  createdAt: string;
  name: string;
  suspendedAt: string | null;
  suspendedBy: number | null;
  suspendedReason: string | null;
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
    earlyAdopter: boolean;
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
  setupReminders: {
    daysSinceCreated: number;
    daysSinceStart: number;
    wasReset: boolean;
    oauth: Array<{ day: number; sent: boolean; due: boolean }>;
    calendars: Array<{ day: number; sent: boolean; due: boolean }>;
    location: Array<{ day: number; sent: boolean; due: boolean }>;
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

interface FeedbackItem {
  id: string;
  userId: number;
  userName: string;
  userTelegramId: number | null;
  text: string;
  source: 'telegram' | 'dashboard';
  createdAt: string;
}

export default function AdminPanelClient({ userId, locale, stats, remindersEnabled: initialRemindersEnabled, earlyAdoptionMode: initialEarlyAdoptionMode, defaultAiModel: initialDefaultAiModel, geminiThinkingLevel: initialGeminiThinkingLevel }: AdminPanelClientProps) {
  const t = useTranslations('admin');
  const [remindersEnabled, setRemindersEnabled] = useState(initialRemindersEnabled);
  const [remindersSaving, setRemindersSaving] = useState(false);
  const [earlyAdoptionMode, setEarlyAdoptionMode] = useState(initialEarlyAdoptionMode);
  const [earlyAdoptionSaving, setEarlyAdoptionSaving] = useState(false);
  const [defaultAiModel, setDefaultAiModel] = useState(initialDefaultAiModel ?? '');
  const [aiModelSaving, setAiModelSaving] = useState(false);
  const [geminiThinkingLevel, setGeminiThinkingLevel] = useState(initialGeminiThinkingLevel ?? '');
  const [thinkingLevelSaving, setThinkingLevelSaving] = useState(false);

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
    earlyAdopter: false,
  });

  // Reminder sending state
  const [isSendingReminder, setIsSendingReminder] = useState(false);
  const [reminderFeedback, setReminderFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  // Reset reminders state
  const [isResettingReminders, setIsResettingReminders] = useState(false);
  const [isResettingAll, setIsResettingAll] = useState(false);
  const [resetAllFeedback, setResetAllFeedback] = useState<string | null>(null);
  // Platform switch state
  const [isSwitchingPlatform, setIsSwitchingPlatform] = useState(false);
  const [whatsappPhoneInput, setWhatsappPhoneInput] = useState('');

  // Moderation state (suspend / hard-delete / ban)
  const [moderationReason, setModerationReason] = useState('');
  const [isSuspending, setIsSuspending] = useState(false);
  const [isHardDeleting, setIsHardDeleting] = useState(false);
  const [isBanning, setIsBanning] = useState(false);
  const [showHardDeleteConfirm, setShowHardDeleteConfirm] = useState(false);
  const [hardDeleteConfirmText, setHardDeleteConfirmText] = useState('');
  const [banTelegram, setBanTelegram] = useState(true);
  const [banWhatsapp, setBanWhatsapp] = useState(true);
  const [moderationFeedback, setModerationFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Blocklist state
  interface BlocklistEntry {
    id: number;
    telegramId: number | null;
    whatsappPhone: string | null;
    bannedBy: number;
    bannedReason: string | null;
    createdAt: string;
  }
  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([]);
  const [isLoadingBlocklist, setIsLoadingBlocklist] = useState(false);
  const [unbanningId, setUnbanningId] = useState<number | null>(null);

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

  // Feedback state
  const [feedbacks, setFeedbacks] = useState<FeedbackItem[]>([]);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const [expandedFeedback, setExpandedFeedback] = useState<string | null>(null);

  const toggleSection = (sectionId: string) => {
    setCollapsedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  // Infinite scroll for activity list
  const activitySentinelRef = useRef<HTMLDivElement>(null);

  // Map app locale to Intl locale
  const intlLocale = { he: 'he-IL', ru: 'ru-RU', en: 'en-US' }[locale] ?? 'en-US';

  // Format dates for today and tomorrow buttons
  useEffect(() => {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();
      tg.ready();
      tg.setHeaderColor('#667eea');
      tg.setBackgroundColor('#ffffff');
    }
  }, []);

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

  const toggleEarlyAdoption = async () => {
    setEarlyAdoptionSaving(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ earlyAdoptionMode: !earlyAdoptionMode, initData })
      });
      if (response.ok) {
        setEarlyAdoptionMode(!earlyAdoptionMode);
      }
    } finally {
      setEarlyAdoptionSaving(false);
    }
  };

  const changeAiModel = async (modelId: string) => {
    setAiModelSaving(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultAiModel: modelId || null, initData })
      });
      if (response.ok) {
        setDefaultAiModel(modelId);
      }
    } finally {
      setAiModelSaving(false);
    }
  };

  const changeThinkingLevel = async (level: string) => {
    setThinkingLevelSaving(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiThinkingLevel: level || null, initData })
      });
      if (response.ok) {
        setGeminiThinkingLevel(level);
      }
    } finally {
      setThinkingLevelSaving(false);
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

  // Fetch user feedback
  const fetchFeedback = useCallback(async () => {
    setIsLoadingFeedback(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch(`/api/admin/feedback?initData=${encodeURIComponent(initData || '')}&limit=50`);
      const data = await response.json();
      if (data.success) {
        setFeedbacks(data.feedbacks || []);
      }
    } catch (error) {
      console.error('Failed to fetch feedback:', error);
    } finally {
      setIsLoadingFeedback(false);
    }
  }, []);

  // Refresh all data
  const refreshAll = useCallback(() => {
    fetchUserList();
    fetchActivity(true);
    fetchFeedback();
  }, [fetchUserList, fetchActivity, fetchFeedback]);

  // Load user list, activity, and feedback on mount
  useEffect(() => {
    fetchUserList();
    fetchActivity(true);
    fetchFeedback();
  }, [fetchUserList, fetchFeedback]);

  // Reload activity when filter changes
  useEffect(() => {
    fetchActivity(true);
  }, [activityFilter]);

  // Refs to avoid re-creating the observer on every state change
  const activityHasMoreRef = useRef(activityHasMore);
  const isLoadingActivityRef = useRef(isLoadingActivity);
  const fetchActivityRef = useRef(fetchActivity);

  useEffect(() => { activityHasMoreRef.current = activityHasMore; }, [activityHasMore]);
  useEffect(() => { isLoadingActivityRef.current = isLoadingActivity; }, [isLoadingActivity]);
  useEffect(() => { fetchActivityRef.current = fetchActivity; }, [fetchActivity]);

  // Stable IntersectionObserver — created once, reads current values from refs
  useEffect(() => {
    const sentinel = activitySentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && activityHasMoreRef.current && !isLoadingActivityRef.current) {
          fetchActivityRef.current(false);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          earlyAdopter: data.user.override?.earlyAdopter === true,
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
          earlyAdopter: pendingOverrides.earlyAdopter || false,
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

  // Reset setup reminders for a user
  const resetReminders = async () => {
    if (!selectedUser) return;
    setIsResettingReminders(true);
    setReminderFeedback(null);

    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/reset-reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, user_id: selectedUser.id }),
      });
      const data = await response.json();
      if (data.success) {
        setReminderFeedback({ type: 'success', message: t('overrides.remindersReset') });
        await loadUserDetails(selectedUser.id);
        setTimeout(() => setReminderFeedback(null), 3000);
      } else {
        setReminderFeedback({ type: 'error', message: data.error || t('overrides.remindersResetFailed') });
      }
    } catch (error) {
      console.error('Failed to reset reminders:', error);
      setReminderFeedback({ type: 'error', message: t('overrides.remindersResetFailed') });
    } finally {
      setIsResettingReminders(false);
    }
  };

  // Reset all incomplete users' reminders
  const resetAllIncomplete = async () => {
    setIsResettingAll(true);
    setResetAllFeedback(null);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/reset-reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, reset_all: true }),
      });
      const data = await response.json();
      if (data.success) {
        setResetAllFeedback(t('overrides.resetAllResult').replace('{count}', String(data.usersReset)));
        setTimeout(() => setResetAllFeedback(null), 5000);
      } else {
        setResetAllFeedback(data.error || 'Failed');
      }
    } catch {
      setResetAllFeedback('Failed');
    } finally {
      setIsResettingAll(false);
    }
  };

  // ============================================
  // Moderation handlers
  // ============================================

  const showModFeedback = (type: 'success' | 'error', message: string, persist = false) => {
    setModerationFeedback({ type, message });
    if (!persist) {
      setTimeout(() => setModerationFeedback(null), 3000);
    }
  };

  const callModerationAction = async (
    action: 'suspend' | 'unsuspend' | 'hard_delete',
    extra: Record<string, unknown> = {}
  ): Promise<boolean> => {
    if (!selectedUser) return false;
    const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
    try {
      const response = await fetch('/api/admin/users/moderation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData,
          action,
          user_id: selectedUser.id,
          reason: moderationReason || null,
          ...extra,
        }),
      });
      const data = await response.json();
      if (!data.success) {
        showModFeedback('error', data.error || 'Action failed');
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[Moderation] ${action} failed:`, err);
      showModFeedback('error', 'Network error');
      return false;
    }
  };

  const suspendSelectedUser = async () => {
    if (!selectedUser) return;
    setIsSuspending(true);
    const ok = await callModerationAction('suspend');
    if (ok) {
      showModFeedback('success', 'User suspended');
      setModerationReason('');
      await loadUserDetails(selectedUser.id);
      await fetchUserList();
    }
    setIsSuspending(false);
  };

  const unsuspendSelectedUser = async () => {
    if (!selectedUser) return;
    setIsSuspending(true);
    const ok = await callModerationAction('unsuspend');
    if (ok) {
      showModFeedback('success', 'User unsuspended');
      await loadUserDetails(selectedUser.id);
      await fetchUserList();
    }
    setIsSuspending(false);
  };

  const hardDeleteSelectedUser = async () => {
    if (!selectedUser) return;
    if (hardDeleteConfirmText !== 'DELETE') {
      showModFeedback('error', 'Type DELETE to confirm');
      return;
    }
    setIsHardDeleting(true);
    const ok = await callModerationAction('hard_delete', { confirmation: 'DELETE' });
    if (ok) {
      // User is gone — clear selection and refresh list
      setShowHardDeleteConfirm(false);
      setHardDeleteConfirmText('');
      setModerationReason('');
      clearSelectedUser();
      await fetchUserList();
      await fetchBlocklist(); // in case user was also banned earlier
      showModFeedback('success', 'User deleted', true);
    }
    setIsHardDeleting(false);
  };

  const banSelectedUserIdentifiers = async () => {
    if (!selectedUser) return;
    if (!banTelegram && !banWhatsapp) {
      showModFeedback('error', 'Select at least one identifier to ban');
      return;
    }
    const tg = banTelegram ? selectedUser.telegramId : null;
    const wa = banWhatsapp ? selectedUser.whatsappPhone : null;
    if (!tg && !wa) {
      showModFeedback('error', 'No matching identifier on user');
      return;
    }
    setIsBanning(true);
    const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
    try {
      const response = await fetch('/api/admin/users/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData,
          action: 'ban',
          telegramId: tg,
          whatsappPhone: wa,
          reason: moderationReason || null,
        }),
      });
      const data = await response.json();
      if (data.success) {
        showModFeedback('success', 'Identifier banned');
        setModerationReason('');
        await fetchBlocklist();
      } else {
        showModFeedback('error', data.error || 'Ban failed');
      }
    } catch (err) {
      console.error('[Moderation] ban failed:', err);
      showModFeedback('error', 'Network error');
    }
    setIsBanning(false);
  };

  const fetchBlocklist = useCallback(async () => {
    setIsLoadingBlocklist(true);
    const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
    try {
      const response = await fetch(`/api/admin/users/blocklist?initData=${encodeURIComponent(initData || '')}`);
      const data = await response.json();
      if (data.success) setBlocklist(data.blocklist);
    } catch (err) {
      console.error('[Blocklist] fetch failed:', err);
    } finally {
      setIsLoadingBlocklist(false);
    }
  }, []);

  useEffect(() => {
    fetchBlocklist();
  }, [fetchBlocklist]);

  const unbanEntry = async (entry: BlocklistEntry) => {
    setUnbanningId(entry.id);
    const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
    try {
      const response = await fetch('/api/admin/users/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData,
          action: 'unban',
          telegramId: entry.telegramId,
          whatsappPhone: entry.whatsappPhone,
        }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchBlocklist();
      }
    } catch (err) {
      console.error('[Blocklist] unban failed:', err);
    }
    setUnbanningId(null);
  };

  // Switch user to WhatsApp
  const switchToWhatsApp = async () => {
    if (!selectedUser || !whatsappPhoneInput.trim()) return;
    setIsSwitchingPlatform(true);
    setReminderFeedback(null);

    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/switch-platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData,
          user_id: selectedUser.id,
          whatsapp_phone: whatsappPhoneInput.trim(),
        }),
      });
      const data = await response.json();
      if (data.success) {
        setReminderFeedback({ type: 'success', message: t('overrides.platformSwitched') });
        setWhatsappPhoneInput('');
        // Refresh user details
        await loadUserDetails(selectedUser.id);
        setTimeout(() => setReminderFeedback(null), 3000);
      } else {
        setReminderFeedback({ type: 'error', message: data.error || t('overrides.platformSwitchFailed') });
      }
    } catch (error) {
      console.error('Failed to switch platform:', error);
      setReminderFeedback({ type: 'error', message: t('overrides.platformSwitchFailed') });
    } finally {
      setIsSwitchingPlatform(false);
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

        .feedback-list {
          background: white;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          overflow: hidden;
          max-height: 400px;
          overflow-y: auto;
        }

        .feedback-item {
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
          cursor: pointer;
          transition: background 0.2s;
        }

        .feedback-item:hover {
          background: #f9fafb;
        }

        .feedback-item:last-child {
          border-bottom: none;
        }

        .feedback-item.expanded {
          background: #f0f4ff;
        }

        .feedback-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
        }

        .feedback-user {
          font-weight: 600;
          font-size: 14px;
          color: #111827;
          min-width: 80px;
          flex-shrink: 0;
        }

        .feedback-preview {
          flex: 1;
          font-size: 13px;
          color: #6b7280;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .feedback-item.expanded .feedback-preview {
          white-space: pre-wrap;
          overflow: visible;
        }

        .feedback-source {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          font-weight: 500;
          background: #f3f4f6;
          color: #6b7280;
          flex-shrink: 0;
        }

        .feedback-source.telegram {
          background: #dbeafe;
          color: #1d4ed8;
        }

        .feedback-source.dashboard {
          background: #d1fae5;
          color: #047857;
        }

        .feedback-time {
          font-size: 12px;
          color: #9ca3af;
          white-space: nowrap;
          flex-shrink: 0;
        }

        @media (max-width: 400px) {
          .stats-grid,
          .button-group {
            grid-template-columns: 1fr;
          }

          .feedback-row {
            flex-wrap: wrap;
          }

          .feedback-user {
            width: 100%;
          }

          .feedback-preview {
            width: 100%;
            order: 3;
            margin-top: 8px;
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
            <div className="toggle-row" style={{ marginTop: '12px' }}>
              <div className="toggle-info">
                <p className="toggle-label">{t('features.earlyAdoption')}</p>
                <p className="toggle-description">{t('features.earlyAdoptionDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${earlyAdoptionMode ? 'checked' : ''} ${earlyAdoptionSaving ? 'disabled' : ''}`}
                onClick={() => !earlyAdoptionSaving && toggleEarlyAdoption()}
                role="switch"
                aria-checked={earlyAdoptionMode}
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !earlyAdoptionSaving) {
                    e.preventDefault();
                    toggleEarlyAdoption();
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>
            <div className="toggle-row" style={{ marginTop: '12px' }}>
              <div className="toggle-info">
                <p className="toggle-label">{t('features.aiModel')}</p>
                <p className="toggle-description">{t('features.aiModelDescription')}</p>
              </div>
              <select
                value={defaultAiModel}
                onChange={(e) => changeAiModel(e.target.value)}
                disabled={aiModelSaving}
                style={{
                  padding: '6px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color, #ddd)',
                  background: 'var(--card-bg, #fff)',
                  color: 'var(--text-primary, #333)',
                  fontSize: '13px',
                  minWidth: '160px',
                  opacity: aiModelSaving ? 0.6 : 1,
                  cursor: aiModelSaving ? 'not-allowed' : 'pointer',
                }}
              >
                <option value="">Default (env)</option>
                {Object.entries(AI_MODELS).map(([id, model]) => (
                  <option key={id} value={id}>
                    {model.displayName} ({model.provider})
                  </option>
                ))}
              </select>
            </div>
            {defaultAiModel && AI_MODELS[defaultAiModel]?.provider === 'gemini' && (
            <div className="toggle-row" style={{ marginTop: '12px' }}>
              <div className="toggle-info">
                <p className="toggle-label">{t('features.geminiThinking')}</p>
                <p className="toggle-description">{t('features.geminiThinkingDescription')}</p>
              </div>
              <select
                value={geminiThinkingLevel}
                onChange={(e) => changeThinkingLevel(e.target.value)}
                disabled={thinkingLevelSaving}
                style={{
                  padding: '6px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color, #ddd)',
                  background: 'var(--card-bg, #fff)',
                  color: 'var(--text-primary, #333)',
                  fontSize: '13px',
                  minWidth: '160px',
                  opacity: thinkingLevelSaving ? 0.6 : 1,
                  cursor: thinkingLevelSaving ? 'not-allowed' : 'pointer',
                }}
              >
                <option value="">Default (Medium)</option>
                <option value="MINIMAL">Minimal - Lowest latency</option>
                <option value="LOW">Low - Fast</option>
                <option value="MEDIUM">Medium - General</option>
                <option value="HIGH">High - Complex reasoning</option>
              </select>
            </div>
            )}
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

            {/* Reset All + User List */}
            {!selectedUser && (
              <div>
                <button
                  className="send-reminder-btn"
                  style={{ marginBottom: 8, background: '#6b7280' }}
                  onClick={resetAllIncomplete}
                  disabled={isResettingAll}
                >
                  {isResettingAll ? (
                    <><Loader2 size={16} className="animate-spin" /> {t('overrides.resetAllResetting')}</>
                  ) : (
                    t('overrides.resetAllIncomplete')
                  )}
                </button>
                {resetAllFeedback && (
                  <div style={{ fontSize: 12, color: '#047857', marginBottom: 8 }}>{resetAllFeedback}</div>
                )}
              </div>
            )}
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
                      style={user.suspendedAt ? { background: '#fef3c7' } : undefined}
                    >
                      <span className="user-list-name">
                        {user.suspendedAt && <span style={{ marginRight: 4 }} title="Suspended">🟡</span>}
                        {user.name}
                      </span>
                      <div className="user-list-right">
                        {user.suspendedAt && (
                          <span className="status-badge" style={{ background: '#fef3c7', color: '#92400e' }}>
                            Suspended
                          </span>
                        )}
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
                        {(user.earlyAdopter || earlyAdoptionMode) && (
                          <span className="status-badge" style={{ background: '#d1fae5', color: '#047857' }}>
                            {t('overrides.earlyAdopterShort')}
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
                    <h3>
                      {selectedUser.name}
                      {selectedUser.suspendedAt && (
                        <span style={{ marginLeft: 8, fontSize: 12, padding: '2px 6px', borderRadius: 6, background: '#fef3c7', color: '#92400e', verticalAlign: 'middle' }}>
                          🟡 Suspended
                        </span>
                      )}
                    </h3>
                    <p>Telegram ID: {selectedUser.telegramId || 'N/A'}</p>
                    {selectedUser.whatsappPhone && <p>WhatsApp: {selectedUser.whatsappPhone}</p>}
                    <p>{t('overrides.currentPlatform')}: {
                      selectedUser.messagingPlatform === 'whatsapp' ? t('overrides.whatsappOnly') :
                      selectedUser.messagingPlatform === 'all' ? t('overrides.bothPlatforms') :
                      t('overrides.telegramOnly')
                    }</p>
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

                  {/* Setup Reminder Attempts */}
                  {selectedUser.setupReminders && (
                    <div style={{ marginTop: 10, fontSize: 13, color: '#374151' }}>
                      <div style={{ marginBottom: 6, lineHeight: 1.6 }}>
                        <div>
                          {t('overrides.signedUpDaysAgo').replace('{days}', String(selectedUser.setupReminders.daysSinceCreated))}
                          <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>
                            ({new Date(selectedUser.createdAt).toLocaleDateString()})
                          </span>
                        </div>
                        {selectedUser.setupReminders.wasReset && (
                          <div>
                            {t('overrides.serviceStartedDaysAgo').replace('{days}', String(selectedUser.setupReminders.daysSinceStart))}
                          </div>
                        )}
                      </div>
                      {[
                        { label: t('overrides.hasOAuth'), attempts: selectedUser.setupReminders.oauth, done: selectedUser.registrationStatus.hasOAuth },
                        { label: t('overrides.hasCalendars'), attempts: selectedUser.setupReminders.calendars, done: selectedUser.registrationStatus.hasCalendars },
                        { label: t('overrides.hasLocation'), attempts: selectedUser.setupReminders.location, done: selectedUser.registrationStatus.hasLocation },
                      ].map(({ label, attempts, done }) => {
                        const sent = attempts.filter(a => a.sent).length;
                        const due = attempts.filter(a => a.due && !a.sent).length;
                        const total = attempts.length;
                        const sentText = t('overrides.remindersSent').replace('{sent}', String(sent)).replace('{total}', String(total));
                        const overdueText = due > 0 ? t('overrides.remindersOverdue').replace('{count}', String(due)) : '';
                        return (
                          <div key={label} style={{ marginBottom: 6 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                              <span>{done ? '✅' : '⬜'} {label}</span>
                              <span style={{ fontSize: 12, color: '#6b7280' }}>
                                {sentText}{overdueText}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: 2 }}>
                              {attempts.map((a, i) => (
                                <div
                                  key={i}
                                  style={{
                                    flex: 1,
                                    height: 6,
                                    borderRadius: 3,
                                    background: a.sent ? '#10b981' : a.due ? '#f59e0b' : '#e5e7eb',
                                  }}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

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

                  {/* Reset Reminders Button */}
                  <button
                    className="send-reminder-btn"
                    style={{ marginTop: 8, background: '#6b7280' }}
                    onClick={resetReminders}
                    disabled={isResettingReminders}
                  >
                    {isResettingReminders ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        {t('overrides.resettingReminders')}
                      </>
                    ) : (
                      t('overrides.resetReminders')
                    )}
                  </button>

                  {/* Reminder Feedback */}
                  {reminderFeedback && (
                    <div className={`reminder-feedback ${reminderFeedback.type}`}>
                      {reminderFeedback.message}
                    </div>
                  )}
                </div>

                {/* Messaging Platform Section — hide if user already has WhatsApp */}
                {!selectedUser.whatsappPhone && (
                <div className="user-card-section">
                  <div className="user-card-section-title">{t('overrides.platformTitle')}</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="text"
                      value={whatsappPhoneInput}
                      onChange={(e) => setWhatsappPhoneInput(e.target.value)}
                      placeholder={t('overrides.whatsappPhonePlaceholder')}
                      style={{
                        flex: 1,
                        padding: '8px 12px',
                        border: '1px solid #d1d5db',
                        borderRadius: 8,
                        fontSize: 14,
                        direction: 'ltr',
                      }}
                    />
                    <button
                      className="send-reminder-btn"
                      style={{ width: 'auto', whiteSpace: 'nowrap' }}
                      onClick={switchToWhatsApp}
                      disabled={isSwitchingPlatform || !whatsappPhoneInput.trim()}
                    >
                      {isSwitchingPlatform ? (
                        <>
                          <Loader2 size={16} className="animate-spin" />
                          {t('overrides.switchingPlatform')}
                        </>
                      ) : (
                        t('overrides.switchToWhatsApp')
                      )}
                    </button>
                  </div>
                </div>
                )}

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

                  {/* Reminders (TG-only — hide for WA-only users) */}
                  {selectedUser.telegramId && <div className={`override-toggle-row ${selectedUser.paidFeatures.remindersEnabled ? 'paid' : ''}`}>
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
                  </div>}

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

                  {/* Early Adopter */}
                  <div className="override-toggle-row">
                    <div className="override-toggle-info">
                      <p className="override-toggle-label">{t('overrides.earlyAdopter')}</p>
                      <p className="override-toggle-desc">{t('overrides.earlyAdopterDesc')}</p>
                    </div>
                    <div
                      className={`mini-toggle ${pendingOverrides.earlyAdopter ? 'checked' : ''}`}
                      onClick={() => {
                        setPendingOverrides(prev => ({ ...prev, earlyAdopter: !prev.earlyAdopter }));
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

                {/* Moderation Section (suspend / hard delete / ban) */}
                <div className="user-card-section" style={{ borderTop: '2px solid #fee2e2', marginTop: 16, paddingTop: 16 }}>
                  <div className="user-card-section-title" style={{ color: '#b91c1c' }}>Moderation</div>

                  {selectedUser.suspendedAt && (
                    <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 13 }}>
                      <strong>Suspended</strong> on {new Date(selectedUser.suspendedAt).toLocaleString(intlLocale)}
                      {selectedUser.suspendedReason && <div style={{ marginTop: 4 }}>Reason: {selectedUser.suspendedReason}</div>}
                    </div>
                  )}

                  <input
                    type="text"
                    className="reason-input"
                    placeholder="Reason (shared by suspend & ban)"
                    value={moderationReason}
                    onChange={(e) => setModerationReason(e.target.value)}
                    style={{ marginBottom: 8 }}
                  />

                  {/* Suspend / Unsuspend */}
                  {selectedUser.suspendedAt ? (
                    <button
                      className="send-reminder-btn"
                      style={{ marginBottom: 6, background: '#10b981' }}
                      onClick={unsuspendSelectedUser}
                      disabled={isSuspending}
                    >
                      {isSuspending ? <><Loader2 size={16} className="animate-spin" /> Working…</> : 'Unsuspend'}
                    </button>
                  ) : (
                    <button
                      className="send-reminder-btn"
                      style={{ marginBottom: 6, background: '#f59e0b' }}
                      onClick={suspendSelectedUser}
                      disabled={isSuspending}
                    >
                      {isSuspending ? <><Loader2 size={16} className="animate-spin" /> Working…</> : 'Suspend'}
                    </button>
                  )}

                  {/* Ban identifier(s) */}
                  <div style={{ marginTop: 10, padding: 10, border: '1px solid #e5e7eb', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, color: '#374151', marginBottom: 6 }}>
                      Ban identifier so they cannot register again. Survives hard delete.
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 4 }}>
                      <input
                        type="checkbox"
                        checked={banTelegram}
                        disabled={!selectedUser.telegramId}
                        onChange={(e) => setBanTelegram(e.target.checked)}
                      />
                      Telegram ID: <code>{selectedUser.telegramId ?? '—'}</code>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 8 }}>
                      <input
                        type="checkbox"
                        checked={banWhatsapp}
                        disabled={!selectedUser.whatsappPhone}
                        onChange={(e) => setBanWhatsapp(e.target.checked)}
                      />
                      WA Phone: <code>{selectedUser.whatsappPhone ?? '—'}</code>
                    </label>
                    <button
                      className="send-reminder-btn"
                      style={{ background: '#7c3aed' }}
                      onClick={banSelectedUserIdentifiers}
                      disabled={isBanning || (!selectedUser.telegramId && !selectedUser.whatsappPhone)}
                    >
                      {isBanning ? <><Loader2 size={16} className="animate-spin" /> Banning…</> : 'Ban Identifier(s)'}
                    </button>
                  </div>

                  {/* Hard Delete with confirmation */}
                  <div style={{ marginTop: 10, padding: 10, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2' }}>
                    <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 6 }}>
                      Permanently delete this user and all related data (subscription, usage, activity, feedback, overrides). Irreversible.
                    </div>
                    {!showHardDeleteConfirm ? (
                      <button
                        className="send-reminder-btn"
                        style={{ background: '#dc2626' }}
                        onClick={() => setShowHardDeleteConfirm(true)}
                      >
                        Hard Delete…
                      </button>
                    ) : (
                      <>
                        <input
                          type="text"
                          className="reason-input"
                          placeholder="Type DELETE to confirm"
                          value={hardDeleteConfirmText}
                          onChange={(e) => setHardDeleteConfirmText(e.target.value)}
                          style={{ marginBottom: 6 }}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="send-reminder-btn"
                            style={{ background: '#dc2626', flex: 1 }}
                            onClick={hardDeleteSelectedUser}
                            disabled={isHardDeleting || hardDeleteConfirmText !== 'DELETE'}
                          >
                            {isHardDeleting ? <><Loader2 size={16} className="animate-spin" /> Deleting…</> : 'Confirm Delete'}
                          </button>
                          <button
                            className="send-reminder-btn"
                            style={{ background: '#6b7280', flex: 1 }}
                            onClick={() => { setShowHardDeleteConfirm(false); setHardDeleteConfirmText(''); }}
                            disabled={isHardDeleting}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {moderationFeedback && (
                    <div className={`reminder-feedback ${moderationFeedback.type}`} style={{ marginTop: 8 }}>
                      {moderationFeedback.message}
                    </div>
                  )}
                </div>
              </div>
            )}

            </div>
          </div>

          {/* Blocklist Section (banned identifiers) */}
          <div className="section">
            <div className="section-header">
              <span className="section-icon section-header-clickable" onClick={() => toggleSection('blocklist')}><X size={20} /></span>
              <h2 className="section-title section-header-clickable" onClick={() => toggleSection('blocklist')}>Blocklist ({blocklist.length})</h2>
              <button
                className="refresh-btn"
                onClick={fetchBlocklist}
                disabled={isLoadingBlocklist}
                aria-label="Refresh blocklist"
              >
                <RefreshCw size={18} className={isLoadingBlocklist ? 'animate-spin' : ''} />
              </button>
              <span className={`section-chevron section-header-clickable ${collapsedSections['blocklist'] ? 'collapsed' : ''}`} onClick={() => toggleSection('blocklist')}>
                <ChevronDown size={20} />
              </span>
            </div>
            <div className={`section-content ${collapsedSections['blocklist'] ? 'collapsed' : ''}`}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                Banned Telegram IDs and WhatsApp phones. Blocked identifiers cannot register a new account.
              </div>
              {isLoadingBlocklist && blocklist.length === 0 ? (
                <div className="empty-state">
                  <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto' }} />
                </div>
              ) : blocklist.length === 0 ? (
                <div className="empty-state">No blocked identifiers</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {blocklist.map(entry => (
                    <div key={entry.id} style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          {entry.telegramId !== null && <div>TG: <code>{entry.telegramId}</code></div>}
                          {entry.whatsappPhone && <div>WA: <code>{entry.whatsappPhone}</code></div>}
                          {entry.bannedReason && <div style={{ color: '#6b7280', marginTop: 2 }}>{entry.bannedReason}</div>}
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                            {new Date(entry.createdAt).toLocaleString(intlLocale)}
                          </div>
                        </div>
                        <button
                          className="send-reminder-btn"
                          style={{ width: 'auto', background: '#10b981' }}
                          onClick={() => unbanEntry(entry)}
                          disabled={unbanningId === entry.id}
                        >
                          {unbanningId === entry.id ? <Loader2 size={14} className="animate-spin" /> : 'Unban'}
                        </button>
                      </div>
                    </div>
                  ))}
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
              {/* Infinite scroll sentinel — inside scrollable container */}
              <div ref={activitySentinelRef} className="activity-sentinel">
                {activityHasMore && isLoadingActivity && (
                  <Loader2 size={20} className="animate-spin" style={{ margin: '0 auto' }} />
                )}
              </div>
            </div>
            </div>
          </div>

          {/* User Feedback Section */}
          <div className="section">
            <div className="section-header">
              <span className="section-icon section-header-clickable" onClick={() => toggleSection('feedback')}><MessageSquare size={20} /></span>
              <h2 className="section-title section-header-clickable" onClick={() => toggleSection('feedback')}>{t('feedback.title')}</h2>
              <button
                className="refresh-btn"
                onClick={fetchFeedback}
                disabled={isLoadingFeedback}
                aria-label="Refresh feedback"
              >
                <RefreshCw size={18} className={isLoadingFeedback ? 'animate-spin' : ''} />
              </button>
              <span className={`section-chevron section-header-clickable ${collapsedSections['feedback'] ? 'collapsed' : ''}`} onClick={() => toggleSection('feedback')}>
                <ChevronDown size={20} />
              </span>
            </div>
            <div className={`section-content ${collapsedSections['feedback'] ? 'collapsed' : ''}`}>
              <div className="feedback-list">
                {isLoadingFeedback && feedbacks.length === 0 ? (
                  <div className="empty-state">
                    <Loader2 size={24} className="animate-spin" style={{ margin: '0 auto' }} />
                    <p>{t('feedback.loading')}</p>
                  </div>
                ) : feedbacks.length === 0 ? (
                  <div className="empty-state">{t('feedback.noFeedback')}</div>
                ) : (
                  feedbacks.map((feedback) => (
                    <div
                      key={feedback.id}
                      className={`feedback-item ${expandedFeedback === feedback.id ? 'expanded' : ''}`}
                      onClick={() => setExpandedFeedback(expandedFeedback === feedback.id ? null : feedback.id)}
                    >
                      <div className="feedback-row">
                        <span className="feedback-user">{feedback.userName}</span>
                        <span className="feedback-preview">
                          {expandedFeedback === feedback.id
                            ? feedback.text
                            : feedback.text.length > 50
                              ? feedback.text.slice(0, 50) + '...'
                              : feedback.text}
                        </span>
                        <span className={`feedback-source ${feedback.source}`}>
                          {t(`feedback.${feedback.source}`)}
                        </span>
                        <span className="feedback-time">
                          {formatRelativeTime(feedback.createdAt)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
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
