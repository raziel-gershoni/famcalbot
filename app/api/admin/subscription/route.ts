/**
 * Admin Subscription API
 * POST: Grant a free ("comped") PRO subscription to a user
 * DELETE: Revoke a comped PRO subscription
 *
 * Only comps are writable here. A real paying customer can never be created or
 * downgraded through this route — the guards live in the service layer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { grantCompedSubscription, revokeCompedSubscription } from '@/src/services/subscription-service';

export const dynamic = 'force-dynamic';

// POST: Grant comped PRO
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { initData, user_id, reason } = body;

    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    if (!user_id || typeof user_id !== 'number') {
      return NextResponse.json(
        { error: 'user_id is required and must be a number' },
        { status: 400 }
      );
    }

    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return NextResponse.json(
        { error: 'reason must be a string' },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { id: user_id } });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const result = await grantCompedSubscription(user_id, auth.adminId!, reason || undefined);

    if (!result.ok) {
      const message =
        result.code === 'ALREADY_COMPED'
          ? 'This user already has a comped subscription'
          : `User already has an active plan (${result.plan} / ${result.status})`;
      return NextResponse.json({ error: message }, { status: 409 });
    }

    console.log(`[admin-subscription] Admin ${auth.adminId} comped PRO for user ${user_id}`);

    return NextResponse.json({
      success: true,
      subscription: {
        plan: result.subscription.plan,
        status: result.subscription.status,
        compedAt: result.subscription.compedAt ? result.subscription.compedAt.toISOString() : null,
        compReason: result.subscription.compReason,
      },
    });
  } catch (error) {
    captureError(error, 'admin-subscription-post', { api_route: '/api/admin/subscription' });
    return NextResponse.json({ error: 'Failed to grant subscription' }, { status: 500 });
  }
}

// DELETE: Revoke comped PRO
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const initData = searchParams.get('initData');
    const targetUserId = searchParams.get('user_id');

    const auth = await verifyAdminAccess(initData || undefined);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    if (!targetUserId) {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 });
    }

    const userId = parseInt(targetUserId, 10);
    if (isNaN(userId)) {
      return NextResponse.json({ error: 'Invalid user_id' }, { status: 400 });
    }

    const result = await revokeCompedSubscription(userId, auth.adminId!);

    if (!result.ok) {
      return NextResponse.json(
        { error: 'This user does not have a comped subscription' },
        { status: 409 }
      );
    }

    console.log(`[admin-subscription] Admin ${auth.adminId} revoked comped PRO for user ${userId}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    captureError(error, 'admin-subscription-delete', { api_route: '/api/admin/subscription' });
    return NextResponse.json({ error: 'Failed to revoke subscription' }, { status: 500 });
  }
}
