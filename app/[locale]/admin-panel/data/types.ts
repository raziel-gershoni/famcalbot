// What the admin routes (app/api/admin/*) send and the panel reads. The shapes are the routes' own, lifted from the old
// panel; the routes are not changed by the redesign (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md).
//
// Ids: a `User.id` is the database id (a list row's `id`, a profile's `id`, every per-user request's `user_id`). A
// `telegramId` is Telegram's own number for the person. The page's ?user_id (the viewer's Telegram id) is never one
// of these and is used only for the way back to the calendar.

/** The five global switches (AdminSettings), by the field the settings route reads. */
export const ADMIN_FLAGS = ['remindersEnabled', 'nativeRemindersEnabled', 'earlyAdoptionMode', 'voiceAutoCreateHighConf', 'voiceTtsOutcome'] as const;
export type AdminFlag = (typeof ADMIN_FLAGS)[number];
export type AdminFlags = Record<AdminFlag, boolean>;

/** The counts GET /api/admin/stats answers. */
export interface AdminStats {
  totalUsers: number;
  usersWithOAuth: number;
  usersWithCalendars: number;
  needSetup: number;
}

export interface UserListItem {
  /** The database id: what every per-user request carries. */
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
    comped?: boolean;
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

export type FilterType = 'all' | 'trial' | 'paid' | 'free' | 'override';

export type SetupAttempts = Array<{ day: number; sent: boolean; due: boolean }>;

/** The kinds of setup reminder the send-reminder route takes (src/services/setup-tracks.ts' tracks). */
export const REMINDER_TYPES = ['calendars', 'reconnect', 'location'] as const;
export type ReminderType = (typeof REMINDER_TYPES)[number];

export interface UserOverrideDetails {
  /** The database id. */
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
    comped: boolean;
    compedAt: string | null;
    compReason: string | null;
  } | null;
  usage: {
    textSummariesUsed: number;
    voiceSummariesUsed: number;
    voiceEventsCreated: number;
  };
  limits: {
    // getPlanLimits() uses Infinity as the unlimited sentinel, and JSON.stringify
    // encodes Infinity as null - so an unlimited plan arrives here as null.
    textSummaries: number | null;
    voiceSummaries: number | null;
    calendars: number | null;
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
    applicableReminder: ReminderType | null;
    googleState: 'none' | 'choose' | 'reconnect' | 'connected';
  };
  setupReminders: {
    daysSinceCreated: number;
    daysSinceStart: number;
    wasReset: boolean;
    calendars: SetupAttempts;
    reconnect: SetupAttempts;
    location: SetupAttempts;
  };
}

/** The feature overrides a profile saves, as the person set them (true is on). */
export interface OverrideInput {
  unlimitedSummaries: boolean;
  remindersEnabled: boolean;
  voiceEventsEnabled: boolean;
  unlimitedCalendars: boolean;
  earlyAdopter: boolean;
  reason: string;
}

export interface ActivityItem {
  id: string;
  userId: number;
  userName: string;
  userTelegramId: number | null;
  action: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityStats {
  action: string;
  count: number;
}

export interface FeedbackItem {
  id: string;
  userId: number;
  userName: string;
  userTelegramId: number | null;
  text: string;
  source: 'telegram' | 'dashboard';
  createdAt: string;
}

export interface BlocklistEntry {
  id: number;
  telegramId: number | null;
  whatsappPhone: string | null;
  bannedBy: number;
  bannedReason: string | null;
  createdAt: string;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// The routes' answers, without the `success: true` the request helper has already checked.
export interface UserListAnswer {
  users: UserListItem[];
}
export interface UserDetailAnswer {
  user: UserOverrideDetails;
}
export interface ActivityAnswer {
  activities: ActivityItem[];
  pagination: Pagination;
  actionStats: ActivityStats[];
}
export interface FeedbackAnswer {
  feedbacks: FeedbackItem[];
  pagination: Pagination;
}
export interface BlocklistAnswer {
  blocklist: BlocklistEntry[];
}
export interface ResetAllAnswer {
  usersReset: number;
}
export type SettingsAnswer = Partial<AdminFlags>;
export interface StatsAnswer {
  stats: AdminStats;
}
