// POST /api/pair/accept — accept an invite as the authenticated user.
// Body: { token, initData? }. Returns { success: true, partnerName }.
//
// Validation lives in pairing-service.acceptInvite — this route just maps the
// PairingError codes onto HTTP responses. Notification of the inviter is
// handled at the bot layer in PR 6 (TG/WA outbound message after accept).

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { getUserByIdentifier } from '@/src/services/user-service';
import { acceptInvite, PairingError } from '@/src/services/pairing-service';
import { captureError } from '@/src/lib/error-capture';
import { prisma } from '@/src/utils/prisma';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json().catch(() => ({}));
    const initData = body.initData ?? searchParams.get('initData');
    const token: string | undefined = body.token;

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'pair-accept');
    if (!auth.success) return auth.response;

    const user = await getUserByIdentifier(auth.userId);
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const result = await acceptInvite(token, user.id);

    // Inviter side: pull their name for the success response so the UI can
    // confirm "paired with X" without an extra round-trip.
    const inviter = await prisma.user.findUnique({
      where: { id: result.inviterUserId },
      select: { name: true, englishName: true },
    });

    return NextResponse.json({
      success: true,
      partner: { name: inviter?.name ?? '', englishName: inviter?.englishName ?? '' },
    });
  } catch (error) {
    if (error instanceof PairingError) {
      const status = error.code === 'INVITE_NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: error.code }, { status });
    }
    captureError(error, 'pair-accept');
    return NextResponse.json({ error: 'Failed to accept invite' }, { status: 500 });
  }
}
