/**
 * Analytics Service
 * Tracks user activity for usage analytics and business insights
 */

import { prisma, withDbRetry } from '../utils/prisma';
import * as Sentry from '@sentry/nextjs';

// Action types for tracking
export type ActivityAction =
  // Bot lifecycle
  | 'bot_start'
  // Message lifecycle (NEW)
  | 'message_received'
  | 'command_started'
  | 'command_completed'
  | 'callback_received'
  // Summary actions
  | 'text_summary_requested'
  | 'text_summary_generated'
  | 'voice_summary_requested'
  | 'voice_summary_generated'
  // Voice event actions
  | 'voice_event_started'
  | 'voice_event_created'
  | 'voice_event_failed'
  // Reminder actions
  | 'reminder_sent'
  // Settings & config
  | 'settings_changed'
  | 'calendar_connected'
  // App interactions (NEW)
  | 'webapp_opened'
  | 'settings_viewed'
  | 'subscription_page_viewed'
  // Calendar operations (NEW)
  | 'calendar_sync_started'
  | 'calendar_sync_completed'
  // Subscription actions
  | 'subscription_started'
  | 'subscription_upgraded'
  | 'subscription_downgraded'
  | 'subscription_canceled'
  | 'subscription_renewed'
  | 'subscription_expired'
  | 'subscription_reminder_sent'
  // Feature gating
  | 'feature_blocked'
  // Error tracking (NEW)
  | 'user_error_shown'
  // Feedback
  | 'feedback_submitted'
  // Other
  | 'weather_requested'
  | 'lookahead_requested';

export interface ActivityMetadata {
  // Common
  language?: string;
  platform?: string;

  // Summary specific
  summary_type?: 'today' | 'tomorrow' | 'lookahead' | 'nextweek';
  calendar_count?: number;
  word_count?: number;
  event_count?: number;

  // Voice specific
  duration_seconds?: number;
  error_type?: string;

  // Reminder specific
  minutes_before?: number;
  reminder_type?: 'start' | 'pickup';

  // Settings specific
  changed_fields?: string[];

  // Subscription specific
  plan?: string;
  is_trial?: boolean;
  from_plan?: string;
  to_plan?: string;
  days_active?: number;

  // Feature gating
  feature?: string;
  current_usage?: number;
  limit?: number;

  // Feedback
  source?: 'telegram' | 'dashboard';
  text_length?: number;

  // Generic
  [key: string]: unknown;
}

// ============================================
// SENTRY HELPERS (FREE - no quota)
// ============================================

/**
 * Set user context for all Sentry events in this request
 * This associates all errors and breadcrumbs with a specific user
 */
export function setUserContext(userId: number, name?: string): void {
  Sentry.setUser({
    id: String(userId),
    username: name,
  });
}

/**
 * Add a Sentry breadcrumb (FREE - no quota impact)
 * Breadcrumbs are only visible when viewing an error in Sentry
 * Use this liberally to track user actions for debugging
 */
export function addBreadcrumb(
  action: string,
  data?: Record<string, unknown>,
  category: string = 'user_action'
): void {
  Sentry.addBreadcrumb({
    category,
    message: action,
    data,
    level: 'info',
  });
}

/**
 * Track a user activity
 * Logs to both database (for detailed queries) and Sentry (for real-time monitoring)
 */
export async function trackActivity(
  userId: number,
  action: ActivityAction,
  metadata?: ActivityMetadata
): Promise<void> {
  try {
    // 1. Log to database for detailed queries
    await withDbRetry(
      () => prisma.userActivity.create({
        data: {
          userId,
          action,
          metadata: metadata as import('@prisma/client').Prisma.InputJsonValue | undefined,
        },
      }),
      'trackActivity'
    );

    // 2. Also add to Sentry breadcrumbs for real-time monitoring
    Sentry.addBreadcrumb({
      category: 'user_activity',
      message: action,
      data: { userId, ...metadata },
      level: 'info',
    });

    // 3. For important actions, also send as Sentry event for easier querying
    const importantActions: ActivityAction[] = [
      'subscription_started',
      'subscription_upgraded',
      'subscription_canceled',
      'subscription_expired',
      'feature_blocked',
    ];

    if (importantActions.includes(action)) {
      Sentry.captureMessage(`User Activity: ${action}`, {
        level: 'info',
        tags: { action, userId: String(userId) },
        extra: { userId, ...metadata },
      });
    }
  } catch (error) {
    // Don't throw - analytics should never break the main flow
    console.error('[Analytics] Failed to track activity:', error);
    Sentry.captureException(error, {
      tags: { service: 'analytics' },
      extra: { userId, action, metadata },
    });
  }
}

/**
 * Track activity without awaiting (fire and forget)
 * Use this when you don't want to block the main flow
 */
export function trackActivityAsync(
  userId: number,
  action: ActivityAction,
  metadata?: ActivityMetadata
): void {
  trackActivity(userId, action, metadata).catch(() => {
    // Silently fail - tracked in main function
  });
}

// ============================================
// QUERY HELPERS (for admin panel)
// ============================================

/**
 * Get activity statistics grouped by action
 */
export async function getActivityStats(days: number = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return withDbRetry(
    () => prisma.userActivity.groupBy({
      by: ['action'],
      where: { createdAt: { gte: since } },
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } },
    }),
    'getActivityStats'
  );
}

/**
 * Get daily activity counts for a specific action
 */
export async function getDailyActivityCounts(
  action: ActivityAction,
  days: number = 30
) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const activities = await withDbRetry(
    () => prisma.userActivity.findMany({
      where: {
        action,
        createdAt: { gte: since },
      },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    'getDailyActivityCounts'
  );

  // Group by date
  const countsByDate: Record<string, number> = {};
  for (const activity of activities) {
    const date = activity.createdAt.toISOString().split('T')[0];
    countsByDate[date] = (countsByDate[date] || 0) + 1;
  }

  return countsByDate;
}

/**
 * Get user's activity journey
 */
export async function getUserJourney(userId: number, limit: number = 100) {
  return withDbRetry(
    () => prisma.userActivity.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    }),
    'getUserJourney'
  );
}

/**
 * Get recent activities for a user
 */
export async function getRecentUserActivities(userId: number, limit: number = 20) {
  return withDbRetry(
    () => prisma.userActivity.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    'getRecentUserActivities'
  );
}

/**
 * Get unique active users in a time period
 */
export async function getActiveUserCount(days: number = 30): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await withDbRetry(
    () => prisma.userActivity.findMany({
      where: { createdAt: { gte: since } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    'getActiveUserCount'
  );

  return result.length;
}

/**
 * Get conversion funnel data (trial -> paid)
 */
export async function getConversionFunnel(days: number = 90) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [starts, upgrades, cancellations] = await Promise.all([
    withDbRetry(
      () => prisma.userActivity.count({
        where: {
          action: 'subscription_started',
          createdAt: { gte: since },
        },
      }),
      'conversionFunnel.starts'
    ),
    withDbRetry(
      () => prisma.userActivity.count({
        where: {
          action: 'subscription_upgraded',
          createdAt: { gte: since },
        },
      }),
      'conversionFunnel.upgrades'
    ),
    withDbRetry(
      () => prisma.userActivity.count({
        where: {
          action: 'subscription_canceled',
          createdAt: { gte: since },
        },
      }),
      'conversionFunnel.cancellations'
    ),
  ]);

  return {
    trialStarts: starts,
    conversions: upgrades,
    cancellations,
    conversionRate: starts > 0 ? (upgrades / starts) * 100 : 0,
    churnRate: (starts + upgrades) > 0 ? (cancellations / (starts + upgrades)) * 100 : 0,
  };
}

/**
 * Get feature usage breakdown
 */
export async function getFeatureUsageBreakdown(days: number = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const featureActions: ActivityAction[] = [
    'text_summary_generated',
    'voice_summary_generated',
    'voice_event_created',
    'reminder_sent',
    'weather_requested',
    'lookahead_requested',
  ];

  const results = await withDbRetry(
    () => prisma.userActivity.groupBy({
      by: ['action'],
      where: {
        action: { in: featureActions },
        createdAt: { gte: since },
      },
      _count: { action: true },
    }),
    'getFeatureUsageBreakdown'
  );

  return results.reduce((acc, r) => {
    acc[r.action] = r._count.action;
    return acc;
  }, {} as Record<string, number>);
}
