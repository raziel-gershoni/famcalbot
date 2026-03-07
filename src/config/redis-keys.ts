/**
 * Centralized Redis key generators
 * All Redis keys used across the application are defined here
 */

// Reminder tracking
export const REDIS_KEYS = {
  // Event reminders: tracks which reminders have been sent
  reminder: (userId: number, eventId: string, type: string, date: string) =>
    `reminder:${userId}:${eventId}:${type}:${date}`,
  REMINDER_PREFIX: 'reminder:',

  // Downgrade notification flag
  reminderDowngradeNotified: (userId: number) =>
    `reminder:downgrade_notified:${userId}`,

  // Subscription reminders (trial expiry, renewal)
  subscriptionReminder: (telegramId: number | string | bigint, dateStr: string, type: string) =>
    `subscription_reminder:${telegramId}:${dateStr}:${type}`,

  // Reminder cache
  REMINDER_USERS: 'reminders:users',
  REMINDERS_GLOBAL_ENABLED: 'reminders:global_enabled',
  EARLY_ADOPTION_GLOBAL: 'early_adoption:global_enabled',
  DEFAULT_AI_MODEL: 'admin:default_ai_model',
  GEMINI_THINKING_LEVEL: 'admin:gemini_thinking_level',

  // Summary dedup (prevents double-delivery within same day)
  summaryDedup: (userId: number, type: 'daily' | 'tomorrow', date: string) =>
    `summary:dedup:${type}:${userId}:${date}`,

  // Feature access cache
  featureAccess: (userId: number, featureType: string) =>
    `feature:access:${userId}:${featureType}`,
  FEATURE_ACCESS_PREFIX: 'feature:access:',

  // Locks
  testModelsLock: (userId: number) => `testmodels:lock:${userId}`,
  voiceLock: (fileUniqueId: string) => `voice:lock:${fileUniqueId}`,

  // Voice pending operations (serverless-safe, replaces in-memory Maps)
  pendingEvent: (pendingId: string) => `voice:pending:event:${pendingId}`,
  pendingEdit: (pendingId: string) => `voice:pending:edit:${pendingId}`,
  pendingDelete: (pendingId: string) => `voice:pending:delete:${pendingId}`,
  lastCreatedEvent: (userId: number) => `voice:last_created:${userId}`,

  // User timezone cache (resolved via geocoding or Google Calendar)
  userTimezone: (telegramId: number) => `tz:user:${telegramId}`,
} as const;
