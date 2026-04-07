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
} from './types';

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

  async sendTypingIndicator(chatId: number | string, _messageId?: string, typingType?: 'text' | 'audio'): Promise<void> {
    try {
      await this.bot.sendChatAction(chatId, typingType === 'audio' ? 'record_voice' : 'typing');
    } catch {
      // Non-critical — ignore errors
    }
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    await this.bot.answerCallbackQuery(queryId, text ? { text } : undefined);
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
