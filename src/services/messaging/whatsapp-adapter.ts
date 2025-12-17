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
    const formattedText = options?.format
      ? this.formatText(text, options.format)
      : text;

    const url = `${this.apiUrl}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: chatId.toString(),
      type: 'text',
      text: { body: formattedText },
    };

    try {
      const response = await this.makeRequest(url, body);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`WhatsApp API error: ${JSON.stringify(error)}`);
      }
    } catch (error) {
      console.error(`[WhatsApp] Failed to send message to ${chatId}:`, error);
      throw error;
    }
  }

  async sendVoice(
    chatId: number | string,
    audioPath: string,
    options?: VoiceOptions
  ): Promise<void> {
    try {
      // Step 1: Upload media to get media ID
      const mediaId = await this.uploadMedia(audioPath);

      // Step 2: Send voice message with media ID
      const url = `${this.apiUrl}/messages`;
      const body = {
        messaging_product: 'whatsapp',
        to: chatId.toString(),
        type: 'audio',
        audio: { id: mediaId },
      };

      const response = await this.makeRequest(url, body);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`WhatsApp API error: ${JSON.stringify(error)}`);
      }
    } catch (error) {
      console.error(`[WhatsApp] Failed to send voice to ${chatId}:`, error);
      throw error;
    }
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

  /**
   * Make a request to WhatsApp API with retry logic
   */
  private async makeRequest(url: string, body: any, retries = 3): Promise<Response> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify(body),
        });

        // Retry on rate limit (429) or server errors (5xx)
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`[WhatsApp] Rate limited or server error, retrying in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        return response;
      } catch (error) {
        if (attempt === retries) throw error;
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`[WhatsApp] Request failed, retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    throw new Error('Max retries exceeded');
  }

  /**
   * Upload media file to WhatsApp and return media ID
   */
  private async uploadMedia(filePath: string): Promise<string> {
    const fs = await import('fs');
    const path = await import('path');
    const FormData = (await import('form-data')).default;

    const url = `${this.apiUrl}/media`;
    const fileStream = fs.createReadStream(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', fileStream, fileName);
    formData.append('type', 'audio/ogg');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          ...formData.getHeaders(),
        },
        body: formData as any,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`WhatsApp media upload error: ${JSON.stringify(error)}`);
      }

      const data = await response.json() as { id: string };
      return data.id;
    } catch (error) {
      console.error('[WhatsApp] Media upload failed:', error);
      throw error;
    }
  }
}
