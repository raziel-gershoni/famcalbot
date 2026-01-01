/**
 * Event Reminders Cron API
 * Triggered every 5 minutes to send event reminders to users
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { convertPrismaUserToConfig } from '@/src/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60; // 60 seconds max for reminder processing

export async function GET(request: NextRequest) {
  // Verify the secret token and get optional window parameter
  const { searchParams } = new URL(request.url);
  const providedSecret = searchParams.get('secret') || request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET;
  const windowMinutes = parseInt(searchParams.get('window') || '5', 10);

  if (!expectedSecret) {
    console.error('[Reminders API] CRON_SECRET is not configured');
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  if (providedSecret !== expectedSecret) {
    console.error('[Reminders API] Invalid secret token provided');
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    // Get all users with reminders enabled
    const users = await prisma.user.findMany({
      where: {
        remindersEnabled: true,
        googleRefreshToken: { not: '' },
        telegramId: { not: null },
      },
    });

    if (users.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No users with reminders enabled',
        usersProcessed: 0,
        remindersSent: 0,
        timestamp: new Date().toISOString(),
      });
    }

    // Dynamically import to avoid build-time initialization
    const { processUserReminders } = await import('@/src/services/reminders');

    let totalRemindersSent = 0;
    let usersProcessed = 0;
    const errors: string[] = [];

    // Process each user
    for (const prismaUser of users) {
      try {
        const user = convertPrismaUserToConfig(prismaUser);
        const sentCount = await processUserReminders(user, windowMinutes);
        totalRemindersSent += sentCount;
        usersProcessed++;
      } catch (error) {
        const errorMsg = `User ${prismaUser.telegramId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`[Reminders API] Error processing user:`, errorMsg);
        errors.push(errorMsg);
      }
    }

    console.log(`[Reminders API] Processed ${usersProcessed} users, sent ${totalRemindersSent} reminders (window: ${windowMinutes}min)`);

    return NextResponse.json({
      success: true,
      message: 'Reminders processed',
      usersProcessed,
      remindersSent: totalRemindersSent,
      windowMinutes,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Reminders API] Error in reminders handler:', error);

    // Notify admin of cron job failures
    try {
      const { notifyAdminError } = await import('@/src/utils/error-notifier');
      await notifyAdminError('Reminders Cron', error, 'Job: Process event reminders');
    } catch (notifyError) {
      console.error('[Reminders API] Failed to notify admin:', notifyError);
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to process reminders',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
