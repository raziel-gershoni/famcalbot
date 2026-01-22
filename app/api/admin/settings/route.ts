/**
 * Admin Settings API
 * GET: Fetch admin settings (public - for settings page to check if reminders are globally enabled)
 * POST: Update admin settings (admin-only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { getUserByTelegramId } from '@/src/services/user-service';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';

// GET: Fetch admin settings
export async function GET() {
  try {
    const adminSettings = await withDbRetry(
      () => prisma.adminSettings.findUnique({
        where: { id: 'global' }
      }),
      'admin-settings.get'
    );

    return NextResponse.json({
      success: true,
      remindersEnabled: adminSettings?.remindersEnabled ?? false
    });
  } catch (error) {
    captureError(error, 'admin-settings-get', { api_route: '/api/admin/settings' });
    return NextResponse.json(
      { error: 'Failed to fetch admin settings' },
      { status: 500 }
    );
  }
}

// POST: Update admin settings (admin-only)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { remindersEnabled, initData } = body;

    // Extract user_id from initData
    if (!initData) {
      return NextResponse.json(
        { error: 'Missing initData' },
        { status: 401 }
      );
    }

    // Parse initData to get user_id
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    if (!userJson) {
      return NextResponse.json(
        { error: 'Invalid initData' },
        { status: 401 }
      );
    }

    const userData = JSON.parse(userJson);
    const userId = userData.id;

    // Verify Telegram authentication
    if (!verifyUserAccess(initData, userId)) {
      console.warn(`[admin-settings] Unauthorized access attempt for user ${userId}`);
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Check if user is admin
    const user = await getUserByTelegramId(userId);
    if (!user?.isAdmin) {
      console.warn(`[admin-settings] Non-admin user ${userId} attempted to update settings`);
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    // Validate input
    if (typeof remindersEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'remindersEnabled must be a boolean' },
        { status: 400 }
      );
    }

    // Upsert admin settings
    await withDbRetry(
      () => prisma.adminSettings.upsert({
        where: { id: 'global' },
        update: { remindersEnabled },
        create: { id: 'global', remindersEnabled }
      }),
      'admin-settings.update'
    );

    console.log(`[admin-settings] Admin ${userId} set remindersEnabled to ${remindersEnabled}`);

    return NextResponse.json({ success: true, remindersEnabled });
  } catch (error) {
    captureError(error, 'admin-settings-post', { api_route: '/api/admin/settings' });
    return NextResponse.json(
      { error: 'Failed to update admin settings' },
      { status: 500 }
    );
  }
}
