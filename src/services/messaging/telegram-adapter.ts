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
// Telegram message size cap is 4096; the sanitizer can append up to ~50 chars
// of closing tags when many remain unclosed, so cap truncation lower.
const DRAFT_MAX_TEXT_CHARS = 4040;

// Tags Telegram parses in HTML mode. Anything else gets stripped during
// sanitization so it doesn't break the parse_mode pass.
const TG_HTML_TAGS = new Set([
  'b', 'strong',
  'i', 'em',
  'u', 'ins',
  's', 'strike', 'del',
  'tg-spoiler',
  'code',
  'pre',
  'blockquote',
  'a',
]);

/**
 * Make a streamed-mid-flight HTML buffer safe to send with parse_mode='HTML'.
 *
 * The LLM emits tokens like `<b>Hello wor` and Telegram rejects unclosed
 * tags with a 400. We:
 *   1. Strip any trailing partial tag (text ending in `<` or `<b` etc.)
 *   2. Strip any trailing partial HTML entity (`&am` waiting for `p;`)
 *   3. Append closing tags in reverse order for any opener still on the stack
 *
 * Stray `<` mid-text (e.g. the LLM writes `3 < 5` instead of `3 &lt; 5`) is
 * NOT fixed here — that would error in the buffered path too. Treating it as
 * out of scope for this helper.
 */
export function sanitizeStreamingHtml(text: string): string {
  // 1. Strip trailing partial tag.
  let cleaned = text.replace(/<[^>]*$/, '');
  // 2. Strip trailing partial entity reference.
  cleaned = cleaned.replace(/&[a-zA-Z#0-9]*$/, '');

  // 3. Walk the tag sequence and track unclosed openers.
  const openStack: string[] = [];
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(cleaned)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    if (!TG_HTML_TAGS.has(tagName)) continue;
    if (isClosing) {
      const lastIdx = openStack.lastIndexOf(tagName);
      if (lastIdx !== -1) openStack.splice(lastIdx, 1);
    } else {
      openStack.push(tagName);
    }
  }

  let suffix = '';
  for (let i = openStack.length - 1; i >= 0; i--) {
    suffix += `</${openStack[i]}>`;
  }
  return cleaned + suffix;
}

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
    // Phase 1: send a regular sendMessage as the stage placeholder. We edit
    // it in place via editMessageText for each stage transition — drafts are
    // designed for actively-streaming content, not static service text.
    // Phase 2: the first pushDelta transitions us into draft mode for live
    // animated LLM streaming. We delete the placeholder and open a draft.
    let placeholderMessageId: number | string | null = null;
    let lastStageText: string | null = null;
    try {
      const initialText = options?.initialPlaceholder ?? ' ';
      placeholderMessageId = await this.sendMessage(chatId, initialText, {
        format: MessageFormat.HTML,
      });
      lastStageText = initialText;
    } catch (error) {
      captureError(error, 'stream-message-placeholder-init', { chat_id: chatId }, 'warning');
    }

    // Streaming-phase state (only initialized when pushDelta first fires).
    const draftId = (Date.now() & 0x7fffffff) || 1;
    let latestText = '';
    let lastSentText: string | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;
    let streamingStarted = false;
    let finalized = false;
    let cancelled = false;
    // When the 25s safety guard fires, we send a real message to persist the
    // in-flight text before the ephemeral draft expires. finalize then edits
    // that message in place — so callers that depend on a stable messageId
    // (e.g. for share-button updates) keep working in the overrun case.
    let safetySentMessageId: number | string | null = null;
    let safetyInFlight: Promise<void> | null = null;

    const callSendMessageDraft = async (text: string): Promise<void> => {
      const truncated = text.slice(0, DRAFT_MAX_TEXT_CHARS);
      const safe = sanitizeStreamingHtml(truncated);
      const form: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
        text: safe,
        parse_mode: 'HTML',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.bot as any)._request('sendMessageDraft', { form });
    };

    const flush = async (): Promise<void> => {
      if (finalized || cancelled) return;
      if (latestText === lastSentText) return;
      const toSend = latestText;
      try {
        await callSendMessageDraft(toSend);
        lastSentText = toSend;
      } catch (error) {
        captureError(error, 'stream-message-draft-flush', { chat_id: chatId }, 'warning');
      }
    };

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

    const startStreamingPhase = async (firstAccumulated: string): Promise<void> => {
      if (streamingStarted || finalized || cancelled) return;
      streamingStarted = true;
      latestText = firstAccumulated;

      // Delete the stage placeholder so the user only sees the active draft.
      if (placeholderMessageId !== null) {
        try {
          await this.deleteMessage(chatId, placeholderMessageId);
        } catch (error) {
          captureError(error, 'stream-message-placeholder-delete', { chat_id: chatId }, 'warning');
        }
        placeholderMessageId = null;
      }

      try {
        await callSendMessageDraft(latestText);
        lastSentText = latestText;
      } catch (error) {
        captureError(error, 'stream-message-draft-init', { chat_id: chatId }, 'warning');
      }

      flushTimer = setInterval(() => {
        void flush();
      }, DRAFT_FLUSH_INTERVAL_MS);

      safetyTimer = setTimeout(() => {
        if (finalized || cancelled) return;
        // Mark finalized BEFORE the async send to close the race window
        // with finalize() / cancel().
        finalized = true;
        teardownTimers();
        safetyInFlight = (async () => {
          try {
            const safeText = sanitizeStreamingHtml(latestText || ' ');
            safetySentMessageId = await this.sendMessage(chatId, safeText, {
              format: MessageFormat.HTML,
            });
          } catch (error) {
            captureError(error, 'stream-message-safety-finalize', { chat_id: chatId }, 'warning');
          }
        })();
      }, DRAFT_SAFETY_GUARD_MS);
    };

    return {
      pushStage: (text: string) => {
        if (streamingStarted || finalized || cancelled) return;
        if (placeholderMessageId === null) return;
        if (text === lastStageText) return;
        const stageText = text;
        const messageId = placeholderMessageId;
        lastStageText = stageText;
        // Fire-and-forget: editMessageText is best-effort, the next stage or
        // streaming transition can recover.
        this.updateMessage(chatId, messageId, stageText, {
          format: MessageFormat.HTML,
        }).catch(error => {
          captureError(error, 'stream-message-stage-update', { chat_id: chatId }, 'warning');
        });
      },
      pushDelta: (accumulated: string) => {
        if (finalized || cancelled) return;
        if (!streamingStarted) {
          void startStreamingPhase(accumulated);
          return;
        }
        latestText = accumulated;
      },
      finalize: async (finalText: string, finalizeOptions?: MessageOptions) => {
        // Phase 1 (no streaming happened): edit the placeholder in place
        // with the final text + keyboard, so we don't leave debris.
        if (!streamingStarted && placeholderMessageId !== null && !finalized) {
          finalized = true;
          try {
            await this.updateMessage(chatId, placeholderMessageId, finalText, {
              ...options,
              ...finalizeOptions,
            });
          } catch (error) {
            captureError(error, 'stream-message-finalize-placeholder', { chat_id: chatId }, 'warning');
            // Recover with a fresh send so the user still gets the text.
            return this.sendMessage(chatId, finalText, { ...options, ...finalizeOptions });
          }
          return placeholderMessageId;
        }

        // Phase 2: safety guard already fired — wait for its send, then
        // edit the safety message in place for a stable messageId.
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
          return this.sendMessage(chatId, finalText, { ...options, ...finalizeOptions });
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

        // Phase 1 (still showing stage placeholder): edit it with the error
        // so we don't leave a stale "Composing…" above the error.
        if (!streamingStarted && placeholderMessageId !== null) {
          try {
            await this.updateMessage(chatId, placeholderMessageId, errorText, {
              format: MessageFormat.HTML,
              ...cancelOptions,
            });
            return;
          } catch (error) {
            captureError(error, 'stream-message-cancel-edit', { chat_id: chatId }, 'warning');
            // fall through to fresh send
          }
        }

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
