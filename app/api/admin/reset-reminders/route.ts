/**
 * Admin Reset Setup Reminders API
 * POST: Clear all setup reminder tracking for a user so they get reminded again
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { Redis } from '@upstash/redis';
import { REDIS_KEYS } from '@/src/config/redis-keys';

export const dynamic = 'force-dynamic';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { initData, user_id } = body;

    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    if (!user_id || typeof user_id !== 'number') {
      return NextResponse.json(
        { error: 'user_id is required and must be a number' },
        { status: 400 }
      );
    }

    // Delete all setup reminder keys for this user (all types, all attempts)
    const types = ['oauth', 'calendars', 'location'];
    const maxAttempts = 4; // max across all schedules
    const keysToDelete: string[] = [];

    for (const type of types) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        keysToDelete.push(REDIS_KEYS.setupReminder(user_id, type, attempt));
      }
    }

    // Delete all keys (Redis DEL ignores non-existent keys)
    let deleted = 0;
    for (const key of keysToDelete) {
      deleted += await redis.del(key);
    }

    console.log(`[reset-reminders] Admin ${auth.adminId} reset reminders for user ${user_id} (${deleted} keys cleared)`);

    return NextResponse.json({
      success: true,
      message: `Cleared ${deleted} reminder tracking keys`,
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
