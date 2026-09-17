import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
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
    const initData = searchParams.get('initData');
    const days = parseInt(searchParams.get('days') || '30');
    const reportType = searchParams.get('type') || 'overview';

    // This route used to gate on `if (initData && !verifyUserAccess(...))`, which
    // skipped verification entirely when initData was absent and then trusted a
    // user_id query param to name the admin - so knowing any admin's Telegram ID
    // was enough to read the full analytics. Now it uses the same unconditional
    // gate as every other admin route, and no longer takes an identity from the
    // query string at all.
    const auth = await verifyAdminAccess(initData || undefined);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
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
