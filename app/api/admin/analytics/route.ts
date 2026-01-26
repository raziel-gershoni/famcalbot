import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { getUserByTelegramId } from '@/src/services/user-service';
import {
  getActivityStats,
  getDailyActivityCounts,
  getActiveUserCount,
  getConversionFunnel,
  getFeatureUsageBreakdown,
  ActivityAction,
} from '@/src/services/analytics-service';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/analytics
 * Get analytics data for admin panel
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const initData = searchParams.get('initData');
    const days = parseInt(searchParams.get('days') || '30');
    const reportType = searchParams.get('type') || 'overview';

    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Missing user_id' },
        { status: 400 }
      );
    }

    const userIdNum = parseInt(userId);

    // Verify user access via Telegram initData
    if (initData && !verifyUserAccess(initData, userIdNum)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Check admin status
    const user = await getUserByTelegramId(userIdNum);
    if (!user?.isAdmin) {
      return NextResponse.json(
        { success: false, error: 'Admin access required' },
        { status: 403 }
      );
    }

    switch (reportType) {
      case 'overview': {
        const [activityStats, activeUsers, conversionFunnel, featureUsage] = await Promise.all([
          getActivityStats(days),
          getActiveUserCount(days),
          getConversionFunnel(days),
          getFeatureUsageBreakdown(days),
        ]);

        return NextResponse.json({
          success: true,
          period: { days },
          overview: {
            activeUsers,
            totalActivities: activityStats.reduce((sum, s) => sum + s._count.action, 0),
          },
          activityBreakdown: activityStats,
          conversionFunnel,
          featureUsage,
        });
      }

      case 'daily': {
        const action = searchParams.get('action') as ActivityAction;
        if (!action) {
          return NextResponse.json(
            { success: false, error: 'Missing action parameter' },
            { status: 400 }
          );
        }

        const dailyCounts = await getDailyActivityCounts(action, days);

        return NextResponse.json({
          success: true,
          period: { days },
          action,
          dailyCounts,
        });
      }

      case 'funnel': {
        const funnel = await getConversionFunnel(days);

        return NextResponse.json({
          success: true,
          period: { days },
          funnel,
        });
      }

      default:
        return NextResponse.json(
          { success: false, error: 'Invalid report type' },
          { status: 400 }
        );
    }
  } catch (error) {
    captureError(error, 'admin-analytics-api', { api_route: '/api/admin/analytics' });
    return NextResponse.json(
      { success: false, error: 'Failed to get analytics' },
      { status: 500 }
    );
  }
}
