// POST /api/pair/invite   — create or refresh the user's invite token.
// GET  /api/pair/invite   — return the user's currently-active invite (if any).
// DELETE /api/pair/invite — revoke the user's active invite.
//
// Token persistence lives in PairingInvite (DB) — see pairing-service.ts.
// The miniapp renders the URL; the bot accepts the token via /start invite_<t>
// (TG) or `accept <t>` (TG+WA), see PR 6.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { getUserByIdentifier } from '@/src/services/user-service';
import {
  createInvite,
  getActiveInvite,
  revokeInvite,
  PairingError,
} from '@/src/services/pairing-service';
import { buildUrl } from '@/src/config/urls';
import { captureError } from '@/src/lib/error-capture';

function buildInviteUrl(token: string, locale: string): string {
  return buildUrl(`/${locale}/invite/${token}`);
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json().catch(() => ({}));
    const initData = body.initData ?? searchParams.get('initData');

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'pair-invite-create');
    if (!auth.success) return auth.response;

    const user = await getUserByIdentifier(auth.userId);
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const invite = await createInvite(user.id);
    return NextResponse.json({
      success: true,
      token: invite.token,
      url: buildInviteUrl(invite.token, user.language || 'en'),
      expiresAt: invite.expiresAt,
    });
  } catch (error) {
    if (error instanceof PairingError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    captureError(error, 'pair-invite-create');
    return NextResponse.json({ error: 'Failed to create invite' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const initData = searchParams.get('initData');

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'pair-invite-get');
    if (!auth.success) return auth.response;

    const user = await getUserByIdentifier(auth.userId);
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const invite = await getActiveInvite(user.id);
    if (!invite) return NextResponse.json({ active: false });

    return NextResponse.json({
      active: true,
      token: invite.token,
      url: buildInviteUrl(invite.token, user.language || 'en'),
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    });
  } catch (error) {
    captureError(error, 'pair-invite-get');
    return NextResponse.json({ error: 'Failed to load invite' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json().catch(() => ({}));
    const initData = body.initData ?? searchParams.get('initData');

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'pair-invite-revoke');
    if (!auth.success) return auth.response;

    const user = await getUserByIdentifier(auth.userId);
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    await revokeInvite(user.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    captureError(error, 'pair-invite-revoke');
    return NextResponse.json({ error: 'Failed to revoke invite' }, { status: 500 });
  }
}
