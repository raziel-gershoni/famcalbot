/**
 * Admin Stats API
 * GET: the admin panel's user counts (admin-only). The panel used to render them into
 * its server HTML for any ?user_id that was an admin's.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { GOOGLE_NUDGE_WHERE, LIVE_GOOGLE_CHOICES_WHERE } from '@/src/services/setup-tracks';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(requestInitData(request));
  if (!auth.authorized) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.error === 'Admin access required' ? 403 : 401 }
    );
  }

  try {
    // "Need setup": a missing location, or a Google state that asks for a nudge (a token
    // with no chosen calendars, or a legacy Google user with no token and calendars stored).
    // Connecting Google is optional; "with OAuth" counts tokens (Google connected), "with
    // calendars" the users whose Google choices count (liveGoogleChoices).
    const [totalUsers, usersWithOAuth, usersWithCalendars, needSetup] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({
        where: { NOT: { googleRefreshToken: '' } }
      }),
      prisma.user.count({
        where: LIVE_GOOGLE_CHOICES_WHERE
      }),
      prisma.user.count({
        where: { OR: [{ location: '' }, ...GOOGLE_NUDGE_WHERE] },
      }),
    ]);

    return NextResponse.json({
      success: true,
      stats: {
        totalUsers,
        usersWithOAuth,
        usersWithCalendars,
        needSetup,
      },
    });
  } catch (error) {
    captureError(error, 'admin-stats-get', { api_route: '/api/admin/stats' });
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
