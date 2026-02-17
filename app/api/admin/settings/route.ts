/**
 * Admin Settings API
 * GET: Fetch admin settings (public - for settings page to check if reminders are globally enabled)
 * POST: Update admin settings (admin-only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma, withDbRetry } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { setGlobalRemindersEnabled, setEarlyAdoptionMode } from '@/src/services/reminder-cache';
import { invalidateAllFeatureAccessCaches } from '@/src/services/subscription-service';

export const dynamic = 'force-dynamic';

// GET: Fetch admin settings
export async function GET() {
  try {
    const adminSettings = await withDbRetry(
      () => prisma.adminSettings.findUnique({
        where: { id: 'global' }
      }),
      'admin-settings.get'
    ).catch(() => null); // Handle missing table gracefully

    return NextResponse.json({
      success: true,
      remindersEnabled: adminSettings?.remindersEnabled ?? false,
      earlyAdoptionMode: adminSettings?.earlyAdoptionMode ?? false,
    });
  } catch (error) {
    captureError(error, 'admin-settings-get', { api_route: '/api/admin/settings' });
    return NextResponse.json({
      success: true,
      remindersEnabled: false // Default to disabled on error
    });
  }
}

// POST: Update admin settings (admin-only)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { remindersEnabled, earlyAdoptionMode, initData } = body;

    // Verify admin access
    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    // Validate input - at least one field must be provided
    const hasReminders = typeof remindersEnabled === 'boolean';
    const hasEarlyAdoption = typeof earlyAdoptionMode === 'boolean';
    if (!hasReminders && !hasEarlyAdoption) {
      return NextResponse.json(
        { error: 'At least one setting field must be a boolean' },
        { status: 400 }
      );
    }

    // Upsert admin settings
    try {
      const updateData: Record<string, boolean> = {};
      const createData: Record<string, boolean | string> = { id: 'global' };
      if (hasReminders) {
        updateData.remindersEnabled = remindersEnabled;
        createData.remindersEnabled = remindersEnabled;
      }
      if (hasEarlyAdoption) {
        updateData.earlyAdoptionMode = earlyAdoptionMode;
        createData.earlyAdoptionMode = earlyAdoptionMode;
      }

      const settings = await withDbRetry(
        () => prisma.adminSettings.upsert({
          where: { id: 'global' },
          update: updateData,
          create: createData as { id: string; remindersEnabled?: boolean; earlyAdoptionMode?: boolean },
        }),
        'admin-settings.update'
      );

      // Sync to Redis cache
      if (hasReminders) {
        await setGlobalRemindersEnabled(remindersEnabled);
      }
      if (hasEarlyAdoption) {
        await setEarlyAdoptionMode(earlyAdoptionMode);
        await invalidateAllFeatureAccessCaches();
      }

      console.log(`[admin-settings] Admin ${auth.adminId} updated settings:`, { remindersEnabled, earlyAdoptionMode });

      return NextResponse.json({
        success: true,
        remindersEnabled: settings.remindersEnabled,
        earlyAdoptionMode: settings.earlyAdoptionMode,
      });
    } catch (dbError) {
      // Table might not exist yet
      console.error('[admin-settings] Database error (table may not exist):', dbError);
      return NextResponse.json(
        { error: 'Feature not available yet - database migration pending' },
        { status: 503 }
      );
    }
  } catch (error) {
    captureError(error, 'admin-settings-post', { api_route: '/api/admin/settings' });
    return NextResponse.json(
      { error: 'Failed to update admin settings' },
      { status: 500 }
    );
  }
}
