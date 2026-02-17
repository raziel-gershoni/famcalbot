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
  handleTestModelsCommand,
  handleTestAICommand,
  handleTestAICallback,
  handleFeedbackCommand,
  setupHandlers,
} from './commands';

// Summary generation and delivery
export {
  categorizeEvents,
  sendDailySummaryToUser,
  sendDailySummaryToAll,
  sendTomorrowSummaryToUser,
  sendTomorrowSummaryToAll,
} from './summary';

// Voice message generation
export { sendVoiceMessage, sendWeeklyVoiceMessage } from './voice';

// Subscription notifications
export { sendTrialExpiredNotification, sendReminderDowngradeNotification } from './notifications';
