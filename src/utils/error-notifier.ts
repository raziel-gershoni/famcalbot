/**
 * Error Notification Utility
 * Sends critical errors to admin users via Telegram AND Sentry
 */

import * as Sentry from '@sentry/nextjs';
import { getBot } from '../services/telegram';
import { prisma } from './prisma';

/**
 * Get all admin user Telegram IDs
 */
export async function getAdminUserIds(): Promise<number[]> {
  try {
    const admins = await prisma.user.findMany({
      where: { isAdmin: true },
      select: { telegramId: true }
    });
    return admins.map(a => Number(a.telegramId));
  } catch (error) {
    console.error('Failed to fetch admin users:', error);
    return [];
  }
}

/**
 * Notify admin of a critical error via Telegram and Sentry
 * @param context - Where the error occurred (e.g., "Webhook Handler", "Daily Summary Cron")
 * @param error - The error object or message
 * @param additionalInfo - Optional additional context
 */
export async function notifyAdminError(
  context: string,
  error: unknown,
  additionalInfo?: string
): Promise<void> {
  // Always capture to Sentry first
  Sentry.withScope(scope => {
    scope.setTag('context', context);
    scope.setLevel('error');
    scope.setTag('notified_admin', 'true');
    if (additionalInfo) scope.setExtra('additionalInfo', additionalInfo);
    Sentry.captureException(error);
  });

  // Then notify via Telegram
  try {
    const bot = getBot();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    let message = `🚨 <b>Error in ${context}</b>\n\n`;
    message += `<b>Error:</b> ${errorMessage}\n`;

    if (additionalInfo) {
      message += `\n<b>Context:</b> ${additionalInfo}\n`;
    }

    if (stack) {
      // Only include first 3 lines of stack trace to avoid message length issues
      const stackLines = stack.split('\n').slice(0, 3).join('\n');
      message += `\n<code>${stackLines}</code>`;
    }

    message += `\n\n<i>Time: ${new Date().toISOString()}</i>`;

    const adminIds = await getAdminUserIds();
    await Promise.all(adminIds.map(id => bot.sendMessage(id, message, { parse_mode: 'HTML' })));
  } catch (notificationError) {
    // If Telegram notification fails, capture that too
    console.error('Failed to send error notification to admin:', notificationError);
    console.error('Original error:', error);
    Sentry.captureException(notificationError, {
      tags: { context: 'admin_notification_failed' }
    });
  }
}

/**
 * Notify admin of a warning (non-critical)
 */
export async function notifyAdminWarning(
  context: string,
  message: string,
  // Who the warning is about. Without this a warning names a failure but not its
  // subject, which makes it undiagnosable - you get an error string and no way to
  // tell which user it concerns, or whether it is one user or twenty.
  subject?: { userId?: number; name?: string | null }
): Promise<void> {
  const subjectLine = subject?.userId
    ? `User ${subject.userId}${subject.name ? ` (${subject.name})` : ''}`
    : null;

  // Capture warning to Sentry
  Sentry.withScope(scope => {
    scope.setTag('context', context);
    scope.setLevel('warning');
    scope.setTag('notified_admin', 'true');
    if (subject?.userId) {
      scope.setUser({ id: String(subject.userId), username: subject.name ?? undefined });
      scope.setTag('user_id', String(subject.userId));
    }
    Sentry.captureMessage(message);
  });

  // Then notify via Telegram
  try {
    const bot = getBot();
    const body = subjectLine ? `${subjectLine}\n\n${message}` : message;
    const warningMessage = `⚠️ <b>Warning: ${context}</b>\n\n${body}\n\n<i>Time: ${new Date().toISOString()}</i>`;

    const adminIds = await getAdminUserIds();
    await Promise.all(adminIds.map(id => bot.sendMessage(id, warningMessage, { parse_mode: 'HTML' })));
  } catch (error) {
    console.error('Failed to send warning notification:', error);
    Sentry.captureException(error, {
      tags: { context: 'admin_warning_notification_failed' }
    });
  }
}

/**
 * Notify admin of new user feedback via Telegram
 * @param userName - Name of the user who submitted feedback
 * @param telegramId - Telegram ID of the user (null for dashboard submissions without it)
 * @param feedbackText - The feedback text
 * @param source - Where the feedback was submitted from ('telegram' or 'dashboard')
 */
export async function notifyAdminFeedback(
  userName: string,
  telegramId: bigint | number | null,
  feedbackText: string,
  source: 'telegram' | 'dashboard'
): Promise<void> {
  try {
    const bot = getBot();
    const adminIds = await getAdminUserIds();

    const message = `📨 <b>New Feedback</b>
From: ${userName}
ID: ${telegramId || 'N/A'}
Source: ${source}
───────────
${feedbackText}`;

    await Promise.all(adminIds.map(id =>
      bot.sendMessage(id, message, { parse_mode: 'HTML' })
    ));
  } catch (error) {
    console.error('Failed to send feedback notification to admin:', error);
    Sentry.captureException(error, {
      tags: { context: 'admin_feedback_notification_failed' }
    });
  }
}
