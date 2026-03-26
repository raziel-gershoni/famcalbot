/**
 * Telegram service barrel re-export
 * Maintains backward compatibility for all existing import paths
 */

// Bot singleton and core utilities
export { initBot, getBot, getMessagingService, setUserMenuButton } from './bot';

// Command handlers
export {
  isUserAuthorized,
  handleStartCommand,
  handleSummaryCommand,
  handleWeatherCommand,
  handleLookaheadCommand,
  handleNextWeekCommand,
  handleFeedbackCommand,
  handleConnectCommand,
  setupHandlers,
} from './commands';

// Summary generation and delivery
export {
  categorizeEvents,
  sendDailySummaryToUser,
  sendDailySummaryToAll,
  sendTomorrowSummaryToUser,
  sendTomorrowSummaryToAll,
  type SummaryBatchResult,
} from './summary';

// Unified command pipeline
export { executeCommand, isAIOverloadError } from './command-pipeline';

// Voice message generation
export { sendVoiceMessage, sendWeeklyVoiceMessage } from './voice';

// Subscription notifications
export { sendTrialExpiredNotification, sendReminderDowngradeNotification } from './notifications';
