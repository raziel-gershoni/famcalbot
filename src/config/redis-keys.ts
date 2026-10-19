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

  // Google consent waiting for its owner's tap (keyed by sha256 of the pendingId), and the
  // flag that tells the Mini App the owner committed it (google-connect.ts)
  oauthPending: (pendingIdHash: string) => `oauth:pending:${pendingIdHash}`,
  googleConnected: (userId: number) => `googleConnected:${userId}`,

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

  // Calendar home, Google reader (src/services/calendar-read/google.ts): the route's range
  // cache, the per-user stamp that invalidates it after a write, the once-a-day "chosen
  // calendars are gone" warning, the per-window fresh=1 limit, and the once-an-hour admin
  // alert for an OAuth client Google rejects. from and to are the window's bounds as the
  // cache keys them.
  gcalRange: (userId: number, setHash: string, tz: string, from: string, to: string) =>
    `gcal:range:v1:${userId}:${setHash}:${tz}:${from}:${to}`,
  gcalStamp: (userId: number) => `gcal:stamp:${userId}`,
  gcalGoneWarned: (userId: number) => `gcal:gone_warned:${userId}`,
  gcalFresh: (userId: number, from: string, to: string) => `gcal:fresh:${userId}:${from}:${to}`,
  gcalConfigAlert: () => 'gcal:config_alert',

  // Identifier blocklist cache (admin moderation; banned telegramId / whatsappPhone)
  blockedTelegramId: (telegramId: number | bigint | string) => `blocked:tg:${telegramId}`,
  blockedWhatsAppPhone: (phone: string) => `blocked:wa:${phone}`,

  // Voice frictionlessness — recent CRUD for follow-up context (PR 9)
  recentEvents: (userId: number) => `voice:recent:${userId}`,

  // Voice frictionlessness — undo window for HIGH-confidence skipped confirmations (PR 10)
  undoToken: (token: string) => `voice:undo:${token}`,

  // Voice frictionlessness — bulk pending batch for multi-event confirmations (PR 11)
  pendingBatch: (pendingId: string) => `voice:pending:batch:${pendingId}`,

  // Voice frictionlessness — admin toggles cached from AdminSettings
  VOICE_AUTO_CREATE_HIGH_CONF: 'admin:voice_auto_create_high_conf',
  VOICE_TTS_OUTCOME: 'admin:voice_tts_outcome',

  // Native reminders — the admin switch cached from AdminSettings. Its own prefix:
  // "reminder:" and "reminders:" belong to event alerts.
  NATIVE_REMINDERS_ENABLED: 'nrem:enabled',

  // Voice frictionlessness — quick-correction "awaiting field reply" state (PR 10 polish)
  quickCorrection: (chatId: number) => `voice:quick:${chatId}`,

  // Voice frictionlessness — audio retry: keep last failed audio + retry-mode flag (PR 10 polish)
  retryAudio: (chatId: number) => `voice:retry:audio:${chatId}`,
  retryMode: (chatId: number) => `voice:retry:mode:${chatId}`,
} as const;
