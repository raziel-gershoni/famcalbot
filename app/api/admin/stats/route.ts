/**
 * Admin Stats API
 * GET: the admin panel's user counts (admin-only). The panel used to render them into
 * its server HTML for any ?user_id that was an admin's.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';

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
    // "Need setup" must be computed source-aware:
    //   GOOGLE: missing OAuth, missing calendars, OR missing location.
    //   NATIVE: missing location only (calendar is auto-bootstrapped at signup).
    const [
      totalUsers,
      usersWithOAuth,
      usersWithCalendars,
      googleIncompleteCount,
      nativeIncompleteCount,
      nativeUsers,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({
        where: { NOT: { googleRefreshToken: '' } }
      }),
      prisma.user.count({
        where: { calendarAssignments: { not: Prisma.JsonNull } }
      }),
      prisma.user.count({
        where: {
          calendarSource: 'GOOGLE',
          OR: [
            { googleRefreshToken: '' },
            { calendarAssignments: { equals: Prisma.JsonNull } },
            { calendarAssignments: { equals: Prisma.DbNull } },
            { calendarAssignments: { equals: [] } },
            { location: '' },
          ],
        },
      }),
      prisma.user.count({
        where: { calendarSource: 'NATIVE', location: '' },
      }),
      prisma.user.count({ where: { calendarSource: 'NATIVE' } }),
    ]);

    return NextResponse.json({
      success: true,
      stats: {
        totalUsers,
        usersWithOAuth,
        usersWithCalendars,
        needSetup: googleIncompleteCount + nativeIncompleteCount,
        nativeUsers,
      },
    });
  } catch (error) {
    captureError(error, 'admin-stats-get', { api_route: '/api/admin/stats' });
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
