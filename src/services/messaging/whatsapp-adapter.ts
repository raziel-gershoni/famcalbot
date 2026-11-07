/**
 * WhatsApp Messaging Adapter
 * Implements IMessagingService for the WhatsApp Business Cloud API (live): text with Markdown conversion, interactive
 * reply buttons and lists, template messages for proactive sends, voice, photos, the typing indicator, media download.
 * Built by getWhatsAppService() (factory.ts) from WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.
 */

import {
  IMessagingService,
  MessagingPlatform,
  MessageFormat,
  MessageOptions,
  VoiceOptions,
  PhotoOptions,
  ParsedCommand,
  StreamMessageHandle,
  StreamMessageOptions,
} from './types';
import { captureError } from '../../lib/error-capture';
import { fetchAndReadWithRetry, fetchWithRetry, HttpStatusError } from '../../utils/fetch-retry';
import { wholeJson } from '../../utils/whole-json';

/**
 * The Cloud API's refusals: every 4xx except 429. They are answers, not failures: Graph puts its error (a code and a
 * message) in a JSON body the send reads and throws as before, and they are never sent again. Among them 400 (100 invalid
 * parameter, 131026 undeliverable, 131047 outside the 24-hour window, 131051 unsupported type, 132000 template
 * parameters), 401 (190 the token expired or is wrong), 403 (10 and 200 permission), 404 (an unknown phone-number or media
 * id) and 413 (media too large). The one third-party loop (src/utils/fetch-retry.ts, CLAUDE.md) retries 429 (4, 80007,
 * 130429, 131048, 131056), every 5xx (131000, 131016, 133004) and no answer, and honours Retry-After up to 10 s.
 */
export const WHATSAPP_REFUSALS: readonly number[] = Array.from({ length: 100 }, (_, i) => 400 + i).filter((status) => status !== 429);

const LOG = '[WhatsApp]';

/** The loop's give-up, told once: what, why, and the status or the error's message (never the token, the body or the URL). */
const logGiveUp = (what: string) => (error: unknown, info: { retried: number; why: string }) =>
  console.warn(`${LOG} ${what} not delivered (${info.why}): ${error instanceof HttpStatusError ? `HTTP ${error.status}` : error instanceof Error ? error.message : String(error)}`);

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
              url: 'https://t.me/family_calendar_telegram_bot?start=connect',
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
    _chatId: number | string,
    _messageId: number | string
  ): Promise<void> {
    // WhatsApp message deletion is limited and requires specific conditions
    console.warn('[WhatsApp] Message deletion not implemented');
  }

  async sendVoice(
    chatId: number | string,
    audioPath: string,
    _options?: VoiceOptions
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
      const response = await this.post(url, JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' }, // WA only supports 'text', no 'audio' variant
      }), 'typing indicator');
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.warn(`[WhatsApp] Typing indicator failed (${response.status}):`, JSON.stringify(err));
      }
    } catch (error) {
      // Non-critical: the reply still goes; the loop logged the give-up
      console.warn(`${LOG} Typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async answerCallbackQuery(_queryId: string, _text?: string): Promise<void> {
    // WhatsApp doesn't have inline buttons with callbacks
    // Uses interactive messages (buttons, lists) instead
    console.log(`[WhatsApp] Callback queries not supported`);
  }

  async streamMessage(
    chatId: number | string,
    options?: StreamMessageOptions
  ): Promise<StreamMessageHandle> {
    // WhatsApp Business API has no equivalent to sendMessageDraft — buffer
    // text in the handle and emit a single sendMessage on finalize so the
    // IMessagingService contract holds without spamming intermediate messages.
    let finalized = false;
    let cancelled = false;

    return {
      pushStage: (_text: string) => {
        // intentional no-op — WA has no animated editing surface
      },
      pushDelta: (_accumulated: string) => {
        // intentional no-op
      },
      finalize: async (finalText: string, finalizeOptions?: MessageOptions) => {
        if (finalized) return '';
        finalized = true;
        return this.sendMessage(chatId, finalText, { ...options, ...finalizeOptions });
      },
      cancel: async (errorText: string, cancelOptions?: MessageOptions) => {
        if (finalized || cancelled) return;
        cancelled = true;
        try {
          await this.sendMessage(chatId, errorText, cancelOptions);
        } catch {
          // best-effort
        }
      },
    };
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
      .replace(/<[^>]+>/g, '')                 // Remove other HTML tags
      // Then the entities Telegram decodes (escapeHtml writes &amp; &lt; &gt;), so an
      // escaped name reads as typed. &amp; last: an escaped "&lt;" stays "&lt;".
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }

  /**
   * A POST to the Cloud API through the one third-party retry loop. A refusal (WHATSAPP_REFUSALS) comes back as the
   * response, for the caller to read Graph's error as before; a 429, 5xx or no answer that outlasts the retries throws.
   */
  private post(url: string, body: string | FormData, what: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    return fetchWithRetry(url, { method: 'POST', headers, body }, { okStatuses: WHATSAPP_REFUSALS, label: `${LOG} ${what}`, onGiveUp: logGiveUp(what) });
  }

  /** A message to the Cloud API (JSON). */
  private makeRequest(url: string, body: unknown): Promise<Response> {
    return this.post(url, JSON.stringify(body), 'send');
  }

  /**
   * Upload media file to WhatsApp and return media ID
   */
  /**
   * Download media from WhatsApp by media ID
   * 2-step: GET /media/{id} → get URL → download binary
   */
  async downloadMedia(mediaId: string): Promise<Buffer> {
    const headers = { Authorization: `Bearer ${this.accessToken}` };
    // Step 1: the media's URL. A GET read whole inside the attempt: an answer cut off on the way is retried like no answer.
    let meta: { url?: unknown };
    try {
      meta = await fetchAndReadWithRetry(`https://graph.facebook.com/v18.0/${mediaId}`, { headers }, async (response) => (await (await wholeJson(response)).json()) as { url?: unknown }, {
        label: `${LOG} media metadata`,
        onGiveUp: logGiveUp('media metadata'),
      });
    } catch (error) {
      if (error instanceof HttpStatusError) throw new Error(`WhatsApp media metadata error: HTTP ${error.status}`);
      throw error;
    }
    if (typeof meta.url !== 'string') throw new Error('WhatsApp media metadata error: no url in the answer');

    // Step 2: the file itself, read inside the attempt as well
    try {
      return await fetchAndReadWithRetry(meta.url, { headers }, async (response) => Buffer.from(await response.arrayBuffer()), {
        label: `${LOG} media download`,
        onGiveUp: logGiveUp('media download'),
      });
    } catch (error) {
      if (error instanceof HttpStatusError) throw new Error(`WhatsApp media download failed: ${error.status}`);
      throw error;
    }
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
      const response = await this.post(url, formData, 'media upload');

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
