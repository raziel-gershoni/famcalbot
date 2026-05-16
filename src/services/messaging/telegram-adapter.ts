/**
 * Telegram Messaging Adapter
 * Implements IMessagingService for Telegram platform
 */

import TelegramBot from 'node-telegram-bot-api';
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

// Telegram-side flush cadence for sendMessageDraft updates. Drafts are
// animated, so 250ms feels live without overwhelming the API.
const DRAFT_FLUSH_INTERVAL_MS = 250;
// Telegram drafts auto-dismiss at 30s. Finalize early to avoid losing text.
const DRAFT_SAFETY_GUARD_MS = 25_000;
// Telegram message size cap (sendMessage and sendMessageDraft both 4096).
const DRAFT_MAX_TEXT_CHARS = 4090;

export class TelegramAdapter implements IMessagingService {
  private bot: TelegramBot;

  constructor(bot: TelegramBot) {
    this.bot = bot;
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    options?: MessageOptions
  ): Promise<number> {
    const telegramOptions: any = {};

    // Set parse mode based on format
    if (options?.format === MessageFormat.HTML) {
      telegramOptions.parse_mode = 'HTML';
    } else if (options?.format === MessageFormat.MARKDOWN) {
      telegramOptions.parse_mode = 'Markdown';
    }

    // Disable link preview
    if (options?.disablePreview) {
      telegramOptions.disable_web_page_preview = true;
    }

    // Reply markup (keyboards or force reply)
    if (options?.forceReply) {
      telegramOptions.reply_markup = {
        force_reply: true,
        ...(options.inputPlaceholder && { input_field_placeholder: options.inputPlaceholder }),
      };
    } else if (options?.replyMarkup) {
      telegramOptions.reply_markup = options.replyMarkup;
    }

    const message = await this.bot.sendMessage(chatId, text, telegramOptions);
    return message.message_id;
  }

  async updateMessage(
    chatId: number | string,
    messageId: number | string,
    text: string,
    options?: MessageOptions
  ): Promise<void> {
    const telegramOptions: any = {
      chat_id: chatId,
      message_id: messageId,
    };

    // Set parse mode based on format
    if (options?.format === MessageFormat.HTML) {
      telegramOptions.parse_mode = 'HTML';
    } else if (options?.format === MessageFormat.MARKDOWN) {
      telegramOptions.parse_mode = 'Markdown';
    }

    // Disable link preview
    if (options?.disablePreview) {
      telegramOptions.disable_web_page_preview = true;
    }

    // Reply markup (inline keyboard)
    if (options?.replyMarkup) {
      telegramOptions.reply_markup = JSON.stringify(options.replyMarkup);
    }

    try {
      await this.bot.editMessageText(text, telegramOptions);
    } catch (error: any) {
      // Ignore "message is not modified" errors
      if (!error.message?.includes('message is not modified')) {
        throw error;
      }
    }
  }

  async deleteMessage(
    chatId: number | string,
    messageId: number | string
  ): Promise<void> {
    try {
      await this.bot.deleteMessage(chatId, messageId as number);
    } catch (error) {
      // Ignore deletion errors (message may already be deleted)
      console.warn('Failed to delete message:', error);
    }
  }

  async sendVoice(
    chatId: number | string,
    audioPath: string,
    options?: VoiceOptions
  ): Promise<void> {
    const telegramOptions: any = {};

    if (options?.caption) {
      telegramOptions.caption = options.caption;
    }

    if (options?.duration) {
      telegramOptions.duration = options.duration;
    }

    await this.bot.sendVoice(chatId, audioPath, telegramOptions);
  }

  async sendPhoto(
    chatId: number | string,
    photo: Buffer,
    options?: PhotoOptions
  ): Promise<number> {
    const telegramOptions: any = {};

    if (options?.caption) {
      telegramOptions.caption = options.caption;
    }

    if (options?.format === MessageFormat.HTML) {
      telegramOptions.parse_mode = 'HTML';
    } else if (options?.format === MessageFormat.MARKDOWN) {
      telegramOptions.parse_mode = 'Markdown';
    }

    if (options?.replyMarkup) {
      telegramOptions.reply_markup = options.replyMarkup;
    }

    const message = await this.bot.sendPhoto(chatId, photo, telegramOptions, {
      filename: 'weather.png',
      contentType: 'image/png',
    });
    return message.message_id;
  }

  parseCommand(text: string): ParsedCommand | null {
    // Telegram commands start with /
    if (!text.startsWith('/')) {
      return null;
    }

    // Remove the leading /
    const withoutSlash = text.slice(1);

    // Split on first space to separate command from args
    const spaceIndex = withoutSlash.indexOf(' ');

    if (spaceIndex === -1) {
      // No arguments
      return {
        command: withoutSlash.toLowerCase(),
      };
    }

    // Has arguments
    return {
      command: withoutSlash.slice(0, spaceIndex).toLowerCase(),
      args: withoutSlash.slice(spaceIndex + 1).trim(),
    };
  }

  async sendTypingIndicator(chatId: number | string, _messageId?: string, typingType?: 'text' | 'audio' | 'photo'): Promise<void> {
    try {
      const action = typingType === 'audio' ? 'record_voice' : typingType === 'photo' ? 'upload_photo' : 'typing';
      await this.bot.sendChatAction(chatId, action);
    } catch {
      // Non-critical — ignore errors
    }
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    await this.bot.answerCallbackQuery(queryId, text ? { text } : undefined);
  }

  async streamMessage(
    chatId: number | string,
    options?: StreamMessageOptions
  ): Promise<StreamMessageHandle> {
    // draft_id must be a non-zero int32 unique per stream; updates with the
    // same id are animated in place. Use the low-31 bits of the timestamp.
    const draftId = (Date.now() & 0x7fffffff) || 1;

    let latestText = options?.initialPlaceholder ?? '';
    let lastSentText: string | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;
    let finalized = false;
    let cancelled = false;
    // When the 25s safety guard fires, we send a real message to persist the
    // in-flight text before the ephemeral draft expires. finalize then edits
    // that message in place instead of opening a fresh one — so callers that
    // depend on a stable messageId (e.g. for share-button updates) keep
    // working in the overrun case.
    let safetySentMessageId: number | string | null = null;

    // Send the initial placeholder (or empty draft for native "Thinking…").
    // sendMessageDraft is new in Bot API 9.5 and not yet typed in
    // node-telegram-bot-api v0.66, so we use the lib's _request escape hatch
    // (same pattern as setChatMenuButton in src/services/telegram/bot.ts).
    const callSendMessageDraft = async (text: string): Promise<void> => {
      const form: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
        text: text.slice(0, DRAFT_MAX_TEXT_CHARS),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.bot as any)._request('sendMessageDraft', { form });
    };

    try {
      await callSendMessageDraft(latestText);
      lastSentText = latestText;
    } catch (error) {
      captureError(error, 'stream-message-draft-init', { chat_id: chatId }, 'warning');
      // Initial draft failed — fall through; finalize will still send a real
      // message. The flush loop is best-effort either way.
    }

    const flush = async (): Promise<void> => {
      if (finalized || cancelled) return;
      if (latestText === lastSentText) return;
      const toSend = latestText;
      try {
        await callSendMessageDraft(toSend);
        lastSentText = toSend;
      } catch (error) {
        // Single non-blocking warning; the stream will still finalize as a
        // normal sendMessage. Don't tear down the stream over a draft hiccup.
        captureError(error, 'stream-message-draft-flush', { chat_id: chatId }, 'warning');
      }
    };

    flushTimer = setInterval(() => {
      void flush();
    }, DRAFT_FLUSH_INTERVAL_MS);

    const teardownTimers = (): void => {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    };

    // Promise that, when present, signals the safety guard is mid-flight
    // sending a persisted message. finalize awaits this so it doesn't race
    // with the safety send and double-send the prose to the user.
    let safetyInFlight: Promise<void> | null = null;

    safetyTimer = setTimeout(() => {
      if (finalized || cancelled) return;
      // Mark finalized BEFORE the async send to close the race window with
      // finalize() / cancel(). finalize will see finalized=true, await the
      // promise, then update the safety message in place.
      finalized = true;
      teardownTimers();
      safetyInFlight = (async () => {
        try {
          safetySentMessageId = await this.sendMessage(chatId, latestText || ' ', {
            format: MessageFormat.PLAIN,
          });
        } catch (error) {
          captureError(error, 'stream-message-safety-finalize', { chat_id: chatId }, 'warning');
        }
      })();
    }, DRAFT_SAFETY_GUARD_MS);

    return {
      pushDelta: (accumulated: string) => {
        latestText = accumulated;
      },
      finalize: async (finalText: string, finalizeOptions?: MessageOptions) => {
        // Safety guard already fired — wait for its send to land, then edit
        // that message in place so the caller's returned messageId stays
        // stable. If the safety send failed (safetySentMessageId stays null)
        // we fall through to a fresh sendMessage so the user still gets the
        // final text.
        if (finalized && safetyInFlight) {
          await safetyInFlight;
          if (safetySentMessageId !== null) {
            try {
              await this.updateMessage(chatId, safetySentMessageId, finalText, {
                ...options,
                ...finalizeOptions,
              });
            } catch (error) {
              captureError(error, 'stream-message-finalize-update', { chat_id: chatId }, 'warning');
            }
            return safetySentMessageId;
          }
          const recoveryId = await this.sendMessage(chatId, finalText, {
            ...options,
            ...finalizeOptions,
          });
          return recoveryId;
        }
        if (finalized) return 0;
        finalized = true;
        teardownTimers();
        const messageId = await this.sendMessage(chatId, finalText, {
          ...options,
          ...finalizeOptions,
        });
        return messageId;
      },
      cancel: async (errorText: string, cancelOptions?: MessageOptions) => {
        if (finalized || cancelled) return;
        cancelled = true;
        teardownTimers();
        try {
          await this.sendMessage(chatId, errorText, cancelOptions);
        } catch (error) {
          captureError(error, 'stream-message-cancel', { chat_id: chatId }, 'warning');
        }
      },
    };
  }

  getPlatform(): MessagingPlatform {
    return MessagingPlatform.TELEGRAM;
  }

  formatText(text: string, from: MessageFormat): string {
    // Telegram natively supports HTML, so if input is HTML, return as-is
    if (from === MessageFormat.HTML) {
      return text;
    }

    // If input is Markdown, convert to HTML for Telegram
    if (from === MessageFormat.MARKDOWN) {
      return this.markdownToHtml(text);
    }

    // Plain text
    return text;
  }

  /**
   * Convert basic Markdown to HTML for Telegram
   */
  private markdownToHtml(markdown: string): string {
    return markdown
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')  // **bold** → <b>bold</b>
      .replace(/\*(.+?)\*/g, '<b>$1</b>')      // *bold* → <b>bold</b>
      .replace(/_(.+?)_/g, '<i>$1</i>')        // _italic_ → <i>italic</i>
      .replace(/`(.+?)`/g, '<code>$1</code>'); // `code` → <code>code</code>
  }
}
