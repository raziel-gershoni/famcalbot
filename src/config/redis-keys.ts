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
  voiceLock: (fileUniqueId: string) => `voice:lock:${fileUniqueId}`,

  // Voice pending operations (serverless-safe, replaces in-memory Maps)
  pendingEvent: (pendingId: string) => `voice:pending:event:${pendingId}`,
  pendingEdit: (pendingId: string) => `voice:pending:edit:${pendingId}`,
  pendingDelete: (pendingId: string) => `voice:pending:delete:${pendingId}`,
  lastCreatedEvent: (userId: number) => `voice:last_created:${userId}`,
  pendingReply: (chatId: number, messageId: number) => `pending:reply:${chatId}:${messageId}`,

  // User timezone cache (resolved via geocoding or Google Calendar)
  userTimezone: (userId: number) => `tz:user:${userId}`,

  // Magic link tokens (WhatsApp web app auth)
  magicLink: (token: string) => `magic:${token}`,

  // Account linking (Telegram ↔ WhatsApp)
  linkCode: (code: string) => `link:code:${code}`,
  linkUser: (telegramId: number) => `link:user:${telegramId}`,

  // WhatsApp onboarding state machine
  waOnboard: (phone: string) => `wa:onboard:${phone}`,

  // WhatsApp message dedup (prevents webhook retry from re-processing)
  waDedup: (messageId: string) => `wa:dedup:${messageId}`,

  // Setup reminder tracking (multi-attempt, prevents duplicate sends)
  setupReminder: (userId: number, type: string, attempt: number) =>
    `setup:reminder:${userId}:${type}:${attempt}`,

  // Story sharing (cached images and stashed text for share-to-story)
  storyImage: (userId: number | string) => `story:img:${userId}`,
  storyText: (userId: number | string, msgId: number | string) => `story:text:${userId}:${msgId}`,

  // Kid name detection (interactive follow-up after summary delivery)
  kidNameAsked: (userId: number, name: string) => `kidname:asked:${userId}:${name}`,
  kidNamePending: (pendingId: string) => `kidname:pending:${pendingId}`,

  // WA typing indicator (stashed inbound message ID for voice typing)
  waLastMsg: (chatId: string) => `wa:lastmsg:${chatId}`,

  // Holiday cache (CalBrew API responses, 24h TTL)
  holidays: (date: string, lang: string) => `holidays:${date}:${lang}`,

  // Identifier blocklist cache (admin moderation; banned telegramId / whatsappPhone)
  blockedTelegramId: (telegramId: number | bigint | string) => `blocked:tg:${telegramId}`,
  blockedWhatsAppPhone: (phone: string) => `blocked:wa:${phone}`,
} as const;
