/**
 * Admin User Moderation API
 * POST: { action: 'suspend' | 'unsuspend' | 'hard_delete', user_id, reason?, confirmation? }
 *
 * - suspend: marks user as suspended; bot stops replying, cron skips them
 * - unsuspend: clears suspension
 * - hard_delete: irreversible cascade delete of user + related rows.
 *   Requires confirmation === 'DELETE' to guard against accidents.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { suspendUser, unsuspendUser, hardDeleteUser } from '@/src/lib/user-moderation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { initData, action, user_id, reason, confirmation } = body;

    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    if (typeof user_id !== 'number') {
      return NextResponse.json({ error: 'user_id is required and must be a number' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: user_id } });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (user_id === auth.adminId) {
      return NextResponse.json({ error: 'Admins cannot moderate their own account' }, { status: 400 });
    }

    switch (action) {
      case 'suspend': {
        await suspendUser(user_id, auth.adminId!, reason ?? null);
        return NextResponse.json({ success: true, message: 'User suspended' });
      }

      case 'unsuspend': {
        await unsuspendUser(user_id, auth.adminId!);
        return NextResponse.json({ success: true, message: 'User unsuspended' });
      }

      case 'hard_delete': {
        if (confirmation !== 'DELETE') {
          return NextResponse.json(
            { error: 'confirmation must equal "DELETE" to hard-delete a user' },
            { status: 400 }
          );
        }
        await hardDeleteUser(user_id, auth.adminId!);
        return NextResponse.json({ success: true, message: 'User hard-deleted' });
      }

      default:
        return NextResponse.json(
          { error: 'action must be "suspend", "unsuspend", or "hard_delete"' },
          { status: 400 }
        );
    }
  } catch (error) {
    captureError(error, 'admin-users-moderation', { api_route: '/api/admin/users/moderation' });
    return NextResponse.json({ error: 'Failed to moderate user' }, { status: 500 });
  }
}
