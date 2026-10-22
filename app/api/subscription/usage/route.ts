import { NextRequest, NextResponse } from 'next/server';
import { checkFeatureAccess } from '@/src/services/subscription-service';
import { captureError } from '@/src/lib/error-capture';
import { matchesSecret } from '@/src/lib/secret-compare';

export const dynamic = 'force-dynamic';

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

    // Internal API - require cron secret (an unset or empty CRON_SECRET matches nothing)
    if (!matchesSecret(secret, process.env.CRON_SECRET)) {
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
