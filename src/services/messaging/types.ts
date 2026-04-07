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
/**
 * WhatsApp reply button (up to 3 per message)
 */
export interface WhatsAppReplyButton {
  id: string;     // Returned as interactive.button_reply.id when tapped
  title: string;  // Button label (max 20 chars)
}

/**
 * WhatsApp CTA URL button
 */
export interface WhatsAppUrlButton {
  text: string;   // Button label
  url: string;    // URL to open
}

/**
 * WhatsApp list message row
 */
export interface WhatsAppListRow {
  id: string;           // Returned as interactive.list_reply.id when selected
  title: string;        // Row title (max 24 chars)
  description?: string; // Optional description (max 72 chars)
}

/**
 * WhatsApp list message (up to 10 items)
 */
export interface WhatsAppListMessage {
  buttonText: string;   // Text on the button that opens the list (max 20 chars)
  sections: Array<{
    title?: string;     // Section header
    rows: WhatsAppListRow[];
  }>;
}

/**
 * Message options for sending messages
 */
export interface WhatsAppTemplate {
  name: string;        // Template name registered in Meta Business Manager
  language: string;    // Language code (e.g. 'en', 'he', 'ru')
  buttonPayload?: string;  // Quick reply button payload (e.g. "summary", "summary tmrw")
}

export interface MessageOptions {
  format?: MessageFormat;
  disablePreview?: boolean;
  replyMarkup?: any;  // Telegram-specific keyboard markup
  whatsappButtons?: WhatsAppReplyButton[];  // WhatsApp reply buttons (max 3)
  whatsappUrlButton?: WhatsAppUrlButton;    // WhatsApp CTA URL button
  whatsappList?: WhatsAppListMessage;       // WhatsApp list message (up to 10 items)
  whatsappTemplate?: WhatsAppTemplate;      // WhatsApp template message (for proactive sends outside 24h window)
  telegramCta?: string;                     // If set, adds a Telegram CTA URL button with this display text (WA only)
  forceReply?: boolean;                     // Force user to reply to this message (TG only)
  inputPlaceholder?: string;                // Placeholder text in input field when forceReply is true
}

/**
 * Voice message options
 */
export interface VoiceOptions {
  caption?: string;
  duration?: number;
}

/**
 * Photo message options
 */
export interface PhotoOptions {
  caption?: string;
  format?: MessageFormat;
  replyMarkup?: any;  // Telegram-specific keyboard markup
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
   * @returns Message ID for later editing/deletion
   */
  sendMessage(
    chatId: number | string,
    text: string,
    options?: MessageOptions
  ): Promise<number | string>;

  /**
   * Update an existing message
   */
  updateMessage(
    chatId: number | string,
    messageId: number | string,
    text: string,
    options?: MessageOptions
  ): Promise<void>;

  /**
   * Delete a message
   */
  deleteMessage(
    chatId: number | string,
    messageId: number | string
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
   * Send a photo message
   * @returns Message ID
   */
  sendPhoto(
    chatId: number | string,
    photo: Buffer,
    options?: PhotoOptions
  ): Promise<number | string>;

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
   * Send typing indicator (TG: "typing..." bubble, WA: requires inbound messageId)
   * @param typingType - 'text' for typing, 'audio' for recording audio, 'photo' for uploading photo
   */
  sendTypingIndicator(chatId: number | string, messageId?: string, typingType?: 'text' | 'audio' | 'photo'): Promise<void>;

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
