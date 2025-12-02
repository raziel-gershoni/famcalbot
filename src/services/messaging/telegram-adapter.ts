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
  ): Promise<void> {
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

    // Reply markup (keyboards)
    if (options?.replyMarkup) {
      telegramOptions.reply_markup = options.replyMarkup;
    }

    await this.bot.sendMessage(chatId, text, telegramOptions);
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
