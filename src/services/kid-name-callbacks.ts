/**
 * Kid Name Detection Callbacks
 * Handles user responses to kid name confirmation prompts
 */

import { redis } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { getBot } from './telegram/bot';
import { getUserById } from './user-service';
import { getBotMessages } from '../lib/bot-messages';
import { buildUrl } from '../config/urls';
import { CalendarAssignment } from '../types';

interface KidNamePending {
  name: string;
  calendarId: string;
  userId: number;
}

/** Rule templates by language */
const RULE_TEMPLATES: Record<string, string> = {
  he: '{name} הוא ילד/ה שלי',
  ru: '{name} — мой ребёнок',
  en: '{name} is my child',
};

/**
 * Handle kid name callback (yes/no button click)
 */
export async function handleKidNameCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  action: string,
  pendingId: string
): Promise<void> {
  const bot = getBot();

  // Get pending data from Redis
  const raw = await redis.get(`kidname:pending:${pendingId}`);
  if (!raw) {
    // Expired
    const t = await getBotMessages('en');
    const kd = t.kidNameDetection || {};
    await bot.answerCallbackQuery(queryId, { text: kd.expired || 'This request has expired.' });
    await bot.editMessageText(kd.expired || 'This request has expired.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
    return;
  }

  const pending: KidNamePending = typeof raw === 'string' ? JSON.parse(raw) : raw as KidNamePending;
  const user = await getUserById(pending.userId);
  if (!user) {
    await redis.del(`kidname:pending:${pendingId}`);
    return;
  }

  const lang = user.language || 'en';
  const t = await getBotMessages(lang);
  const kd = t.kidNameDetection || {};

  if (action === 'kidname_yes') {
    // Find the CalendarAssignment matching calendarId
    const assignments: CalendarAssignment[] = user.calendarAssignments ? [...user.calendarAssignments] : [];
    const assignmentIndex = assignments.findIndex(a => a.calendarId === pending.calendarId);

    if (assignmentIndex !== -1) {
      // Build rule string based on language
      const ruleTemplate = RULE_TEMPLATES[lang] || RULE_TEMPLATES.en;
      const rule = ruleTemplate.replace('{name}', pending.name);

      // Set rules on the assignment
      assignments[assignmentIndex] = {
        ...assignments[assignmentIndex],
        rules: [rule],
      };

      // Save via prisma
      await prisma.user.update({
        where: { id: pending.userId },
        data: { calendarAssignments: assignments as unknown as object[] },
      });
    }

    // Build confirmation text with settings link
    const calendarName = assignments[assignmentIndex]?.name || pending.calendarId;
    const ruleTemplate = RULE_TEMPLATES[lang] || RULE_TEMPLATES.en;
    const ruleText = ruleTemplate.replace('{name}', pending.name);
    const confirmedText = (kd.confirmed || 'Added a rule to {calendar}: "{name} is my child"')
      .replace('{calendar}', calendarName)
      .replace('{name}', pending.name);

    const settingsUrl = buildUrl(`/${lang}/select-calendars?user_id=${pending.userId}`);
    const openSettingsText = kd.openSettings || 'Open Settings';

    await bot.answerCallbackQuery(queryId, { text: ruleText });
    await bot.editMessageText(confirmedText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: openSettingsText, web_app: { url: settingsUrl } },
        ]],
      },
    });

    // Delete pending from Redis
    await redis.del(`kidname:pending:${pendingId}`);
  } else if (action === 'kidname_no') {
    const declinedText = kd.declined || 'Got it, thanks!';

    await bot.answerCallbackQuery(queryId, { text: declinedText });
    await bot.editMessageText(declinedText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });

    // Delete pending from Redis
    await redis.del(`kidname:pending:${pendingId}`);
  }
}
