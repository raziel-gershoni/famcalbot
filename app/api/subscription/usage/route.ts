import { NextRequest, NextResponse } from 'next/server';
import {
  incrementUsage,
  checkFeatureAccess,
} from '@/src/services/subscription-service';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';

type UsageFeature = 'textSummaries' | 'voiceSummaries' | 'voiceEvents' | 'reminders';

/**
 * POST /api/subscription/usage
 * Increment usage counter for a feature
 * Internal API - called by services after feature use
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, feature, secret } = body;

    // Internal API - require cron secret
    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    if (!user_id || !feature) {
      return NextResponse.json(
        { success: false, error: 'Missing user_id or feature' },
        { status: 400 }
      );
    }

    const validFeatures: UsageFeature[] = ['textSummaries', 'voiceSummaries', 'voiceEvents', 'reminders'];
    if (!validFeatures.includes(feature)) {
      return NextResponse.json(
        { success: false, error: 'Invalid feature' },
        { status: 400 }
      );
    }

    const userIdNum = parseInt(user_id);
    const updated = await incrementUsage(userIdNum, feature);

    return NextResponse.json({
      success: true,
      usage: {
        textSummaries: updated.textSummariesUsed,
        voiceSummaries: updated.voiceSummariesUsed,
        voiceEvents: updated.voiceEventsCreated,
        reminders: updated.remindersTriggered,
      },
    });
  } catch (error) {
    captureError(error, 'subscription-usage-api', { api_route: '/api/subscription/usage' });
    return NextResponse.json(
      { success: false, error: 'Failed to update usage' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/subscription/usage
 * Check if user can use a feature (pre-check before use)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const feature = searchParams.get('feature');
    const secret = searchParams.get('secret');

    // Internal API - require cron secret
    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    if (!userId || !feature) {
      return NextResponse.json(
        { success: false, error: 'Missing user_id or feature' },
        { status: 400 }
      );
    }

    const featureMap: Record<string, 'text_summary' | 'voice_summary' | 'reminders' | 'voice_events'> = {
      textSummaries: 'text_summary',
      voiceSummaries: 'voice_summary',
      voiceEvents: 'voice_events',
      reminders: 'reminders',
    };

    const mappedFeature = featureMap[feature];
    if (!mappedFeature) {
      return NextResponse.json(
        { success: false, error: 'Invalid feature' },
        { status: 400 }
      );
    }

    const userIdNum = parseInt(userId);
    const accessResult = await checkFeatureAccess(userIdNum, mappedFeature);

    return NextResponse.json({
      success: true,
      access: accessResult,
    });
  } catch (error) {
    captureError(error, 'subscription-usage-check-api', { api_route: '/api/subscription/usage' });
    return NextResponse.json(
      { success: false, error: 'Failed to check feature access' },
      { status: 500 }
    );
  }
}
