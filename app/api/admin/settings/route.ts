/**
 * Admin Settings API
 * GET: Fetch admin settings (admin-only; pages read AdminSettings server-side)
 * POST: Update admin settings (admin-only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { setGlobalRemindersEnabled, setEarlyAdoptionMode, setVoiceAutoCreateHighConf, setVoiceTtsOutcome } from '@/src/services/reminder-cache';
import { invalidateAllFeatureAccessCaches } from '@/src/services/subscription-service';

export const dynamic = 'force-dynamic';

// GET: Fetch admin settings (admin-only)
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request.nextUrl.searchParams.get('initData') || undefined);
  if (!auth.authorized) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.error === 'Admin access required' ? 403 : 401 }
    );
  }

  try {
    const adminSettings = await prisma.adminSettings.findUnique({
      where: { id: 'global' }
    }).catch(() => null); // Handle missing table gracefully

    return NextResponse.json({
      success: true,
      remindersEnabled: adminSettings?.remindersEnabled ?? false,
      earlyAdoptionMode: adminSettings?.earlyAdoptionMode ?? false,
      voiceAutoCreateHighConf: adminSettings?.voiceAutoCreateHighConf ?? false,
      voiceTtsOutcome: adminSettings?.voiceTtsOutcome ?? false,
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
    const { remindersEnabled, earlyAdoptionMode, voiceAutoCreateHighConf, voiceTtsOutcome, initData } = body;

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
    const hasVoiceAutoCreate = typeof voiceAutoCreateHighConf === 'boolean';
    const hasVoiceTts = typeof voiceTtsOutcome === 'boolean';
    if (!hasReminders && !hasEarlyAdoption && !hasVoiceAutoCreate && !hasVoiceTts) {
      return NextResponse.json(
        { error: 'At least one setting field must be provided' },
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
      if (hasVoiceAutoCreate) {
        updateData.voiceAutoCreateHighConf = voiceAutoCreateHighConf;
        createData.voiceAutoCreateHighConf = voiceAutoCreateHighConf;
      }
      if (hasVoiceTts) {
        updateData.voiceTtsOutcome = voiceTtsOutcome;
        createData.voiceTtsOutcome = voiceTtsOutcome;
      }

      const settings = await prisma.adminSettings.upsert({
        where: { id: 'global' },
        update: updateData,
        create: createData as { id: string; remindersEnabled?: boolean; earlyAdoptionMode?: boolean; voiceAutoCreateHighConf?: boolean; voiceTtsOutcome?: boolean },
      });

      // Sync to Redis cache
      if (hasReminders) {
        await setGlobalRemindersEnabled(remindersEnabled);
      }
      if (hasEarlyAdoption) {
        await setEarlyAdoptionMode(earlyAdoptionMode);
        await invalidateAllFeatureAccessCaches();
      }
      if (hasVoiceAutoCreate) {
        await setVoiceAutoCreateHighConf(voiceAutoCreateHighConf);
      }
      if (hasVoiceTts) {
        await setVoiceTtsOutcome(voiceTtsOutcome);
      }

      console.log(`[admin-settings] Admin ${auth.adminId} updated settings:`, { remindersEnabled, earlyAdoptionMode, voiceAutoCreateHighConf, voiceTtsOutcome });

      return NextResponse.json({
        success: true,
        remindersEnabled: settings.remindersEnabled,
        earlyAdoptionMode: settings.earlyAdoptionMode,
        voiceAutoCreateHighConf: settings.voiceAutoCreateHighConf,
        voiceTtsOutcome: settings.voiceTtsOutcome,
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
