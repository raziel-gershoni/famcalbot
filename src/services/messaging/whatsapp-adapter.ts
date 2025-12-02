/**
 * WhatsApp Messaging Adapter (Skeleton)
 * Implements IMessagingService for WhatsApp Business Cloud API
 *
 * TODO: Implement when WhatsApp integration is needed
 * Requires: WhatsApp Business account, phone number verification, API tokens
 */

import {
  IMessagingService,
  MessagingPlatform,
  MessageFormat,
  MessageOptions,
  VoiceOptions,
  ParsedCommand,
} from './types';

export class WhatsAppAdapter implements IMessagingService {
  private apiUrl: string;
  private accessToken: string;
  private phoneNumberId: string;

  constructor(accessToken: string, phoneNumberId: string) {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.apiUrl = `https://graph.facebook.com/v18.0/${phoneNumberId}`;
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    options?: MessageOptions
  ): Promise<void> {
    // TODO: Implement WhatsApp message sending
    // WhatsApp uses phone numbers as chat IDs
    // Format: text with Markdown (*bold*, _italic_)

    const formattedText = options?.format
      ? this.formatText(text, options.format)
      : text;

    console.log(`[WhatsApp] Would send to ${chatId}: ${formattedText}`);

    // Implementation would use WhatsApp Cloud API:
    // POST https://graph.facebook.com/v18.0/{phone-number-id}/messages
    // Body: { messaging_product: "whatsapp", to: chatId, type: "text", text: { body: formattedText } }

    throw new Error('WhatsApp adapter not yet implemented');
  }

  async sendVoice(
    chatId: number | string,
    audioPath: string,
    options?: VoiceOptions
  ): Promise<void> {
    // TODO: Implement WhatsApp voice message sending
    // WhatsApp requires uploading media first, then sending media ID

    console.log(`[WhatsApp] Would send voice to ${chatId}: ${audioPath}`);

    throw new Error('WhatsApp adapter not yet implemented');
  }

  parseCommand(text: string): ParsedCommand | null {
    // WhatsApp doesn't have native commands, parse manually
    // Look for keywords at start of message
    const lowerText = text.toLowerCase().trim();

    // Map of WhatsApp command patterns to commands
    const commandPatterns: Array<{ pattern: RegExp; command: string }> = [
      { pattern: /^summary\s*(tmrw)?/, command: 'summary' },
      { pattern: /^weather\s*(std|dtl)?/, command: 'weather' },
      { pattern: /^help/, command: 'help' },
      { pattern: /^start/, command: 'start' },
    ];

    for (const { pattern, command } of commandPatterns) {
      const match = lowerText.match(pattern);
      if (match) {
        return {
          command,
          args: match[1] || undefined,
        };
      }
    }

    return null;
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    // WhatsApp doesn't have inline buttons with callbacks
    // Uses interactive messages (buttons, lists) instead
    console.log(`[WhatsApp] Callback queries not supported`);
  }

  getPlatform(): MessagingPlatform {
    return MessagingPlatform.WHATSAPP;
  }

  formatText(text: string, from: MessageFormat): string {
    // WhatsApp uses Markdown-style formatting
    if (from === MessageFormat.MARKDOWN) {
      return text;
    }

    // Convert HTML to Markdown for WhatsApp
    if (from === MessageFormat.HTML) {
      return this.htmlToMarkdown(text);
    }

    return text;
  }

  /**
   * Convert HTML to Markdown for WhatsApp
   */
  private htmlToMarkdown(html: string): string {
    return html
      .replace(/<b>(.+?)<\/b>/g, '*$1*')      // <b>bold</b> → *bold*
      .replace(/<i>(.+?)<\/i>/g, '_$1_')      // <i>italic</i> → _italic_
      .replace(/<code>(.+?)<\/code>/g, '`$1`') // <code>code</code> → `code`
      .replace(/<u>(.+?)<\/u>/g, '$1')        // <u>underline</u> → underline (no support)
      .replace(/<[^>]+>/g, '');                // Remove other HTML tags
  }
}
