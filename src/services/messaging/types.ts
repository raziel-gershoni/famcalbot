/**
 * Messaging Service Abstraction Layer
 * Platform-agnostic interface for messaging platforms (Telegram, WhatsApp, etc.)
 */

/**
 * Supported messaging platforms
 */
export enum MessagingPlatform {
  TELEGRAM = 'telegram',
  WHATSAPP = 'whatsapp',
}

/**
 * Message format types
 */
export enum MessageFormat {
  HTML = 'html',
  MARKDOWN = 'markdown',
  PLAIN = 'plain',
}

/**
 * Parsed command from user message
 */
export interface ParsedCommand {
  command: string;  // e.g., 'summary', 'weather'
  args?: string;    // e.g., 'tmrw', 'dtl'
}

/**
 * User context for platform-agnostic user identification
 */
export interface UserContext {
  userId: number | string;  // Platform-specific user ID
  chatId: number | string;  // Platform-specific chat ID
  platform: MessagingPlatform;
  username?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Message options for sending messages
 */
export interface MessageOptions {
  format?: MessageFormat;
  disablePreview?: boolean;
  replyMarkup?: any;  // Platform-specific keyboard markup
}

/**
 * Voice message options
 */
export interface VoiceOptions {
  caption?: string;
  duration?: number;
}

/**
 * Callback query from inline buttons
 */
export interface CallbackQuery {
  id: string;
  userId: number | string;
  chatId?: number | string;
  data?: string;
  messageId?: number | string;
}

/**
 * Abstract messaging service interface
 * All messaging platforms must implement this interface
 */
export interface IMessagingService {
  /**
   * Send a text message
   */
  sendMessage(
    chatId: number | string,
    text: string,
    options?: MessageOptions
  ): Promise<void>;

  /**
   * Send a voice message
   */
  sendVoice(
    chatId: number | string,
    audioPath: string,
    options?: VoiceOptions
  ): Promise<void>;

  /**
   * Parse command from text message
   * Extracts command and arguments from platform-specific format
   */
  parseCommand(text: string): ParsedCommand | null;

  /**
   * Answer callback query (for inline buttons)
   */
  answerCallbackQuery(queryId: string, text?: string): Promise<void>;

  /**
   * Get platform name
   */
  getPlatform(): MessagingPlatform;

  /**
   * Convert text to platform-specific format
   * (e.g., HTML to Markdown for WhatsApp)
   */
  formatText(text: string, from: MessageFormat): string;
}
