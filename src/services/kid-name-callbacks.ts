/**
 * Kid Name Detection Callbacks
 * Handles user responses to kid name confirmation prompts
 */

import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { prisma } from '../utils/prisma';
import { getBot } from './telegram/bot';
import { getUserById } from './user-service';
import { getBotMessages, getBotMessagesForTelegramUser } from '../lib/bot-messages';
import { buildUrl } from '../config/urls';
import { CalendarAssignment } from '../types';
import { isFamcalId } from '../utils/calendar-helpers';
import { decodeCalendarId } from './native-calendar/event-store';
import { liveGoogleChoices } from '../lib/google-state';

interface KidNamePending {
  name: string;
  calendarId: string;
  userId: number;
}

/** Rule templates by language */
const RULE_TEMPLATES: Record<string, string> = {
  he: '{name} – בין ילדיי',
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
  const raw = await redis.get(REDIS_KEYS.kidNamePending(pendingId));
  if (!raw) {
    // Expired: the question is answered in the language of the person who tapped it (the chat is theirs)
    const t = await getBotMessagesForTelegramUser(chatId);
    await bot.answerCallbackQuery(queryId, { text: t.kidNameDetection.expired });
    await bot.editMessageText(t.kidNameDetection.expired, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });
    return;
  }

  const pending: KidNamePending = typeof raw === 'string' ? JSON.parse(raw) : raw as KidNamePending;
  const user = await getUserById(pending.userId);
  if (!user) {
    await redis.del(REDIS_KEYS.kidNamePending(pendingId));
    return;
  }

  const lang = user.language || 'en';
  const t = await getBotMessages(lang);
  const kd = t.kidNameDetection || {};

  if (action === 'kidname_yes') {
    const ruleTemplate = RULE_TEMPLATES[lang] || RULE_TEMPLATES.en;
    const ruleText = ruleTemplate.replace('{name}', pending.name);
    const { text: answer, written } = isFamcalId(pending.calendarId)
      ? await confirmOnFamcal(user.id, pending, ruleText, kd)
      : await confirmOnGoogle(user.id, liveGoogleChoices(user), pending, ruleText, kd);

    const settingsPage = isFamcalId(pending.calendarId) ? 'calendars' : 'select-calendars';
    const settingsUrl = buildUrl(`/${lang}/${settingsPage}?user_id=${user.telegramId ?? user.id}`);
    const openSettingsText = kd.openSettings || 'Open Settings';

    // The toast repeats the rule only when it was written; otherwise it says what the card says
    await bot.answerCallbackQuery(queryId, { text: written ? ruleText : answer });
    await bot.editMessageText(answer, {
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
    await redis.del(REDIS_KEYS.kidNamePending(pendingId));
  } else if (action === 'kidname_no') {
    const declinedText = kd.declined || 'Got it, thanks!';

    await bot.answerCallbackQuery(queryId, { text: declinedText });
    await bot.editMessageText(declinedText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
    });

    // Delete pending from Redis
    await redis.del(REDIS_KEYS.kidNamePending(pendingId));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KidNameTexts = any;

/** What a "Yes" answered: the card's text, and whether a rule or a name was written (the toast repeats the rule only then). */
interface KidNameAnswer {
  text: string;
  written: boolean;
}

/**
 * "Yes" on a Google calendar: the rule goes on its assignment (User.calendarAssignments, of the
 * choices that count: liveGoogleChoices), and the answer says so, naming the calendar. A calendar
 * that is no longer chosen gets nothing written and an answer that says so.
 */
async function confirmOnGoogle(
  userId: number,
  stored: CalendarAssignment[] | undefined | null,
  pending: KidNamePending,
  ruleText: string,
  kd: KidNameTexts
): Promise<KidNameAnswer> {
  const assignments: CalendarAssignment[] = stored ? [...stored] : [];
  const assignmentIndex = assignments.findIndex(a => a.calendarId === pending.calendarId);
  if (assignmentIndex === -1) {
    console.warn(`[KidName] user ${userId}: the Google calendar of the question is no longer chosen; nothing written`);
    return { text: kd.calendarGone, written: false };
  }
  assignments[assignmentIndex] = { ...assignments[assignmentIndex], rules: [ruleText] };
  await prisma.user.update({
    where: { id: userId },
    data: { calendarAssignments: assignments as unknown as object[] },
  });
  return {
    text: kd.confirmed.replace('{calendar}', assignments[assignmentIndex].name).replace('{name}', pending.name),
    written: true,
  };
}

/**
 * "Yes" on a FamCal calendar ("Google as a connection" spec §4): the child is the calendar's
 * person (NativeCalendar.personName), as the calendars page sets it, but only on a calendar
 * labelled kids that names no one yet: personName is read only there. Any other calendar
 * (unlabelled, birthdays, or a kids one that already names a child) gets the rule instead, as a
 * Google one does. Only the user's own calendar is written; a partner's is left as it is.
 */
async function confirmOnFamcal(userId: number, pending: KidNamePending, ruleText: string, kd: KidNameTexts): Promise<KidNameAnswer> {
  const cuid = decodeCalendarId(pending.calendarId);
  const calendar = cuid
    ? await prisma.nativeCalendar.findFirst({ where: { id: cuid, ownerUserId: userId, isDeleted: false } })
    : null;
  if (!calendar) {
    console.warn(`[KidName] user ${userId}: ${pending.calendarId} is not a FamCal calendar of theirs; nothing written`);
    return { text: kd.declined || 'Got it, thanks!', written: false };
  }
  if (calendar.labels.includes('kids') && !calendar.personName?.trim()) {
    await prisma.nativeCalendar.update({ where: { id: calendar.id }, data: { personName: pending.name } });
    return {
      text: (kd.confirmedFamcal || '{calendar} is now {name}\'s calendar').replace('{calendar}', calendar.name).replace('{name}', pending.name),
      written: true,
    };
  }
  await prisma.nativeCalendar.update({ where: { id: calendar.id }, data: { rules: [ruleText] } });
  return {
    text: (kd.confirmed || 'Added a rule to {calendar}: "{name} is my child"').replace('{calendar}', calendar.name).replace('{name}', pending.name),
    written: true,
  };
}
