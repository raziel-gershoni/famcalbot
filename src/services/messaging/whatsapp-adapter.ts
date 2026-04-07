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
  PhotoOptions,
  ParsedCommand,
} from './types';
import { captureError } from '../../lib/error-capture';

export class WhatsAppAdapter implements IMessagingService {
  private apiUrl: string;
  private accessToken: string;
  private phoneNumberId: string;

  constructor(accessToken: string, phoneNumberId: string) {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.apiUrl = `https://graph.facebook.com/v23.0/${phoneNumberId}`;
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    options?: MessageOptions
  ): Promise<string> {
    const formattedText = options?.format
      ? this.formatText(text, options.format)
      : text;

    const url = `${this.apiUrl}/messages`;

    // Build message body based on options
    let body: Record<string, unknown>;

    if (options?.whatsappButtons && options.whatsappButtons.length > 0) {
      // Interactive reply buttons (max 3)
      body = {
        messaging_product: 'whatsapp',
        to: chatId.toString(),
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: formattedText },
          action: {
            buttons: options.whatsappButtons.slice(0, 3).map(btn => ({
              type: 'reply',
              reply: { id: btn.id, title: btn.title.slice(0, 20) },
            })),
          },
        },
      };
    } else if (options?.whatsappList) {
      // List message (up to 10 items)
      body = {
        messaging_product: 'whatsapp',
        to: chatId.toString(),
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: formattedText },
          action: {
            button: options.whatsappList.buttonText.slice(0, 20),
            sections: options.whatsappList.sections.map(section => ({
              ...(section.title && { title: section.title }),
              rows: section.rows.map(row => ({
                id: row.id,
                title: row.title.slice(0, 24),
                ...(row.description && { description: row.description.slice(0, 72) }),
              })),
            })),
          },
        },
      };
    } else if (options?.whatsappUrlButton) {
      // CTA URL button
      body = {
        messaging_product: 'whatsapp',
        to: chatId.toString(),
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: formattedText },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: options.whatsappUrlButton.text,
              url: options.whatsappUrlButton.url,
            },
          },
        },
      };
    } else if (options?.whatsappTemplate) {
      // Template message with optional quick reply button for proactive sends
      const tpl = options.whatsappTemplate;
      body = {
        messaging_product: 'whatsapp',
        to: chatId.toString(),
        type: 'template',
        template: {
          name: tpl.name,
          language: { code: tpl.language },
          ...(tpl.buttonPayload && {
            components: [{
              type: 'button',
              sub_type: 'quick_reply',
              index: '0',
              parameters: [{ type: 'payload', payload: tpl.buttonPayload }],
            }],
          }),
        },
      };
    } else if (options?.telegramCta) {
      // Text message with translated TG CTA button (summaries only)
      body = {
        messaging_product: 'whatsapp',
        to: chatId.toString(),
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: formattedText },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: options.telegramCta,
              url: 'https://t.me/family_calendar_telegram_bot',
            },
          },
        },
      };
    } else {
      // Plain text message
      body = {
        messaging_product: 'whatsapp',
        to: chatId.toString(),
        type: 'text',
        text: { body: formattedText },
      };
    }

    try {
      const response = await this.makeRequest(url, body);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`WhatsApp API error: ${JSON.stringify(error)}`);
      }
      const data = await response.json() as { messages?: Array<{ id: string }> };
      return data.messages?.[0]?.id || '';
    } catch (error) {
      console.error(`[WhatsApp] Failed to send message to ${chatId}:`, error);
      captureError(error, 'whatsapp-adapter');
      throw error;
    }
  }

  async updateMessage(
    chatId: number | string,
    messageId: number | string,
    text: string,
    options?: MessageOptions
  ): Promise<void> {
    // WhatsApp doesn't support message editing
    // Fall back to sending a new message
    console.warn('[WhatsApp] Message editing not supported, sending new message');
    await this.sendMessage(chatId, text, options);
  }

  async deleteMessage(
    chatId: number | string,
    messageId: number | string
  ): Promise<void> {
    // WhatsApp message deletion is limited and requires specific conditions
    console.warn('[WhatsApp] Message deletion not implemented');
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
      captureError(error, 'whatsapp-adapter');
      throw error;
    }
  }

  async sendPhoto(
    chatId: number | string,
    photo: Buffer,
    options?: PhotoOptions
  ): Promise<string> {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    // Write Buffer to temp file for upload
    const tmpPath = path.join(os.tmpdir(), `wa-photo-${Date.now()}.png`);
    try {
      fs.writeFileSync(tmpPath, photo);

      // Upload image
      const mediaId = await this.uploadMedia(tmpPath, 'image/png');

      // Send image message
      const url = `${this.apiUrl}/messages`;
      const caption = options?.caption
        ? (options.format ? this.formatText(options.caption, options.format) : options.caption)
        : undefined;

      const body = {
        messaging_product: 'whatsapp',
        to: chatId.toString(),
        type: 'image',
        image: {
          id: mediaId,
          ...(caption && { caption }),
        },
      };

      const response = await this.makeRequest(url, body);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`WhatsApp API error: ${JSON.stringify(error)}`);
      }
      const data = await response.json() as { messages?: Array<{ id: string }> };
      return data.messages?.[0]?.id || '';
    } catch (error) {
      console.error(`[WhatsApp] Failed to send photo to ${chatId}:`, error);
      captureError(error, 'whatsapp-adapter');
      throw error;
    } finally {
      // Cleanup temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  parseCommand(text: string): ParsedCommand | null {
    // WhatsApp doesn't have native commands, parse manually
    // Look for keywords at start of message
    const lowerText = text.toLowerCase().trim();

    // Map of WhatsApp command patterns to commands
    const commandPatterns: Array<{ pattern: RegExp; command: string }> = [
      { pattern: /^summary\s*(tmrw)?/, command: 'summary' },
      { pattern: /^weather/, command: 'weather' },
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

  async sendTypingIndicator(_chatId: number | string, messageId?: string, _typingType?: 'text' | 'audio' | 'photo'): Promise<void> {
    if (!messageId) return; // WA requires the inbound message ID
    try {
      const url = `${this.apiUrl}/messages`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' }, // WA only supports 'text', no 'audio' variant
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.warn(`[WhatsApp] Typing indicator failed (${response.status}):`, JSON.stringify(err));
      }
    } catch {
      // Non-critical
    }
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
  /**
   * Download media from WhatsApp by media ID
   * 2-step: GET /media/{id} → get URL → download binary
   */
  async downloadMedia(mediaId: string): Promise<Buffer> {
    // Step 1: Get media URL
    const metaUrl = `https://graph.facebook.com/v18.0/${mediaId}`;
    const metaResponse = await fetch(metaUrl, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });

    if (!metaResponse.ok) {
      const error = await metaResponse.json();
      throw new Error(`WhatsApp media metadata error: ${JSON.stringify(error)}`);
    }

    const meta = await metaResponse.json() as { url: string };

    // Step 2: Download the actual file
    const fileResponse = await fetch(meta.url, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });

    if (!fileResponse.ok) {
      throw new Error(`WhatsApp media download failed: ${fileResponse.status}`);
    }

    const arrayBuffer = await fileResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async uploadMedia(filePath: string, mimeType: string = 'audio/ogg'): Promise<string> {
    const fs = await import('fs');
    const path = await import('path');

    const url = `${this.apiUrl}/media`;
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    // Use native Web FormData + Blob (Node 18+) instead of form-data npm package
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
    formData.append('type', mimeType);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`WhatsApp media upload error: ${JSON.stringify(error)}`);
      }

      const data = await response.json() as { id: string };
      return data.id;
    } catch (error) {
      console.error('[WhatsApp] Media upload failed:', error);
      captureError(error, 'whatsapp-adapter');
      throw error;
    }
  }
}
