/**
 * Admin Send Reminder API
 * POST: Send a registration reminder to a specific user
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { getMessagingService } from '@/src/services/telegram';
import { getBotMessages } from '@/src/lib/bot-messages';
import { MessageFormat } from '@/src/services/messaging';
import { buildUrl } from '@/src/config/urls';

export const dynamic = 'force-dynamic';

type ReminderType = 'oauth' | 'calendars' | 'location';

/**
 * Get the reminder message content based on type
 */
function getReminderContent(
  messages: any,
  reminderType: ReminderType,
  locale: string,
  telegramId: number
): { title: string; body: string; button: string; url: string } {
  const setupReminders = messages.setupReminders;

  switch (reminderType) {
    case 'oauth':
      return {
        title: setupReminders.oauth.title,
        body: setupReminders.oauth.body,
        button: setupReminders.oauth.button,
        url: buildUrl(`/${locale}/dashboard?user_id=${telegramId}`),
      };
    case 'calendars':
      return {
        title: setupReminders.calendars.title,
        body: setupReminders.calendars.body,
        button: setupReminders.calendars.button,
        url: buildUrl(`/${locale}/select-calendars?user_id=${telegramId}`),
      };
    case 'location':
      return {
        title: setupReminders.location.title,
        body: setupReminders.location.body,
        button: setupReminders.location.button,
        url: buildUrl(`/${locale}/settings?user_id=${telegramId}`),
      };
  }
}

// POST: Send a reminder to a specific user
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { initData, user_id, reminder_type } = body;

    // Verify admin access
    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    // Validate user_id
    if (!user_id || typeof user_id !== 'number') {
      return NextResponse.json(
        { error: 'user_id is required and must be a number' },
        { status: 400 }
      );
    }

    // Validate reminder_type
    const validTypes: ReminderType[] = ['oauth', 'calendars', 'location'];
    if (!reminder_type || !validTypes.includes(reminder_type)) {
      return NextResponse.json(
        { error: 'reminder_type must be one of: oauth, calendars, location' },
        { status: 400 }
      );
    }

    // Get target user
    const user = await prisma.user.findUnique({
      where: { id: user_id },
      select: {
        id: true,
        telegramId: true,
        language: true,
        name: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    if (!user.telegramId) {
      return NextResponse.json(
        { error: 'User has no Telegram ID' },
        { status: 400 }
      );
    }

    // Get localized messages
    const locale = user.language || 'en';
    const messages = await getBotMessages(locale);
    const reminderContent = getReminderContent(messages, reminder_type, locale, Number(user.telegramId));

    // Build the message
    const messageText = `${reminderContent.title}\n\n${reminderContent.body}`;

    // Send the message via Telegram
    const messagingService = getMessagingService();
    await messagingService.sendMessage(
      Number(user.telegramId),
      messageText,
      {
        format: MessageFormat.HTML,
        replyMarkup: {
          inline_keyboard: [
            [{ text: reminderContent.button, web_app: { url: reminderContent.url } }]
          ]
        }
      }
    );

    console.log(`[send-reminder] Admin ${auth.adminId} sent ${reminder_type} reminder to user ${user_id} (${user.name})`);

    return NextResponse.json({
      success: true,
      message: `Reminder sent to ${user.name}`,
    });
  } catch (error) {
    captureError(error, 'send-reminder-post', { api_route: '/api/admin/send-reminder' });
    console.error('[send-reminder] Error:', error);
    return NextResponse.json(
      { error: 'Failed to send reminder' },
      { status: 500 }
    );
  }
}
