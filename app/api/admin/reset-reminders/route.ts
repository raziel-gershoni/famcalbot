/**
 * Admin Reset Setup Reminders API
 * POST: Clear all setup reminder tracking for a user so they get reminded again
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { redis } from '@/src/utils/redis';
import { GOOGLE_NUDGE_WHERE, setupTrackKeys } from '@/src/services/setup-tracks';

export const dynamic = 'force-dynamic';

/** Every setup track's attempts (setup-tracks.ts). */
async function clearReminderKeys(userId: number): Promise<number> {
  return redis.del(...setupTrackKeys(userId));
}

/** The location track counts from now, and the Google track starts over when the cron next sees the state. */
async function resetReminderStart(userId: number): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { reminderStartAt: new Date(), googleNudgeStartedAt: null },
  });
}

// POST: Reset reminders for one user or all incomplete users
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { initData, user_id, reset_all } = body;

    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    // Reset all incomplete users: a missing location, or a Google state that asks for a
    // nudge (a token with no chosen calendars, or no token with calendars stored).
    // Connecting Google is optional, so a never-connected user with a location is complete.
    if (reset_all) {
      const incompleteUsers = await prisma.user.findMany({
        where: {
          AND: {
            OR: [{ telegramId: { not: null } }, { whatsappPhone: { not: null } }, { whatsappBsuid: { not: null } }],
          },
          OR: [{ location: '' }, ...GOOGLE_NUDGE_WHERE],
        },
        select: { id: true, name: true },
      });

      let totalKeys = 0;
      for (const user of incompleteUsers) {
        totalKeys += await clearReminderKeys(user.id);
        await resetReminderStart(user.id);
      }

      console.log(`[reset-reminders] Admin ${auth.adminId} reset ALL incomplete users (${incompleteUsers.length} users, ${totalKeys} keys)`);

      return NextResponse.json({
        success: true,
        message: `Reset ${incompleteUsers.length} incomplete users`,
        usersReset: incompleteUsers.length,
        keysCleared: totalKeys,
      });
    }

    // Reset single user
    if (!user_id || typeof user_id !== 'number') {
      return NextResponse.json(
        { error: 'user_id is required and must be a number' },
        { status: 400 }
      );
    }

    const deleted = await clearReminderKeys(user_id);
    await resetReminderStart(user_id);

    console.log(`[reset-reminders] Admin ${auth.adminId} reset reminders for user ${user_id} (${deleted} keys, createdAt reset)`);

    return NextResponse.json({
      success: true,
      message: `Reset reminders and signup date for user ${user_id}`,
      keysCleared: deleted,
    });
  } catch (error) {
    captureError(error, 'reset-reminders-post', { api_route: '/api/admin/reset-reminders' });
    console.error('[reset-reminders] Error:', error);
    return NextResponse.json(
      { error: 'Failed to reset reminders' },
      { status: 500 }
    );
  }
}
